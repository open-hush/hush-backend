import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import type { S3Client } from '@aws-sdk/client-s3';

import {
  ErrorSchema,
  FirmwareLatestQuerySchema,
  FirmwareManifestSchema,
} from '../schemas.js';
import type { Database } from '../db/types.js';
import { presignGet, type S3Config } from '../storage/s3.js';

interface FirmwareDeps {
  db: Kysely<Database>;
  s3: S3Client;
  s3Config: S3Config;
}

const FIRMWARE_PRESIGN_TTL_SEC = Number(process.env.FIRMWARE_PRESIGN_TTL_SEC ?? 1800);

export const firmwareRoutes =
  (deps: FirmwareDeps): FastifyPluginAsyncZod =>
  async (app) => {
    const { db, s3, s3Config } = deps;

    app.get(
      '/firmware/latest',
      {
        preHandler: app.requireDevice,
        schema: {
          querystring: FirmwareLatestQuerySchema,
          response: {
            200: FirmwareManifestSchema,
            401: ErrorSchema,
            404: ErrorSchema,
          },
        },
      },
      async (req, reply) => {
        const { hw_rev } = req.query;

        const release = await db
          .selectFrom('firmware_releases')
          .select([
            'version',
            'hw_rev',
            'blob_key',
            'sha256',
            'signature',
            'size_bytes',
            'released_at',
            'notes',
          ])
          .where('hw_rev', '=', hw_rev)
          .orderBy('released_at', 'desc')
          .limit(1)
          .executeTakeFirst();

        if (!release) {
          return reply
            .code(404)
            .send({ code: 'no_firmware', message: `no firmware published for hw_rev=${hw_rev}` });
        }

        const presigned = await presignGet(s3, s3Config, release.blob_key, {
          expiresInSec: FIRMWARE_PRESIGN_TTL_SEC,
        });

        return reply.code(200).send({
          version: release.version,
          hwRev: release.hw_rev,
          url: presigned.url,
          expiresAt: presigned.expiresAt.toISOString(),
          sha256: release.sha256,
          signature: release.signature,
          signatureAlgorithm: 'ed25519',
          sizeBytes: Number(release.size_bytes),
          releasedAt: release.released_at.toISOString(),
          ...(release.notes ? { notes: release.notes } : {}),
        });
      },
    );
  };
