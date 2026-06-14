import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type pg from 'pg';

import { createServer } from '../src/server.js';
import { createDb, createPool } from '../src/db/client.js';
import type { Database } from '../src/db/types.js';
import { hashPassword } from '../src/auth/password.js';

// Real end-to-end against a live Postgres (the dev stack from `make services`).
// There is no transactional-rollback harness yet, so we use a unique email
// prefix and delete the rows we created in afterAll. refresh_tokens cascade on
// user delete.
const TAG = `e2e+${Date.now()}`;
const adminEmail = `${TAG}-admin@test.local`;
const adminPassword = 'admin-correct-horse-battery';

let app: FastifyInstance;
let db: Kysely<Database>;
let pool: pg.Pool;

async function login(email: string, password: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/users/login',
    payload: { email, password },
  });
  return res;
}

beforeAll(async () => {
  process.env.JWT_SIGNING_KEY = 'x'.repeat(32);
  process.env.METRICS_ENABLED = 'false';
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://hush:hush@localhost:5432/hush';
  pool = createPool(databaseUrl);
  db = createDb(pool);
  app = await createServer({ db, skipStorage: true });

  // Seed an existing user so we can obtain a token: registration is no longer
  // public, so without a seeded account there is no way in.
  await db
    .insertInto('users')
    .values({
      email: adminEmail,
      password_hash: await hashPassword(adminPassword),
      display_name: 'E2E admin',
    })
    .execute();
});

afterAll(async () => {
  await db.deleteFrom('users').where('email', 'like', `${TAG}-%`).execute();
  await app.close();
  // The server did not own this pool (we passed `db` in), so close it here to
  // avoid a dangling connection / open-handle warning in CI.
  await pool.end();
});

describe('closed registration', () => {
  it('rejects register without a bearer token (401)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/register',
      payload: { email: `${TAG}-nope@test.local`, password: 'whatever-long-enough' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('creates a user when authenticated and returns the profile, not tokens', async () => {
    const auth = await login(adminEmail, adminPassword);
    expect(auth.statusCode).toBe(200);
    const { accessToken } = auth.json();

    const newEmail = `${TAG}-created@test.local`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/register',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { email: newEmail, password: 'created-user-password', displayName: 'Created' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.email).toBe(newEmail);
    expect(body.id).toBeTruthy();
    // Must NOT log the caller in as the new user.
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
  });

  it('returns 409 when the email is already in use', async () => {
    const auth = await login(adminEmail, adminPassword);
    const { accessToken } = auth.json();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/register',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { email: adminEmail, password: 'another-long-password' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('email_taken');
  });
});

describe('PATCH /v1/users/me/password', () => {
  it('changes the password, revokes old refresh tokens, and issues a fresh pair', async () => {
    const email = `${TAG}-rotate@test.local`;
    const oldPassword = 'rotate-initial-password';
    await db
      .insertInto('users')
      .values({ email, password_hash: await hashPassword(oldPassword), display_name: null })
      .execute();

    const auth = await login(email, oldPassword);
    const { accessToken, refreshToken: oldRefresh } = auth.json();

    const newPassword = 'rotate-brand-new-password';
    const change = await app.inject({
      method: 'PATCH',
      url: '/v1/users/me/password',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: oldPassword, newPassword },
    });
    expect(change.statusCode).toBe(200);
    expect(change.json().accessToken).toBeTruthy();
    expect(change.json().refreshToken).toBeTruthy();

    // Old refresh token is revoked.
    const reuse = await app.inject({
      method: 'POST',
      url: '/v1/users/refresh',
      payload: { refreshToken: oldRefresh },
    });
    expect(reuse.statusCode).toBe(401);

    // New password works; old one no longer does.
    expect((await login(email, newPassword)).statusCode).toBe(200);
    expect((await login(email, oldPassword)).statusCode).toBe(401);
  });

  it('rejects a wrong current password (401)', async () => {
    const auth = await login(adminEmail, adminPassword);
    const { accessToken } = auth.json();
    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/users/me/password',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { currentPassword: 'definitely-not-it', newPassword: 'a-new-long-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('invalid_credentials');
  });
});
