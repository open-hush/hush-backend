import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import type { S3Client } from '@aws-sdk/client-s3';

import { createDb, createPool } from './db/client.js';
import type { Database } from './db/types.js';
import { hmacPlugin, loadSecretFromDb } from './auth/hmac.js';
import { jwtPlugin } from './auth/jwt.js';
import { healthRoutes } from './routes/health.js';
import { usersRoutes } from './routes/users.js';
import { deviceRoutes } from './routes/device.js';
import { devicesRoutes } from './routes/devices.js';
import { audioRoutes } from './routes/audio.js';
import { createS3Client, readS3Config, type S3Config } from './storage/s3.js';
import { TranscodeQueue } from './transcode/queue.js';

export interface CreateServerOptions {
  databaseUrl?: string;
  pool?: pg.Pool;
  db?: Kysely<Database>;
  s3?: S3Client;
  s3Config?: S3Config;
  /** When true, do not initialise S3 / transcode queue. Used by tests. */
  skipStorage?: boolean;
}

export async function createServer(opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    disableRequestLogging: false,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl && !opts.pool && !opts.db) {
    throw new Error('DATABASE_URL is required');
  }
  const ownedPool = opts.pool ?? (opts.db ? undefined : createPool(databaseUrl!));
  const pool = opts.pool ?? ownedPool!;
  const db = opts.db ?? createDb(pool);

  // S3 + transcode queue. Skippable for unit tests.
  let s3: S3Client | undefined = opts.s3;
  let s3Config: S3Config | undefined = opts.s3Config;
  let queue: TranscodeQueue | undefined;
  if (!opts.skipStorage) {
    s3Config = s3Config ?? readS3Config();
    s3 = s3 ?? createS3Client(s3Config);
    queue = new TranscodeQueue(
      { db, s3, s3Config, log: app.log },
      { maxConcurrency: Number(process.env.TRANSCODE_CONCURRENCY ?? 2) },
    );
  }

  app.addHook('onClose', async () => {
    if (queue) await queue.close();
    if (ownedPool) await ownedPool.end();
  });

  // Capture raw body bytes for HMAC verification on device endpoints.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      const buf = body as Buffer;
      req.rawBody = buf;
      if (buf.length === 0) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(buf.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await app.register(sensible);
  await app.register(cookie);
  const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
  });
  await app.register(jwtPlugin);
  await app.register(hmacPlugin, { loadSecret: loadSecretFromDb(db) });

  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { message?: string; statusCode?: number; code?: string; validation?: unknown };
    if (err instanceof ZodError) {
      return reply.code(422).send({
        code: 'validation_failed',
        message: 'request failed validation',
        details: { issues: err.issues },
      });
    }
    if (e.validation) {
      return reply.code(422).send({
        code: 'validation_failed',
        message: e.message ?? 'validation_failed',
        details: { issues: e.validation },
      });
    }
    const status = e.statusCode ?? 500;
    if (status >= 500) {
      app.log.error({ err }, 'unhandled error');
      return reply.code(500).send({ code: 'internal_error', message: 'internal error' });
    }
    return reply.code(status).send({
      code: e.code ?? statusCodeToErrorCode(status),
      message: e.message ?? 'error',
    });
  });

  await app.register(healthRoutes, { prefix: '/v1' });
  await app.register(usersRoutes({ db }), { prefix: '/v1' });
  await app.register(deviceRoutes({ db, s3, s3Config }), { prefix: '/v1' });
  await app.register(devicesRoutes({ db }), { prefix: '/v1' });
  if (queue && s3 && s3Config) {
    await app.register(audioRoutes({ db, s3, s3Config, queue }), { prefix: '/v1' });
    // Re-enqueue orphaned `processing` rows. Fire-and-forget at boot.
    app.ready(() => {
      queue!.recoverOrphans()
        .then((n) => n > 0 && app.log.info({ recovered: n }, 'transcode: recovered orphans'))
        .catch((err) => app.log.error({ err }, 'transcode: orphan recovery failed'));
    });
  }

  return app;
}

function statusCodeToErrorCode(status: number): string {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 422:
      return 'validation_failed';
    default:
      return 'error';
  }
}
