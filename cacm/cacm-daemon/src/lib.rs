//! cacm-daemon — HTTP + WebSocket server for CACM.
//!
//! The daemon is the RUNNING PROCESS that watches agent sessions and serves
//! queries to every client (SPEG web, any tool). It exposes a
//! JSON-RPC-style API over a WebSocket endpoint plus a plain-HTTP health
//! check, all on top of [`cacm_core`]:
//!
//! - `storage` — pluggable backends: SQLite persistence, auto-selected at
//!   startup, plus an in-memory graph used by tests.
//! - `handlers` — the JSON-RPC method implementations (`cacm.query`,
//!   `cacm.sessions`, `cacm.inject`, `cacm.ping`, plus `cacm.context.store`).
//! - `server` — the axum HTTP + WebSocket server: frame parsing/routing,
//!   request/reply correlation, and `cacm.session_activity` push
//!   notifications broadcast to all connected clients.
//! - `memory` — the memory manager: budgets, pressure levels, and store
//!   admission so the daemon degrades instead of OOM-ing.
//! - `crashpad` — crash reports + a collectible daemon log; combined with the
//!   restart loop in `main` this gives the daemon self-heal.

pub mod crashpad;
pub mod handlers;
pub mod memory;
pub mod server;
pub mod storage;

pub use crashpad::{CrashInfo, Crashpad};
pub use handlers::{
    handle_inject, handle_memory_stats, handle_ping, handle_query, handle_sessions,
    handle_store_context,
};
pub use memory::{MemoryManager, MemoryPressure, MemoryStats};
pub use server::{
    broadcast_activity, dispatch, AppState, RpcError, RpcNotification, RpcRequest, RpcResponse,
};
pub use storage::{select_backend, InMemoryBackend, SqliteBackend, Storage, StorageError};
