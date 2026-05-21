# hush-backend

> Backend API (Rust + axum) and dashboard (Next.js 15 + TypeScript + Tailwind) for the Hush ecosystem.

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![api](https://img.shields.io/badge/api-axum-blueviolet)](./api)
[![dashboard](https://img.shields.io/badge/dashboard-Next.js%2015-black)](./dashboard)

Hush is an open-source RFID-activated audio device for children — see [open-hush.com](https://open-hush.com).

This monorepo holds **two** projects that ship together:

- `api/` — Rust + axum HTTP server. Implements every endpoint defined in [`hush-protocol/hush-api.yaml`](https://github.com/open-hush/hush-protocol/blob/main/hush-api.yaml).
- `dashboard/` — Next.js 15 web dashboard. Users manage their devices, upload audio, and bind RFID cards.

---

## Local development

You need:

- **Rust** 1.85+ (`rustup install stable`)
- **Node** 20+ and **npm** 10+
- **Docker** and **docker compose** (Postgres + MinIO)
- **ffmpeg** (transcoding; only needed when running the worker — `brew install ffmpeg` or `apt install ffmpeg`)

### 1. Start the data plane

```bash
cp .env.example .env       # tweak if you want; defaults work
docker compose up -d       # Postgres (5432) + MinIO (9000 + 9001 console)
```

### 2. Run migrations

```bash
cargo install sqlx-cli --no-default-features --features postgres
sqlx migrate run --source migrations
```

### 3. Run the API

```bash
cargo run -p api
# → listening on http://localhost:8080
# Smoke test:
curl http://localhost:8080/v1/health
```

### 4. Run the dashboard

```bash
cd dashboard
npm install
npm run dev
# → http://localhost:3000
```

---

## Project layout

```
hush-backend/
├── api/                  Rust + axum API
│   ├── Cargo.toml
│   └── src/
│       ├── main.rs       # axum::serve, router wiring
│       ├── routes/       # one module per resource
│       ├── auth/         # HMAC (device) + JWT (user) middleware
│       ├── db/           # sqlx queries
│       ├── storage/      # S3 presigned URLs
│       ├── transcode/    # ffmpeg invocation
│       └── models.rs     # shared types
├── migrations/           # sqlx migrations, applied with `sqlx migrate run`
├── dashboard/            # Next.js 15 (App Router) + TypeScript + Tailwind
├── docker-compose.yml    # local Postgres + MinIO
├── Dockerfile            # production image for the API
├── .env.example
└── PLAN.md / CLAUDE.md / README.md
```

---

## OpenAPI source of truth

The API contract is defined in **[`hush-protocol/hush-api.yaml`](https://github.com/open-hush/hush-protocol/blob/main/hush-api.yaml)**. The Rust code mirrors the spec via [`utoipa`](https://github.com/juhaku/utoipa) annotations, and the dashboard's TypeScript client is generated with `openapi-typescript`:

```bash
# In dashboard/
npm run gen:api    # reads ../../hush-protocol/hush-api.yaml → lib/api/
```

Drift between the spec and either consumer is a release blocker.

---

## Auth model

| Audience | Mechanism | Where it's verified |
|---|---|---|
| Devices (`/v1/device/*`) | HMAC-SHA256 of canonical request | `api/src/auth/hmac.rs` |
| Users (everything else) | JWT (15 min access + 30 day refresh) | `api/src/auth/jwt.rs` |

See [`hush-protocol/docs/auth.md`](https://github.com/open-hush/hush-protocol/blob/main/docs/auth.md) for the canonicalization rules and rotation policy.

---

## Status

**Phase 0** — scaffolding only. The `/v1/health` endpoint exists; everything else is a stub. See [`PLAN.md`](./PLAN.md) for the phased roadmap.

---

## License

MIT — see [`LICENSE`](./LICENSE).
