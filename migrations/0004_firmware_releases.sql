-- Firmware OTA: published builds per hardware revision.
--
-- A release row carries the metadata; the signed binary lives in object
-- storage at `blob_key`. The signature is computed offline by the maintainer
-- (Ed25519); the backend never sees the private key.

-- Up Migration

CREATE TABLE firmware_releases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hw_rev       TEXT NOT NULL CHECK (hw_rev ~ '^r[0-9]+$'),
  version      TEXT NOT NULL CHECK (version ~ '^[0-9]+\.[0-9]+\.[0-9]+'),
  blob_key     TEXT NOT NULL,
  sha256       TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  signature    TEXT NOT NULL CHECK (signature ~ '^[0-9a-f]+$'),
  size_bytes   BIGINT NOT NULL CHECK (size_bytes >= 0),
  released_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes        TEXT,
  UNIQUE (hw_rev, version)
);
CREATE INDEX firmware_releases_latest_idx
  ON firmware_releases (hw_rev, released_at DESC);

-- Down Migration

DROP TABLE IF EXISTS firmware_releases;
