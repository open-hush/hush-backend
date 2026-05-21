/**
 * Pre-provision a device row + its HMAC secret. Simulates what the factory
 * tooling will do in production. Prints the values the firmware needs baked
 * into NVS (device id, serial, secret as hex).
 *
 *   pnpm run provision-device -- --serial=DEV001
 */
import { randomBytes } from 'node:crypto';

import { createDb, createPool } from '../src/db/client.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      throw new Error(`unsupported arg: ${arg} (use --key=value)`);
    }
    return [arg.slice(2, eq), arg.slice(eq + 1)];
  }),
);

const serial = args.serial;
if (!serial) {
  console.error('--serial=<value> is required');
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const pool = createPool(databaseUrl);
const db = createDb(pool);

try {
  const secret = randomBytes(32);
  const device = await db
    .insertInto('devices')
    .values({ serial })
    .returning(['id', 'serial'])
    .executeTakeFirstOrThrow();
  await db.insertInto('device_secrets').values({ device_id: device.id, secret }).execute();

  console.log(
    JSON.stringify(
      {
        deviceId: device.id,
        serial: device.serial,
        secretHex: secret.toString('hex'),
      },
      null,
      2,
    ),
  );
} finally {
  await db.destroy();
  await pool.end();
}
