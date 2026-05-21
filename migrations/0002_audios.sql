-- Audio items: metadata + state machine for upload + transcode.
-- Bytes never live in Postgres — only in object storage.

-- Up Migration

CREATE TABLE audios (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title                 TEXT NOT NULL,
  description           TEXT,
  source_content_type   TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'uploading'
                          CHECK (state IN ('uploading','processing','ready','failed')),
  source_key            TEXT NOT NULL,    -- raw upload object key (uploads/<id>)
  transcoded_key        TEXT,             -- transcoded MP3 key (audio/<id>.mp3)
  sha256                TEXT,
  size_bytes            BIGINT,
  duration_ms           INTEGER,
  failure_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalized_at          TIMESTAMPTZ,
  ready_at              TIMESTAMPTZ
);

CREATE INDEX audios_owner_created_idx ON audios(owner_id, created_at DESC, id DESC);
CREATE INDEX audios_state_idx ON audios(state) WHERE state IN ('uploading','processing');

-- Down Migration

DROP TABLE IF EXISTS audios;
