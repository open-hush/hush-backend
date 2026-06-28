import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type pg from 'pg';
import { createServer } from '../src/server.js';
import { createDb, createPool } from '../src/db/client.js';
import type { Database, DeviceState, AudioState } from '../src/db/types.js';
import { hashPassword } from '../src/auth/password.js';
import { createS3Client, type S3Config } from '../src/storage/s3.js';

// Real end-to-end against a live Postgres (the dev stack from `make services`).
// Object storage is faked: the only storage call this route makes is
// `presignGet`, which is pure request signing (no network), so a fake client +
// config is enough to exercise the 200 path offline. We drive the endpoint
// through the userJwt-acting-as-device branch, mirroring the sync/events e2e.
const TAG = `card-dl-e2e+${Date.now()}`;
const ownerPassword = 'owner-correct-horse-battery';
const otherPassword = 'other-correct-horse-battery';

const SHA = 'a'.repeat(64);

// `presignGet` is pure request signing (no network), but it needs a real
// client built from a config — a `{ send }` stub has no signing middleware.
const fakeS3Config: S3Config = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'hush-test',
  accessKey: 'test',
  secretKey: 'test',
  pathStyle: true,
};
const fakeS3 = createS3Client(fakeS3Config);

let app: FastifyInstance;
let db: Kysely<Database>;
let pool: pg.Pool;

let ownerToken: string;
let ownerId: string;
let otherId: string;

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/v1/users/login', payload: { email, password } });
  return res.json().accessToken as string;
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function seedUser(email: string, password: string): Promise<string> {
  const row = await db
    .insertInto('users')
    .values({ email, password_hash: await hashPassword(password), display_name: null, role: 'user' })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedDevice(opts: { serial: string; ownerId: string | null; state?: DeviceState }): Promise<string> {
  const row = await db
    .insertInto('devices')
    .values({ serial: opts.serial, owner_id: opts.ownerId, name: null, state: opts.state ?? 'claimed' })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedAudio(opts: { ownerId: string; state: AudioState; ready?: boolean }): Promise<string> {
  const ready = opts.ready ?? opts.state === 'ready';
  const row = await db
    .insertInto('audios')
    .values({
      owner_id: opts.ownerId,
      title: 'A clip',
      source_content_type: 'audio/mpeg',
      source_key: 'uploads/seed',
      state: opts.state,
      transcoded_key: ready ? 'audio/seed.mp3' : null,
      sha256: ready ? SHA : null,
      size_bytes: ready ? 2048 : null,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return row.id;
}

async function seedBinding(deviceId: string, uid: string, audioId: string): Promise<void> {
  await db.insertInto('card_bindings').values({ device_id: deviceId, uid, audio_id: audioId }).execute();
}

beforeAll(async () => {
  process.env.JWT_SIGNING_KEY = 'x'.repeat(32);
  process.env.METRICS_ENABLED = 'false';
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://hush:hush@localhost:5432/hush';
  pool = createPool(databaseUrl);
  db = createDb(pool);
  app = await createServer({ db, s3: fakeS3, s3Config: fakeS3Config });

  ownerId = await seedUser(`${TAG}-owner@test.local`, ownerPassword);
  otherId = await seedUser(`${TAG}-other@test.local`, otherPassword);
  ownerToken = await login(`${TAG}-owner@test.local`, ownerPassword);
});

afterAll(async () => {
  // card_bindings and audios cascade off the rows we seed; clean the roots.
  await db.deleteFrom('devices').where('serial', 'like', `${TAG}-%`).execute();
  await db.deleteFrom('audios').where('owner_id', 'in', [ownerId, otherId]).execute();
  await db.deleteFrom('users').where('email', 'like', `${TAG}-%`).execute();
  await app.close();
  await pool.end();
});

describe('GET /v1/device/cards/:uid/download (userJwt acting as device)', () => {
  it('200s with a presigned link when the card is bound to a ready audio', async () => {
    const deviceId = await seedDevice({ serial: `${TAG}-ok`, ownerId });
    const audioId = await seedAudio({ ownerId, state: 'ready' });
    const uid = '04a1b2c3d4e5';
    await seedBinding(deviceId, uid, audioId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/device/cards/${uid}/download?device_id=${deviceId}`,
      headers: auth(ownerToken),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.audioId).toBe(audioId);
    expect(body.sha256).toBe(SHA);
    expect(body.sizeBytes).toBe(2048);
    expect(typeof body.downloadUrl).toBe('string');
    expect(body.downloadUrl).toContain('audio/seed.mp3');
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('404s with card_not_bound when the UID has no binding on this device', async () => {
    const deviceId = await seedDevice({ serial: `${TAG}-nobind`, ownerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/device/cards/0badc0de/download?device_id=${deviceId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('card_not_bound');
  });

  it('409s with audio_not_ready when the bound audio is still processing', async () => {
    const deviceId = await seedDevice({ serial: `${TAG}-notready`, ownerId });
    const audioId = await seedAudio({ ownerId, state: 'processing' });
    const uid = '0a1b2c3d4e5f';
    await seedBinding(deviceId, uid, audioId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/device/cards/${uid}/download?device_id=${deviceId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('audio_not_ready');
    expect(res.json().details?.state).toBe('processing');
  });

  it('401s without any authentication', async () => {
    const deviceId = await seedDevice({ serial: `${TAG}-noauth`, ownerId });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/device/cards/04a1b2c3d4e5/download?device_id=${deviceId}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("404s on another user's device (no IDOR, no existence leak)", async () => {
    const deviceId = await seedDevice({ serial: `${TAG}-other`, ownerId: otherId });
    const audioId = await seedAudio({ ownerId: otherId, state: 'ready' });
    const uid = '04ffffffffff';
    await seedBinding(deviceId, uid, audioId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/device/cards/${uid}/download?device_id=${deviceId}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('device_not_found');
  });

  it('400s when device_id is missing for a user caller', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/device/cards/04a1b2c3d4e5/download',
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('device_id_required');
  });

  it('404s on an unknown device_id (no existence leak)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/device/cards/04a1b2c3d4e5/download?device_id=${randomUUID()}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(404);
  });
});
