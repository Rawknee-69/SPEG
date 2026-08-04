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
use crate::storage::Storage;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
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
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;

/// Capacity of the session-activity broadcast channel (per daemon).
pub const EVENT_CHANNEL_CAPACITY: usize = 128;

/// A client request frame.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    /// Client-chosen correlation id (number or string).
    pub id: Value,
    /// Method name, e.g. `cacm.query`.
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
    /// In-flight request ids → method, for request/reply correlation.
    pub pending: Arc<Mutex<HashMap<String, PendingRequest>>>,
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

/// Build the axum router (WebSocket + health endpoint + CORS).
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/ws", get(ws_handler))
        .route("/healthz", get(health))
        .layer(CorsLayer::permissive())
        .with_state(state)
}

/// HTTP health check — plain JSON, no WebSocket upgrade required.
async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let (storage_name, session_count) = {
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
        (storage.name().to_string(), sessions)
    };
    let body = json!({
        "status": "ok",
        "storage": storage_name,
        "sessions": session_count,
        "pending": state.pending_count(),
        "uptime_secs": (Utc::now() - state.started_at).num_seconds(),
        "version": env!("CARGO_PKG_VERSION"),
    });
    (StatusCode::OK, Json(body))
}

/// WebSocket upgrade handler.
pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

/// Per-connection loop: dispatch incoming frames and forward replies +
/// broadcast notifications back over the socket.
async fn handle_socket(mut socket: WebSocket, state: AppState) {
    let mut event_rx = state.events.subscribe();
    loop {
        tokio::select! {
            maybe = socket.recv() => {
                match maybe {
                    Some(Ok(Message::Text(text))) => {
                        let payload = dispatch(&state, &text);
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
/// Always returns a serialized [`RpcResponse`]; JSON-RPC mandates a reply for
/// every message (id is `null` when the frame could not be parsed).
pub fn dispatch(state: &AppState, raw: &str) -> String {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(value) => value,
        Err(_) => return response_json(RpcResponse::err(Value::Null, RpcError::parse_error())),
    };

    // Reject batch arrays (out of scope) and frames without scalar ids.
    let id = match parsed.get("id") {
        Some(id) if id.is_number() || id.is_string() => id.clone(),
        _ => {
            return response_json(RpcResponse::err(
                Value::Null,
                RpcError::invalid_request("request must carry a numeric or string 'id'"),
            ))
        }
    };
    let method = parsed
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if method.is_empty() {
        return response_json(RpcResponse::err(
            id,
            RpcError::invalid_request("request must carry a non-empty 'method'"),
        ));
    }
    let params = parsed.get("params").cloned().unwrap_or_else(|| json!({}));

    // Request/reply correlation: a still-in-flight id is a duplicate.
    let id_key = id.to_string();
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

    let response = match result {
        Ok(value) => RpcResponse::ok(id, value),
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
        "cacm.context.store" => {
            let mut storage = state
                .storage
                .lock()
                .map_err(|_| RpcError::server_error("storage lock poisoned"))?;
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
        let resp = dispatch(&state, r#"{"id":1,"method":"cacm.ping","params":{}}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["id"], 1);
        assert_eq!(value["result"], "pong");
        assert!(value.get("error").is_none());
    }

    #[test]
    fn dispatch_query_returns_entries() {
        let state = test_state();
        seed(&state, "c1", "s1", "/repo/a.rs");
        let resp = dispatch(
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
        let resp = dispatch(&state, r#"{"id":3,"method":"cacm.sessions","params":{}}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["result"]["sessions"].as_array().unwrap().len(), 1);

        let resp = dispatch(
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
        let resp = dispatch(&state, r#"{"id":1,"method":"cacm.nope","params":{}}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["error"]["code"], -32601);

        let resp = dispatch(&state, r#"{"method":"cacm.ping"}"#);
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["error"]["code"], -32600);
        assert_eq!(value["id"], Value::Null);
    }

    #[test]
    fn dispatch_malformed_json_returns_parse_error() {
        let state = test_state();
        let resp = dispatch(&state, "not json {");
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
                "7".into(),
                PendingRequest {
                    method: "cacm.ping".into(),
                    started_at: Instant::now(),
                },
            );
        }
        let resp = dispatch(&state, r#"{"id":7,"method":"cacm.ping","params":{}}"#);
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
    fn dispatch_clears_pending_after_success() {
        let state = test_state();
        dispatch(&state, r#"{"id":9,"method":"cacm.ping","params":{}}"#);
        assert_eq!(state.pending_count(), 0);
    }

    #[test]
    fn dispatch_store_context_extension() {
        let state = test_state();
        let resp = dispatch(
            &state,
            r#"{"id":5,"method":"cacm.context.store","params":{"context":{
                "id":"ctx-5","session_id":"s5","agent_type":"codex","context_type":"pattern",
                "content":"always use the resolver","file_paths":["/repo/Cargo.toml"],
                "decisions":[],"errors":[],"timestamp":"2026-01-01T00:00:00Z"
            }}}"#,
        );
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["result"]["stored"], "ctx-5");
        let resp = dispatch(
            &state,
            r#"{"id":6,"method":"cacm.query","params":{"project":"/repo"}}"#,
        );
        let value: Value = serde_json::from_str(&resp).unwrap();
        assert_eq!(value["result"]["entries"][0]["id"], "ctx-5");
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
}
