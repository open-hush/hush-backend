# `hush-backend` — plan

This repo holds the Hush backend (Rust + axum) **and** the Hush dashboard (Next.js 15). They live together because they ship together and share the same OpenAPI client artefacts.

## Stack

| Concern | Choice |
|---|---|
| API server | Rust 1.85+, [axum](https://github.com/tokio-rs/axum) 0.8, [tokio](https://tokio.rs/) |
| DB | PostgreSQL 16 via [sqlx](https://github.com/launchbadge/sqlx) 0.8 (compile-time-checked queries) |
| Migrations | sqlx-cli, plain `.sql` files in `migrations/` |
| Device auth | HMAC-SHA256 (per-device 32-byte secret) |
| User auth | JWT (jsonwebtoken) — 15 min access + 30 day refresh, Argon2id password hashing |
| Object storage | S3-compatible (MinIO locally, Cloudflare R2 in prod) via `aws-sdk-s3` with presigned URLs |
| Transcoding | `ffmpeg` invocation → MP3 128 kbps CBR mono 44.1 kHz |
| Observability | `tracing` + `tracing-subscriber` (JSON in prod) |
| Dashboard | Next.js 15 (App Router), TypeScript, Tailwind CSS 3.4, shadcn/ui, Tanstack Query |
| OpenAPI drift check | `utoipa` derives API spec from code; CI diffs against `hush-protocol/hush-api.yaml` |

---

## Phase 1 — Skeleton + auth (~2 weeks)

Acceptance: `docker compose up -d && cargo run -p api && curl /v1/users/register` works locally; a device can `POST /v1/device/register` and the dashboard can render a "Hush dashboard" landing.

- [x] Cargo workspace with `api` crate, `/v1/health` endpoint.
- [x] Dashboard scaffolded with Next.js 15 + Tailwind + landing page.
- [x] `docker-compose.yml` for Postgres + MinIO.
- [ ] Postgres schema (migration 0001): `users`, `devices`, `device_secrets`, `refresh_tokens`.
- [ ] `POST /v1/users/register` + `POST /v1/users/login` + `POST /v1/users/refresh` + `GET /v1/users/me`.
- [ ] JWT issuance + refresh rotation + Argon2id password hashing.
- [ ] HMAC middleware + `POST /v1/device/register`.
- [ ] `cargo test` green on host; structured `tracing` JSON logs.

## Phase 2 — Audio + transcoding (~2 weeks)

Acceptance: a user can upload an audio file from the dashboard and see `state: ready` once transcoding finishes.

- [ ] S3 client + bucket lifecycle (uploads/ vs audio/).
- [ ] `POST /v1/audio` (returns presigned PUT URL).
- [ ] `POST /v1/audio/{id}/finalize` (enqueues transcode).
- [ ] Background worker: `ffmpeg` → MP3 128k mono 44.1 kHz; updates `audios.state`.
- [ ] `GET /v1/audio` + `GET /v1/audio/{id}`.
- [ ] Dashboard upload UI with progress.

## Phase 3 — Device sync + events (~1-2 weeks)

Acceptance: a device polls `/v1/device/sync` and receives card bindings + presigned audio download URLs; event posts land in the events table.

- [ ] Migration: `cards`, `card_bindings`, `device_events`, `device_configs`.
- [ ] `GET /v1/device/sync` with `since` cursor.
- [ ] `POST /v1/device/events` idempotent on `event_id`.
- [ ] `POST /v1/devices/{id}/cards` and `DELETE …/{uid}`.

## Phase 4 — Dashboard functional (~2-3 weeks)

Acceptance: a non-technical user can claim a device, upload audio, bind cards, and see playback events in a feed.

- [ ] Auth pages (login, register, password reset).
- [ ] Devices list + detail page (status, last seen, config).
- [ ] Audio library (upload, rename, delete).
- [ ] Card-binding workflow (scan unknown card → bind from dashboard).
- [ ] Events feed.
- [ ] shadcn/ui design system applied consistently.

## Phase 5 — OTA endpoint (~1 week)

Acceptance: signed firmware artifacts are stored, devices can fetch them.

- [ ] `GET /v1/firmware/latest` (per device hardware revision).
- [ ] Manifest schema: `{ version, url, sha256, signature }`.
- [ ] Maintainer CLI (or dashboard admin page) to upload signed builds.

## Phase 6 — Observability + production (~ongoing)

Acceptance: deployable, observable, recoverable.

- [ ] Prometheus metrics (`/metrics`).
- [ ] Healthchecks for downstream dependencies (DB, S3) at `/v1/ready`.
- [ ] Structured access logs with `request_id`.
- [ ] Hosting decision (open).
- [ ] Backup story documented (Postgres point-in-time recovery; S3 lifecycle).

---

## Decisions taken

- **Postgres** (not SQLite, not MySQL) — JSON, listen/notify, mature operations.
- **sqlx** with compile-time-checked queries — catches schema drift at `cargo check` time.
- **Argon2id** for password hashing (OWASP recommendation).
- **Presigned URLs** for all binary I/O — backend never proxies audio bytes.
- **utoipa** for OpenAPI generation from code — CI diffs against `hush-protocol/hush-api.yaml` to catch drift.
- **Tailwind + shadcn/ui** for the dashboard — small bundle, accessible, easy to brand.
- **App Router** in Next.js — server components by default.

## Decisions open

- **Hosting** for the API: Fly.io, Railway, self-hosted on Hetzner? Decide at end of phase 4.
- **Email provider** (for verification + password reset): Postmark vs Resend. Lean Resend (cheaper, modern API).
- **Email verification timing**: required on register, or required-before-claiming-device? Lean the second (lower signup friction).
- **Migration strategy in prod**: run `sqlx migrate` on boot, or as a separate job? Lean separate job (safer rollbacks).
- **Worker model**: same process as the API, or separate? Lean separate once we hit > 10 concurrent transcodes.
- **Multi-tenant model** (sharing a device with another adult): introduce in phase 3 or punt to a "v2"? Lean punt — single-owner devices are simpler and cover the home use case.

---

## Cross-repo touch points

- **`hush-protocol`** — every spec change requires regenerated `utoipa` annotations here and a regenerated TypeScript client in `dashboard/lib/api/`. CI gates on drift.
- **`hush-device`** — HMAC canonicalization, `DeviceSyncResponse` shape, partition / OTA endpoint must match what the firmware expects.
- **`hush-app`** — JWT auth, `/v1/devices/*` claim flow, BLE Improv WiFi pairing UX. The app talks to the same API as the dashboard.
