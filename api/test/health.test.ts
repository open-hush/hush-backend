import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kysely, DummyDriver, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler } from 'kysely';
import type { FastifyInstance } from 'fastify';

import { createServer } from '../src/server.js';
import type { Database } from '../src/db/types.js';

let app: FastifyInstance;

beforeAll(async () => {
  process.env.JWT_SIGNING_KEY = 'x'.repeat(32);
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

describe('GET /v1/health', () => {
  it('returns status ok and the package version', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});
