import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { DeleteObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import { createServer } from '../src/server.js';
import { createDb, createPool } from '../src/db/client.js';
import type { Database } from '../src/db/types.js';
import { hashPassword } from '../src/auth/password.js';
import type { S3Config } from '../src/storage/s3.js';

// Real end-to-end against a live Postgres (the dev stack from `make services`).
// Object storage is faked: the delete path only calls `deleteObject`, so we
// record the keys it asks S3 to remove instead of hitting MinIO. This keeps
// the ownership/cascade assertions deterministic and MinIO-independent.
const TAG = `e2e-audio+${Date.now()}`;

const ownerEmail = `${TAG}-owner@test.local`;
const otherEmail = `${TAG}-other@test.local`;
const password = 'a-perfectly-long-password';

let app: FastifyInstance;
let db: Kysely<Database>;
let pool: pg.Pool;

// Keys the route asked S3 to delete, in order. Reset per test that cares.
let deletedKeys: string[] = [];

const fakeS3: S3Client = {
  send: async (cmd: unknown) => {
    if (cmd instanceof DeleteObjectCommand) {
      deletedKeys.push(String(cmd.input.Key));
    }
    return {};
  },
} as unknown as S3Client;

const fakeS3Config: S3Config = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'hush-test',
  accessKey: 'test',
  secretKey: 'test',
  pathStyle: true,
};

async function seedUser(email: string): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({
      email,
      password_hash: await hashPassword(password),
      display_name: 'Audio E2E',
      role: 'user',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
}

async function login(email: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/users/login',
    payload: { email, password },
  });
  expect(res.statusCode).toBe(200);
  return res.json().accessToken as string;
}

async function seedAudio(ownerId: string, opts: { transcoded?: boolean } = {}): Promise<string> {
  const row = await db
    .insertInto('audios')
    .values({
      owner_id: ownerId,
      title: 'A clip',
      source_content_type: 'audio/mpeg',
      source_key: 'uploads/seed',
      transcoded_key: opts.transcoded ? 'audio/seed.mp3' : null,
      state: opts.transcoded ? 'ready' : 'uploading',
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  // Pin the canonical key layout once we know the generated id.
  await db
    .updateTable('audios')
    .set({
      source_key: `uploads/${row.id}`,
      ...(opts.transcoded ? { transcoded_key: `audio/${row.id}.mp3` } : {}),
    })
    .where('id', '=', row.id)
    .execute();
  return row.id;
}

let ownerToken: string;
let otherToken: string;
let ownerId: string;

beforeAll(async () => {
  process.env.JWT_SIGNING_KEY = 'x'.repeat(32);
  process.env.METRICS_ENABLED = 'false';
  delete process.env.DISABLE_PUBLIC_REGISTRATION;
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://hush:hush@localhost:5432/hush';
  pool = createPool(databaseUrl);
  db = createDb(pool);
  app = await createServer({ db, s3: fakeS3, s3Config: fakeS3Config });

  ownerId = await seedUser(ownerEmail);
  await seedUser(otherEmail);
  ownerToken = await login(ownerEmail);
  otherToken = await login(otherEmail);
});

afterAll(async () => {
  await db.deleteFrom('users').where('email', 'like', `${TAG}-%`).execute();
  await app.close();
  await pool.end();
});

describe('POST /v1/audio — validation', () => {
  it('rejects a request without a title (422)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audio',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { sourceContentType: 'audio/mpeg' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('validation_failed');
  });

  it('requires authentication (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/audio',
      payload: { title: 'x', sourceContentType: 'audio/mpeg' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /v1/audio/{id}', () => {
  it('deletes the owner\'s audio and removes both stored objects (204)', async () => {
    deletedKeys = [];
    const id = await seedAudio(ownerId, { transcoded: true });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/audio/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(204);
    expect(deletedKeys).toEqual(
      expect.arrayContaining([`uploads/${id}`, `audio/${id}.mp3`]),
    );

    const row = await db
      .selectFrom('audios')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    expect(row).toBeUndefined();
  });

  it('only deletes the raw upload when there is no transcoded object', async () => {
    deletedKeys = [];
    const id = await seedAudio(ownerId, { transcoded: false });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/audio/${id}`,
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(res.statusCode).toBe(204);
    expect(deletedKeys).toEqual([`uploads/${id}`]);
  });

  it('returns 404 when deleting an audio that does not exist', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/audio/00000000-0000-0000-0000-000000000000',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('does not let a user delete another user\'s audio (404, row untouched)', async () => {
    deletedKeys = [];
    const id = await seedAudio(ownerId, { transcoded: true });

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/audio/${id}`,
      headers: { authorization: `Bearer ${otherToken}` },
    });

    expect(res.statusCode).toBe(404);
    expect(deletedKeys).toEqual([]);

    const row = await db
      .selectFrom('audios')
      .select('id')
      .where('id', '=', id)
      .executeTakeFirst();
    expect(row?.id).toBe(id);
  });

  it('requires authentication (401)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/audio/00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(401);
  });
});
