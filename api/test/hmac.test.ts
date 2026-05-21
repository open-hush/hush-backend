import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';

import {
  canonicalRequest,
  parseHmacHeader,
  sign,
  verifySignature,
} from '../src/auth/hmac.js';

describe('HMAC canonical request', () => {
  it('formats path, sorted query, ts and body sha', () => {
    const c = canonicalRequest({
      method: 'post',
      path: '/v1/device/register',
      query: undefined,
      ts: 1716290000,
      body: '{"serial":"ABC"}',
    });
    expect(c).toBe(
      [
        'POST',
        '/v1/device/register',
        '1716290000',
        // sha256('{"serial":"ABC"}')
        '4ab5335fc428dd5acb18e99a9c531408017a472feb6fc5ce1e382723678083e8',
      ].join('\n'),
    );
  });

  it('hashes empty body to the standard empty-sha256', () => {
    const c = canonicalRequest({
      method: 'GET',
      path: '/v1/device/sync',
      query: undefined,
      ts: 1,
      body: undefined,
    });
    expect(c.endsWith('\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')).toBe(true);
  });

  it('sorts query params lexicographically and url-encodes them', () => {
    const c = canonicalRequest({
      method: 'GET',
      path: '/v1/device/sync',
      query: new URLSearchParams([
        ['since', '2024-01-01T00:00:00Z'],
        ['a', 'b'],
      ]),
      ts: 100,
      body: undefined,
    });
    expect(c.split('\n')[1]).toBe('/v1/device/sync?a=b&since=2024-01-01T00%3A00%3A00Z');
  });

  it('drops the question mark when there are no params', () => {
    const c = canonicalRequest({
      method: 'GET',
      path: '/v1/device/sync',
      query: '',
      ts: 100,
      body: undefined,
    });
    expect(c.split('\n')[1]).toBe('/v1/device/sync');
  });
});

describe('HMAC sign / verify', () => {
  it('round-trips with the same secret', () => {
    const secret = randomBytes(32);
    const canonical = 'POST\n/v1/device/register\n1716290000\nfeed';
    const sig = sign(secret, canonical);
    expect(verifySignature(secret, canonical, sig)).toBe(true);
  });

  it('rejects a tampered signature', () => {
    const secret = randomBytes(32);
    const canonical = 'POST\n/v1/device/register\n1716290000\nfeed';
    const sig = sign(secret, canonical);
    const flipped = `${sig.slice(0, -1)}${sig.endsWith('0') ? '1' : '0'}`;
    expect(verifySignature(secret, canonical, flipped)).toBe(false);
  });

  it('rejects a different secret', () => {
    const canonical = 'POST\n/v1/device/register\n1716290000\nfeed';
    const sig = sign(randomBytes(32), canonical);
    expect(verifySignature(randomBytes(32), canonical, sig)).toBe(false);
  });

  it('rejects non-hex signatures gracefully', () => {
    const secret = randomBytes(32);
    expect(verifySignature(secret, 'whatever', 'not-hex')).toBe(false);
  });
});

describe('HMAC header parsing', () => {
  it('extracts keyId, signature and ts', () => {
    const parsed = parseHmacHeader('HMAC keyId=abc,signature=deadbeef,ts=42');
    expect(parsed.keyId).toBe('abc');
    expect(parsed.signature).toBe('deadbeef');
    expect(parsed.ts).toBe(42);
  });

  it('tolerates whitespace and accepts arbitrary param order', () => {
    const parsed = parseHmacHeader('HMAC  ts=42 , keyId=abc, signature=deadbeef');
    expect(parsed).toEqual({ keyId: 'abc', signature: 'deadbeef', ts: 42 });
  });

  it('rejects missing scheme', () => {
    expect(() => parseHmacHeader('Bearer xyz')).toThrow();
  });

  it('rejects missing fields', () => {
    expect(() => parseHmacHeader('HMAC keyId=abc')).toThrow();
  });
});
