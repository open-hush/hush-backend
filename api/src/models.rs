//! Shared types used by routes, db and auth.
//!
//! TODO(phase-1): mirror the schemas in `hush-protocol/hush-api.yaml` here
//! (User, Device, Audio, CardBinding, Error, …) with `serde::{Serialize,
//! Deserialize}` and `utoipa::ToSchema` derives. Naming follows the spec
//! exactly: camelCase JSON, snake_case Rust fields with `#[serde(rename_all
//! = "camelCase")]` at the struct level.
