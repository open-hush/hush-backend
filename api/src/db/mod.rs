//! Database access layer.
//!
//! Uses `sqlx` with compile-time-checked queries. One file per resource.
//! The connection pool is initialised once in `main.rs` and passed via
//! axum state.
//!
//! TODO(phase-1): `users.rs`, `devices.rs`, `device_secrets.rs`,
//! `refresh_tokens.rs`.
