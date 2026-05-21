import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Kysely } from 'kysely';
import type { S3Client } from '@aws-sdk/client-s3';
import { z } from 'zod';

import {
  AudioCreateRequestSchema,
  AudioCreateResponseSchema,
  AudioListQuerySchema,
  AudioListSchema,
  AudioSchema,
  ErrorSchema,
} from '../schemas.js';
import type { AudiosTable, Database } from '../db/types.js';
import { headObject, presignPut, type S3Config } from '../storage/s3.js';
import type { TranscodeQueue } from '../transcode/queue.js';
import { decodeCursor, encodeCursor } from '../util/cursor.js';
import type { Selectable } from 'kysely';

const ISO = (d: Date | string): string =>
  (d instanceof Date ? d : new Date(d)).toISOString();

const UPLOAD_TTL_SEC = 15 * 60;
const PAGE_SIZE = 50;

type AudioRow = Selectable<AudiosTable>;

function toApi(row: Pick<AudioRow,
  'id' | 'title' | 'description' | 'duration_ms' | 'state' | 'sha256' | 'size_bytes' | 'created_at'
>): z.infer<typeof AudioSchema> {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    durationMs: row.duration_ms,
    state: row.state,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    createdAt: ISO(row.created_at),
  };
}

export interface AudioDeps {
  db: Kysely<Database>;
  s3: S3Client;
  s3Config: S3Config;
  queue: TranscodeQueue;
}

export const audioRoutes = (deps: AudioDeps): FastifyPluginAsyncZod => async (app) => {
  const { db, s3, s3Config, queue } = deps;

  app.post(
    '/audio',
    {
      preHandler: app.requireUser,
      schema: {
        body: AudioCreateRequestSchema,
        response: { 201: AudioCreateResponseSchema, 401: ErrorSchema, 422: ErrorSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const { title, description, sourceContentType } = req.body;

      const inserted = await db
        .insertInto('audios')
        .values({
          owner_id: userId,
          title,
          description: description ?? null,
          source_content_type: sourceContentType,
          source_key: 'pending',
        })
        .returning([
          'id', 'title', 'description', 'duration_ms', 'state', 'sha256',
          'size_bytes', 'created_at',
        ])
        .executeTakeFirstOrThrow();

      const sourceKey = `uploads/${inserted.id}`;
      await db
        .updateTable('audios')
        .set({ source_key: sourceKey })
        .where('id', '=', inserted.id)
        .execute();

      const upload = await presignPut(s3, s3Config, sourceKey, {
        contentType: sourceContentType,
        expiresInSec: UPLOAD_TTL_SEC,
      });

      return reply.code(201).send({
        audio: toApi(inserted),
        upload: {
          url: upload.url,
          method: upload.method,
          expiresAt: upload.expiresAt.toISOString(),
          headers: upload.headers,
        },
      });
    },
  );

  app.post(
    '/audio/:id/finalize',
    {
      preHandler: app.requireUser,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 202: AudioSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema, 422: ErrorSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const { id } = req.params;

      const row = await db
        .selectFrom('audios')
        .selectAll()
        .where('id', '=', id)
        .where('owner_id', '=', userId)
        .executeTakeFirst();
      if (!row) {
        return reply.code(404).send({ code: 'not_found', message: 'audio not found' });
      }
      if (row.state !== 'uploading' && row.state !== 'failed') {
        return reply.code(409).send({ code: 'already_finalized', message: 'audio already finalized' });
      }

      const head = await headObject(s3, s3Config, row.source_key);
      if (!head) {
        return reply.code(422).send({ code: 'upload_missing', message: 'upload not found in object storage' });
      }

      const updated = await db
        .updateTable('audios')
        .set({
          state: 'processing',
          size_bytes: head.contentLength,
          finalized_at: new Date(),
          updated_at: new Date(),
          failure_reason: null,
        })
        .where('id', '=', id)
        .returning([
          'id', 'title', 'description', 'duration_ms', 'state', 'sha256',
          'size_bytes', 'created_at',
        ])
        .executeTakeFirstOrThrow();

      queue.enqueue(id);

      return reply.code(202).send(toApi(updated));
    },
  );

  app.get(
    '/audio',
    {
      preHandler: app.requireUser,
      schema: {
        querystring: AudioListQuerySchema,
        response: { 200: AudioListSchema, 401: ErrorSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const cursor = req.query.cursor ? decodeCursor(req.query.cursor) : null;

      let q = db
        .selectFrom('audios')
        .select([
          'id', 'title', 'description', 'duration_ms', 'state', 'sha256',
          'size_bytes', 'created_at',
        ])
        .where('owner_id', '=', userId)
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(PAGE_SIZE + 1);

      if (cursor) {
        const ts = new Date(cursor.createdAt);
        q = q.where((eb) =>
          eb.or([
            eb('created_at', '<', ts),
            eb.and([eb('created_at', '=', ts), eb('id', '<', cursor.id)]),
          ]),
        );
      }

      const rows = await q.execute();
      const hasMore = rows.length > PAGE_SIZE;
      const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
      const last = page[page.length - 1];
      const nextCursor = hasMore && last ? encodeCursor({ createdAt: ISO(last.created_at), id: last.id }) : undefined;

      return reply.code(200).send({
        items: page.map(toApi),
        ...(nextCursor ? { nextCursor } : {}),
      });
    },
  );

  app.get(
    '/audio/:id',
    {
      preHandler: app.requireUser,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: AudioSchema, 401: ErrorSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const userId = req.user.sub;
      const row = await db
        .selectFrom('audios')
        .select([
          'id', 'title', 'description', 'duration_ms', 'state', 'sha256',
          'size_bytes', 'created_at',
        ])
        .where('id', '=', req.params.id)
        .where('owner_id', '=', userId)
        .executeTakeFirst();
      if (!row) return reply.code(404).send({ code: 'not_found', message: 'audio not found' });
      return reply.code(200).send(toApi(row));
    },
  );
};
