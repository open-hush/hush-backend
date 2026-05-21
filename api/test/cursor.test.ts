import { describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor } from '../src/util/cursor.js';

describe('audio cursor', () => {
  it('round-trips through base64url', () => {
    const c = { createdAt: '2026-05-21T10:00:00.000Z', id: '11111111-1111-1111-1111-111111111111' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('returns null for garbage input', () => {
    expect(decodeCursor('not a cursor')).toBeNull();
    expect(decodeCursor('')).toBeNull();
    expect(decodeCursor(Buffer.from('{"id":"x"}').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('{"createdAt":"not-a-date","id":"x"}').toString('base64url'))).toBeNull();
  });

  it('produces url-safe characters only', () => {
    const c = { createdAt: new Date().toISOString(), id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    expect(encodeCursor(c)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
