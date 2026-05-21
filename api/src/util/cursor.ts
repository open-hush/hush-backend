/**
 * Opaque cursor encoding for `(created_at, id)` keyset pagination. Encoded as
 * base64url(JSON). Clients must not decode it; we treat it as opaque on the
 * wire even though it's not encrypted (a tampered cursor only affects the
 * tamperer's own paging).
 */
export interface AudioCursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(cursor: AudioCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(value: string): AudioCursor | null {
  try {
    const json = Buffer.from(value, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as Partial<AudioCursor>;
    if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') return null;
    if (Number.isNaN(Date.parse(parsed.createdAt))) return null;
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    return null;
  }
}
