import { describe, expect, it } from 'vitest';

import {
  CardBindingRequestSchema,
  DeviceEventsRequestSchema,
  DeviceSyncResponseSchema,
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
