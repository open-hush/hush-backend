import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('argon2id password hashing', () => {
  it('round-trips a known password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(hash, 'correct-horse-battery-staple')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct-horse-battery-staple');
    expect(await verifyPassword(hash, 'wrong')).toBe(false);
  });
});
