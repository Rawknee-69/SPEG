//! cacm-daemon — HTTP + WebSocket server for CACM.
//!
//! The daemon is the RUNNING PROCESS that watches agent sessions and serves
//! queries to every client (Jcode, SPEG web, any tool). It exposes a
//! JSON-RPC-style API over a WebSocket endpoint plus a plain-HTTP health
//! check, all on top of [`cacm_core`]:
//!
//! - `storage` — pluggable backends: a Jcode harness-API backend (in-memory
//!   graph, probed via the `jcode-api.sock` socket) and a SQLite fallback,
//!   auto-selected at startup.
//! - `handlers` — the JSON-RPC method implementations (`cacm.query`,
//!   `cacm.sessions`, `cacm.inject`, `cacm.ping`, plus `cacm.context.store`).
//! - `server` — the axum HTTP + WebSocket server: frame parsing/routing,
//!   request/reply correlation, and `cacm.session_activity` push
//!   notifications broadcast to all connected clients.

pub mod handlers;
pub mod server;
pub mod storage;

pub use handlers::{
    handle_inject, handle_ping, handle_query, handle_sessions, handle_store_context,
};
pub use server::{
    broadcast_activity, dispatch, AppState, RpcError, RpcNotification, RpcRequest, RpcResponse,
};
pub use storage::{select_backend, JcodeBackend, SqliteBackend, Storage, StorageError};
