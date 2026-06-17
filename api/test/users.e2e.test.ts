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

// POST /v1/users/register is admin-only (OPE-28, aligned with hush-protocol):
// it requires an admin JWT, never logs the new account in, and returns the
// created user's profile rather than tokens.
describe('admin-only registration', () => {
  const userEmail = `${TAG}-plainuser@test.local`;
  const userPassword = 'plain-user-correct-horse';
  let adminToken: string;
  let userToken: string;

  const register = (payload: unknown, token?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/users/register',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
      payload,
    });

  beforeAll(async () => {
    // Seed a plain (non-admin) user so we can assert the 403 path, then grab a
    // token for each role via login.
    await db
      .insertInto('users')
      .values({
        email: userEmail,
        password_hash: await hashPassword(userPassword),
        display_name: 'Plain user',
        role: 'user',
      })
      .execute();
    adminToken = (await login(adminEmail, adminPassword)).json().accessToken;
    userToken = (await login(userEmail, userPassword)).json().accessToken;
  });

  it('lets an admin create a non-admin user and returns the profile (no tokens)', async () => {
    const email = `${TAG}-created@test.local`;
    const res = await register(
      { email, password: 'a-perfectly-long-password', displayName: 'New customer' },
      adminToken,
    );

    expect(res.statusCode).toBe(201);
    const body = res.json();
    // The response is the created user's profile — NOT a token pair, and the
    // new account is not logged in.
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(body.id).toBeTruthy();
    expect(body.email).toBe(email);
    expect(body.displayName).toBe('New customer');
    expect(body.role).toBe('user');
    expect(body.createdAt).toBeTruthy();

    // The created account can still log in afterwards with its own credentials.
    expect((await login(email, 'a-perfectly-long-password')).statusCode).toBe(200);
  });

  it('never mints an admin even if a role is supplied in the body', async () => {
    const email = `${TAG}-sneaky@test.local`;
    const res = await register(
      // `role` is not part of the schema; it must be ignored, not honoured.
      { email, password: 'a-perfectly-long-password', role: 'admin' },
      adminToken,
    );
    expect(res.statusCode).toBe(201);
    expect(res.json().role).toBe('user');
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await register({
      email: `${TAG}-anon@test.local`,
      password: 'a-perfectly-long-password',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthorized');
  });

  it('rejects an authenticated non-admin with 403', async () => {
    const res = await register(
      { email: `${TAG}-byuser@test.local`, password: 'a-perfectly-long-password' },
      userToken,
    );
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('forbidden');
  });

  it('returns 409 when the email is already in use', async () => {
    const res = await register({ email: adminEmail, password: 'another-long-password' }, adminToken);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('email_taken');
  });

  it('returns 422 when the password is too short', async () => {
    const res = await register(
      { email: `${TAG}-weak@test.local`, password: 'short' },
      adminToken,
    );
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('validation_failed');
  });

  it('admin accounts keep role=admin through login → /me', async () => {
    const profile = await me(adminToken);
    expect(profile.json().role).toBe('admin');
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
