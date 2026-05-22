# `hush-backend` — plan

This repo holds the Hush backend (Node.js + Fastify + TypeScript) **and** the Hush dashboard (Next.js 15). They live together because they ship together and share the same OpenAPI client artefacts.

## Stack

| Concern | Choice |
|---|---|
| API server | Node.js 22+, [Fastify](https://fastify.dev/) 5, TypeScript 5.6+ |
| Package manager (api) | pnpm 10+ |
| DB | PostgreSQL 16 via [`kysely`](https://kysely.dev/) (type-safe query builder, no ORM, no codegen) over `pg` |
| Migrations | Plain SQL files in `migrations/`, applied with [`node-pg-migrate`](https://salsita.github.io/node-pg-migrate/) |
| Device auth | HMAC-SHA256 (per-device 32-byte secret) |
| User auth | JWT — 15 min access + 30 day refresh, Argon2id password hashing (`argon2` npm) |
| Object storage | S3-compatible (MinIO locally, Cloudflare R2 in prod) via `@aws-sdk/client-s3` + presigned URLs |
| Transcoding | `ffmpeg` invocation → MP3 128 kbps CBR mono 44.1 kHz |
| Observability | Fastify pino logger (JSON in prod, pretty in dev via `pino-pretty`) |
| Validation | [`zod`](https://zod.dev/) schemas per route, integrated with Fastify via [`fastify-type-provider-zod`](https://github.com/turkerdev/fastify-type-provider-zod) |
| Dashboard | Next.js 15 (App Router), TypeScript, Tailwind CSS 3.4, shadcn/ui, Tanstack Query |
| OpenAPI drift check | API exposes a generated spec; CI diffs against `hush-protocol/hush-api.yaml` |

---

## Phase 1 — Skeleton + auth (~2 weeks)

Acceptance: `docker compose up -d && pnpm --dir api run dev && curl /v1/users/register` works locally; a device can `POST /v1/device/register` and the dashboard can render a "Hush dashboard" landing.

- [x] `api/` scaffolded with Fastify 5 + TypeScript + pnpm, `/v1/health` endpoint.
- [x] Dashboard scaffolded with Next.js 15 + Tailwind + landing page.
- [x] `docker-compose.yml` for Postgres + MinIO.
- [x] Phase 1 deps installed: `kysely`, `pg`, `node-pg-migrate`, `zod`, `fastify-type-provider-zod`, `@fastify/jwt`, `argon2`, `fastify-plugin`.
- [x] Postgres schema (migration 0001): `users`, `refresh_tokens`, `devices`, `device_secrets`.
- [x] `POST /v1/users/register` + `POST /v1/users/login` + `POST /v1/users/refresh` + `GET /v1/users/me`.
- [x] JWT (HS256) issuance + refresh rotation (single-use, reuse-revokes-session) + Argon2id password hashing.
- [x] HMAC plugin + `POST /v1/device/register` (canonical request per `hush-protocol/docs/auth.md`, ±300s clock skew).
- [x] `provision-device` CLI to seed a device + secret for testing.
- [x] `pnpm test` green on host (18 tests); structured JSON logs from pino.

> Pending verification (requires `docker compose up -d`): `pnpm run migrate:up` against a live Postgres, end-to-end exercise of `/v1/users/*` and `/v1/device/register` against the running server.

## Phase 2 — Audio + transcoding (~2 weeks)

Acceptance: a user can upload an audio file from the dashboard and see `state: ready` once transcoding finishes.

- [x] Migration 0002: `audios` table with state machine (uploading → processing → ready / failed).
- [x] S3 client wrapper (`api/src/storage/s3.ts`) with presigned PUT/GET, HEAD, delete; two-prefix layout (`uploads/<id>`, `audio/<id>.mp3`).
- [x] `POST /v1/audio` (returns presigned PUT URL, 15 min TTL).
- [x] `POST /v1/audio/{id}/finalize` (HEAD verifies upload, transitions to `processing`, enqueues transcode).
- [x] Background worker: in-process queue (`api/src/transcode/queue.ts`), concurrency cap 2 by default. `ffmpeg` → MP3 128 kbps CBR mono 44.1 kHz. Computes SHA-256 + duration via ffprobe. Updates `audios.state`. Best-effort cleanup of the raw upload on success.
- [x] Restart recovery: orphan `state='processing'` rows re-enqueued on boot.
- [x] `GET /v1/audio` (cursor pagination on `(created_at, id)`) + `GET /v1/audio/{id}`.
- [ ] Dashboard upload UI with progress. **Deferred** to a UI-only session; backend ready for it.

> Pending verification (requires `docker compose up -d` for Postgres + MinIO): apply migration 0002, upload a real audio file end-to-end, observe state transitions and the transcoded MP3 in the bucket.

## Phase 3 — Device sync + events (~1-2 weeks)

Acceptance: a device polls `/v1/device/sync` and receives card bindings + presigned audio download URLs; event posts land in the events table.

- [x] Migration 0003: `card_bindings`, `device_events`, `device_configs`. (The speculative standalone `cards` table was folded into `card_bindings`: cards carry no metadata beyond their UID.)
- [x] `POST /v1/devices/:id/claim` (JWT) — required for sync to be testable; transitions `unclaimed → claimed`, bootstraps `device_configs`.
- [x] `GET /v1/device/sync` with `since` cursor — returns `{serverTime, config, cards, audio}`; 304 when `since >= max(updated timestamps)`. Presigned GET URLs for ready audio, TTL `SYNC_PRESIGN_TTL_SEC` (default 1800).
- [x] `POST /v1/device/events` — bulk, idempotent on `event_id` via `ON CONFLICT DO NOTHING`. Touches `devices.last_seen_at`.
- [x] `POST /v1/devices/:id/cards` — ownership check on both device and audio; upsert on `(device_id, uid)`.
- [x] `DELETE /v1/devices/:id/cards/:uid` — ownership check; 204 on success, 404 if absent.
- [x] Tests: 29 vitest green (added 5 schema tests).

> Pending verification (requires `docker compose up -d`): apply migration 0003, claim a device with the claim code from `/v1/device/register`, exercise sync + events end-to-end against a real Postgres + MinIO.

## Phase 4 — Dashboard functional (~2-3 weeks)

Acceptance: a non-technical user can claim a device, upload audio, bind cards, and see playback events in a feed.

Backend additions for phase 4:
- [x] `GET /v1/devices` (cursor pagination) + `GET /v1/devices/:id`.
- [x] `GET /v1/devices/:id/cards` (added to spec + implemented).
- [x] HttpOnly refresh cookie on `/v1/users/{register,login,refresh}`; `/refresh` accepts cookie OR body. CORS via `@fastify/cors` (origins from `CORS_ALLOWED_ORIGINS`).

Dashboard:
- [x] shadcn/ui base (button, input, label, card, badge, dialog) + cn util + Tailwind tokens.
- [x] QueryClient provider + zustand auth store (access token in memory, refresh via cookie).
- [x] Generated TS client from OpenAPI (`lib/api/schema.ts` + typed endpoint helpers).
- [x] Auth pages: `app/(public)/login` and `app/(public)/register` with react-hook-form + zod.
- [x] Authenticated layout with sidebar + sign out.
- [x] Devices list page with claim dialog.
- [x] Device detail page with current bindings + bind/unbind form.
- [x] Audio library page: list with state badges (uploading/processing/ready/failed), upload form (POST /v1/audio → presigned PUT → finalize), auto-polls while items are in flight.
- [x] shadcn/ui applied consistently across all pages.

Deferred:
- [ ] **Password reset** — needs email provider decision (lean Resend) + spec extension. Tracked separately.
- [ ] **Events feed** — needs `GET /v1/devices/:id/events` endpoint added to spec.
- [ ] **Audio rename / delete** — needs `PATCH /v1/audio/:id` + `DELETE /v1/audio/:id` added to spec.
- [ ] **"Scan unknown card → bind"** UX flow — depends on events feed.
- [ ] **Device config edit** (light/deep sleep, volume, LED brightness) — needs `PATCH /v1/devices/:id/config` endpoint.

> Pending verification (Docker + browser): `docker compose up -d`, `pnpm --dir api run migrate:up`, `pnpm --dir api run dev`, `npm --prefix dashboard run dev`, register → claim a provisioned device → upload audio → bind card.

## Phase 5 — OTA endpoint (~1 week)

Acceptance: signed firmware artifacts are stored, devices can fetch them.

- [x] Migration 0004: `firmware_releases` (id, hw_rev, version, blob_key, sha256, signature, size_bytes, released_at, notes) with UNIQUE(hw_rev, version) and a `(hw_rev, released_at DESC)` index.
- [x] `GET /v1/firmware/latest?hw_rev=...` (HMAC-authenticated). Returns the latest `FirmwareManifest` for the requested hardware revision; presigned GET URL with TTL `FIRMWARE_PRESIGN_TTL_SEC` (default 1800). 404 when no release exists.
- [x] `FirmwareManifest` schema: `version, hwRev, url, expiresAt, sha256, signature, signatureAlgorithm: ed25519, sizeBytes, releasedAt, notes?`.
- [x] Maintainer CLI: `pnpm run upload-firmware -- --hw-rev=r0 --version=0.2.0 --bin=./fw.bin --sig=./fw.sig [--notes="..."]`. Computes SHA-256, validates a 64-byte hex Ed25519 signature, uploads `firmware/<hw_rev>/<version>.bin` to S3, inserts the release row.
- [x] 6 vitest schema tests added (35 green total).

Channels (`stable` only) and a dashboard admin page for upload are deliberately out of scope; both can be added later as additive changes.

> Pending verification (requires `docker compose up -d` for Postgres + MinIO): apply migration 0004, sign a test binary offline, run `upload-firmware`, then `GET /v1/firmware/latest?hw_rev=r0` with valid HMAC and verify the presigned URL serves the bytes.

## Phase 6 — Observability + production (~ongoing)

Acceptance: deployable, observable, recoverable.

- [x] Prometheus metrics at `/metrics` via `fastify-metrics` (default process + per-route histograms). Toggleable with `METRICS_ENABLED=false` for tests.
- [x] `GET /v1/ready` with per-dependency checks: DB (`SELECT 1`) + S3 (`HeadBucket`), each gated by `READY_PROBE_TIMEOUT_MS` (default 2000). 200 when all `ok`, 503 with the same `Ready` schema otherwise so the probe response identifies the degraded dependency.
- [x] Request id in every log line — Fastify's built-in `req.id` (auto-generated per request, surfaced as `reqId` by pino). `app.log` calls inside route handlers switched to `req.log` so background work scoped to a request keeps the same id. `@fastify/request-context` deferred — not needed unless we start propagating ids into deep code paths (DB, S3) without going through the request lifecycle.
- [ ] Hosting decision (open). Fly.io vs. Railway vs. self-hosted on Hetzner.
- [ ] Backup story documented (Postgres point-in-time recovery; S3 lifecycle).

---

## Decisions taken

- **Node + Fastify** over Rust + axum — same TS ecosystem as `dashboard/` and `hush-app`, lower friction.
- **pnpm** for `api/` — fast installs, deterministic lockfile, good monorepo story if we expand later.
- **Postgres** (not SQLite, not MySQL) — JSON, listen/notify, mature operations.
- **No ORM** — `kysely` query builder over `pg`. Type-safe, SQL stays explicit, no schema codegen step, no hidden N+1 traps.
- **`node-pg-migrate`** for migrations — plain `.sql` files in `migrations/`, no coupling to the query layer.
- **`zod`** for request/response validation, wired into Fastify via `fastify-type-provider-zod`. Shared schemas double as the source of TypeScript types for handlers; the dashboard keeps using `openapi-typescript` for its client (single direction: OpenAPI → TS), so the API derives JSON Schema from zod for OpenAPI emission.
- **Worker runs in-process** with an in-memory queue, concurrency cap 2 by default (`TRANSCODE_CONCURRENCY`). On boot, any `audios.state='processing'` orphan is re-enqueued. Reconsider when we see > 10 concurrent transcodes or need horizontal scale — then move to a separate process and pick a queue lib at that point.
- **Argon2id** for password hashing (OWASP recommendation).
- **Presigned URLs** for all binary I/O — backend never proxies audio bytes.
- **Tailwind + shadcn/ui** for the dashboard — small bundle, accessible, easy to brand.
- **App Router** in Next.js — server components by default.

## Decisions open

- **OpenAPI emission**: `@fastify/swagger` + typebox-derived schemas, emitted to a file and diffed in CI.
- **Hosting** for the API: Fly.io, Railway, self-hosted on Hetzner? Decide at end of phase 4.
- **Email provider** (for verification + password reset): Postmark vs Resend. Lean Resend (cheaper, modern API).
- **Email verification timing**: required on register, or required-before-claiming-device? Lean the second (lower signup friction).
- **Migration strategy in prod**: run migrations on boot, or as a separate job? Lean separate job (safer rollbacks).
- **Multi-tenant model** (sharing a device with another adult): introduce in phase 3 or punt to a "v2"? Lean punt — single-owner devices are simpler and cover the home use case.

---

## Cross-repo touch points

- **`hush-protocol`** — every spec change requires regenerating the API server's JSON Schemas and the dashboard's TypeScript client. CI gates on drift.
- **`hush-device`** — HMAC canonicalization, `DeviceSyncResponse` shape, partition / OTA endpoint must match what the firmware expects.
- **`hush-app`** — JWT auth, `/v1/devices/*` claim flow, BLE Improv WiFi pairing UX. The app talks to the same API as the dashboard.
