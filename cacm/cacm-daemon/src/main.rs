//! cacm-daemon — the RUNNING PROCESS of CACM.
//!
//! Watches agent session directories, serves the JSON-RPC-style WebSocket
//! API, and pushes `cacm.session_activity` notifications. One daemon serves
//! all clients (Jcode, SPEG web, any tool).
//!
//! Resilience: a [`Crashpad`] writes crash reports + a collectible daemon log
//! on panic, the [`MemoryManager`] bounds memory so the process degrades
//! instead of OOM-ing, and the restart loop below **self-heals**: if the main
//! runtime task panics, the crash is recorded and the daemon starts a fresh
//! runtime after a backoff, up to `--max-restarts` times.

use cacm_core::parsers::ParserRegistry;
use cacm_core::types::AgentSession;
use cacm_core::watcher::{default_agent_dirs, SessionActivity, SessionWatcher};
use cacm_daemon::crashpad::{Crashpad, CURRENT_MEMORY_USED};
use cacm_daemon::memory::MemoryManager;
use cacm_daemon::server::{broadcast_activity, build_router, AppState};
use cacm_daemon::storage;
use clap::Parser;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::Layer;

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

    /// Directory for crash reports and the daemon log (default:
    /// ~/.cacm/crashes).
    #[arg(long)]
    crash_dir: Option<PathBuf>,

    /// Soft memory budget in bytes (default 256 MiB): above this, storage is
    /// shrunk before writes.
    #[arg(long, default_value_t = cacm_daemon::memory::DEFAULT_SOFT_LIMIT)]
    memory_soft: usize,

    /// Hard memory budget in bytes (default 512 MiB): writes that would reach
    /// it are rejected with `-32002 memory pressure`.
    #[arg(long, default_value_t = cacm_daemon::memory::DEFAULT_HARD_LIMIT)]
    memory_hard: usize,

    /// Maximum self-heal restarts after a crash before giving up.
    #[arg(long, default_value_t = 5)]
    max_restarts: u32,

    /// Disable self-heal: exit on the first crash instead of restarting.
    #[arg(long)]
    no_restart: bool,

    /// Enable debug-only RPC methods (cacm.debug.panic).
    #[arg(long)]
    debug: bool,

    /// Debug only: panic on the main task after this many seconds (requires
    /// --debug) to exercise the crashpad + self-heal loop.
    #[arg(long)]
    debug_panic_after: Option<u64>,
}

/// Why the daemon runtime stopped.
enum ExitReason {
    /// Clean shutdown (SIGINT/SIGTERM) — do not restart.
    Graceful,
    /// Crashed or fatal error — restart unless disabled/exhausted.
    Crash(String),
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();

    // Crashpad: crash reports + collectible logs.
    let crash_dir = cli.crash_dir.clone().unwrap_or_else(default_crash_dir);
    let crashpad = match Crashpad::new(crash_dir) {
        Ok(pad) => pad,
        Err(err) => {
            eprintln!("cacm-daemon: failed to create crash dir: {err}");
            return std::process::ExitCode::FAILURE;
        }
    };
    let crash_dir_for_state = crashpad.dir().to_path_buf();
    crashpad.clone().install_hook();

    // Logging: console + mirrored to <crash-dir>/daemon.log (non-blocking).
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,cacm_daemon=debug"));
    let file_appender = tracing_appender::rolling::never(crashpad.dir(), "daemon.log");
    let (file_writer, _file_guard) = tracing_appender::non_blocking(file_appender);
    tracing_subscriber::registry()
        .with(tracing_subscriber::fmt::layer().with_filter(filter.clone()))
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(file_writer)
                .with_filter(filter),
        )
        .init();

    if !is_loopback_host(&cli.host) && !cli.expose {
        eprintln!(
            "refusing to bind to non-loopback host '{}': the daemon is unauthenticated \
             and serves session context; pass --expose to override",
            cli.host
        );
        return std::process::ExitCode::FAILURE;
    }

    tracing::info!(
        port = cli.port,
        host = %cli.host,
        expose = cli.expose,
        allow_origin = ?cli.allow_origin,
        crash_dir = %crashpad.dir().display(),
        memory_soft = cli.memory_soft,
        memory_hard = cli.memory_hard,
        max_restarts = cli.max_restarts,
        "starting cacm-daemon"
    );

    // Self-heal loop: run the daemon; on a crash (panic/error), record it
    // (the panic hook already wrote the crash report), back off, and run a
    // fresh runtime. Clean shutdown exits without restarting.
    let mut restarts = 0u32;
    loop {
        let reason = run_daemon(&cli, &crashpad, &crash_dir_for_state);
        match &reason {
            ExitReason::Graceful => {
                tracing::info!("cacm-daemon stopped cleanly");
                return std::process::ExitCode::SUCCESS;
            }
            ExitReason::Crash(detail) => {
                tracing::error!(%detail, "cacm-daemon crashed");
                eprintln!("cacm-daemon crashed: {detail}");
                if !decide_restart(&reason, restarts, cli.max_restarts, cli.no_restart) {
                    tracing::error!(
                        restarts,
                        no_restart = cli.no_restart,
                        "self-heal budget exhausted — giving up"
                    );
                    return std::process::ExitCode::FAILURE;
                }
                restarts += 1;
                let delay = restart_backoff(restarts);
                tracing::warn!(
                    restarts,
                    delay_secs = delay.as_secs(),
                    "self-healing: restarting"
                );
                std::thread::sleep(delay);
            }
        }
    }
}

/// Build a fresh tokio runtime, run the daemon, and catch panics so the
/// restart loop can revive the process.
fn run_daemon(cli: &Cli, crashpad: &Crashpad, crash_dir_for_state: &std::path::Path) -> ExitReason {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => return ExitReason::Crash(format!("failed to build runtime: {err}")),
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime.block_on(daemon_main(
            cli,
            crashpad.clone(),
            crash_dir_for_state.to_path_buf(),
        ))
    }));
    match result {
        Ok(Ok(())) => ExitReason::Graceful,
        Ok(Err(err)) => ExitReason::Crash(format!("daemon error: {err}")),
        Err(panic) => ExitReason::Crash(panic_message(&panic)),
    }
}

/// The daemon itself (async). Returns `Ok(())` only on graceful shutdown.
async fn daemon_main(
    cli: &Cli,
    _crashpad: Crashpad,
    crash_dir_for_state: PathBuf,
) -> Result<(), Box<dyn std::error::Error>> {
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

    // Watcher: watch agent session dirs for activity (supervised below so a
    // crashed watcher task is respawned).
    let (mut watcher, activity_rx) = SessionWatcher::new()?;
    let watched = watcher.watch_defaults()?;
    tracing::info!(dirs = watched, "watching agent session directories");

    // Parser registry: concrete parsers land in task 1.5; registered here so
    // the daemon has the extension point wired up.
    let registry = ParserRegistry::new();

    let mut state = AppState::new(storage_box, registry, sessions);
    state.memory = MemoryManager::new(cli.memory_soft, cli.memory_hard);
    state.debug = cli.debug;
    state.crash_dir = Arc::new(crash_dir_for_state);
    state.allow_origins = Arc::new(cli.allow_origin.clone());

    // Watchdog: respawn the watcher task if it ever dies.
    tokio::spawn(watcher_supervisor(
        Some((watcher, activity_rx)),
        state.clone(),
    ));
    // Keep the crashpad's memory figure fresh for panic reports.
    tokio::spawn(memory_sampler(state.clone()));

    // HTTP + WebSocket server. Loopback by default (see `--host`).
    let app = build_router(state);
    let listener = tokio::net::TcpListener::bind((cli.host.as_str(), cli.port)).await?;
    let addr = listener.local_addr()?;
    tracing::info!(%addr, "cacm-daemon listening (ws://{addr}/ws, http://{addr}/healthz)");

    let serve = axum::serve(listener, app).with_graceful_shutdown(shutdown_signal());
    if let Some(secs) = cli.debug_panic_after {
        // Debug only: panic on the MAIN task so the restart loop revives the
        // daemon and the crashpad records it. Requires --debug.
        if !cli.debug {
            return Err("--debug-panic-after requires --debug".into());
        }
        tracing::warn!(secs, "debug: will panic on the main task");
        let boom = async move {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            panic!("debug panic after {secs}s (--debug-panic-after)");
        };
        tokio::select! {
            result = serve => result?,
            _ = boom => unreachable!("panic propagated through select"),
        }
    } else {
        serve.await?;
    }
    tracing::info!("cacm-daemon stopped");
    Ok(())
}

/// Respawn the session watcher whenever its task dies, so activity tracking
/// self-heals without a full daemon restart.
async fn watcher_supervisor(
    initial: Option<(SessionWatcher, mpsc::Receiver<SessionActivity>)>,
    state: AppState,
) {
    let mut backoff = Duration::from_secs(1);
    let mut current = initial;
    loop {
        // Take the current watcher pair, or build a fresh one.
        let pair = match current.take() {
            Some(pair) => pair,
            None => match SessionWatcher::new() {
                Ok((mut watcher, rx)) => {
                    let _ = watcher.watch_defaults();
                    (watcher, rx)
                }
                Err(err) => {
                    tracing::warn!(error = %err, "failed to rebuild session watcher");
                    tokio::time::sleep(backoff).await;
                    continue;
                }
            },
        };
        let (watcher, rx) = pair;
        // The task owns the watcher (it holds the mpsc sender), so the
        // channel stays open for the task's lifetime. Clone state *outside*
        // the async block so later respawn iterations still own it.
        let task_state = state.clone();
        let task = tokio::spawn(async move {
            let _keep_watcher_alive = watcher;
            watcher_task(rx, task_state).await;
        });
        match task.await {
            Ok(()) => tracing::warn!("watcher task ended unexpectedly — respawning"),
            Err(err) => tracing::warn!(error = %err, "watcher task crashed — respawning"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(Duration::from_secs(30));
    }
}

/// Periodically refresh the crashpad's memory snapshot so panic reports carry
/// a useful footprint.
async fn memory_sampler(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(5));
    loop {
        interval.tick().await;
        let used = state.storage.lock().map(|s| s.memory_bytes()).unwrap_or(0);
        CURRENT_MEMORY_USED.store(used, std::sync::atomic::Ordering::Relaxed);
    }
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

/// Backoff between self-heal restarts: 1s, 2s, 4s, … capped at 30s.
fn restart_backoff(attempt: u32) -> Duration {
    let secs = 1u64 << attempt.min(5);
    Duration::from_secs(secs.min(30))
}

/// Should the restart loop revive the daemon?
fn decide_restart(reason: &ExitReason, restarts: u32, max_restarts: u32, no_restart: bool) -> bool {
    !matches!(reason, ExitReason::Graceful) && !no_restart && restarts < max_restarts
}

/// Best-effort extraction of the panic message for logging/reports.
fn panic_message(panic: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        format!("panic: {s}")
    } else if let Some(s) = panic.downcast_ref::<String>() {
        format!("panic: {s}")
    } else {
        "panic: <non-string payload>".to_string()
    }
}

/// Default crash directory: `~/.cacm/crashes` (temp fallback if no home).
fn default_crash_dir() -> PathBuf {
    cacm_core::watcher::home_dir()
        .map(|home| home.join(".cacm").join("crashes"))
        .unwrap_or_else(|| std::env::temp_dir().join("cacm-crashes"))
}

/// Is `host` a loopback address? Anything else exposes the unauthenticated
/// daemon to the network and requires `--expose`. Conservative: unknown host
/// names (other than `localhost`) and hostnames merely prefixed with `127.`
/// (e.g. `127.evil.com`) are treated as non-loopback.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim();
    if host == "localhost" || host == "[::1]" {
        return true;
    }
    // std's Ipv6Addr::is_loopback does not cover IPv4-mapped loopback
    // (::ffff:127.0.0.1); recognize the prefix explicitly before parsing.
    if host.starts_with("::ffff:127.") {
        return true;
    }
    host.parse::<std::net::IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
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
        assert!(!is_loopback_host("127.evil.com"));
        assert!(!is_loopback_host(""));
    }

    #[test]
    fn restart_backoff_doubles_and_caps() {
        assert_eq!(restart_backoff(1), Duration::from_secs(2));
        assert_eq!(restart_backoff(2), Duration::from_secs(4));
        assert_eq!(restart_backoff(5), Duration::from_secs(30));
        assert_eq!(restart_backoff(99), Duration::from_secs(30));
    }

    #[test]
    fn decide_restart_rules() {
        assert!(decide_restart(&ExitReason::Crash("x".into()), 0, 5, false));
        assert!(!decide_restart(&ExitReason::Graceful, 0, 5, false));
        assert!(!decide_restart(&ExitReason::Crash("x".into()), 5, 5, false));
        assert!(!decide_restart(&ExitReason::Crash("x".into()), 0, 5, true));
    }

    #[test]
    fn panic_message_extracts_payloads() {
        let str_panic: Box<dyn std::any::Any + Send> = Box::new("boom");
        assert_eq!(panic_message(&str_panic), "panic: boom");
        let string_panic: Box<dyn std::any::Any + Send> = Box::new("detailed boom".to_string());
        assert_eq!(panic_message(&string_panic), "panic: detailed boom");
        let other_panic: Box<dyn std::any::Any + Send> = Box::new(42i32);
        assert_eq!(panic_message(&other_panic), "panic: <non-string payload>");
    }

    #[tokio::test]
    async fn watcher_task_upserts_index_and_broadcasts() {
        let (tx, rx) = mpsc::channel(16);
        let state = AppState::new(
            Box::new(cacm_daemon::storage::JcodeBackend::new(PathBuf::from(
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
