//! Authentication: HMAC (devices) and JWT (users).
//!
//! Both expose axum extractors (`DeviceClaims`, `JwtUser`) so handlers can
//! depend on authenticated state without manual middleware plumbing.
//!
//! TODO(phase-1): `jwt.rs` (issue, verify, refresh rotation) and
//! `hmac.rs` (canonical-request signing + verification, host-tested).
