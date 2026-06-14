import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FastifyBaseLogger } from 'fastify';
import type { Kysely } from 'kysely';

import type { Database } from '../db/types.js';
import { hashPassword } from './password.js';

const DEFAULT_ADMIN_EMAIL = 'admin@hush.local';

/**
 * Seed the first user on a fresh install so the operator can reach the
 * dashboard without hand-crafting a row.
 *
 * Idempotent: it no-ops the moment `users` holds any row, so it is safe to run
 * on every boot. There is deliberately **no hardcoded default credential** — a
 * known default password is how self-hosted devices get mass-compromised.
 *
 * The initial password is never written to the structured logger: that stream
 * is forwarded to log aggregation in prod, where a plaintext secret would be
 * indexed and retained. Instead:
 *   - if `BOOTSTRAP_ADMIN_PASSWORD` is set, that value is used and no secret is
 *     emitted anywhere;
 *   - otherwise a random password (hashed with Argon2id) is written to an
 *     operator-only file (mode 0600, `BOOTSTRAP_ADMIN_PASSWORD_FILE`, default
 *     `initial-admin-password.txt` in the cwd). The operator reads it, logs in,
 *     changes the password, and deletes the file.
 *
 * `BOOTSTRAP_ADMIN_EMAIL` overrides the login email (defaults to
 * `admin@hush.local`).
 */
export async function bootstrapFirstAdmin(
  db: Kysely<Database>,
  log: FastifyBaseLogger,
): Promise<void> {
  const existing = await db
    .selectFrom('users')
    .select('id')
    .limit(1)
    .executeTakeFirst();
  if (existing) return;

  const email = process.env.BOOTSTRAP_ADMIN_EMAIL ?? DEFAULT_ADMIN_EMAIL;
  const supplied = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const password = supplied ?? randomBytes(18).toString('base64url');

  // When the password is generated, hand it to the operator via a 0600 file —
  // never the structured logger. Write it *before* creating the account so a
  // write failure can't leave an admin row whose password is unrecoverable.
  let passwordFile: string | undefined;
  if (!supplied) {
    passwordFile = resolve(
      process.env.BOOTSTRAP_ADMIN_PASSWORD_FILE ?? 'initial-admin-password.txt',
    );
    writeFileSync(passwordFile, `email:    ${email}\npassword: ${password}\n`, {
      mode: 0o600,
      flag: 'w',
    });
  }

  const password_hash = await hashPassword(password);

  await db
    .insertInto('users')
    .values({ email, password_hash, display_name: 'Hush admin' })
    .execute();

  if (supplied) {
    log.warn(
      { email },
      'Hush: created the first admin account on this fresh install using ' +
        'BOOTSTRAP_ADMIN_PASSWORD. Log in to the dashboard and rotate it.',
    );
  } else {
    log.warn(
      { email, passwordFile },
      'Hush: created the first admin account on this fresh install. The ' +
        `one-time password was written to ${passwordFile} (mode 0600). Read ` +
        'it, log in to the dashboard, change the password, then delete that file.',
    );
  }
}
