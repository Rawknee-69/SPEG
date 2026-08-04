//! Storage backends for the CACM daemon.
//!
//! [`Storage`] is the trait the daemon's handlers go through. Two backends
//! implement it, mirroring the task spec:
//!
//! - [`JcodeBackend`] — the primary backend. It resolves the Jcode harness
//!   API socket (`jcode-api.sock`, see [`resolve_jcode_socket`]) and probes it
//!   at startup; if a Jcode daemon is reachable it is selected and context is
//!   kept in an in-memory graph (mirroring Jcode's `MemoryGraph`). The full
//!   harness-protocol write path (pushing entries into Jcode's memory graph)
//!   is wired by task 1.8 (`jcode-cacm-bridge`); here the graph is local.
//! - [`SqliteBackend`] — the fallback, used whenever the Jcode socket is not
//!   reachable. Persists context entries and sessions in a local SQLite file.
//!
//! [`select_backend`] implements the auto-select: try Jcode first, fall back
//! to SQLite.

use crate::server::RpcError;
use cacm_core::types::{AgentSession, AgentType, CrossAgentContext, SessionStatus};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Errors produced by storage backends.
#[derive(Debug)]
pub enum StorageError {
    /// Underlying SQLite failure.
    Sqlite(rusqlite::Error),
    /// JSON serialization failure (stored payloads are JSON-encoded).
    Json(serde_json::Error),
    /// Filesystem failure (opening the database, home dir, ...).
    Io(std::io::Error),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StorageError::Sqlite(err) => write!(f, "sqlite error: {err}"),
            StorageError::Json(err) => write!(f, "json error: {err}"),
            StorageError::Io(err) => write!(f, "io error: {err}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<rusqlite::Error> for StorageError {
    fn from(err: rusqlite::Error) -> Self {
        StorageError::Sqlite(err)
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(err: serde_json::Error) -> Self {
        StorageError::Json(err)
    }
}

impl From<std::io::Error> for StorageError {
    fn from(err: std::io::Error) -> Self {
        StorageError::Io(err)
    }
}

/// The storage surface the daemon's handlers depend on.
///
/// `store_context` / `query_context` / `list_sessions` are the task-spec
/// methods; `store_session` is a small extension so the watcher can persist
/// sessions it observes (the daemon's session index is hydrated from
/// [`Storage::list_sessions`] at startup).
pub trait Storage: Send + Sync {
    /// Backend identifier, reported in `/healthz` and logs (`"jcode"`,
    /// `"sqlite"`).
    fn name(&self) -> &'static str;

    /// Persist a cross-agent context entry.
    fn store_context(&mut self, ctx: &CrossAgentContext) -> Result<(), StorageError>;

    /// Query stored context for `project`, newest first, capped at `limit`.
    ///
    /// `project == "*"` (or empty) matches every entry.
    fn query_context(
        &self,
        project: &str,
        limit: usize,
    ) -> Result<Vec<CrossAgentContext>, StorageError>;

    /// All sessions the backend knows about.
    fn list_sessions(&self) -> Result<Vec<AgentSession>, StorageError>;

    /// Record (or update) a session.
    fn store_session(&mut self, session: &AgentSession) -> Result<(), StorageError>;
}

/// Does this context entry belong to `project`?
///
/// Matching is best-effort until parsers extract real project paths (task
/// 1.5+): a context matches when its `session_id` equals `project`, when any
/// of its `file_paths` is `project` or lies under it (path-separator aware —
/// `/repo` does NOT match `/repo2/x`), or when `project` is the wildcard
/// `"*"` / empty (match everything).
pub fn context_matches_project(ctx: &CrossAgentContext, project: &str) -> bool {
    if project.is_empty() || project == "*" {
        return true;
    }
    if ctx.session_id == project {
        return true;
    }
    ctx.file_paths
        .iter()
        .any(|p| path_within(p, project) || path_within(project, p))
}

/// Is `path` equal to `base`, or under it (separator-aware)?
///
/// `"a/b/c".within("a/b")` → true; `"a/bc".within("a/b")` → false. A base
/// ending in a separator (including the root `"/"`) matches every path under
/// it.
fn path_within(path: &str, base: &str) -> bool {
    if path == base {
        return true;
    }
    if base.ends_with('/') || base.ends_with('\\') {
        // Directory-style base (e.g. "/" or "/repo/"): any path below it.
        return path.strip_prefix(base).is_some_and(|rest| !rest.is_empty());
    }
    path.strip_prefix(base)
        .is_some_and(|rest| rest.starts_with('/') || rest.starts_with('\\'))
}

/// Shared in-memory store used by [`JcodeBackend`] (and tests).
///
/// Mirrors Jcode's `MemoryGraph` in spirit: entries live in memory only. No
/// persistence — that is what the harness write path (task 1.8) and the
/// SQLite fallback provide.
#[derive(Default)]
pub struct MemoryGraph {
    /// All context entries, in insertion order.
    contexts: Vec<CrossAgentContext>,
    /// Sessions keyed by session id.
    sessions: HashMap<String, AgentSession>,
}

impl MemoryGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn store_context(&mut self, ctx: &CrossAgentContext) {
        self.contexts.push(ctx.clone());
    }

    pub fn query_context(&self, project: &str, limit: usize) -> Vec<CrossAgentContext> {
        // Order by timestamp descending — the same ordering the SQLite
        // backend uses — so both backends rank identically.
        let mut matching: Vec<CrossAgentContext> = self
            .contexts
            .iter()
            .filter(|ctx| context_matches_project(ctx, project))
            .cloned()
            .collect();
        matching.sort_by_key(|c| std::cmp::Reverse(c.timestamp));
        matching.truncate(limit);
        matching
    }

    pub fn list_sessions(&self) -> Vec<AgentSession> {
        let mut sessions: Vec<AgentSession> = self.sessions.values().cloned().collect();
        sessions.sort_by_key(|s| s.created_at);
        sessions
    }

    pub fn store_session(&mut self, session: &AgentSession) {
        self.sessions
            .insert(session.session_id.clone(), session.clone());
    }
}

/// Resolve the Jcode harness API socket path.
///
/// Precedence (mirrors `jcode-harness-api::sockets`):
/// 1. `--jcode-home` (CLI override) → `<home>/jcode-api.sock`
/// 2. `JCODE_API_SOCKET` env var
/// 3. runtime dir: `JCODE_RUNTIME_DIR` → `XDG_RUNTIME_DIR` → macOS `TMPDIR`
///    → `$TMP/jcode-<user>` fallback; socket file `jcode-api.sock`.
pub fn resolve_jcode_socket(jcode_home: Option<&Path>) -> PathBuf {
    if let Some(home) = jcode_home {
        return home.join("jcode-api.sock");
    }
    if let Ok(path) = std::env::var("JCODE_API_SOCKET") {
        return PathBuf::from(path);
    }
    runtime_dir().join("jcode-api.sock")
}

fn runtime_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("JCODE_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(dir) = std::env::var("XDG_RUNTIME_DIR") {
        return PathBuf::from(dir);
    }
    #[cfg(target_os = "macos")]
    if let Ok(dir) = std::env::var("TMPDIR") {
        return PathBuf::from(dir);
    }
    std::env::temp_dir().join(format!("jcode-{}", runtime_user_discriminator()))
}

fn runtime_user_discriminator() -> String {
    let raw = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .or_else(|_| std::env::var("UID"))
        .unwrap_or_default();
    let clean: String = raw
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(64)
        .collect();
    if clean.is_empty() {
        "user".to_string()
    } else {
        clean
    }
}

/// Derive the Windows named-pipe name for a socket path, exactly as
/// `jcode-transport` does (stem + sha256 of the normalized path, 16 hex).
#[cfg(windows)]
fn pipe_name_from_path(path: &Path) -> String {
    use sha2::{Digest, Sha256};

    let stem: String = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("jcode")
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
        .take(32)
        .collect();
    let stem = if stem.is_empty() { "jcode" } else { &stem };
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    let hash = hex::encode(digest);
    format!(r"\\.\pipe\{}-{}", stem, &hash[..16])
}

/// Try to open the Jcode harness API socket once (connect-and-close).
async fn probe_socket(path: &Path) -> bool {
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(path).await.is_ok()
    }
    #[cfg(windows)]
    {
        // tokio's named-pipe client `open` is synchronous; fine for a
        // one-shot startup probe.
        let pipe = pipe_name_from_path(path);
        tokio::net::windows::named_pipe::ClientOptions::new()
            .open(&pipe)
            .is_ok()
    }
}

/// Primary backend: in-memory graph, selected when the Jcode harness API
/// socket is reachable.
pub struct JcodeBackend {
    graph: MemoryGraph,
    socket_path: PathBuf,
    connected: bool,
}

impl JcodeBackend {
    /// Create a backend for `socket_path` without probing.
    pub fn new(socket_path: PathBuf) -> Self {
        Self {
            graph: MemoryGraph::new(),
            socket_path,
            connected: false,
        }
    }

    /// The harness API socket this backend talks to.
    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Whether the socket probe succeeded.
    pub fn is_connected(&self) -> bool {
        self.connected
    }

    /// Probe the Jcode daemon socket; sets `connected` on success.
    pub async fn probe(&mut self) -> bool {
        self.connected = probe_socket(&self.socket_path).await;
        self.connected
    }
}

impl Storage for JcodeBackend {
    fn name(&self) -> &'static str {
        "jcode"
    }

    fn store_context(&mut self, ctx: &CrossAgentContext) -> Result<(), StorageError> {
        self.graph.store_context(ctx);
        Ok(())
    }

    fn query_context(
        &self,
        project: &str,
        limit: usize,
    ) -> Result<Vec<CrossAgentContext>, StorageError> {
        Ok(self.graph.query_context(project, limit))
    }

    fn list_sessions(&self) -> Result<Vec<AgentSession>, StorageError> {
        Ok(self.graph.list_sessions())
    }

    fn store_session(&mut self, session: &AgentSession) -> Result<(), StorageError> {
        self.graph.store_session(session);
        Ok(())
    }
}

/// Fallback backend: local SQLite persistence used when Jcode is unavailable.
pub struct SqliteBackend {
    /// rusqlite's `Connection` is `Send` but not `Sync` (internal `RefCell`
    /// statement cache), so the daemon's `Storage: Send + Sync` bound is met
    /// by serializing access behind a mutex.
    conn: Mutex<Connection>,
}

impl SqliteBackend {
    /// Open (creating if needed) the SQLite database at `path`.
    pub fn new(path: &Path) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)?;
            }
        }
        let conn = Connection::open(path)?;
        Self::from_conn(conn)
    }

    /// In-memory database (tests).
    pub fn open_in_memory() -> Result<Self, StorageError> {
        Self::from_conn(Connection::open_in_memory()?)
    }

    fn from_conn(conn: Connection) -> Result<Self, StorageError> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS contexts (
                 id          TEXT PRIMARY KEY,
                 session_id  TEXT NOT NULL,
                 agent_type  TEXT NOT NULL,
                 context_type TEXT NOT NULL,
                 content     TEXT NOT NULL,
                 file_paths  TEXT NOT NULL DEFAULT '[]',
                 decisions   TEXT NOT NULL DEFAULT '[]',
                 errors      TEXT NOT NULL DEFAULT '[]',
                 timestamp   TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sessions (
                 session_id TEXT PRIMARY KEY,
                 agent_type TEXT NOT NULL,
                 path       TEXT NOT NULL,
                 created_at TEXT NOT NULL,
                 status     TEXT NOT NULL
             );",
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Lock the connection, mapping a poisoned mutex into [`StorageError`].
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Connection>, StorageError> {
        self.conn
            .lock()
            .map_err(|_| StorageError::Io(std::io::Error::other("sqlite connection lock poisoned")))
    }

    /// Default database location: `~/.cacm/cacm.db` (temp dir if no home).
    pub fn default_db_path() -> PathBuf {
        cacm_core::watcher::home_dir()
            .map(|home| home.join(".cacm").join("cacm.db"))
            .unwrap_or_else(|| std::env::temp_dir().join("cacm.db"))
    }

    fn row_to_context(row: &rusqlite::Row<'_>) -> rusqlite::Result<CrossAgentContext> {
        let agent_type_raw: String = row.get(2)?;
        let context_type_raw: String = row.get(3)?;
        let file_paths: String = row.get(5)?;
        let decisions: String = row.get(6)?;
        let errors: String = row.get(7)?;
        let timestamp: String = row.get(8)?;

        fn conversion(
            idx: usize,
            err: impl std::error::Error + Send + Sync + 'static,
        ) -> rusqlite::Error {
            rusqlite::Error::FromSqlConversionFailure(
                idx,
                rusqlite::types::Type::Text,
                Box::new(err),
            )
        }

        let agent_type: AgentType = agent_type_raw.parse().map_err(|_| {
            conversion(
                2,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unknown agent type stored: {agent_type_raw}"),
                ),
            )
        })?;
        let context_type: cacm_core::types::ContextType =
            serde_json::from_str(&context_type_raw).map_err(|err| conversion(3, err))?;
        let timestamp: DateTime<Utc> = DateTime::parse_from_rfc3339(&timestamp)
            .map(|dt| dt.with_timezone(&Utc))
            .map_err(|err| conversion(8, err))?;

        Ok(CrossAgentContext {
            id: row.get(0)?,
            session_id: row.get(1)?,
            agent_type,
            context_type,
            content: row.get(4)?,
            file_paths: serde_json::from_str(&file_paths).map_err(|err| conversion(5, err))?,
            decisions: serde_json::from_str(&decisions).map_err(|err| conversion(6, err))?,
            errors: serde_json::from_str(&errors).map_err(|err| conversion(7, err))?,
            timestamp,
        })
    }
}

impl Storage for SqliteBackend {
    fn name(&self) -> &'static str {
        "sqlite"
    }

    fn store_context(&mut self, ctx: &CrossAgentContext) -> Result<(), StorageError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT OR REPLACE INTO contexts
                 (id, session_id, agent_type, context_type, content,
                  file_paths, decisions, errors, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                ctx.id,
                ctx.session_id,
                ctx.agent_type.to_string(),
                serde_json::to_string(&ctx.context_type)?,
                ctx.content,
                serde_json::to_string(&ctx.file_paths)?,
                serde_json::to_string(&ctx.decisions)?,
                serde_json::to_string(&ctx.errors)?,
                ctx.timestamp.to_rfc3339(),
            ],
        )?;
        Ok(())
    }

    fn query_context(
        &self,
        project: &str,
        limit: usize,
    ) -> Result<Vec<CrossAgentContext>, StorageError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, agent_type, context_type, content,
                    file_paths, decisions, errors, timestamp
             FROM contexts
             ORDER BY timestamp DESC",
        )?;
        let rows = stmt.query_map([], Self::row_to_context)?;
        let mut out = Vec::new();
        for row in rows {
            let ctx = row?;
            if context_matches_project(&ctx, project) {
                out.push(ctx);
                if out.len() >= limit {
                    break;
                }
            }
        }
        Ok(out)
    }

    fn list_sessions(&self) -> Result<Vec<AgentSession>, StorageError> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT session_id, agent_type, path, created_at, status
             FROM sessions ORDER BY created_at",
        )?;
        let rows = stmt.query_map([], |row| {
            let agent_type_raw: String = row.get(1)?;
            let agent_type: AgentType = agent_type_raw.parse().map_err(|_| {
                rusqlite::Error::FromSqlConversionFailure(
                    1,
                    rusqlite::types::Type::Text,
                    Box::new(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("unknown agent type stored: {agent_type_raw}"),
                    )),
                )
            })?;
            let status_raw: String = row.get(4)?;
            let status: SessionStatus =
                serde_json::from_str(&status_raw).unwrap_or(SessionStatus::Active);
            let created_raw: String = row.get(3)?;
            let created_at: DateTime<Utc> = DateTime::parse_from_rfc3339(&created_raw)
                .map(|dt| dt.with_timezone(&Utc))
                .map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(err),
                    )
                })?;
            Ok(AgentSession {
                session_id: row.get(0)?,
                agent_type,
                path: PathBuf::from(row.get::<_, String>(2)?),
                created_at,
                status,
            })
        })?;
        let mut sessions = Vec::new();
        for row in rows {
            sessions.push(row?);
        }
        Ok(sessions)
    }

    fn store_session(&mut self, session: &AgentSession) -> Result<(), StorageError> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT OR REPLACE INTO sessions
                 (session_id, agent_type, path, created_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                session.session_id,
                session.agent_type.to_string(),
                session.path.to_string_lossy(),
                session.created_at.to_rfc3339(),
                serde_json::to_string(&session.status)?,
            ],
        )?;
        Ok(())
    }
}

/// Auto-select a storage backend: try Jcode first, fall back to SQLite.
pub async fn select_backend(
    jcode_home: Option<&Path>,
    db_path: Option<&Path>,
) -> Result<Box<dyn Storage>, StorageError> {
    let socket = resolve_jcode_socket(jcode_home);
    let mut jcode = JcodeBackend::new(socket.clone());
    if jcode.probe().await {
        tracing::info!(
            socket = %socket.display(),
            "jcode harness API reachable — using Jcode memory-graph backend"
        );
        Ok(Box::new(jcode))
    } else {
        let db = db_path
            .map(Path::to_path_buf)
            .unwrap_or_else(SqliteBackend::default_db_path);
        tracing::info!(
            socket = %socket.display(),
            db = %db.display(),
            "jcode harness API not reachable — falling back to SQLite backend"
        );
        Ok(Box::new(SqliteBackend::new(&db)?))
    }
}

impl From<StorageError> for RpcError {
    fn from(err: StorageError) -> Self {
        RpcError::server_error(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use cacm_core::types::ContextType;

    fn sample_context(id: &str, session_id: &str, path: &str) -> CrossAgentContext {
        CrossAgentContext {
            id: id.into(),
            session_id: session_id.into(),
            agent_type: AgentType::ClaudeCode,
            context_type: ContextType::Decision,
            content: format!("use the workspace resolver ({id})"),
            file_paths: vec![path.into()],
            decisions: vec!["resolver = 2".into()],
            errors: vec![],
            timestamp: Utc::now(),
        }
    }

    #[test]
    fn context_matches_project_rules() {
        let ctx = sample_context("c1", "sess-a", "/repo/src/lib.rs");
        assert!(context_matches_project(&ctx, "/repo"));
        assert!(context_matches_project(&ctx, "/repo/src/lib.rs"));
        assert!(context_matches_project(&ctx, "sess-a"));
        assert!(context_matches_project(&ctx, "*"));
        assert!(context_matches_project(&ctx, ""));
        assert!(!context_matches_project(&ctx, "/other"));
        // Separator-aware: /repo must not match /repo2 or /repository.
        let sibling = sample_context("c2", "sess-b", "/repo2/src/lib.rs");
        assert!(!context_matches_project(&sibling, "/repo"));
        assert!(context_matches_project(&sibling, "/repo2"));
        // Querying a specific file matches that file's context.
        assert!(context_matches_project(&ctx, "/repo/src/lib.rs"));
    }

    #[test]
    fn path_within_is_separator_aware() {
        assert!(path_within("/repo/src/lib.rs", "/repo"));
        assert!(path_within("/repo", "/repo"));
        assert!(path_within("/repo/src/lib.rs", "/repo/src/lib.rs"));
        assert!(!path_within("/repo2/x", "/repo"));
        assert!(!path_within("/repository/x", "/repo"));
        assert!(path_within("/repo/x", "/repo"));
        // Directional: "a under b". The reverse direction (querying a specific
        // file) is handled by context_matches_project's second check.
        assert!(!path_within("/repo", "/repo/src/lib.rs"));
        // Root and trailing-separator bases match everything under them.
        assert!(path_within("/repo/src/lib.rs", "/"));
        assert!(path_within("/repo", "/"));
        assert!(path_within("/repo/src/lib.rs", "/repo/"));
        assert!(!path_within("/repo2", "/repo/"));
        // Windows-style separators count too.
        assert!(path_within("C:/repo/src/lib.rs", "C:/repo"));
        assert!(!path_within("C:/repo2/x", "C:/repo"));
    }

    #[test]
    fn memory_graph_store_query_and_limit() {
        let mut graph = MemoryGraph::new();
        let t0 = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let t1 = t0 + chrono::Duration::minutes(1);
        let t2 = t0 + chrono::Duration::minutes(2);
        graph.store_context(&CrossAgentContext {
            timestamp: t0,
            ..sample_context("c1", "s1", "/a/f1.rs")
        });
        graph.store_context(&CrossAgentContext {
            timestamp: t1,
            ..sample_context("c2", "s2", "/b/f2.rs")
        });
        graph.store_context(&CrossAgentContext {
            timestamp: t2,
            ..sample_context("c3", "s1", "/a/f3.rs")
        });

        let all = graph.query_context("*", 10);
        assert_eq!(all.len(), 3);
        // Newest timestamp first, matching the SQLite backend ordering.
        assert_eq!(all[0].id, "c3");
        assert_eq!(all[2].id, "c1");

        let repo_a = graph.query_context("/a", 10);
        assert_eq!(repo_a.len(), 2);

        let limited = graph.query_context("*", 2);
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].id, "c3");
    }

    #[test]
    fn memory_graph_sessions() {
        let mut graph = MemoryGraph::new();
        graph.store_session(&AgentSession::new(
            "s1",
            AgentType::Jcode,
            "/x/s1",
            Utc::now(),
        ));
        graph.store_session(&AgentSession::new(
            "s2",
            AgentType::Speg,
            "/x/s2",
            Utc::now(),
        ));
        let sessions = graph.list_sessions();
        assert_eq!(sessions.len(), 2);
    }

    #[test]
    fn sqlite_store_query_and_list_roundtrip() {
        let mut backend = SqliteBackend::open_in_memory().unwrap();
        backend
            .store_context(&sample_context("c1", "s1", "/repo/a.rs"))
            .unwrap();
        backend
            .store_context(&sample_context("c2", "s2", "/other/b.rs"))
            .unwrap();

        let repo = backend.query_context("/repo", 10).unwrap();
        assert_eq!(repo.len(), 1);
        assert_eq!(repo[0].id, "c1");
        assert_eq!(repo[0].agent_type, AgentType::ClaudeCode);
        assert_eq!(repo[0].context_type, ContextType::Decision);

        let all = backend.query_context("*", 10).unwrap();
        assert_eq!(all.len(), 2);

        backend
            .store_session(&AgentSession::new(
                "s1",
                AgentType::Jcode,
                "/x/s1",
                Utc::now(),
            ))
            .unwrap();
        let sessions = backend.list_sessions().unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "s1");
        assert_eq!(sessions[0].status, SessionStatus::Active);
    }

    #[test]
    fn sqlite_replace_updates_existing_context() {
        let mut backend = SqliteBackend::open_in_memory().unwrap();
        backend
            .store_context(&sample_context("c1", "s1", "/repo/a.rs"))
            .unwrap();
        let mut updated = sample_context("c1", "s1", "/repo/a.rs");
        updated.content = "updated".into();
        backend.store_context(&updated).unwrap();
        let all = backend.query_context("*", 10).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].content, "updated");
    }

    #[test]
    fn sqlite_query_respects_limit() {
        let mut backend = SqliteBackend::open_in_memory().unwrap();
        for i in 0..5 {
            backend
                .store_context(&sample_context(&format!("c{i}"), "s1", "/repo/f.rs"))
                .unwrap();
        }
        let limited = backend.query_context("/repo", 3).unwrap();
        assert_eq!(limited.len(), 3);
        assert_eq!(limited[0].id, "c4"); // newest first
    }

    #[test]
    fn jcode_backend_is_memory_graph() {
        let mut backend = JcodeBackend::new(PathBuf::from("C:\\nonexistent\\jcode-api.sock"));
        backend
            .store_context(&sample_context("c1", "s1", "/repo/a.rs"))
            .unwrap();
        backend
            .store_session(&AgentSession::new(
                "s1",
                AgentType::Jcode,
                "/x/s1",
                Utc::now(),
            ))
            .unwrap();
        assert_eq!(backend.query_context("/repo", 10).unwrap().len(), 1);
        assert_eq!(backend.list_sessions().unwrap().len(), 1);
        assert!(!backend.is_connected());
    }

    #[tokio::test]
    async fn select_backend_falls_back_to_sqlite_when_jcode_unreachable() {
        let db = std::env::temp_dir().join(format!(
            "cacm-select-backend-test-{}.db",
            std::process::id()
        ));
        let backend = select_backend(
            Some(Path::new("C:\\definitely\\not\\a\\jcode\\home")),
            Some(&db),
        )
        .await
        .unwrap();
        assert_eq!(backend.name(), "sqlite");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn resolve_jcode_socket_prefers_explicit_home() {
        let home = Path::new("/tmp/jcode-home");
        assert_eq!(
            resolve_jcode_socket(Some(home)),
            PathBuf::from("/tmp/jcode-home/jcode-api.sock")
        );
        // No env overrides set in tests: falls back to the runtime dir.
        let resolved = resolve_jcode_socket(None);
        assert_eq!(resolved.file_name().unwrap(), "jcode-api.sock");
    }

    #[cfg(windows)]
    #[test]
    fn pipe_name_matches_jcode_transport_shape() {
        // jcode-transport: /run/user/1000/jcode-api.sock -> \\.\pipe\jcode-api-<sha16>
        let name = pipe_name_from_path(Path::new("C:/tmp/jcode-api.sock"));
        assert!(name.starts_with(r"\\.\pipe\jcode-api-"), "{name}");
        assert_eq!(name.len(), r"\\.\pipe\jcode-api-".len() + 16);
    }
}
