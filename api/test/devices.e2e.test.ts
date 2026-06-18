import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type pg from 'pg';

import { createServer } from '../src/server.js';
import { createDb, createPool } from '../src/db/client.js';
import type { Database, DeviceState } from '../src/db/types.js';
import { hashPassword } from '../src/auth/password.js';

// Real end-to-end against a live Postgres (the dev stack from `make services`).
// No transactional-rollback harness yet: we tag every row we create with a
// unique prefix and delete them in afterAll. Devices cascade-clean their own
// children (configs, bindings) is not relied upon here — we only seed devices.
const TAG = `dev-e2e+${Date.now()}`;
const ownerPassword = 'owner-correct-horse-battery';
const otherPassword = 'other-correct-horse-battery';

let app: FastifyInstance;
let db: Kysely<Database>;
let pool: pg.Pool;

let ownerToken: string;
let otherToken: string;

async function login(email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/users/login',
    payload: { email, password },
  });
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

async function seedDevice(opts: {
  serial: string;
  ownerId: string | null;
  name?: string | null;
  state?: DeviceState;
}): Promise<string> {
  const row = await db
    .insertInto('devices')
    .values({
      serial: opts.serial,
      owner_id: opts.ownerId,
      name: opts.name ?? null,
      state: opts.state ?? 'claimed',
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return row.id;
}

let ownerId: string;
let otherId: string;

beforeAll(async () => {
  process.env.JWT_SIGNING_KEY = 'x'.repeat(32);
  process.env.METRICS_ENABLED = 'false';
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://hush:hush@localhost:5432/hush';
  pool = createPool(databaseUrl);
  db = createDb(pool);
  app = await createServer({ db, skipStorage: true });

  ownerId = await seedUser(`${TAG}-owner@test.local`, ownerPassword);
  otherId = await seedUser(`${TAG}-other@test.local`, otherPassword);
  ownerToken = await login(`${TAG}-owner@test.local`, ownerPassword);
  otherToken = await login(`${TAG}-other@test.local`, otherPassword);
});

afterAll(async () => {
  await db.deleteFrom('devices').where('serial', 'like', `${TAG}-%`).execute();
  await db.deleteFrom('users').where('email', 'like', `${TAG}-%`).execute();
  await app.close();
  await pool.end();
});

describe('GET /v1/devices (list, owner-scoped)', () => {
  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/devices' });
    expect(res.statusCode).toBe(401);
  });

  it('returns only the caller-owned, non-retired devices', async () => {
    const mine = await seedDevice({ serial: `${TAG}-list-mine`, ownerId, name: 'Mine' });
    const theirs = await seedDevice({ serial: `${TAG}-list-theirs`, ownerId: otherId, name: 'Theirs' });
    const retired = await seedDevice({ serial: `${TAG}-list-retired`, ownerId, state: 'retired' });

    const res = await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(ownerToken) });
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((d: { id: string }) => d.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs); // not visible to this owner
    expect(ids).not.toContain(retired); // retired devices drop out of the list
  });
});

describe('GET /v1/devices/:id (read, ownership)', () => {
  it('returns the owner-scoped device', async () => {
    const id = await seedDevice({ serial: `${TAG}-get-mine`, ownerId, name: 'Box' });
    const res = await app.inject({ method: 'GET', url: `/v1/devices/${id}`, headers: auth(ownerToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(id);
    expect(res.json().name).toBe('Box');
  });

  it("404s on another user's device (no IDOR, no existence leak)", async () => {
    const id = await seedDevice({ serial: `${TAG}-get-theirs`, ownerId: otherId });
    const res = await app.inject({ method: 'GET', url: `/v1/devices/${id}`, headers: auth(ownerToken) });
    expect(res.statusCode).toBe(404);
  });

  it('404s on a retired device', async () => {
    const id = await seedDevice({ serial: `${TAG}-get-retired`, ownerId, state: 'retired' });
    const res = await app.inject({ method: 'GET', url: `/v1/devices/${id}`, headers: auth(ownerToken) });
    expect(res.statusCode).toBe(404);
  });
});

describe('PATCH /v1/devices/:id (rename)', () => {
  it('renames the caller-owned device', async () => {
    const id = await seedDevice({ serial: `${TAG}-patch-mine`, ownerId, name: 'Old' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/devices/${id}`,
      headers: auth(ownerToken),
      payload: { name: 'New name' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('New name');
  });

  it('clears the name when null is sent', async () => {
    const id = await seedDevice({ serial: `${TAG}-patch-clear`, ownerId, name: 'Has name' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/devices/${id}`,
      headers: auth(ownerToken),
      payload: { name: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name == null).toBe(true);
  });

  it("404s when patching another user's device (ownership enforced)", async () => {
    const id = await seedDevice({ serial: `${TAG}-patch-theirs`, ownerId: otherId, name: 'Theirs' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/devices/${id}`,
      headers: auth(ownerToken),
      payload: { name: 'hijack' },
    });
    expect(res.statusCode).toBe(404);

    // The victim's device is untouched.
    const check = await app.inject({ method: 'GET', url: `/v1/devices/${id}`, headers: auth(otherToken) });
    expect(check.json().name).toBe('Theirs');
  });

  it('422s on an unknown field (strict body)', async () => {
    const id = await seedDevice({ serial: `${TAG}-patch-strict`, ownerId });
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/devices/${id}`,
      headers: auth(ownerToken),
      payload: { state: 'retired' }, // not a mutable field
    });
    expect(res.statusCode).toBe(422);
  });

  it('requires authentication', async () => {
    const id = await seedDevice({ serial: `${TAG}-patch-noauth`, ownerId });
    const res = await app.inject({ method: 'PATCH', url: `/v1/devices/${id}`, payload: { name: 'x' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('DELETE /v1/devices/:id (retire)', () => {
  it('retires the caller-owned device and removes it from the list', async () => {
    const id = await seedDevice({ serial: `${TAG}-del-mine`, ownerId, name: 'ToRetire' });

    const del = await app.inject({ method: 'DELETE', url: `/v1/devices/${id}`, headers: auth(ownerToken) });
    expect(del.statusCode).toBe(204);

    // Gone from the list and from GET.
    const list = await app.inject({ method: 'GET', url: '/v1/devices', headers: auth(ownerToken) });
    expect(list.json().items.map((d: { id: string }) => d.id)).not.toContain(id);
    const get = await app.inject({ method: 'GET', url: `/v1/devices/${id}`, headers: auth(ownerToken) });
    expect(get.statusCode).toBe(404);

    // Ownership survives (recoverable by support): the row is still owned.
    const row = await db
      .selectFrom('devices')
      .select(['owner_id', 'state'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    expect(row.owner_id).toBe(ownerId);
    expect(row.state).toBe('retired');
  });

  it('is idempotent-safe: a second delete 404s', async () => {
    const id = await seedDevice({ serial: `${TAG}-del-twice`, ownerId });
    expect((await app.inject({ method: 'DELETE', url: `/v1/devices/${id}`, headers: auth(ownerToken) })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/v1/devices/${id}`, headers: auth(ownerToken) })).statusCode).toBe(404);
  });

  it("404s when deleting another user's device (ownership enforced)", async () => {
    const id = await seedDevice({ serial: `${TAG}-del-theirs`, ownerId: otherId });
    const res = await app.inject({ method: 'DELETE', url: `/v1/devices/${id}`, headers: auth(ownerToken) });
    expect(res.statusCode).toBe(404);

    // Still alive for its real owner.
    const check = await app.inject({ method: 'GET', url: `/v1/devices/${id}`, headers: auth(otherToken) });
    expect(check.statusCode).toBe(200);
  });

  it('requires authentication', async () => {
    const id = await seedDevice({ serial: `${TAG}-del-noauth`, ownerId });
    const res = await app.inject({ method: 'DELETE', url: `/v1/devices/${id}` });
    expect(res.statusCode).toBe(401);
  });
});

// Dual auth: a user app (userJwt) can drive a device it owns by passing
// `device_id`, alongside the existing physical-device HMAC flow (OPE-32).
describe('POST /v1/device/events (userJwt acting as device)', () => {
  function oneEvent() {
    return {
      events: [
        {
          eventId: randomUUID(),
          ts: new Date().toISOString(),
          type: 'button_pressed' as const,
        },
      ],
    };
  }

  it('accepts events for a claimed device owned by the caller', async () => {
    const id = await seedDevice({ serial: `${TAG}-evt-ok`, ownerId, state: 'claimed' });
    const body = oneEvent();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/device/events?device_id=${id}`,
      headers: auth(ownerToken),
      payload: body,
    });
    expect(res.statusCode).toBe(202);

    const row = await db
      .selectFrom('device_events')
      .select(['device_id'])
      .where('event_id', '=', body.events[0]!.eventId)
      .executeTakeFirst();
    expect(row?.device_id).toBe(id);
  });

  it('400s when device_id is missing for a user caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/events',
      headers: auth(ownerToken),
      payload: oneEvent(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('device_id_required');
  });

  it("403s on another user's device (no IDOR)", async () => {
    const id = await seedDevice({ serial: `${TAG}-evt-other`, ownerId: otherId, state: 'claimed' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/device/events?device_id=${id}`,
      headers: auth(ownerToken),
      payload: oneEvent(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('device_forbidden');
  });

  it('403s on an unclaimed device even when owned', async () => {
    const id = await seedDevice({ serial: `${TAG}-evt-unclaimed`, ownerId, state: 'unclaimed' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/device/events?device_id=${id}`,
      headers: auth(ownerToken),
      payload: oneEvent(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('403s on an unknown device_id (no existence leak)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/device/events?device_id=${randomUUID()}`,
      headers: auth(ownerToken),
      payload: oneEvent(),
    });
    expect(res.statusCode).toBe(403);
  });

  it('401s without any authentication', async () => {
    const id = await seedDevice({ serial: `${TAG}-evt-noauth`, ownerId, state: 'claimed' });
    const res = await app.inject({
      method: 'POST',
      url: `/v1/device/events?device_id=${id}`,
      payload: oneEvent(),
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/device/sync (userJwt acting as device — auth gate)', () => {
  it('400s when device_id is missing for a user caller', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/device/sync', headers: auth(ownerToken) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('device_id_required');
  });

  it("403s on another user's device", async () => {
    const id = await seedDevice({ serial: `${TAG}-sync-other`, ownerId: otherId, state: 'claimed' });
    const res = await app.inject({
      method: 'GET',
      url: `/v1/device/sync?device_id=${id}`,
      headers: auth(ownerToken),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('device_forbidden');
  });

  it('401s without any authentication', async () => {
    const res = await app.inject({ method: 'GET', url: `/v1/device/sync?device_id=${randomUUID()}` });
    expect(res.statusCode).toBe(401);
  });
});
