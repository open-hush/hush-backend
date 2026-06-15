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
  return app.inject({ method: 'POST', url: '/v1/users/login', payload: { email, password } });
}

async function me(accessToken: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/users/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

beforeAll(async () => {
  process.env.JWT_SIGNING_KEY = 'x'.repeat(32);
  process.env.METRICS_ENABLED = 'false';
  delete process.env.DISABLE_PUBLIC_REGISTRATION;
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://hush:hush@localhost:5432/hush';
  pool = createPool(databaseUrl);
  db = createDb(pool);
  app = await createServer({ db, skipStorage: true });

  // Seed an admin account directly so we can assert the admin role flows
  // through login → token → /me without relying on the bootstrap seed.
  await db
    .insertInto('users')
    .values({
      email: adminEmail,
      password_hash: await hashPassword(adminPassword),
      display_name: 'E2E admin',
      role: 'admin',
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

describe('public self-registration', () => {
  it('creates a non-admin user, logs them in, and exposes role=user on /me', async () => {
    const email = `${TAG}-signup@test.local`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/register',
      payload: { email, password: 'a-perfectly-long-password', displayName: 'New customer' },
    });

    expect(res.statusCode).toBe(201);
    const tokens = res.json();
    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresIn).toBeGreaterThan(0);

    // The session works and the new account is a plain user — never an admin.
    const profile = await me(tokens.accessToken);
    expect(profile.statusCode).toBe(200);
    expect(profile.json().email).toBe(email);
    expect(profile.json().role).toBe('user');

    // The same credentials log in afterwards.
    expect((await login(email, 'a-perfectly-long-password')).statusCode).toBe(200);
  });

  it('cannot escalate to admin even if a role is supplied in the body', async () => {
    const email = `${TAG}-sneaky@test.local`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/register',
      // `role` is not part of the schema; it must be ignored, not honoured.
      payload: { email, password: 'a-perfectly-long-password', role: 'admin' },
    });
    expect(res.statusCode).toBe(201);
    const profile = await me(res.json().accessToken);
    expect(profile.json().role).toBe('user');
  });

  it('returns 409 when the email is already in use', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/register',
      payload: { email: adminEmail, password: 'another-long-password' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('email_taken');
  });

  it('returns 422 when the password is too short', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/register',
      payload: { email: `${TAG}-weak@test.local`, password: 'short' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('validation_failed');
  });

  it('admin accounts keep role=admin through login → /me', async () => {
    const auth = await login(adminEmail, adminPassword);
    expect(auth.statusCode).toBe(200);
    const profile = await me(auth.json().accessToken);
    expect(profile.json().role).toBe('admin');
  });
});

describe('public self-registration disabled', () => {
  let lockedApp: FastifyInstance;

  beforeAll(async () => {
    process.env.DISABLE_PUBLIC_REGISTRATION = 'true';
    lockedApp = await createServer({ db, skipStorage: true });
  });

  afterAll(async () => {
    await lockedApp.close();
    delete process.env.DISABLE_PUBLIC_REGISTRATION;
  });

  it('returns 403 registration_disabled', async () => {
    const res = await lockedApp.inject({
      method: 'POST',
      url: '/v1/users/register',
      payload: { email: `${TAG}-locked@test.local`, password: 'a-perfectly-long-password' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('registration_disabled');
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
