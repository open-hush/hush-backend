-- Card bindings, device events and per-device configs.
--
-- PLAN.md mentioned a separate `cards` table; in practice a card has no
-- metadata beyond its UID, so `card_bindings` covers both concepts.

-- Up Migration

CREATE TABLE card_bindings (
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  uid         TEXT NOT NULL CHECK (uid ~ '^[0-9a-f]{8,20}$'),
  audio_id    UUID NOT NULL REFERENCES audios(id) ON DELETE CASCADE,
  bound_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, uid)
);
CREATE INDEX card_bindings_audio_id_idx ON card_bindings(audio_id);

CREATE TABLE device_configs (
  device_id               UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  light_sleep_after_sec   INTEGER NOT NULL DEFAULT 30  CHECK (light_sleep_after_sec >= 5),
  deep_sleep_after_sec    INTEGER NOT NULL DEFAULT 300 CHECK (deep_sleep_after_sec >= 60),
  volume_max              INTEGER NOT NULL DEFAULT 100 CHECK (volume_max BETWEEN 0 AND 100),
  led_brightness          INTEGER CHECK (led_brightness IS NULL OR led_brightness BETWEEN 0 AND 100),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE device_events (
  event_id    UUID PRIMARY KEY,                                -- client-generated; idempotency key
  device_id   UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts          TIMESTAMPTZ NOT NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'card_scanned','card_unknown','playback_started',
                'playback_finished','button_pressed','low_battery','error'
              )),
  payload     JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX device_events_device_ts_idx ON device_events(device_id, ts DESC);
CREATE INDEX device_events_received_at_idx ON device_events(received_at DESC);

-- Down Migration

DROP TABLE IF EXISTS device_events;
DROP TABLE IF EXISTS device_configs;
DROP TABLE IF EXISTS card_bindings;
