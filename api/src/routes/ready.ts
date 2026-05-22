import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { sql, type Kysely } from 'kysely';
import type { S3Client } from '@aws-sdk/client-s3';

import { ReadySchema } from '../schemas.js';
import type { Database } from '../db/types.js';
import { headBucket, type S3Config } from '../storage/s3.js';

interface ReadyDeps {
  db: Kysely<Database>;
  s3?: S3Client | undefined;
  s3Config?: S3Config | undefined;
}

const PROBE_TIMEOUT_MS = Number(process.env.READY_PROBE_TIMEOUT_MS ?? 2000);

type CheckResult =
  | { status: 'ok'; latencyMs: number }
  | { status: 'error' | 'timeout'; error: string };

async function timed<T>(label: string, fn: () => Promise<T>, timeoutMs: number): Promise<CheckResult> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    return { status: 'ok', latencyMs: Date.now() - started };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes('timed out');
    return { status: isTimeout ? 'timeout' : 'error', error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const readyRoutes =
  (deps: ReadyDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, s3, s3Config } = deps;

    app.get(
      '/ready',
      { schema: { response: { 200: ReadySchema, 503: ReadySchema } } },
      async (req, reply) => {
        const checks: Record<string, CheckResult> = {};

        checks.database = await timed(
          'database',
          async () => {
            await sql`SELECT 1`.execute(db);
          },
          PROBE_TIMEOUT_MS,
        );

        if (s3 && s3Config) {
          checks.objectStorage = await timed(
            'objectStorage',
            () => headBucket(s3, s3Config),
            PROBE_TIMEOUT_MS,
          );
        }

        const allOk = Object.values(checks).every((c) => c.status === 'ok');
        const status = allOk ? 'ok' : 'degraded';
        if (!allOk) {
          req.log.warn({ checks }, 'readiness probe degraded');
        }
        return reply.code(allOk ? 200 : 503).send({ status, checks });
      },
    );
  };
