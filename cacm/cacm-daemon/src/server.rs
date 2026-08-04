//! HTTP + WebSocket server: JSON-RPC-style protocol over axum.
//!
//! Wire protocol (task 1.4 API spec):
//!
//! ```text
//! → {"id": 1, "method": "cacm.query", "params": {"project": "/repo", "limit": 10}}
//! ← {"id": 1, "result": {"entries": [...]}}
//! ← {"id": 1, "error": {"code": -32602, "message": "..."}}
//! ← {"event": "cacm.session_activity", "data": {...}}
//! ```
//!
//! Every client frame is a request (id + method + params); the daemon replies
//! with a correlated [`RpcResponse`]. Server-initiated messages are
//! [`RpcNotification`]s broadcast to all connected clients. Request/reply
//! correlation is tracked in [`AppState::pending`]: a duplicate id that is
//! still in flight is rejected, and the map also serves `/healthz` and logs.

use crate::handlers;
use crate::memory::MemoryManager;
use crate::storage::Storage;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::header::{HeaderMap, HeaderValue, ORIGIN};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use cacm_core::parsers::ParserRegistry;
use cacm_core::types::AgentSession;
use cacm_core::watcher::SessionActivity;
use chrono::{DateTime, Utc};
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

/// Capacity of the session-activity broadcast channel (per daemon).
pub const EVENT_CHANNEL_CAPACITY: usize = 128;
/// Maximum WebSocket message/frame size (1 MiB) — the daemon is
/// unauthenticated, so oversized frames must not be buffered.
pub const MAX_WS_MESSAGE_SIZE: usize = 1 << 20;
/// Maximum concurrent WebSocket connections.
pub const MAX_CONNECTIONS: usize = 64;

/// A client request frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    /// Client-chosen correlation id (number or string). Defaults to `null`
    /// when absent so dispatch can reject it with `-32600` like an invalid id.
    #[serde(default)]
    pub id: Value,
    /// Method name, e.g. `cacm.query`. Defaults to empty so a missing method
    /// is a `-32600` Invalid Request (not a `-32700` parse error).
    #[serde(default)]
    pub method: String,
    /// Method-specific parameters (defaults to `{}`).
    #[serde(default)]
    pub params: Value,
}

/// JSON-RPC-style error object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcError {
    /// JSON-RPC error code (see the constructors below).
    pub code: i32,
    pub message: String,
}

impl RpcError {
    /// Invalid JSON / unparseable frame.
    pub fn parse_error() -> Self {
        Self {
            code: -32700,
            message: "parse error".into(),
        }
    }
    /// Well-formed JSON but not a valid request.
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: -32600,
            message: message.into(),
        }
    }
    /// Unknown method.
    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("method not found: {method}"),
        }
    }
    /// Missing/invalid parameters.
    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: message.into(),
        }
    }
    /// Internal server error.
    pub fn server_error(message: impl Into<String>) -> Self {
        Self {
            code: -32000,
            message: message.into(),
        }
    }
    /// Memory-pressure rejection (exposed to clients, unlike `-32000`).
    pub fn memory_exhausted(message: impl Into<String>) -> Self {
        Self {
            code: -32002,
            message: message.into(),
        }
    }
}

/// A reply frame: exactly one of `result` / `error` is present.
#[derive(Debug, Clone, Serialize)]
pub struct RpcResponse {
    pub id: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

impl RpcResponse {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Value, error: RpcError) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
        }
    }
}

/// A server-initiated notification frame.
#[derive(Debug, Clone, Serialize)]
pub struct RpcNotification {
    pub event: String,
    pub data: Value,
}

/// A request whose reply is still outstanding (correlation bookkeeping).
#[derive(Debug, Clone)]
pub struct PendingRequest {
    pub method: String,
    pub started_at: Instant,
}

/// Shared daemon state, injected into every axum handler.
#[derive(Clone)]
pub struct AppState {
    /// Boxed trait object so the mutex holds a sized type (a `Box<dyn
    /// Storage>` coerces into `Arc<Mutex<Box<dyn Storage>>>` directly).
    pub storage: Arc<Mutex<Box<dyn Storage>>>,
    /// Live session index keyed by session id (hydrated from storage at
    /// startup, updated by the watcher task).
    pub sessions: Arc<Mutex<HashMap<String, AgentSession>>>,
    /// Registered session parsers (populated by task 1.5).
    pub registry: Arc<ParserRegistry>,
    /// In-flight request ids → method, for request/reply correlation. Keyed by
    /// `<connection id>:<request id>` so ids from different clients never
    /// collide.
    pub pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
    /// Monotonic per-connection counter (used to scope the pending map).
    pub next_conn: Arc<AtomicU64>,
    /// Currently-open WebSocket connections (bounded by [`MAX_CONNECTIONS`]).
    pub active_connections: Arc<AtomicUsize>,
    /// Allowed WebSocket `Origin` headers. Empty = only clients that send no
    /// Origin (e.g. node, the SDK) are accepted — browsers are rejected until
    /// the operator opts in per origin. The daemon is unauthenticated, so it
    /// must not be reachable from arbitrary web pages.
    pub allow_origins: Arc<Vec<String>>,
    /// Memory manager (budgets, pressure, store admission).
    pub memory: MemoryManager,
    /// Debug mode (`--debug`): enables `cacm.debug.panic`.
    pub debug: bool,
    /// Directory crash reports and the daemon log are collected in.
    pub crash_dir: Arc<PathBuf>,
    /// Pre-serialized notification broadcast to every connected client.
    pub events: broadcast::Sender<String>,
    pub started_at: DateTime<Utc>,
}

impl AppState {
    pub fn new(
        storage: Box<dyn Storage>,
        registry: ParserRegistry,
        sessions: HashMap<String, AgentSession>,
    ) -> Self {
        let (events, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        Self {
            storage: Arc::new(Mutex::new(storage)),
            sessions: Arc::new(Mutex::new(sessions)),
            registry: Arc::new(registry),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_conn: Arc::new(AtomicU64::new(0)),
            active_connections: Arc::new(AtomicUsize::new(0)),
            allow_origins: Arc::new(Vec::new()),
            memory: MemoryManager::defaults(),
            debug: false,
            crash_dir: Arc::new(PathBuf::from("./crashes")),
            events,
            started_at: Utc::now(),
        }
    }

    /// Number of in-flight requests (used by `/healthz` and tests).
    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|m| m.len()).unwrap_or(0)
    }
}

/// Serialize a `cacm.session_activity` notification from a watcher event.
pub fn broadcast_activity(tx: &broadcast::Sender<String>, activity: &SessionActivity) {
    let notification = RpcNotification {
        event: "cacm.session_activity".into(),
        data: serde_json::to_value(activity).unwrap_or_else(|_| json!({})),
    };
    if let Ok(payload) = serde_json::to_string(&notification) {
        let _ = tx.send(payload);
    }
}

/// Is this WS upgrade request's Origin allowed?
///
/// Clients that send no Origin (node, the SDK, desktop tools) are always
/// allowed; browser requests must match an entry in `allow`. The daemon is
/// unauthenticated, so this is the only defense against malicious web pages
/// reaching it via `127.0.0.1`.
pub fn origin_allowed(origin: Option<&str>, allow: &[String]) -> bool {
    match origin {
        None => true,
        Some(origin) => allow.iter().any(|allowed| allowed == origin),
    }
}

/// Build the axum router (WebSocket + health endpoint + CORS).
pub fn build_router(state: AppState) -> Router {
    let cors = if state.allow_origins.is_empty() {
        // Loopback default: browsers are blocked at the WS handshake anyway;
        // /healthz leaks only status counters, so permissive is acceptable.
        CorsLayer::permissive()
    } else {
        let origins: Vec<HeaderValue> = state
            .allow_origins
            .iter()
            .filter_map(|o| match o.parse() {
                Ok(v) => Some(v),
                Err(_) => {
                    tracing::warn!(origin = %o, "ignoring unparseable --allow-origin value");
                    None
                }
            })
            .collect();
        CorsLayer::new()
            .allow_origin(origins)
            .allow_methods([Method::GET])
            .allow_headers([axum::http::header::CONTENT_TYPE])
    };
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/healthz", get(health))
        .layer(cors)
        .with_state(state)
}

/// HTTP health check — plain JSON, no WebSocket upgrade required.
async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let (storage_name, session_count, used, pressure) = {
        let storage = match state.storage.lock() {
            Ok(s) => s,
            Err(_) => {
                return (
                    StatusCode::SERVICE_UNAVAILABLE,
                    Json(json!({"status": "degraded"})),
                )
            }
        };
        let sessions = state.sessions.lock().map(|s| s.len()).unwrap_or(0);
        let used = storage.memory_bytes();
        let pressure = state.memory.pressure(used);
        (storage.name().to_string(), sessions, used, pressure)
    };
    let body = json!({
        "status": "ok",
        "storage": storage_name,
        "sessions": session_count,
        "pending": state.pending_count(),
        "memory": {
            "used_bytes": used,
            "soft_limit": state.memory.soft_limit(),
            "hard_limit": state.memory.hard_limit(),
            "pressure": pressure,
        },
        "crash_dir": state.crash_dir.display().to_string(),
        "uptime_secs": (Utc::now() - state.started_at).num_seconds(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    (StatusCode::OK, Json(body))
}

/// Try to reserve a connection slot. Callers must release it with
/// [`release_connection`] when the connection ends.
pub fn try_acquire_connection(active: &AtomicUsize, cap: usize) -> bool {
    let mut current = active.load(Ordering::Relaxed);
    loop {
        if current >= cap {
            return false;
        }
        match active.compare_exchange_weak(
            current,
            current + 1,
            Ordering::Relaxed,
            Ordering::Relaxed,
        ) {
            Ok(_) => return true,
            Err(observed) => current = observed,
        }
    }
}

/// Release a connection slot previously acquired with
/// [`try_acquire_connection`].
pub fn release_connection(active: &AtomicUsize) {
    active.fetch_sub(1, Ordering::Relaxed);
}

/// RAII guard that holds a connection slot until dropped, so a panic or an
/// early return in the connection task cannot leak the slot.
pub struct ConnectionGuard {
    active: Arc<AtomicUsize>,
}

impl ConnectionGuard {
    /// Acquire a slot, or return `None` when the cap is reached.
    pub fn acquire(active: &Arc<AtomicUsize>, cap: usize) -> Option<Self> {
        if try_acquire_connection(active, cap) {
            Some(Self {
                active: Arc::clone(active),
            })
        } else {
            None
        }
    }
}

impl Drop for ConnectionGuard {
    fn drop(&mut self) {
        release_connection(&self.active);
    }
}

/// WebSocket upgrade handler. Rejects requests from origins not on the
/// allow-list (browsers send an `Origin` header; non-browser clients usually
/// don't) and enforces the connection cap and frame-size limits.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    let origin = headers.get(ORIGIN).and_then(|v| v.to_str().ok());
    if !origin_allowed(origin, &state.allow_origins) {
        tracing::warn!(?origin, "rejected WebSocket upgrade from disallowed origin");
        return (StatusCode::FORBIDDEN, "origin not allowed").into_response();
    }
    let Some(guard) = ConnectionGuard::acquire(&state.active_connections, MAX_CONNECTIONS) else {
        tracing::warn!("rejected WebSocket upgrade: connection limit reached");
        return (StatusCode::SERVICE_UNAVAILABLE, "too many connections").into_response();
    };
    ws.max_message_size(MAX_WS_MESSAGE_SIZE)
        .max_frame_size(MAX_WS_MESSAGE_SIZE)
        .on_upgrade(move |socket| handle_socket(socket, state, guard))
}

/// Per-connection loop: dispatch incoming frames and forward replies +
/// broadcast notifications back over the socket. The [`ConnectionGuard`]
/// releases the connection slot on drop.
async fn handle_socket(mut socket: WebSocket, state: AppState, _guard: ConnectionGuard) {
    // Scope request/reply correlation per connection so two clients can use
    // the same request ids concurrently without false "duplicate" rejections.
    let conn_id = state.next_conn.fetch_add(1, Ordering::Relaxed);
    let mut event_rx = state.events.subscribe();
    loop {
        tokio::select! {
            maybe = socket.recv() => {
                match maybe {
                    Some(Ok(Message::Text(text))) => {
                        let payload = dispatch(&state, conn_id, &text);
                        if socket.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        // tungstenite queues the close-ack internally; drive the
                        // handshake to completion so the client sees a clean close.
                        let _ = socket.close().await;
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            event = event_rx.recv() => {
                match event {
                    Ok(payload) => {
                        if socket.send(Message::Text(payload.into())).await.is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }
}

/// Parse a raw client frame and route it to the matching handler.
///
/// `conn_id` scopes the request/reply correlation map, so ids from different
/// connections never collide. Always returns a serialized [`RpcResponse`];
/// JSON-RPC mandates a reply for every message (id is `null` when the frame
/// could not be parsed).
pub fn dispatch(state: &AppState, conn_id: u64, raw: &str) -> String {
    let request: RpcRequest = match serde_json::from_str(raw) {
        Ok(request) => request,
        // Batch arrays (JSON arrays) and unparseable frames both land here.
        Err(_) => return response_json(RpcResponse::err(Value::Null, RpcError::parse_error())),
    };

    // Reject frames without a numeric or string id (missing id is `null` via
    // `#[serde(default)]`).
    let id = if request.id.is_number() || request.id.is_string() {
        request.id
    } else {
        return response_json(RpcResponse::err(
            Value::Null,
            RpcError::invalid_request("request must carry a numeric or string 'id'"),
        ));
    };
    let method = request.method;
    if method.is_empty() {
        return response_json(RpcResponse::err(
            id,
            RpcError::invalid_request("request must carry a non-empty 'method'"),
        ));
    }
    let params = request.params;

    // Request/reply correlation: a still-in-flight id is a duplicate. The key
    // is scoped by connection, so concurrent clients reusing ids don't clash.
    let id_key = format!("{conn_id}:{id}");
    {
        let mut pending = match state.pending.lock() {
            Ok(p) => p,
            Err(_) => {
                return response_json(RpcResponse::err(
                    id,
                    RpcError::server_error("pending map lock poisoned"),
                ))
            }
        };
        if pending.contains_key(&id_key) {
            return response_json(RpcResponse::err(
                id,
                RpcError::invalid_request(format!("duplicate in-flight request id {id_key}")),
            ));
        }
        pending.insert(
            id_key.clone(),
            PendingRequest {
                method: method.clone(),
                started_at: Instant::now(),
            },
        );
    }

    // Route to the handler. Storage access is short (SQLite/memory), so a
    // blocking mutex is fine here.
    let result = route(state, &method, &params);

    if let Ok(mut pending) = state.pending.lock() {
        pending.remove(&id_key);
    }

    // Client errors (-3260x) are safe to echo; server errors (-32000) may
    // embed filesystem paths or backend internals, so log the detail and
    // return a generic message.
    let response = match result {
        Ok(value) => RpcResponse::ok(id, value),
        Err(error) if error.code == -32000 => {
            tracing::warn!(method = %method, error = %error.message, "request handler failed");
            RpcResponse::err(id, RpcError::server_error("internal server error"))
        }
        Err(error) => RpcResponse::err(id, error),
    };
    response_json(response)
}

fn route(state: &AppState, method: &str, params: &Value) -> Result<Value, RpcError> {
    match method {
        "cacm.ping" => Ok(handlers::handle_ping()),
        "cacm.query" => {
            let storage = state
                .storage
                .lock()
                .map_err(|_| RpcError::server_error("storage lock poisoned"))?;
            handlers::handle_query(&**storage, params)
        }
        "cacm.sessions" => handlers::handle_sessions(&state.sessions, params),
        "cacm.inject" => {
            let storage = state
                .storage
                .lock()
                .map_err(|_| RpcError::server_error("storage lock poisoned"))?;
            handlers::handle_inject(&**storage, params)
        }
        "cacm.memory.stats" => {
            let storage = state
                .storage
                .lock()
                .map_err(|_| RpcError::server_error("storage lock poisoned"))?;
            let sessions = state.sessions.lock().map(|s| s.len()).unwrap_or(0);
            let connections = state.active_connections.load(Ordering::Relaxed);
            let pending = state.pending_count();
            Ok(handlers::handle_memory_stats(
                &state.memory,
                &**storage,
                sessions,
                connections,
                pending,
            ))
        }
        // Debug-only: deliberately panics the calling connection's task. The
        // crashpad records it and the daemon keeps running (self-heals at the
        // task level).
        "cacm.debug.panic" if state.debug => handlers::handle_debug_panic(),
        "cacm.debug.panic" => Err(RpcError::method_not_found("cacm.debug.panic")),
        "cacm.context.store" => {
            let mut storage = state
                .storage
                .lock()
                .map_err(|_| RpcError::server_error("storage lock poisoned"))?;
            // Memory manager: shrink under soft pressure, reject under hard.
            let used = storage.memory_bytes();
            match state.memory.pressure(used) {
                crate::memory::MemoryPressure::Normal => {}
                pressure => {
                    let target = state.memory.shrink_target();
                    if storage.memory_bytes() > target {
                        storage.shrink_memory(target);
                    }
                    tracing::warn!(
                        ?pressure,
                        used,
                        target,
                        "memory pressure — shrinking storage before write"
                    );
                }
            }
            let incoming = serde_json::to_string(params).map(|s| s.len()).unwrap_or(0);
            state
                .memory
                .admit(storage.memory_bytes(), incoming)
                .map_err(RpcError::memory_exhausted)?;
            handlers::handle_store_context(&mut **storage, params)
        }
        other => Err(RpcError::method_not_found(other)),
    }
}

fn response_json(response: RpcResponse) -> String {
    serde_json::to_string(&response).unwrap_or_else(|_| {
        r#"{"id":null,"error":{"code":-32000,"message":"response serialization failed"}}"#.into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{JcodeBackend, Storage};
    use cacm_core::types::{AgentType, ContextType, CrossAgentContext};
    use std::path::PathBuf;

    fn test_state() -> AppState {
        let backend = JcodeBackend::new(PathBuf::from("C:\\nonexistent\\jcode-api.sock"));
        AppState::new(Box::new(backend), ParserRegistry::new(), HashMap::new())
    }

    /// Helper: dispatch a frame as if from connection 0.
    fn call(state: &AppState, raw: &str) -> String {
        dispatch(state, 0, raw)
    }

    fn seed(state: &AppState, id: &str, session: &str, path: &str) {
        let ctx = CrossAgentContext {
            id: id.into(),
            session_id: session.into(),
            agent_type: AgentType::ClaudeCode,
            context_type: ContextType::Task,
            content: format!("task about {id}"),
            file_paths: vec![path.into()],
            decisions: vec![],
            errors: vec![],
            timestamp: Utc::now(),
        };
        let mut storage = state.storage.lock().unwrap();
        storage.store_context(&ctx).unwrap();
    }

    #[test]
    fn dispatch_ping_roundtrip() {
        let state = test_state();
        let resp = call(&state, r#"{"id":1,"method":"cacm.ping","params":{}}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["id"], 1);
        assert_eq!(value["result"], "pong");
        assert!(value.get("error").is_none());
    }

    #[test]
    fn dispatch_query_returns_entries() {
        let state = test_state();
        seed(&state, "c1", "s1", "/repo/a.rs");
        let resp = call(
            &state,
            r#"{"id":2,"method":"cacm.query","params":{"project":"/repo","limit":10}}"#,
        );
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["id"], 2);
        assert_eq!(value["result"]["entries"].as_array().unwrap().len(), 1);
        assert_eq!(value["result"]["entries"][0]["id"], "c1");
    }

    #[test]
    fn dispatch_sessions_and_inject() {
        let state = test_state();
        seed(&state, "c1", "abc", "/repo/a.rs");
        {
            let mut sessions = state.sessions.lock().unwrap();
            sessions.insert(
                "abc".into(),
                AgentSession::new("abc", AgentType::Jcode, "/repo/abc", Utc::now()),
            );
        }
        let resp = call(&state, r#"{"id":3,"method":"cacm.sessions","params":{}}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["result"]["sessions"].as_array().unwrap().len(), 1);

        let resp = call(
            &state,
            r#"{"id":4,"method":"cacm.inject","params":{"sessionId":"abc","agent":"claude-code"}}"#,
        );
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert!(value["result"]["formatted"]
            .as_str()
            .unwrap()
            .starts_with("[Cross-Agent Context]"));
    }

    #[test]
    fn dispatch_unknown_method_and_missing_id() {
        let state = test_state();
        let resp = call(&state, r#"{"id":1,"method":"cacm.nope","params":{}}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["error"]["code"], -32601);

        let resp = call(&state, r#"{"method":"cacm.ping"}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["error"]["code"], -32600);
        assert_eq!(value["id"], Value::Null);

        // Valid JSON but no method → Invalid Request (-32600), not a parse
        // error (-32700).
        let resp = call(&state, r#"{"id":1}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["error"]["code"], -32600);
        assert_eq!(value["id"], 1);
    }

    #[test]
    fn dispatch_malformed_json_returns_parse_error() {
        let state = test_state();
        let resp = call(&state, "not json {");
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["error"]["code"], -32700);
        assert_eq!(value["id"], Value::Null);
    }

    #[test]
    fn dispatch_rejects_duplicate_in_flight_id() {
        let state = test_state();
        {
            let mut pending = state.pending.lock().unwrap();
            pending.insert(
                "0:7".into(),
                PendingRequest {
                    method: "cacm.ping".into(),
                    started_at: Instant::now(),
                },
            );
        }
        let resp = call(&state, r#"{"id":7,"method":"cacm.ping","params":{}}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["error"]["code"], -32600);
        assert!(value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("duplicate"));
        // And the original entry is still tracked (not removed by the rejected call).
        assert_eq!(state.pending_count(), 1);
    }

    #[test]
    fn dispatch_ids_are_scoped_per_connection() {
        let state = test_state();
        // Two connections both using id 1 concurrently must both succeed.
        let a = dispatch(&state, 1, r#"{"id":1,"method":"cacm.ping","params":{}}"#);
        let b = dispatch(&state, 2, r#"{"id":1,"method":"cacm.ping","params":{}}"#);
        let va: Value = serde_json::from_str(&a).unwrap();
        let vb: Value = serde_json::from_str(&b).unwrap();
        assert_eq!(va["result"], "pong");
        assert_eq!(vb["result"], "pong");
        assert_eq!(state.pending_count(), 0);
    }

    #[test]
    fn dispatch_clears_pending_after_success() {
        let state = test_state();
        call(&state, r#"{"id":9,"method":"cacm.ping","params":{}}"#);
        assert_eq!(state.pending_count(), 0);
    }

    #[test]
    fn dispatch_store_context_extension() {
        let state = test_state();
        let resp = call(
            &state,
            r#"{"id":5,"method":"cacm.context.store","params":{"context":{
                "id":"ctx-5","session_id":"s5","agent_type":"codex","context_type":"pattern",
                "content":"always use the resolver","file_paths":["/repo/Cargo.toml"],
                "decisions":[],"errors":[],"timestamp":"2026-01-01T00:00:00Z"
            }}}"#,
        );
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["result"]["stored"], "ctx-5");
        let resp = call(
            &state,
            r#"{"id":6,"method":"cacm.query","params":{"project":"/repo"}}"#,
        );
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["result"]["entries"][0]["id"], "ctx-5");
    }

    #[test]
    fn try_acquire_connection_respects_cap() {
        let active = AtomicUsize::new(0);
        assert!(try_acquire_connection(&active, 2));
        assert!(try_acquire_connection(&active, 2));
        assert!(!try_acquire_connection(&active, 2)); // cap reached
        assert_eq!(active.load(Ordering::Relaxed), 2);
        release_connection(&active);
        assert!(try_acquire_connection(&active, 2));
        release_connection(&active);
        release_connection(&active);
        assert_eq!(active.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn connection_guard_releases_on_drop() {
        let active = Arc::new(AtomicUsize::new(0));
        {
            let guard = ConnectionGuard::acquire(&active, 1).unwrap();
            assert!(!try_acquire_connection(&active, 1)); // held by the guard
            drop(guard); // RAII release
        }
        assert!(try_acquire_connection(&active, 1)); // slot is free again
        release_connection(&active);
        // Cap reached → acquire returns None without leaking.
        let _g1 = ConnectionGuard::acquire(&active, 1).unwrap();
        assert!(ConnectionGuard::acquire(&active, 1).is_none());
        assert_eq!(active.load(Ordering::Relaxed), 1);
    }

    /// A storage backend that always fails, to exercise server-error masking.
    struct FailingStorage;

    impl Storage for FailingStorage {
        fn name(&self) -> &'static str {
            "failing"
        }
        fn store_context(
            &mut self,
            _ctx: &CrossAgentContext,
        ) -> Result<(), crate::storage::StorageError> {
            Err(crate::storage::StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "C:\\secret\\path\\detail",
            )))
        }
        fn query_context(
            &self,
            _project: &str,
            _limit: usize,
        ) -> Result<Vec<CrossAgentContext>, crate::storage::StorageError> {
            Err(crate::storage::StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "C:\\secret\\path\\detail",
            )))
        }
        fn list_sessions(&self) -> Result<Vec<AgentSession>, crate::storage::StorageError> {
            Err(crate::storage::StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "C:\\secret\\path\\detail",
            )))
        }
        fn store_session(&mut self, _s: &AgentSession) -> Result<(), crate::storage::StorageError> {
            Err(crate::storage::StorageError::Io(std::io::Error::new(
                std::io::ErrorKind::Other,
                "C:\\secret\\path\\detail",
            )))
        }
    }

    #[test]
    fn dispatch_masks_server_error_details() {
        let state = AppState::new(
            Box::new(FailingStorage),
            ParserRegistry::new(),
            HashMap::new(),
        );
        let resp = call(
            &state,
            r#"{"id":1,"method":"cacm.query","params":{"project":"/repo"}}"#,
        );
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["error"]["code"], -32000);
        // The filesystem detail must not leak to the client.
        assert_eq!(value["error"]["message"], "internal server error");
        assert!(!value["error"]["message"]
            .as_str()
            .unwrap()
            .contains("C:\\secret"));
    }

    #[test]
    fn origin_allowed_checks_allow_list() {
        let allow = vec!["http://localhost:5173".to_string()];
        // Non-browser clients (no Origin) are always allowed.
        assert!(origin_allowed(None, &allow));
        // Allowed browser origin passes.
        assert!(origin_allowed(Some("http://localhost:5173"), &allow));
        // Anything else is rejected.
        assert!(!origin_allowed(Some("http://evil.example"), &allow));
        assert!(!origin_allowed(
            Some("http://localhost:5173.evil.example"),
            &allow
        ));
        // Empty allow-list: no browser origins accepted.
        assert!(!origin_allowed(Some("http://localhost:5173"), &[]));
    }

    #[test]
    fn notification_serializes_event_shape() {
        let (tx, _) = broadcast::channel(16);
        let mut rx = tx.subscribe(); // keep ≥1 receiver so sends are stored
        let activity = SessionActivity {
            session_id: "fox".into(),
            agent_type: AgentType::Jcode,
            event_type: cacm_core::watcher::SessionEventType::Modified,
            turn: Some(3),
            timestamp: Utc::now(),
        };
        broadcast_activity(&tx, &activity);
        let payload = rx.try_recv().unwrap();
        let value: Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["event"], "cacm.session_activity");
        assert_eq!(value["data"]["session_id"], "fox");
        assert_eq!(value["data"]["agent_type"], "jcode");
    }

    // ---- HTTP-layer WebSocket handshake tests (real server + tungstenite) ----

    /// Spawn the daemon router on an ephemeral loopback port.
    async fn spawn_test_server(state: AppState) -> String {
        let app = build_router(state);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("ws://{addr}/ws")
    }

    #[tokio::test]
    async fn ws_handshake_rejects_disallowed_origin() {
        let mut state = test_state();
        state.allow_origins = Arc::new(vec!["http://ok.example".to_string()]);
        let url = spawn_test_server(state).await;

        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert(ORIGIN, HeaderValue::from_static("http://evil.example"));
        let result = tokio_tungstenite::connect_async(request).await;
        assert!(
            result.is_err(),
            "disallowed origin must fail the handshake (403)"
        );
    }

    #[tokio::test]
    async fn ws_handshake_allows_listed_origin_and_serves_ping() {
        let mut state = test_state();
        state.allow_origins = Arc::new(vec!["http://ok.example".to_string()]);
        let url = spawn_test_server(state).await;

        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert(ORIGIN, HeaderValue::from_static("http://ok.example"));
        let (mut ws, _) = tokio_tungstenite::connect_async(request).await.unwrap();

        use futures_util::{SinkExt, StreamExt};
        ws.send(tokio_tungstenite::tungstenite::Message::Text(
            r#"{"id":1,"method":"cacm.ping","params":{}}"#.into(),
        ))
        .await
        .unwrap();
        let reply = ws.next().await.unwrap().unwrap();
        let text = match reply {
            tokio_tungstenite::tungstenite::Message::Text(t) => t.to_string(),
            other => panic!("expected a text reply, got {other:?}"),
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["id"], 1);
        assert_eq!(value["result"], "pong");
        let _ = ws.close(None).await;
    }

    #[tokio::test]
    async fn ws_handshake_rejects_connections_over_cap() {
        let state = test_state();
        state
            .active_connections
            .store(MAX_CONNECTIONS, Ordering::Relaxed);
        let url = spawn_test_server(state).await;

        let result = tokio_tungstenite::connect_async(&url).await;
        assert!(
            result.is_err(),
            "connection over the cap must fail the handshake (503)"
        );
    }
}
