import { z } from 'zod';

export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorBody = z.infer<typeof ErrorSchema>;

export const AuthTokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresIn: z.number().int().positive(),
});

export const UserRoleSchema = z.enum(['admin', 'user']);

export const UserRegisterRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(256),
  displayName: z.string().max(120).optional(),
  role: UserRoleSchema.optional(),
});

export const UserLoginRequestSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

export const RefreshRequestSchema = z.object({
  refreshToken: z.string().min(1),
});

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
});

export const UserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string().nullish(),
  role: UserRoleSchema,
  createdAt: z.string().datetime(),
});

export const UserListQuerySchema = z.object({
  cursor: z.string().optional(),
});

export const UserListSchema = z.object({
  items: z.array(UserSchema),
  nextCursor: z.string().optional(),
});

export const DeviceStateSchema = z.enum(['unclaimed', 'claimed', 'retired']);

export const DeviceSchema = z.object({
  id: z.string().uuid(),
  serial: z.string(),
  ownerId: z.string().uuid().nullish(),
  name: z.string().nullish(),
  state: DeviceStateSchema,
  firmwareVersion: z.string().nullish(),
  lastSeenAt: z.string().datetime().nullish(),
  createdAt: z.string().datetime(),
});

export const DeviceRegisterRequestSchema = z.object({
  serial: z.string().min(1).max(64),
  firmwareVersion: z.string().min(1).max(64),
  macAddress: z
    .string()
    .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/)
    .optional(),
});

export const DeviceRegisterResponseSchema = z.object({
  device: DeviceSchema,
  claimCode: z.string().optional(),
});

export const HealthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  commit: z.string().optional(),
});

export const ReadyCheckSchema = z.object({
  status: z.enum(['ok', 'error', 'timeout']),
  latencyMs: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

export const ReadySchema = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z.record(z.string(), ReadyCheckSchema),
});

// Audio / phase 2

export const ALLOWED_SOURCE_CONTENT_TYPES = [
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/wave',
  'audio/x-wav',
  'audio/x-m4a',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/flac',
  'audio/x-flac',
] as const;

export const AudioStateSchema = z.enum(['uploading', 'processing', 'ready', 'failed']);

export const AudioSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  description: z.string().nullish(),
  durationMs: z.number().int().nonnegative().nullish(),
  state: AudioStateSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullish(),
  sizeBytes: z.number().int().nonnegative().nullish(),
  createdAt: z.string().datetime(),
});

export const AudioCreateRequestSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  sourceContentType: z
    .string()
    .refine((v) => (ALLOWED_SOURCE_CONTENT_TYPES as readonly string[]).includes(v), {
      message: 'unsupported sourceContentType',
    }),
});

export const PresignedUploadSchema = z.object({
  url: z.string().url(),
  method: z.literal('PUT'),
  expiresAt: z.string().datetime(),
  headers: z.record(z.string(), z.string()).optional(),
});

export const AudioCreateResponseSchema = z.object({
  audio: AudioSchema,
  upload: PresignedUploadSchema,
});

export const AudioListQuerySchema = z.object({
  cursor: z.string().optional(),
});

export const AudioListSchema = z.object({
  items: z.array(AudioSchema),
  nextCursor: z.string().optional(),
});

// Phase 3 — device sync, events, cards, claim

const CARD_UID_RE = /^[0-9a-f]{8,20}$/;

export const DeviceClaimRequestSchema = z.object({
  claimCode: z.string().min(1).max(64),
  name: z.string().min(1).max(120).optional(),
});

// Only the user-chosen name is mutable; serial, state and firmware are owned
// by the device lifecycle. `null` clears the name.
export const DeviceUpdateRequestSchema = z
  .object({
    name: z.string().max(120).nullable().optional(),
  })
  .strict();

export const DeviceConfigSchema = z.object({
  lightSleepAfterSec: z.number().int().min(5),
  deepSleepAfterSec: z.number().int().min(60),
  volumeMax: z.number().int().min(0).max(100),
  ledBrightness: z.number().int().min(0).max(100).nullish(),
});

export const CardBindingSchema = z.object({
  uid: z.string().regex(CARD_UID_RE),
  audioId: z.string().uuid(),
  boundAt: z.string().datetime().optional(),
});

export const CardBindingRequestSchema = z.object({
  uid: z.string().regex(CARD_UID_RE),
  audioId: z.string().uuid(),
});

export const AudioSyncEntrySchema = z.object({
  id: z.string().uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  sizeBytes: z.number().int().nonnegative().optional(),
  downloadUrl: z.string().url(),
  expiresAt: z.string().datetime(),
});

export const DeviceSyncQuerySchema = z.object({
  since: z.string().datetime().optional(),
});

export const DeviceSyncResponseSchema = z.object({
  serverTime: z.string().datetime(),
  config: DeviceConfigSchema,
  cards: z.array(CardBindingSchema),
  audio: z.array(AudioSyncEntrySchema),
});

export const DeviceEventTypeSchema = z.enum([
  'card_scanned',
  'card_unknown',
  'playback_started',
  'playback_finished',
  'button_pressed',
  'low_battery',
  'error',
]);

export const DeviceEventSchema = z.object({
  eventId: z.string().uuid(),
  ts: z.string().datetime(),
  type: DeviceEventTypeSchema,
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const DeviceEventsRequestSchema = z.object({
  events: z.array(DeviceEventSchema).min(1).max(200),
});

export const DeviceListQuerySchema = z.object({
  cursor: z.string().optional(),
});

export const DeviceListSchema = z.object({
  items: z.array(DeviceSchema),
  nextCursor: z.string().optional(),
});

export const CardBindingListSchema = z.object({
  items: z.array(CardBindingSchema),
});

// Phase 5 — firmware OTA

export const HW_REV_RE = /^r[0-9]+$/;

export const FirmwareLatestQuerySchema = z.object({
  hw_rev: z.string().regex(HW_REV_RE),
});

export const FirmwareManifestSchema = z.object({
  version: z.string().min(1),
  hwRev: z.string().regex(HW_REV_RE),
  url: z.string().url(),
  expiresAt: z.string().datetime(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  signature: z.string().regex(/^[0-9a-f]+$/),
  signatureAlgorithm: z.literal('ed25519'),
  sizeBytes: z.number().int().nonnegative(),
  releasedAt: z.string().datetime(),
  notes: z.string().optional(),
});
