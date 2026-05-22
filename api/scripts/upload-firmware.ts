/**
 * Upload a signed firmware build for a given hardware revision.
 *
 *   pnpm run upload-firmware -- \
 *     --hw-rev=r0 --version=0.2.0 \
 *     --bin=./firmware.bin --sig=./firmware.bin.sig \
 *     [--notes="release notes"]
 *
 * The maintainer signs `firmware.bin` offline with the Ed25519 private key.
 * `firmware.bin.sig` carries either the raw 64-byte signature, lowercase hex,
 * or hex with a trailing newline. Anything else is rejected.
 *
 * The script:
 *   1. computes SHA-256 over the binary,
 *   2. uploads the .bin to S3 at `firmware/<hw_rev>/<version>.bin`,
 *   3. inserts a `firmware_releases` row (UNIQUE on hw_rev + version),
 *   4. prints the resulting release id.
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { createDb, createPool } from '../src/db/client.js';
import { createS3Client, putObjectFromBuffer, readS3Config } from '../src/storage/s3.js';

const HW_REV_RE = /^r[0-9]+$/;
const SEMVER_RE = /^[0-9]+\.[0-9]+\.[0-9]+/;
const HEX_RE = /^[0-9a-f]+$/;
const ED25519_SIG_HEX_LEN = 128; // 64 bytes

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const eq = arg.indexOf('=');
    if (!arg.startsWith('--') || eq < 0) {
      throw new Error(`unsupported arg: ${arg} (use --key=value)`);
    }
    return [arg.slice(2, eq), arg.slice(eq + 1)];
  }),
);

function need(key: string): string {
  const v = args[key];
  if (!v) {
    console.error(`--${key}=<value> is required`);
    process.exit(2);
  }
  return v;
}

const hwRev = need('hw-rev');
const version = need('version');
const binPath = need('bin');
const sigPath = need('sig');
const notes = args.notes;

if (!HW_REV_RE.test(hwRev)) {
  console.error(`--hw-rev must match ${HW_REV_RE} (got "${hwRev}")`);
  process.exit(2);
}
if (!SEMVER_RE.test(version)) {
  console.error(`--version must start with X.Y.Z (got "${version}")`);
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const binStat = await stat(binPath);
if (!binStat.isFile() || binStat.size === 0) {
  console.error(`bin file is missing or empty: ${binPath}`);
  process.exit(2);
}
const bin = await readFile(binPath);
const sha256 = createHash('sha256').update(bin).digest('hex');

const sigRaw = (await readFile(sigPath, 'utf8')).trim().toLowerCase();
if (!HEX_RE.test(sigRaw) || sigRaw.length !== ED25519_SIG_HEX_LEN) {
  console.error(
    `sig file must contain exactly ${ED25519_SIG_HEX_LEN} hex chars (Ed25519 signature). got ${sigRaw.length} chars.`,
  );
  process.exit(2);
}

const s3Config = readS3Config();
const s3 = createS3Client(s3Config);
const blobKey = `firmware/${hwRev}/${version}${path.extname(binPath) || '.bin'}`;

await putObjectFromBuffer(s3, s3Config, blobKey, bin, { contentType: 'application/octet-stream' });

const pool = createPool(databaseUrl);
const db = createDb(pool);

try {
  const inserted = await db
    .insertInto('firmware_releases')
    .values({
      hw_rev: hwRev,
      version,
      blob_key: blobKey,
      sha256,
      signature: sigRaw,
      size_bytes: bin.length,
      notes: notes ?? null,
    })
    .returning(['id', 'hw_rev', 'version', 'blob_key', 'released_at'])
    .executeTakeFirstOrThrow();

  console.log(
    JSON.stringify(
      {
        id: inserted.id,
        hwRev: inserted.hw_rev,
        version: inserted.version,
        blobKey: inserted.blob_key,
        sha256,
        sizeBytes: bin.length,
        releasedAt: inserted.released_at.toISOString(),
      },
      null,
      2,
    ),
  );
} finally {
  await db.destroy();
  await pool.end();
}
