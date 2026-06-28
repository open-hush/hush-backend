import { randomBytes } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type pg from 'pg';

import { createServer } from '../src/server.js';
import { createDb, createPool } from '../src/db/client.js';
import type { Database, DeviceState } from '../src/db/types.js';
import { hashPassword } from '../src/auth/password.js';
import { canonicalRequest, sign } from '../src/auth/hmac.js';

// Dual-auth registration (OPE-52): a physical device authenticates with
// `deviceHmac`, a user app registers a virtual device with `userJwt`.
// Real end-to-end against the dev Postgres; rows are tagged and cleaned up.
const TAG = `reg-e2e+${Date.now()}`;
const ownerPassword = 'owner-correct-horse-battery';
const otherPassword = 'other-correct-horse-battery';

let app: FastifyInstance;
let db: Kysely<Database>;
let pool: pg.Pool;

let _ownerId: string;
let ownerToken: string;
let otherId: string;
let _otherToken: string;

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

async function seedDevice(opts: {
  serial: string;
  ownerId: string | null;
  state?: DeviceState;
}): Promise<string> {
  const row = await db
    .insertInto('devices')
    .values({ serial: opts.serial, owner_id: opts.ownerId, state: opts.state ?? 'claimed' })
    .returning(['id'])
    .executeTakeFirstOrThrow();
  return row.id;
}

// Provision a physical device: a device row + its baked-in HMAC secret, exactly
// as the factory tooling would. Returns the keyId (= device id) and secret.
async function provisionPhysical(serial: string): Promise<{ id: string; secret: Buffer }> {
  const secret = randomBytes(32);
  const id = await seedDevice({ serial, ownerId: null, state: 'unclaimed' });
  await db.insertInto('device_secrets').values({ device_id: id, secret }).execute();
  return { id, secret };
}

function hmacHeader(keyId: string, secret: Buffer, bodyJson: string): { authorization: string; 'content-type': string } {
  const ts = Math.floor(Date.now() / 1000);
  const canonical = canonicalRequest({
    method: 'POST',
    path: '/v1/device/register',
    query: undefined,
    ts,
    body: bodyJson,
  });
  const signature = sign(secret, canonical);
  return {
    authorization: `HMAC keyId=${keyId},signature=${signature},ts=${ts}`,
    'content-type': 'application/json',
  };
}

beforeAll(async () => {
  process.env.JWT_SIGNING_KEY = 'x'.repeat(32);
  process.env.METRICS_ENABLED = 'false';
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://hush:hush@localhost:5432/hush';
  pool = createPool(databaseUrl);
  db = createDb(pool);
  app = await createServer({ db, skipStorage: true });

  _ownerId = await seedUser(`${TAG}-owner@test.local`, ownerPassword);
  otherId = await seedUser(`${TAG}-other@test.local`, otherPassword);
  ownerToken = await login(`${TAG}-owner@test.local`, ownerPassword);
  _otherToken = await login(`${TAG}-other@test.local`, otherPassword);
});

afterAll(async () => {
  // device_secrets cascade-delete with their device.
  await db.deleteFrom('devices').where('serial', 'like', `${TAG}-%`).execute();
  await db.deleteFrom('users').where('email', 'like', `${TAG}-%`).execute();
  await app.close();
  await pool.end();
});

describe('POST /v1/device/register — physical device (deviceHmac)', () => {
  it('registers an unclaimed device and returns a claim code', async () => {
    const serial = `${TAG}-phys-ok`;
    const { id, secret } = await provisionPhysical(serial);
    const body = JSON.stringify({ serial, firmwareVersion: '1.4.2' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      headers: hmacHeader(id, secret, body),
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.device.id).toBe(id);
    expect(json.device.serial).toBe(serial);
    expect(json.device.state).toBe('unclaimed');
    expect(json.device.firmwareVersion).toBe('1.4.2');
    expect(typeof json.claimCode).toBe('string');
  });

  it('422s when the body serial does not match the signing device', async () => {
    const serial = `${TAG}-phys-mismatch`;
    const { id, secret } = await provisionPhysical(serial);
    const body = JSON.stringify({ serial: `${TAG}-phys-wrong`, firmwareVersion: '1.0.0' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      headers: hmacHeader(id, secret, body),
      payload: body,
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('serial_mismatch');
  });

  it('ignores `virtual` for an HMAC caller (treated as physical)', async () => {
    const serial = `${TAG}-phys-virtflag`;
    const { id, secret } = await provisionPhysical(serial);
    const body = JSON.stringify({ serial, firmwareVersion: '1.0.0', virtual: true });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      headers: hmacHeader(id, secret, body),
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().device.id).toBe(id);
  });
});

describe('POST /v1/device/register — virtual device (userJwt)', () => {
  it('creates a new unclaimed virtual device with no owner and a claim code', async () => {
    const serial = `${TAG}-virt-new`;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      headers: auth(ownerToken),
      payload: { serial, firmwareVersion: 'app-2.0.0', virtual: true },
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.device.serial).toBe(serial);
    expect(json.device.state).toBe('unclaimed');
    expect(json.device.ownerId == null).toBe(true);
    expect(typeof json.claimCode).toBe('string');

    const row = await db
      .selectFrom('devices')
      .select(['owner_id', 'state', 'firmware_version'])
      .where('serial', '=', serial)
      .executeTakeFirstOrThrow();
    expect(row.owner_id).toBe(null);
    expect(row.state).toBe('unclaimed');
    expect(row.firmware_version).toBe('app-2.0.0');
  });

  it('is idempotent on serial: re-registering returns the same device', async () => {
    const serial = `${TAG}-virt-idem`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      headers: auth(ownerToken),
      payload: { serial, firmwareVersion: 'app-1.0.0', virtual: true },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      headers: auth(ownerToken),
      payload: { serial, firmwareVersion: 'app-1.0.1', virtual: true },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().device.id).toBe(first.json().device.id);
    expect(second.json().device.firmwareVersion).toBe('app-1.0.1');
  });

  it('422s when `virtual` is not true for a user caller', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      headers: auth(ownerToken),
      payload: { serial: `${TAG}-virt-flagless`, firmwareVersion: 'app-1.0.0' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('virtual_required');
  });

  it('422s when the serial belongs to a physical device (no hijack)', async () => {
    const serial = `${TAG}-virt-vs-phys`;
    await provisionPhysical(serial);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      headers: auth(ownerToken),
      payload: { serial, firmwareVersion: 'app-1.0.0', virtual: true },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('serial_taken');
  });

  it("422s when the serial is claimed by another user", async () => {
    const serial = `${TAG}-virt-vs-other`;
    await seedDevice({ serial, ownerId: otherId, state: 'claimed' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      headers: auth(ownerToken),
      payload: { serial, firmwareVersion: 'app-1.0.0', virtual: true },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('serial_taken');
  });

  it('401s without any authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/device/register',
      payload: { serial: `${TAG}-virt-noauth`, firmwareVersion: 'app-1.0.0', virtual: true },
    });
    expect(res.statusCode).toBe(401);
  });
});
