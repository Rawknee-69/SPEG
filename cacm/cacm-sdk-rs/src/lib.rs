//! cacm-sdk-rs — Rust SDK client for the CACM daemon.
//!
//! Talks to `cacm-daemon` over WebSocket using its JSON-RPC-style protocol
//! (see `cacm-daemon/src/server.rs` for the wire spec):
//!
//! ```text
//! → {"id": 1, "method": "cacm.query", "params": {"project": "/repo", "limit": 10}}
//! ← {"id": 1, "result": {"entries": [...]}}
//! ← {"id": 1, "error": {"code": -32602, "message": "..."}}
//! ← {"event": "cacm.session_activity", "data": {...}}
//! ```
//!
//! The client keeps one persistent WebSocket connection, correlates replies
//! by request id (skipping server-initiated notifications), and reconnects
//! with exponential backoff when the connection drops.
//!
//! # Example
//!
//! ```no_run
//! # async fn demo() -> Result<(), cacm_sdk_rs::CacmError> {
//! use cacm_sdk_rs::CacmClient;
//! let client = CacmClient::connect("ws://127.0.0.1:9786/ws").await?;
//! let entries = client.query("/repo", 10).await?;
//! let sessions = client.sessions("/repo").await?;
//! let reminder = client.inject("ses_abc", "codex").await?;
//! # Ok(())
//! # }
//! ```

use cacm_core::types::{AgentSession, CrossAgentContext};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::net::TcpStream;
use tokio::sync::Mutex;
use tokio::time::{sleep, timeout};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub use cacm_core;
pub use cacm_core::types::{AgentType, ContextType};

/// Default daemon address — matches `cacm-daemon`'s `--port 9786` default
/// and its `/ws` WebSocket route.
pub const DEFAULT_DAEMON_ADDR: &str = "ws://127.0.0.1:9786/ws";

/// Per-request reply timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Initial reconnect delay (doubles per failed attempt).
const BACKOFF_BASE: Duration = Duration::from_millis(100);
/// Ceiling for the reconnect delay.
const BACKOFF_MAX: Duration = Duration::from_secs(10);
/// Connection attempts per request before giving up.
const MAX_CONNECT_ATTEMPTS: usize = 8;

/// Errors returned by the CACM client.
#[derive(Debug)]
pub enum CacmError {
    /// The address could not be parsed into a WebSocket URL.
    InvalidAddress(String),
    /// Connecting to the daemon failed (after backoff retries).
    Connect(String),
    /// The connection broke mid-request (after backoff retries).
    Transport(String),
    /// The daemon did not reply within [`REQUEST_TIMEOUT`].
    Timeout,
    /// The daemon returned a JSON-RPC error object.
    Rpc { code: i32, message: String },
    /// A reply could not be parsed into the expected shape.
    Protocol(String),
}

impl fmt::Display for CacmError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CacmError::InvalidAddress(addr) => write!(f, "invalid daemon address: {addr}"),
            CacmError::Connect(msg) => write!(f, "cannot reach cacm-daemon: {msg}"),
            CacmError::Transport(msg) => write!(f, "cacm-daemon connection lost: {msg}"),
            CacmError::Timeout => write!(f, "cacm-daemon did not reply in time"),
            CacmError::Rpc { code, message } => write!(f, "cacm-daemon error ({code}): {message}"),
            CacmError::Protocol(msg) => write!(f, "invalid cacm-daemon reply: {msg}"),
        }
    }
}

impl std::error::Error for CacmError {}

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;

/// Client for the CACM daemon's WebSocket JSON-RPC surface.
///
/// `connect` validates the address; the actual socket is opened lazily on the
/// first request and reused until it breaks, then reconnected with exponential
/// backoff. All public methods are idempotent reads, so a lost reply can be
/// safely retried.
pub struct CacmClient {
    addr: String,
    next_id: AtomicU64,
    /// Live connection, if any. Held behind a mutex so concurrent callers
    /// serialize requests (the SDK's request/reply correlation is per-client).
    conn: Mutex<Option<WsStream>>,
}

impl CacmClient {
    /// Connect to the daemon at `addr` (e.g. `ws://127.0.0.1:9786/ws`).
    ///
    /// A bare `host:port` is normalized to `ws://host:port/ws`. The address
    /// defaults to [`DEFAULT_DAEMON_ADDR`] when empty.
    pub async fn connect(addr: &str) -> Result<Self, CacmError> {
        let addr = normalize_addr(addr)?;
        Ok(Self {
            addr,
            next_id: AtomicU64::new(0),
            conn: Mutex::new(None),
        })
    }

    /// `cacm.query` — stored cross-agent context for `project`, newest first,
    /// capped at `limit` (daemon clamps to 1..=100).
    pub async fn query(
        &self,
        project: &str,
        limit: usize,
    ) -> Result<Vec<CrossAgentContext>, CacmError> {
        let result = self
            .request("cacm.query", json!({ "project": project, "limit": limit }))
            .await?;
        let entries = result
            .get("entries")
            .ok_or_else(|| CacmError::Protocol("cacm.query reply missing 'entries'".into()))?;
        serde_json::from_value(entries.clone())
            .map_err(|e| CacmError::Protocol(format!("bad entries: {e}")))
    }

    /// `cacm.sessions` — live agent sessions, optionally filtered to
    /// `project`.
    pub async fn sessions(&self, project: &str) -> Result<Vec<AgentSession>, CacmError> {
        let result = self
            .request("cacm.sessions", json!({ "project": project }))
            .await?;
        let sessions = result
            .get("sessions")
            .ok_or_else(|| CacmError::Protocol("cacm.sessions reply missing 'sessions'".into()))?;
        serde_json::from_value(sessions.clone())
            .map_err(|e| CacmError::Protocol(format!("bad sessions: {e}")))
    }

    /// `cacm.inject` — cross-agent context formatted for `agent`'s next turn
    /// in `session`, ready to paste into a system reminder.
    pub async fn inject(&self, session: &str, agent: &str) -> Result<String, CacmError> {
        let result = self
            .request(
                "cacm.inject",
                json!({ "sessionId": session, "agent": agent }),
            )
            .await?;
        result
            .get("formatted")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| CacmError::Protocol("cacm.inject reply missing 'formatted'".into()))
    }

    /// `cacm.ping` — liveness check, returns `"pong"`.
    pub async fn ping(&self) -> Result<String, CacmError> {
        let result = self.request("cacm.ping", json!({})).await?;
        result
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| CacmError::Protocol("cacm.ping reply is not a string".into()))
    }

    /// Send one request, retrying transport failures with exponential backoff.
    ///
    /// JSON-RPC errors (`Rpc`) and protocol/parse failures are returned
    /// immediately; connection/transport failures drop the socket and retry.
    async fn request(&self, method: &str, params: Value) -> Result<Value, CacmError> {
        let mut attempt = 0usize;
        let mut backoff = BACKOFF_BASE;
        loop {
            match self.try_request(method, params.clone()).await {
                Ok(reply) => return Ok(reply),
                // Daemon-side errors and bad replies: nothing to retry.
                Err(error @ CacmError::Rpc { .. })
                | Err(error @ CacmError::Protocol(_))
                | Err(error @ CacmError::InvalidAddress(_)) => return Err(error),
                // Transport/connection/timeout: drop the dead socket and retry
                // with backoff up to the attempt budget.
                Err(error) => {
                    self.drop_connection().await;
                    attempt += 1;
                    if attempt >= MAX_CONNECT_ATTEMPTS {
                        return Err(error);
                    }
                    sleep(backoff).await;
                    backoff = (backoff * 2).min(BACKOFF_MAX);
                }
            }
        }
    }

    /// One request attempt on the current (possibly freshly opened) socket.
    async fn try_request(&self, method: &str, params: Value) -> Result<Value, CacmError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut conn = self.conn.lock().await;
        if conn.is_none() {
            *conn = Some(self.open_connection().await?);
        }
        let ws = conn.as_mut().expect("connection just ensured");

        let frame = json!({ "id": id, "method": method, "params": params }).to_string();
        ws.send(Message::Text(frame))
            .await
            .map_err(|e| CacmError::Transport(e.to_string()))?;

        let reply = timeout(REQUEST_TIMEOUT, Self::await_reply(ws, id))
            .await
            .map_err(|_| CacmError::Timeout)??;
        Ok(reply)
    }

    /// Read frames until the reply matching `id` arrives, skipping
    /// notifications (`{"event": ...}`) and other requests' replies.
    async fn await_reply(ws: &mut WsStream, id: u64) -> Result<Value, CacmError> {
        loop {
            match ws.next().await {
                Some(Ok(Message::Text(text))) => {
                    let frame: Value = serde_json::from_str(&text)
                        .map_err(|e| CacmError::Protocol(format!("unparseable frame: {e}")))?;
                    if frame.get("event").is_some() {
                        continue; // server-initiated notification
                    }
                    if frame.get("id").and_then(Value::as_u64) != Some(id) {
                        continue; // someone else's reply (shouldn't happen; serialized)
                    }
                    if let Some(error) = frame.get("error") {
                        let code = error.get("code").and_then(Value::as_i64).unwrap_or(0) as i32;
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown error")
                            .to_string();
                        return Err(CacmError::Rpc { code, message });
                    }
                    return frame
                        .get("result")
                        .cloned()
                        .ok_or_else(|| CacmError::Protocol("reply missing 'result'".into()));
                }
                Some(Ok(Message::Ping(payload))) => {
                    // Keep the daemon's liveness probe answered.
                    ws.send(Message::Pong(payload))
                        .await
                        .map_err(|e| CacmError::Transport(e.to_string()))?;
                }
                Some(Ok(Message::Pong(_))) => {}
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => {
                    return Err(CacmError::Transport("connection closed".into()));
                }
                Some(Ok(Message::Binary(_))) | Some(Ok(Message::Frame(_))) => {
                    return Err(CacmError::Protocol("unexpected binary frame".into()));
                }
            }
        }
    }

    /// Open a fresh WebSocket connection (one attempt; backoff is the caller's
    /// job).
    async fn open_connection(&self) -> Result<WsStream, CacmError> {
        let request = self
            .addr
            .as_str()
            .into_client_request()
            .map_err(|e| CacmError::InvalidAddress(format!("{}: {e}", self.addr)))?;
        let (ws, _response) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| CacmError::Connect(e.to_string()))?;
        Ok(ws)
    }

    async fn drop_connection(&self) {
        *self.conn.lock().await = None;
    }
}

/// Normalize a user-supplied address into a full `ws://` URL with the daemon's
/// `/ws` route. Accepts `host:port`, `host:port/ws`, `ws://host:port/ws`, or
/// `wss://...` (kept as-is).
fn normalize_addr(addr: &str) -> Result<String, CacmError> {
    let addr = addr.trim();
    if addr.is_empty() {
        return Ok(DEFAULT_DAEMON_ADDR.to_string());
    }
    if addr.starts_with("ws://") || addr.starts_with("wss://") {
        return Ok(addr.to_string());
    }
    let host_port = addr
        .strip_suffix("/ws")
        .unwrap_or(addr)
        .trim_end_matches('/');
    if host_port.is_empty() || host_port.contains(char::is_whitespace) || host_port.contains("://")
    {
        return Err(CacmError::InvalidAddress(addr.to_string()));
    }
    Ok(format!("ws://{host_port}/ws"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cacm_core::types::{AgentType, SessionStatus};
    use std::sync::Arc;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    /// Spawn a mock daemon: accepts connections and serves the JSON-RPC-style
    /// protocol through `handler(method, params) -> result` (or an error
    /// object when `handler` returns `Err`).
    ///
    /// Returns the `ws://127.0.0.1:<port>/ws` address and a shutdown signal.
    async fn spawn_mock_daemon(
        handler: impl Fn(&str, &Value) -> Result<Value, (i32, String)> + Send + Sync + 'static,
    ) -> (String, oneshot::Sender<()>) {
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
        let (addr_tx, addr_rx) = oneshot::channel::<String>();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let addr = listener.local_addr().expect("local addr");
            let _ = addr_tx.send(format!("ws://{addr}/ws"));
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { continue };
                        let handler = handler.clone();
                        tokio::spawn(async move {
                            let mut ws = match tokio_tungstenite::accept_async(stream).await {
                                Ok(ws) => ws,
                                Err(_) => return,
                            };
                            while let Some(Ok(Message::Text(text))) = ws.next().await {
                                let frame: Value = match serde_json::from_str(&text) {
                                    Ok(frame) => frame,
                                    Err(_) => continue,
                                };
                                let id = frame.get("id").cloned().unwrap_or(Value::Null);
                                let method = frame
                                    .get("method")
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .to_string();
                                let params = frame.get("params").cloned().unwrap_or(Value::Null);
                                let reply = match handler(&method, &params) {
                                    Ok(result) => json!({ "id": id, "result": result }),
                                    Err((code, message)) => {
                                        json!({ "id": id, "error": { "code": code, "message": message } })
                                    }
                                };
                                if ws
                                    .send(Message::Text(reply.to_string()))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        });
                    }
                }
            }
        });
        let addr = addr_rx.await.expect("mock daemon address");
        (addr, shutdown_tx)
    }

    fn sample_entry(id: &str, session: &str) -> CrossAgentContext {
        CrossAgentContext {
            id: id.into(),
            session_id: session.into(),
            agent_type: AgentType::Codex,
            context_type: ContextType::Decision,
            content: "use the workspace resolver".into(),
            file_paths: vec!["Cargo.toml".into()],
            decisions: vec!["resolver = 2".into()],
            errors: vec![],
            project: None,
            timestamp: chrono::Utc::now(),
        }
    }

    #[tokio::test]
    async fn query_roundtrip_parses_entries() {
        let (addr, _shutdown) = spawn_mock_daemon(|method, params| {
            assert_eq!(method, "cacm.query");
            assert_eq!(params["project"], "/repo");
            assert_eq!(params["limit"], 5);
            Ok(json!({ "entries": [sample_entry("c1", "s1")] }))
        })
        .await;
        let client = CacmClient::connect(&addr).await.unwrap();
        let entries = client.query("/repo", 5).await.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "c1");
        assert_eq!(entries[0].session_id, "s1");
    }

    #[tokio::test]
    async fn sessions_roundtrip_parses_sessions() {
        let (addr, _shutdown) = spawn_mock_daemon(|method, params| {
            assert_eq!(method, "cacm.sessions");
            assert_eq!(params["project"], "/repo");
            Ok(json!({
                "sessions": [{
                    "session_id": "s9",
                    "agent_type": "codex",
                    "path": "/repo/s9.jsonl",
                    "created_at": "2026-01-01T00:00:00Z",
                    "status": "active"
                }]
            }))
        })
        .await;
        let client = CacmClient::connect(&addr).await.unwrap();
        let sessions = client.sessions("/repo").await.unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "s9");
        assert_eq!(sessions[0].agent_type, AgentType::Codex);
        assert_eq!(sessions[0].status, SessionStatus::Active);
    }

    #[tokio::test]
    async fn inject_roundtrip_returns_formatted() {
        let (addr, _shutdown) = spawn_mock_daemon(|method, params| {
            assert_eq!(method, "cacm.inject");
            assert_eq!(params["sessionId"], "ses_abc");
            assert_eq!(params["agent"], "codex");
            Ok(json!({ "formatted": "[Cross-Agent Context]\n• Task: hi (codex, 5m ago)" }))
        })
        .await;
        let client = CacmClient::connect(&addr).await.unwrap();
        let formatted = client.inject("ses_abc", "codex").await.unwrap();
        assert!(formatted.starts_with("[Cross-Agent Context]"));
    }

    #[tokio::test]
    async fn reply_correlation_skips_notifications() {
        let (addr, _shutdown) = {
            // A daemon that sends a notification frame before the reply.
            let (addr_tx, addr_rx) = oneshot::channel::<String>();
            let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
            tokio::spawn(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let _ = addr_tx.send(format!("ws://{addr}/ws"));
                let (stream, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                // Read the request first.
                let _ = ws.next().await;
                // Notification then correlated reply.
                ws.send(Message::Text(
                    json!({"event": "cacm.session_activity", "data": {}}).to_string(),
                ))
                .await
                .unwrap();
                ws.send(Message::Text(
                    json!({"id": 1, "result": {"entries": []}}).to_string(),
                ))
                .await
                .unwrap();
                let _ = shutdown_rx.await;
            });
            let addr = addr_rx.await.unwrap();
            (addr, shutdown_tx)
        };
        let client = CacmClient::connect(&addr).await.unwrap();
        let entries = client.query("/repo", 10).await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn rpc_error_is_propagated_not_retried() {
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let calls2 = calls.clone();
        let (addr, _shutdown) = spawn_mock_daemon(move |method, _params| {
            assert_eq!(method, "cacm.query");
            calls2.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err((-32602, "missing required param 'project'".to_string()))
        })
        .await;
        let client = CacmClient::connect(&addr).await.unwrap();
        let err = client.query("", 10).await.unwrap_err();
        match err {
            CacmError::Rpc { code, message } => {
                assert_eq!(code, -32602);
                assert!(message.contains("project"));
            }
            other => panic!("expected Rpc error, got {other:?}"),
        }
        // Exactly one attempt: RPC errors are not retried.
        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn reconnects_with_backoff_after_drop() {
        // First connection is dropped immediately; the client must reconnect
        // and complete the request on the second connection.
        let (addr, _shutdown) = {
            let (addr_tx, addr_rx) = oneshot::channel::<String>();
            let (shutdown_tx, mut shutdown_rx) = oneshot::channel::<()>();
            let served = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            tokio::spawn(async move {
                let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
                let addr = listener.local_addr().unwrap();
                let _ = addr_tx.send(format!("ws://{addr}/ws"));
                loop {
                    tokio::select! {
                        _ = &mut shutdown_rx => break,
                        accepted = listener.accept() => {
                            let Ok((stream, _)) = accepted else { continue };
                            let served = served.clone();
                            tokio::spawn(async move {
                                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                                if served.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                                    // First connection: close before any request.
                                    let _ = ws.close(None).await;
                                    return;
                                }
                                if let Some(Ok(Message::Text(text))) = ws.next().await {
                                    let frame: Value = serde_json::from_str(&text).unwrap();
                                    let id = frame["id"].clone();
                                    ws.send(Message::Text(
                                        json!({"id": id, "result": {"entries": []}}).to_string(),
                                    ))
                                    .await
                                    .unwrap();
                                }
                            });
                        }
                    }
                }
            });
            let addr = addr_rx.await.unwrap();
            (addr, shutdown_tx)
        };
        let client = CacmClient::connect(&addr).await.unwrap();
        let entries = client.query("/repo", 10).await.unwrap();
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn address_normalization() {
        assert_eq!(normalize_addr("").unwrap(), DEFAULT_DAEMON_ADDR);
        assert_eq!(
            normalize_addr("127.0.0.1:9786").unwrap(),
            "ws://127.0.0.1:9786/ws"
        );
        assert_eq!(
            normalize_addr("127.0.0.1:9786/ws").unwrap(),
            "ws://127.0.0.1:9786/ws"
        );
        assert_eq!(
            normalize_addr("ws://localhost:9999/ws").unwrap(),
            "ws://localhost:9999/ws"
        );
        assert!(normalize_addr("http://evil").is_err());
        assert!(normalize_addr("bad addr").is_err());
    }
}
