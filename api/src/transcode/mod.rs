//! Audio transcoding worker.
//!
//! Wraps `ffmpeg` to convert arbitrary user-uploaded audio into
//! MP3 128 kbps CBR mono 44.1 kHz — a format the firmware can decode
//! without surprise.
//!
//! TODO(phase-2): `ffmpeg.rs` (spawn the binary, stream stdout for
//! progress) and `worker.rs` (loops over the queue of finalized audio
//! items, updates `audios.state`).
