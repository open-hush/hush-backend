//! S3-compatible object storage client.
//!
//! Uses `aws-sdk-s3` against MinIO locally and Cloudflare R2 / AWS S3 in
//! prod. The only operations the backend performs directly are
//! presigned-URL minting (PUT for uploads, GET for downloads) and bucket
//! lifecycle. **No audio bytes ever transit the backend process.**
//!
//! TODO(phase-2): `s3.rs` with `presign_put(key)` and `presign_get(key,
//! ttl)`.
