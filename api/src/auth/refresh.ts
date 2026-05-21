import { createHash, randomBytes } from 'node:crypto';

const REFRESH_BYTES = 32;

export function refreshTtlSeconds(): number {
  return Number(process.env.JWT_REFRESH_TTL_SEC ?? 60 * 60 * 24 * 30);
}

export function generateRefreshToken(): string {
  return randomBytes(REFRESH_BYTES).toString('base64url');
}

export function hashRefresh(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
