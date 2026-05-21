# syntax=docker/dockerfile:1
#
# Production image for the Hush API. Multi-stage build:
#   1. `builder` compiles the workspace in release mode with sqlx offline mode.
#   2. `runtime` is a slim Debian image with just the binary + ffmpeg.
#
# Build:    docker build -t open-hush/hush-api:dev .
# Run:      docker run --env-file .env -p 8080:8080 open-hush/hush-api:dev

ARG RUST_VERSION=1.85
FROM rust:${RUST_VERSION}-bookworm AS builder
WORKDIR /build

# Cache deps first.
COPY Cargo.toml ./
COPY api/Cargo.toml ./api/
RUN mkdir -p api/src && echo "fn main() {}" > api/src/main.rs
RUN cargo build --release --bin api || true

# Now build for real.
COPY . .
RUN cargo build --release --bin api

# ----------------------------------------------------------------------------
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/api /app/api
EXPOSE 8080
ENV RUST_LOG=info
ENTRYPOINT ["/app/api"]
