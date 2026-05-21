import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';

import type { Database } from './types.js';

const { Pool, types } = pg;

types.setTypeParser(1184, (val) => new Date(val));
types.setTypeParser(1114, (val) => new Date(val));
// Parse BIGINT as Number. Audio sizes etc. stay well below 2^53.
types.setTypeParser(20, (val) => (val === null ? null : Number(val)));

export function createPool(databaseUrl: string): pg.Pool {
  return new Pool({
    connectionString: databaseUrl,
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
  });
}

export function createDb(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
  });
}
