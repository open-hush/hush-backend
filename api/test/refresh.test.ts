import { describe, expect, it } from 'vitest';

import { generateRefreshToken, hashRefresh } from '../src/auth/refresh.js';

describe('refresh tokens', () => {
  it('generates a base64url string of expected length', () => {
    const t = generateRefreshToken();
    // 32 bytes → 43 base64url chars (no padding).
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hash is deterministic SHA-256 hex', () => {
    const t = 'abc';
    expect(hashRefresh(t)).toBe(hashRefresh(t));
    expect(hashRefresh(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different tokens hash to different values', () => {
    expect(hashRefresh('a')).not.toBe(hashRefresh('b'));
  });
});
