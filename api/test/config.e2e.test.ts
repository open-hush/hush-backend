import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type pg from 'pg';

import { createServer } from '../src/server.js';
import { createDb, createPool } from '../src/db/client.js';
import type { Database } from '../src/db/types.js';
import { hashPassword } from '../src/auth/password.js';

// GET /v1/config is admin-only and read-only (OPE-21): it reports which env
// vars are set per external service, never their values.
const TAG = `e2e-config+${Date.now()}`;
const adminEmail = `${TAG}-admin@test.local`;
const adminPassword = 'admin-correct-horse-battery';
const userEmail = `${TAG}-user@test.local`;
const userPassword = 'plain-user-correct-horse';

let app: FastifyInstance;
let db: Kysely<Database>;
let pool: pg.Pool;

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/v1/users/login', payload: { email, password } });

const getConfig = (token?: string) =>
  app.inject({
    method: 'GET',
    url: '/v1/config',
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

beforeAll(async () => {
  process.env.JWT_SIGNING_KEY = 'x'.repeat(32);
  process.env.METRICS_ENABLED = 'false';
  // A known-set, non-secret var so we can assert a hint surfaces.
  process.env.S3_BUCKET = 'hush-audio';
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://hush:hush@localhost:5432/hush';
  pool = createPool(databaseUrl);
  db = createDb(pool);
  app = await createServer({ db, skipStorage: true });

  await db
    .insertInto('users')
    .values([
      {
        email: adminEmail,
        password_hash: await hashPassword(adminPassword),
        display_name: 'E2E config admin',
        role: 'admin',
      },
      {
        email: userEmail,
        password_hash: await hashPassword(userPassword),
        display_name: 'E2E config user',
        role: 'user',
      },
    ])
    .execute();
});

afterAll(async () => {
  await db.deleteFrom('users').where('email', 'like', `${TAG}-%`).execute();
  await app.close();
  await pool.end();
});

describe('GET /v1/config', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await getConfig();
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthorized');
  });

  it('rejects an authenticated non-admin with 403', async () => {
    const token = (await login(userEmail, userPassword)).json().accessToken;
    const res = await getConfig(token);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden');
  });

  it('returns the per-service status to an admin without leaking secret values', async () => {
    const token = (await login(adminEmail, adminPassword)).json().accessToken;
    const res = await getConfig(token);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.services.map((s: { service: string }) => s.service)).toEqual([
      'email',
      'storage',
      'traces',
      'crash',
    ]);

    const storage = body.services.find((s: { service: string }) => s.service === 'storage');
    expect(storage.hints.bucket).toBe('hush-audio');

    // No variable ever carries a `value`; secret vars are flagged.
    for (const svc of body.services) {
      for (const v of svc.variables) {
        expect(v.value).toBeUndefined();
        expect(typeof v.set).toBe('boolean');
        expect(typeof v.secret).toBe('boolean');
      }
    }
  });
});
