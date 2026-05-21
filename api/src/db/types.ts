import type { Generated } from 'kysely';

export interface UsersTable {
  id: Generated<string>;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface RefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  token_hash: string;
  issued_at: Generated<Date>;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
}

export type DeviceState = 'unclaimed' | 'claimed' | 'retired';

export interface DevicesTable {
  id: Generated<string>;
  serial: string;
  owner_id: string | null;
  name: string | null;
  state: Generated<DeviceState>;
  firmware_version: string | null;
  mac_address: string | null;
  claim_code: string | null;
  claim_code_expires_at: Date | null;
  last_seen_at: Date | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DeviceSecretsTable {
  device_id: string;
  secret: Buffer;
  issued_at: Generated<Date>;
  rotated_at: Date | null;
}

export type AudioState = 'uploading' | 'processing' | 'ready' | 'failed';

export interface AudiosTable {
  id: Generated<string>;
  owner_id: string;
  title: string;
  description: string | null;
  source_content_type: string;
  state: Generated<AudioState>;
  source_key: string;
  transcoded_key: string | null;
  sha256: string | null;
  size_bytes: number | null;
  duration_ms: number | null;
  failure_reason: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
  finalized_at: Date | null;
  ready_at: Date | null;
}

export interface CardBindingsTable {
  device_id: string;
  uid: string;
  audio_id: string;
  bound_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface DeviceConfigsTable {
  device_id: string;
  light_sleep_after_sec: Generated<number>;
  deep_sleep_after_sec: Generated<number>;
  volume_max: Generated<number>;
  led_brightness: number | null;
  updated_at: Generated<Date>;
}

export type DeviceEventType =
  | 'card_scanned'
  | 'card_unknown'
  | 'playback_started'
  | 'playback_finished'
  | 'button_pressed'
  | 'low_battery'
  | 'error';

export interface DeviceEventsTable {
  event_id: string;
  device_id: string;
  ts: Date;
  type: DeviceEventType;
  payload: unknown | null;
  received_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  refresh_tokens: RefreshTokensTable;
  devices: DevicesTable;
  device_secrets: DeviceSecretsTable;
  audios: AudiosTable;
  card_bindings: CardBindingsTable;
  device_configs: DeviceConfigsTable;
  device_events: DeviceEventsTable;
}
