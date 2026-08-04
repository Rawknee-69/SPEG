//! cacm-daemon — the RUNNING PROCESS of CACM.
//!
//! Watches agent session directories, serves the JSON-RPC-style WebSocket
//! API, and pushes `cacm.session_activity` notifications. One daemon serves
//! all clients (Jcode, SPEG web, any tool).

use cacm_core::parsers::ParserRegistry;
use cacm_core::types::AgentSession;
use cacm_core::watcher::{default_agent_dirs, SessionActivity, SessionWatcher};
use cacm_daemon::server::{broadcast_activity, build_router, AppState};
use cacm_daemon::storage;
use clap::Parser;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(
    name = "cacm-daemon",
    version,
    about = "Cross-Agent Context Manager daemon: HTTP + WebSocket server watching agent sessions"
)]
struct Cli {
    /// TCP port for the HTTP + WebSocket server.
    #[arg(long, default_value_t = 9786)]
    port: u16,

    /// Address to bind. Defaults to loopback: the daemon serves session and
    /// context data with no authentication, so it must not be exposed to the
    /// network unless you know what you are doing.
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// Allowed browser `Origin` for WebSocket connections (repeatable). The
    /// daemon is unauthenticated; browsers are rejected until an origin is
    /// explicitly allowed here (e.g. --allow-origin http://localhost:5173).
    #[arg(long, value_name = "ORIGIN")]
    allow_origin: Vec<String>,

    /// Explicitly allow binding to a non-loopback `--host`. The daemon is
    /// unauthenticated and serves raw session context, so binding off-loopback
    /// without this flag is refused.
    #[arg(long)]
    expose: bool,

    /// Jcode home directory; the harness API socket is resolved under it as
    /// `<home>/jcode-api.sock` (default: JCODE_API_SOCKET / runtime-dir rules).
    #[arg(long)]
    jcode_home: Option<PathBuf>,

    /// SQLite database path for the fallback backend
    /// (default: ~/.cacm/cacm.db).
    #[arg(long)]
    db_path: Option<PathBuf>,
}

/// Is `host` a loopback address? Anything else exposes the unauthenticated
/// daemon to the network and requires `--expose`. Conservative: unknown host
/// names (other than `localhost`) are treated as non-loopback.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    host == "localhost"
        || host == "127.0.0.1"
        || host == "::1"
        || host == "[::1]"
        || host.starts_with("127.")
        || host.starts_with("::ffff:127.")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,cacm_daemon=debug"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let cli = Cli::parse();
    if !is_loopback_host(&cli.host) && !cli.expose {
        return Err(format!(
            "refusing to bind to non-loopback host '{}': the daemon is unauthenticated \
             and serves session context; pass --expose to override",
            cli.host
        )
        .into());
    }
    tracing::info!(
        port = cli.port,
        host = %cli.host,
        expose = cli.expose,
        allow_origin = ?cli.allow_origin,
        jcode_home = ?cli.jcode_home,
        db_path = ?cli.db_path,
        "starting cacm-daemon"
    );

    // Storage: try the Jcode harness API backend first, fall back to SQLite.
    let mut storage_box =
        storage::select_backend(cli.jcode_home.as_deref(), cli.db_path.as_deref()).await?;
    tracing::info!(backend = storage_box.name(), "storage backend selected");

    // Session index: hydrate from persisted sessions, then overlay a
    // best-effort scan of the default agent directories.
    let mut sessions: HashMap<String, AgentSession> = storage_box
        .list_sessions()?
        .into_iter()
        .map(|s| (s.session_id.clone(), s))
        .collect();
    for scanned in scan_default_dirs() {
        if !sessions.contains_key(&scanned.session_id) {
            let _ = storage_box.store_session(&scanned);
        }
        sessions.insert(scanned.session_id.clone(), scanned);
    }
    tracing::info!(count = sessions.len(), "session index seeded");

    // Watcher: watch agent session dirs for activity.
    let (mut watcher, activity_rx) = SessionWatcher::new()?;
    let watched = watcher.watch_defaults()?;
    tracing::info!(dirs = watched, "watching agent session directories");

    // Parser registry: concrete parsers land in task 1.5; registered here so
    // the daemon has the extension point wired up.
    let registry = ParserRegistry::new();

    let mut state = AppState::new(storage_box, registry, sessions);
    state.allow_origins = Arc::new(cli.allow_origin);

    // Forward watcher activity → session index, storage, and clients.
    tokio::spawn(watcher_task(activity_rx, state.clone()));

    // HTTP + WebSocket server. Loopback by default (see `--host`).
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind((cli.host.as_str(), cli.port)).await?;
    let addr = listener.local_addr()?;
    tracing::info!(%addr, "cacm-daemon listening (ws://{addr}/ws, http://{addr}/healthz)");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("cacm-daemon stopped");
    Ok(())
}

/// Watch loop: record sessions seen by the watcher and broadcast activity.
///
/// The index is upserted (never just first-seen), and a poisoned index lock
/// must not swallow the storage write or the client notification.
async fn watcher_task(mut rx: mpsc::Receiver<SessionActivity>, state: AppState) {
    while let Some(activity) = rx.recv().await {
        let session = session_from_activity(&activity);
        match state.sessions.lock() {
            Ok(mut index) => {
                index.insert(session.session_id.clone(), session.clone());
            }
            Err(_) => {
                tracing::warn!("session index lock poisoned — skipping index update");
            }
        }
        if let Ok(mut storage) = state.storage.lock() {
            let _ = storage.store_session(&session);
        } else {
            tracing::warn!("storage lock poisoned — skipping session persist");
        }
        broadcast_activity(&state.events, &activity);
        tracing::debug!(
            session = %activity.session_id,
            agent = %activity.agent_type,
            event = ?activity.event_type,
            "session activity"
        );
    }
}

/// Best-effort scan of the default agent directories into [`AgentSession`]s.
///
/// Mirrors the watcher's path heuristic: for files the stem is the session id
/// (Claude Code / Codex transcripts), for directories the entry name is
/// (Jcode / SPEG session dirs). Real extraction comes with the parsers
/// (task 1.5).
fn scan_default_dirs() -> Vec<AgentSession> {
    let mut out = Vec::new();
    for (agent, dir) in default_agent_dirs() {
        if !dir.is_dir() {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let created_at = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(chrono::DateTime::<chrono::Utc>::from)
                .unwrap_or_else(chrono::Utc::now);
            let session_id = if path.is_file() {
                path.file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            } else {
                path.file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default()
            };
            if session_id.is_empty() {
                continue;
            }
            out.push(AgentSession::new(session_id, agent, path, created_at));
        }
    }
    out
}

/// Build an [`AgentSession`] from a watcher event (path is best-effort).
fn session_from_activity(activity: &SessionActivity) -> AgentSession {
    let path = default_agent_dirs()
        .into_iter()
        .find(|(agent, _)| *agent == activity.agent_type)
        .map(|(_, dir)| dir.join(&activity.session_id))
        .unwrap_or_else(|| PathBuf::from(&activity.session_id));
    AgentSession::new(
        &activity.session_id,
        activity.agent_type,
        path,
        activity.timestamp,
    )
}

/// Wait for SIGINT (Ctrl+C) or SIGTERM, then trigger graceful shutdown.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received — stopping gracefully");
}

#[cfg(test)]
mod tests {
    use super::*;
    use cacm_core::types::AgentType;
    use cacm_core::watcher::SessionEventType;
    use cacm_daemon::storage::JcodeBackend;

    #[test]
    fn session_from_activity_uses_agent_default_dir() {
        let activity = SessionActivity {
            session_id: "fox".into(),
            agent_type: AgentType::Jcode,
            event_type: SessionEventType::Modified,
            turn: None,
            timestamp: chrono::Utc::now(),
        };
        let session = session_from_activity(&activity);
        assert_eq!(session.session_id, "fox");
        assert_eq!(session.agent_type, AgentType::Jcode);
        assert!(session.path.ends_with(".jcode/sessions/fox"));
    }

    #[test]
    fn is_loopback_host_classifies_addresses() {
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.5.5.5"));
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(is_loopback_host("::ffff:127.0.0.1"));
        assert!(!is_loopback_host("0.0.0.0"));
        assert!(!is_loopback_host("192.168.1.10"));
        assert!(!is_loopback_host(""));
    }

    #[tokio::test]
    async fn watcher_task_upserts_index_and_broadcasts() {
        let (tx, rx) = mpsc::channel(16);
        let state = AppState::new(
            Box::new(JcodeBackend::new(PathBuf::from(
                "C:\\nonexistent\\jcode-api.sock",
            ))),
            ParserRegistry::new(),
            HashMap::new(),
        );
        // Subscribe before the task sends so the broadcast retains the message.
        let mut event_rx = state.events.subscribe();

        let task = tokio::spawn(watcher_task(rx, state.clone()));

        tx.send(SessionActivity {
            session_id: "fox".into(),
            agent_type: AgentType::Jcode,
            event_type: SessionEventType::Modified,
            turn: Some(2),
            timestamp: chrono::Utc::now(),
        })
        .await
        .unwrap();
        drop(tx);
        task.await.unwrap();

        // Session upserted into the live index and persisted to storage.
        let index = state.sessions.lock().unwrap();
        assert!(index.contains_key("fox"));
        let stored = state.storage.lock().unwrap();
        let sessions = stored.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "fox");

        // Notification broadcast to connected clients.
        let payload = event_rx.try_recv().unwrap();
        let value: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(value["event"], "cacm.session_activity");
        assert_eq!(value["data"]["session_id"], "fox");
        assert_eq!(value["data"]["agent_type"], "jcode");
    }
}
