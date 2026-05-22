import { describe, expect, it } from 'vitest';

import {
  CardBindingRequestSchema,
  DeviceEventsRequestSchema,
  DeviceSyncResponseSchema,
  FirmwareLatestQuerySchema,
  FirmwareManifestSchema,
} from '../src/schemas.js';

describe('phase 3 schemas', () => {
  it('CardBindingRequest accepts lowercase hex UIDs of 8-20 chars', () => {
    expect(CardBindingRequestSchema.safeParse({ uid: '04a1b2c3', audioId: '00000000-0000-4000-8000-000000000001' }).success).toBe(true);
    expect(CardBindingRequestSchema.safeParse({ uid: '04A1B2C3', audioId: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
    expect(CardBindingRequestSchema.safeParse({ uid: '04', audioId: '00000000-0000-4000-8000-000000000001' }).success).toBe(false);
  });

  it('DeviceEventsRequest rejects empty event arrays', () => {
    expect(DeviceEventsRequestSchema.safeParse({ events: [] }).success).toBe(false);
  });

  it('DeviceEventsRequest accepts up to 200 events', () => {
    const events = Array.from({ length: 200 }, (_, i) => ({
      eventId: `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`,
      ts: new Date().toISOString(),
      type: 'card_scanned' as const,
    }));
    expect(DeviceEventsRequestSchema.safeParse({ events }).success).toBe(true);
  });

  it('DeviceEventsRequest rejects unknown event types', () => {
    const ok = DeviceEventsRequestSchema.safeParse({
      events: [
        { eventId: '00000000-0000-4000-8000-000000000000', ts: new Date().toISOString(), type: 'totally_made_up' },
      ],
    });
    expect(ok.success).toBe(false);
  });

  it('DeviceSyncResponse accepts a minimal payload', () => {
    const ok = DeviceSyncResponseSchema.safeParse({
      serverTime: new Date().toISOString(),
      config: { lightSleepAfterSec: 30, deepSleepAfterSec: 300, volumeMax: 100 },
      cards: [],
      audio: [],
    });
    expect(ok.success).toBe(true);
  });
});

describe('phase 5 schemas', () => {
  const validManifest = {
    version: '0.2.0',
    hwRev: 'r0',
    url: 'https://example.com/fw.bin?sig=x',
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    sha256: 'a'.repeat(64),
    signature: 'a'.repeat(128),
    signatureAlgorithm: 'ed25519' as const,
    sizeBytes: 1024,
    releasedAt: new Date().toISOString(),
  };

  it('FirmwareLatestQuery accepts r0..rN, rejects garbage', () => {
    expect(FirmwareLatestQuerySchema.safeParse({ hw_rev: 'r0' }).success).toBe(true);
    expect(FirmwareLatestQuerySchema.safeParse({ hw_rev: 'r12' }).success).toBe(true);
    expect(FirmwareLatestQuerySchema.safeParse({ hw_rev: 'R0' }).success).toBe(false);
    expect(FirmwareLatestQuerySchema.safeParse({ hw_rev: 'beta' }).success).toBe(false);
    expect(FirmwareLatestQuerySchema.safeParse({}).success).toBe(false);
  });

  it('FirmwareManifest accepts a fully populated payload', () => {
    expect(FirmwareManifestSchema.safeParse(validManifest).success).toBe(true);
  });

  it('FirmwareManifest accepts optional notes', () => {
    expect(
      FirmwareManifestSchema.safeParse({ ...validManifest, notes: 'fixes BLE pairing' }).success,
    ).toBe(true);
  });

  it('FirmwareManifest rejects non-hex sha256', () => {
    expect(
      FirmwareManifestSchema.safeParse({ ...validManifest, sha256: 'ZZZ' }).success,
    ).toBe(false);
  });

  it('FirmwareManifest rejects non-ed25519 signature algorithm', () => {
    expect(
      FirmwareManifestSchema.safeParse({ ...validManifest, signatureAlgorithm: 'rsa' }).success,
    ).toBe(false);
  });

  it('FirmwareManifest rejects negative sizeBytes', () => {
    expect(
      FirmwareManifestSchema.safeParse({ ...validManifest, sizeBytes: -1 }).success,
    ).toBe(false);
  });
});
