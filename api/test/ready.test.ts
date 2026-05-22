import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../src/server.js';
import type { Database } from '../src/db/types.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.JWT_SIGNING_KEY = 'x'.repeat(32);
  process.env.METRICS_ENABLED = 'false'; // prom-client registers global counters; skip in tests.
  const db = new Kysely<Database>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  app = await createServer({ db, skipStorage: true });
});

afterAll(async () => {
  await app.close();
});

describe('GET /v1/ready', () => {
  it('returns 200 with status=ok when only the DB check runs (no S3)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
    // S3 is skipped via skipStorage=true.
    expect(body.checks.objectStorage).toBeUndefined();
  });
});
