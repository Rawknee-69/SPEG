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

    /// Jcode home directory; the harness API socket is resolved under it as
    /// `<home>/jcode-api.sock` (default: JCODE_API_SOCKET / runtime-dir rules).
    #[arg(long)]
    jcode_home: Option<PathBuf>,

    /// SQLite database path for the fallback backend
    /// (default: ~/.cacm/cacm.db).
    #[arg(long)]
    db_path: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,cacm_daemon=debug"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let cli = Cli::parse();
    tracing::info!(
        port = cli.port,
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

    let state = AppState::new(storage_box, registry, sessions);

    // Forward watcher activity → session index, storage, and clients.
    tokio::spawn(watcher_task(activity_rx, state.clone()));

    // HTTP + WebSocket server.
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", cli.port)).await?;
    let addr = listener.local_addr()?;
    tracing::info!(%addr, "cacm-daemon listening (ws://{addr}/ws, http://{addr}/healthz)");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    tracing::info!("cacm-daemon stopped");
    Ok(())
}

/// Watch loop: record sessions seen by the watcher and broadcast activity.
async fn watcher_task(mut rx: mpsc::Receiver<SessionActivity>, state: AppState) {
    while let Some(activity) = rx.recv().await {
        let session = session_from_activity(&activity);
        {
            let mut index = match state.sessions.lock() {
                Ok(index) => index,
                Err(_) => continue,
            };
            index
                .entry(session.session_id.clone())
                .or_insert_with(|| session.clone());
        }
        if let Ok(mut storage) = state.storage.lock() {
            let _ = storage.store_session(&session);
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
}
