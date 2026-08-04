//! JSON-RPC method handlers.
//!
//! Each handler takes parsed params and returns a JSON [`serde_json::Value`]
//! result, or an [`RpcError`]. Handlers are pure with respect to the storage
//! and session-index they are given, which keeps them unit-testable without a
//! running server.
//!
//! Wire methods (task 1.4 API spec):
//!
//! - `cacm.ping` → `"pong"`
//! - `cacm.query` → `{"entries": [...]}`
//! - `cacm.sessions` → `{"sessions": [...]}`
//! - `cacm.inject` → `{"formatted": "[Cross-Agent Context]\\n• ..."}`
//!
//! Plus one additive extension used by the context extractor (task 1.6):
//!
//! - `cacm.context.store` → `{"stored": "<context id>"}`

use crate::server::RpcError;
use crate::storage::Storage;
use cacm_core::types::{AgentSession, CrossAgentContext};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

/// Default number of entries returned by `cacm.query`.
pub const DEFAULT_QUERY_LIMIT: usize = 10;
/// Hard cap on entries returned by `cacm.query`.
pub const MAX_QUERY_LIMIT: usize = 100;
/// Maximum entries formatted by `cacm.inject`.
pub const INJECT_LIMIT: usize = 20;

/// `cacm.ping` → `"pong"`.
pub fn handle_ping() -> Value {
    json!("pong")
}

/// `cacm.query` — params `{"project": "...", "limit": N}` → `{"entries": [...]}`.
pub fn handle_query(storage: &dyn Storage, params: &Value) -> Result<Value, RpcError> {
    let project = params
        .get("project")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if project.is_empty() {
        return Err(RpcError::invalid_params(
            "missing required param 'project' (string)",
        ));
    }
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|l| l as usize)
        .unwrap_or(DEFAULT_QUERY_LIMIT)
        .clamp(1, MAX_QUERY_LIMIT);

    let entries = storage.query_context(project, limit)?;
    Ok(json!({ "entries": entries }))
}

/// `cacm.sessions` — params `{"project": "..."}` → `{"sessions": [...]}`.
///
/// Sessions come from the daemon's live session index (hydrated from
/// [`Storage::list_sessions`] at startup and updated by the watcher). When
/// `project` is given, only sessions whose path or id mentions it are
/// returned.
pub fn handle_sessions(
    sessions: &Mutex<HashMap<String, AgentSession>>,
    params: &Value,
) -> Result<Value, RpcError> {
    let project = params
        .get("project")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let guard = sessions
        .lock()
        .map_err(|_| RpcError::server_error("session index lock poisoned"))?;
    let mut all: Vec<AgentSession> = guard.values().cloned().collect();
    drop(guard);
    if !project.is_empty() {
        // Same separator-aware rules as cacm.query (via storage::path_within),
        // plus an exact session-id match for directory-named sessions.
        all.retain(|s| {
            s.session_id == project
                || crate::storage::path_within(&s.path.to_string_lossy(), project)
        });
    }
    all.sort_by_key(|s| s.created_at);
    Ok(json!({ "sessions": all }))
}

/// `cacm.inject` — params `{"sessionId": "...", "agent": "..."}`
/// → `{"formatted": "[Cross-Agent Context]\n• ..."}`.
///
/// Queries context for the given session (falling back to any stored context
/// when the session has none yet) and formats it as markdown-ish bullets
/// intended to be injected into another agent's prompt.
pub fn handle_inject(storage: &dyn Storage, params: &Value) -> Result<Value, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if session_id.is_empty() {
        return Err(RpcError::invalid_params(
            "missing required param 'sessionId' (string)",
        ));
    }
    let agent = params
        .get("agent")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");

    let mut entries = storage.query_context(session_id, INJECT_LIMIT)?;
    if entries.is_empty() {
        // Nothing attributed to this session yet — share the latest context.
        entries = storage.query_context("*", INJECT_LIMIT)?;
    }
    Ok(json!({ "formatted": format_inject(session_id, agent, &entries) }))
}

/// Format stored context as injectable text.
pub fn format_inject(session_id: &str, agent: &str, entries: &[CrossAgentContext]) -> String {
    let mut out = String::from("[Cross-Agent Context]");
    if entries.is_empty() {
        out.push_str("\nNo cross-agent context available yet.");
        return out;
    }
    for ctx in entries.iter().take(INJECT_LIMIT) {
        out.push_str(&format!(
            "\n• ({}) {} — from session {} ({})",
            context_type_str(ctx.context_type),
            ctx.content,
            ctx.session_id,
            ctx.agent_type
        ));
    }
    if agent.is_empty() {
        out.push_str(&format!("\n— prepared for session {session_id}"));
    } else {
        out.push_str(&format!("\n— prepared for {agent} (session {session_id})"));
    }
    out
}

/// Kebab-case wire name of a context type (mirrors the serde rename).
fn context_type_str(t: cacm_core::types::ContextType) -> &'static str {
    use cacm_core::types::ContextType;
    match t {
        ContextType::Task => "task",
        ContextType::Decision => "decision",
        ContextType::FileChange => "file-change",
        ContextType::Error => "error",
        ContextType::Pattern => "pattern",
    }
}

/// `cacm.context.store` (extension) — params
/// `{"context": {CrossAgentContext}}` → `{"stored": "<id>"}`.
///
/// Not part of the task-1.4 wire spec; added so the extractor (task 1.6) has
/// a storage endpoint and the store path is exercisable over the wire.
pub fn handle_store_context(storage: &mut dyn Storage, params: &Value) -> Result<Value, RpcError> {
    let ctx_value = params
        .get("context")
        .cloned()
        .unwrap_or_else(|| params.clone());
    let ctx: CrossAgentContext = serde_json::from_value(ctx_value)
        .map_err(|e| RpcError::invalid_params(format!("invalid context object: {e}")))?;
    storage.store_context(&ctx)?;
    Ok(json!({ "stored": ctx.id }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::{JcodeBackend, MemoryGraph, Storage};
    use cacm_core::types::{AgentType, ContextType, SessionStatus};
    use chrono::Utc;
    use std::path::PathBuf;

    fn test_backend() -> JcodeBackend {
        JcodeBackend::new(PathBuf::from("C:\\nonexistent\\jcode-api.sock"))
    }

    fn seed_context(backend: &mut dyn Storage, id: &str, session: &str, path: &str) {
        backend
            .store_context(&CrossAgentContext {
                id: id.into(),
                session_id: session.into(),
                agent_type: AgentType::ClaudeCode,
                context_type: ContextType::Decision,
                content: format!("decision about {id}"),
                file_paths: vec![path.into()],
                decisions: vec![],
                errors: vec![],
                timestamp: Utc::now(),
            })
            .unwrap();
    }

    #[test]
    fn ping_returns_pong() {
        assert_eq!(handle_ping(), json!("pong"));
    }

    #[test]
    fn query_requires_project() {
        let backend = test_backend();
        let err = handle_query(&backend, &json!({})).unwrap_err();
        assert_eq!(err.code, -32602);
    }

    #[test]
    fn query_returns_matching_entries_with_limit() {
        let mut backend = test_backend();
        seed_context(&mut backend, "c1", "s1", "/repo/a.rs");
        seed_context(&mut backend, "c2", "s2", "/other/b.rs");

        let result = handle_query(&backend, &json!({"project": "/repo"})).unwrap();
        assert_eq!(result["entries"].as_array().unwrap().len(), 1);

        let limited = handle_query(&backend, &json!({"project": "*", "limit": 1})).unwrap();
        assert_eq!(limited["entries"].as_array().unwrap().len(), 1);

        // Limit above the cap is clamped.
        let capped = handle_query(&backend, &json!({"project": "*", "limit": 10_000})).unwrap();
        assert_eq!(
            capped["entries"].as_array().unwrap().len(),
            MAX_QUERY_LIMIT.min(2)
        );
    }

    #[test]
    fn sessions_filters_and_sorts() {
        let index = Mutex::new(HashMap::from([
            (
                "s1".to_string(),
                AgentSession::new("s1", AgentType::Jcode, "/repo/s1", Utc::now()),
            ),
            (
                "s2".to_string(),
                AgentSession::new("s2", AgentType::Speg, "/other/s2", Utc::now()),
            ),
        ]));
        let all = handle_sessions(&index, &json!({})).unwrap();
        assert_eq!(all["sessions"].as_array().unwrap().len(), 2);

        let filtered = handle_sessions(&index, &json!({"project": "/repo"})).unwrap();
        let filtered = filtered["sessions"].as_array().unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0]["session_id"], "s1");
    }

    #[test]
    fn inject_formats_bullets_and_prepares_for_agent() {
        let mut backend = test_backend();
        seed_context(&mut backend, "c1", "abc", "/repo/a.rs");
        seed_context(&mut backend, "c2", "abc", "/repo/b.rs");

        let result = handle_inject(
            &backend,
            &json!({"sessionId": "abc", "agent": "claude-code"}),
        )
        .unwrap();
        let formatted = result["formatted"].as_str().unwrap();
        assert!(formatted.starts_with("[Cross-Agent Context]\n• (decision)"));
        assert!(formatted.contains("— from session abc (claude-code)"));
        assert!(formatted.contains("— prepared for claude-code (session abc)"));
        assert!(formatted.matches('•').count() == 2);
    }

    #[test]
    fn inject_requires_session_id() {
        let backend = test_backend();
        assert!(handle_inject(&backend, &json!({})).is_err());
    }

    #[test]
    fn inject_falls_back_to_any_context_when_session_has_none() {
        let mut backend = test_backend();
        seed_context(&mut backend, "c1", "other-session", "/repo/a.rs");
        let result =
            handle_inject(&backend, &json!({"sessionId": "unknown", "agent": "codex"})).unwrap();
        let formatted = result["formatted"].as_str().unwrap();
        assert!(formatted.contains("other-session"));
    }

    #[test]
    fn inject_empty_returns_placeholder() {
        let backend = test_backend();
        let result = handle_inject(&backend, &json!({"sessionId": "abc"})).unwrap();
        assert_eq!(
            result["formatted"],
            "[Cross-Agent Context]\nNo cross-agent context available yet."
        );
    }

    #[test]
    fn store_context_extension_roundtrip() {
        let mut backend = test_backend();
        let ctx = json!({
            "id": "ctx-9",
            "session_id": "s9",
            "agent_type": "codex",
            "context_type": "task",
            "content": "build the thing",
            "file_paths": ["/repo/x.rs"],
            "decisions": [],
            "errors": [],
            "timestamp": "2026-01-01T00:00:00Z",
        });
        let stored = handle_store_context(&mut backend, &json!({"context": ctx})).unwrap();
        assert_eq!(stored["stored"], "ctx-9");
        let queried = handle_query(&backend, &json!({"project": "/repo"})).unwrap();
        assert_eq!(queried["entries"][0]["id"], "ctx-9");
        assert_eq!(queried["entries"][0]["agent_type"], "codex");
    }

    #[test]
    fn store_context_rejects_invalid_object() {
        let mut backend = test_backend();
        let err = handle_store_context(&mut backend, &json!({"context": {"id": 1}})).unwrap_err();
        assert_eq!(err.code, -32602);
    }

    #[test]
    fn memory_graph_reachable_via_trait() {
        let mut graph = MemoryGraph::new();
        graph.store_session(&AgentSession {
            session_id: "s1".into(),
            agent_type: AgentType::Jcode,
            path: PathBuf::from("/x"),
            created_at: Utc::now(),
            status: SessionStatus::Active,
        });
        assert_eq!(graph.list_sessions().len(), 1);
    }
}
