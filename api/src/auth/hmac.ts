import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { createDb, createPool } from '../db/client.js';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

const EMPTY_BODY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const HEADER_RE = /^HMAC\s+(.+)$/i;

export interface HmacHeader {
  keyId: string;
  signature: string;
  ts: number;
}

export function parseHmacHeader(header: string): HmacHeader {
  const match = HEADER_RE.exec(header);
  if (!match) throw new Error('malformed HMAC header');
  const params: Record<string, string> = {};
  for (const part of match[1]!.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new Error('malformed HMAC header');
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key || !value) throw new Error('malformed HMAC header');
    params[key] = value;
  }
  const keyId = params.keyId;
  const signature = params.signature;
  const tsRaw = params.ts;
  if (!keyId || !signature || !tsRaw) throw new Error('malformed HMAC header');
  const ts = Number(tsRaw);
  if (!Number.isInteger(ts)) throw new Error('malformed HMAC header');
  return { keyId, signature, ts };
}

export function canonicalRequest(args: {
  method: string;
  path: string;
  query: URLSearchParams | string | undefined;
  ts: number;
  body: Buffer | string | undefined;
}): string {
  const method = args.method.toUpperCase();
  const path = canonicalPath(args.path, args.query);
  const bodyBuf =
    args.body === undefined
      ? Buffer.alloc(0)
      : typeof args.body === 'string'
        ? Buffer.from(args.body, 'utf8')
        : args.body;
  const bodyHash =
    bodyBuf.length === 0 ? EMPTY_BODY_SHA256 : createHash('sha256').update(bodyBuf).digest('hex');
  return `${method}\n${path}\n${args.ts}\n${bodyHash}`;
}

function canonicalPath(rawPath: string, query: URLSearchParams | string | undefined): string {
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  const params = normalizeQuery(query);
  if (params.length === 0) return path;
  const sorted = params
    .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${path}?${sorted.map(([k, v]) => `${k}=${v}`).join('&')}`;
}

function normalizeQuery(query: URLSearchParams | string | undefined): Array<[string, string]> {
  if (!query) return [];
  if (query instanceof URLSearchParams) return [...query.entries()];
  const trimmed = query.startsWith('?') ? query.slice(1) : query;
  if (!trimmed) return [];
  return [...new URLSearchParams(trimmed).entries()];
}

export function sign(secret: Buffer, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifySignature(secret: Buffer, canonical: string, signature: string): boolean {
  const expected = Buffer.from(sign(secret, canonical), 'hex');
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(expected, provided);
}

declare module 'fastify' {
  interface FastifyInstance {
    requireDevice: (req: FastifyRequest) => Promise<void>;
  }
  interface FastifyRequest {
    device?: { id: string };
  }
}

interface HmacPluginOptions {
  loadSecret: (deviceId: string) => Promise<Buffer | null>;
  clockSkewSec?: number;
  now?: () => number;
}

const plugin: FastifyPluginAsync<HmacPluginOptions> = async (app, opts) => {
  const clockSkewSec = opts.clockSkewSec ?? Number(process.env.HMAC_CLOCK_SKEW_SEC ?? 300);
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));

  app.decorate('requireDevice', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header) throw app.httpErrors.unauthorized('missing authorization');

    let parsed: HmacHeader;
    try {
      parsed = parseHmacHeader(header);
    } catch {
      throw app.httpErrors.unauthorized('unauthorized');
    }

    const drift = Math.abs(now() - parsed.ts);
    if (drift > clockSkewSec) {
      throw app.httpErrors.unauthorized('expired_token');
    }

    const secret = await opts.loadSecret(parsed.keyId);
    if (!secret) throw app.httpErrors.unauthorized('unauthorized');

    const url = new URL(req.url, 'http://x');
    const canonical = canonicalRequest({
      method: req.method,
      path: url.pathname,
      query: url.searchParams,
      ts: parsed.ts,
      body: req.rawBody,
    });

    if (!verifySignature(secret, canonical, parsed.signature)) {
      throw app.httpErrors.unauthorized('invalid_signature');
    }

    req.device = { id: parsed.keyId };
  });
};

export const hmacPlugin = fp(plugin, { name: 'hush-hmac' });

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
  }
}

export function loadSecretFromDb(db: Kysely<Database>) {
  return async (deviceId: string): Promise<Buffer | null> => {
    if (!/^[0-9a-f-]{36}$/.test(deviceId)) return null;
    const row = await db
      .selectFrom('device_secrets')
      .select(['secret'])
      .where('device_id', '=', deviceId)
      .executeTakeFirst();
    return row?.secret ?? null;
  };
}

// Re-exported for callers that build the secret loader outside the plugin
// (e.g. tests). Keeps the plugin agnostic of how the secret is fetched.
export type LoadSecret = HmacPluginOptions['loadSecret'];

export { createPool, createDb };
