# syntax=docker/dockerfile:1
#
# Production image for the Hush API. Multi-stage build:
#   1. `deps`    installs pnpm deps with a cached layer.
#   2. `builder` runs `tsc` to produce `dist/`.
#   3. `runtime` is a slim Node image with just the compiled JS + ffmpeg.
#
# Build:    docker build -t open-hush/hush-api:dev .
# Run:      docker run --env-file .env -p 8080:8080 open-hush/hush-api:dev

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /build/api
RUN corepack enable
COPY api/package.json api/pnpm-lock.yaml* api/.npmrc ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /build/api
RUN corepack enable
COPY --from=deps /build/api/node_modules ./node_modules
COPY api/package.json api/tsconfig.json ./
COPY api/src ./src
RUN pnpm run build \
 && pnpm prune --prod

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /build/api/node_modules ./node_modules
COPY --from=builder /build/api/dist ./dist
COPY --from=builder /build/api/package.json ./package.json
EXPOSE 8080
ENV LOG_LEVEL=info
ENTRYPOINT ["node", "dist/index.js"]
