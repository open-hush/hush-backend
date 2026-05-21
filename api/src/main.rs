//! Hush API entry point.
//!
//! Phase 0: only `/v1/health` is wired. The submodules under
//! `src/{routes,auth,db,storage,transcode}/` exist as stubs and are not
//! part of the compilation graph yet. They'll be declared here as phase 1
//! lands each piece.

use std::net::SocketAddr;

use axum::{routing::get, Json, Router};
use serde::Serialize;
use tracing_subscriber::EnvFilter;

#[derive(Serialize)]
struct Health {
    status: &'static str,
    version: &'static str,
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Load .env in development; ignored in production where env vars come
    // from the orchestrator.
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let app = Router::new().route("/v1/health", get(health));

    let bind = std::env::var("HUSH_BIND").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let addr: SocketAddr = bind.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("hush-api listening on http://{addr}");
    axum::serve(listener, app).await?;
    Ok(())
}
