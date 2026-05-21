-- Initial schema: users, refresh_tokens, devices, device_secrets.
-- Applied by node-pg-migrate (sql migration language).

-- Up Migration

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT NOT NULL UNIQUE,
  password_hash   TEXT NOT NULL,
  display_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX refresh_tokens_user_id_idx ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_expires_at_idx ON refresh_tokens(expires_at);

CREATE TABLE devices (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  serial                  TEXT NOT NULL UNIQUE,
  owner_id                UUID REFERENCES users(id) ON DELETE SET NULL,
  name                    TEXT,
  state                   TEXT NOT NULL DEFAULT 'unclaimed'
                            CHECK (state IN ('unclaimed','claimed','retired')),
  firmware_version        TEXT,
  mac_address             TEXT,
  claim_code              TEXT,
  claim_code_expires_at   TIMESTAMPTZ,
  last_seen_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_owner_id_idx ON devices(owner_id);

-- Per-device 32-byte HMAC secret. Cleartext required to verify HMACs.
-- Encrypt-at-rest is delegated to the DB / disk layer in phase 1; an
-- app-layer KEK wrap is planned for phase 6.
CREATE TABLE device_secrets (
  device_id       UUID PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  secret          BYTEA NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at      TIMESTAMPTZ
);

-- Down Migration

DROP TABLE IF EXISTS device_secrets;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS refresh_tokens;
DROP TABLE IF EXISTS users;
