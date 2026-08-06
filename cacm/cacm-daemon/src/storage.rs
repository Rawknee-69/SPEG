//! Storage backends for the CACM daemon.
//!
//! [`Storage`] is the trait the daemon's handlers go through. The SQLite
//! backend persists context entries and sessions in a local SQLite file;
//! an in-memory graph ([`MemoryGraph`]) backs tests and lightweight runs.

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
    /// Backend identifier, reported in `/healthz` and logs (`"sqlite"`).
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

    /// Approximate in-memory footprint of the stored data, used by the
    /// memory manager. Default: 0 (nothing tracked).
    fn memory_bytes(&self) -> usize {
        0
    }

    /// Ask the backend to release memory until its footprint is at most
    /// `target_bytes` (evicting oldest context entries; SQLite is disk-backed
    /// so it is a no-op there). Default: no-op.
    fn shrink_memory(&mut self, _target_bytes: usize) {}

    /// Align the backend's own eviction budget with the memory manager's soft
    /// limit so pressure signals are real (the in-memory graph evicts at the
    /// soft budget; SQLite is disk-backed, so a no-op there). Default: no-op.
    fn set_budgets(&mut self, _byte_budget: usize, _count_cap: usize) {}
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
    if let Some(proj) = ctx.project.as_deref() {
        if path_within(proj, project) || path_within(project, proj) {
            return true;
        }
    }
    ctx.file_paths
        .iter()
        .any(|p| path_within(p, project) || path_within(project, p))
}

/// Is `path` equal to `base`, or under it (separator-aware)?
///
/// `"a/b/c".within("a/b")` → true; `"a/bc".within("a/b")` → false. A base
/// ending in a separator (including the root `"/"`) matches every path under
/// it. `pub(crate)` so the sessions handler can filter with the same rules as
/// `cacm.query`.
///
/// Both sides are normalized first: `\` separators become `/` (agents and the
/// panel can disagree on Windows), and on Windows the case is folded so
/// `E:\SPEG\repo` matches `e:/speg/REPO`.
pub(crate) fn path_within(path: &str, base: &str) -> bool {
    let path = normalize_path_for_match(path);
    let base = normalize_path_for_match(base);
    if path == base {
        return true;
    }
    if base.ends_with('/') {
        // Directory-style base (e.g. "/" or "/repo/"): any path below it.
        return path.strip_prefix(&base).is_some_and(|rest| !rest.is_empty());
    }
    path.strip_prefix(&base)
        .is_some_and(|rest| rest.starts_with('/'))
}

/// Fold a filesystem path for [`path_within`] comparisons: `\` → `/` and
/// (on Windows) lowercase.
fn normalize_path_for_match(input: &str) -> String {
    let normalized = input.replace('\\', "/");
    #[cfg(windows)]
    {
        normalized.to_ascii_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

/// Shared in-memory store used by [`SqliteBackend`]-adjacent tests and
/// lightweight runs.
///
/// Entries live in memory only. No persistence — that is what the SQLite
/// backend provides. Storing the same id again replaces the old entry
/// (matching SQLite's `INSERT OR REPLACE`), and the store is bounded both by
/// entry count and by a total string-data byte budget, so an unauthenticated
/// `cacm.context.store` loop cannot grow memory without bound.
pub struct MemoryGraph {
    /// All context entries, in insertion order.
    contexts: Vec<CrossAgentContext>,
    /// Sessions keyed by session id.
    sessions: HashMap<String, AgentSession>,
    /// Approximate total string-data bytes (used for the eviction budget).
    total_bytes: usize,
    /// Byte budget enforced on store (defaults to [`MEMORY_GRAPH_MAX_BYTES`];
    /// lowered by the memory manager under pressure).
    byte_budget: usize,
    /// Entry-count cap (defaults to [`MEMORY_GRAPH_CAP`]).
    count_cap: usize,
}

/// Maximum entries kept in a [`MemoryGraph`]; the oldest is evicted beyond
/// this (the default `count_cap`).
pub const MEMORY_GRAPH_CAP: usize = 10_000;
/// Maximum total string-data bytes kept in a [`MemoryGraph`]; the oldest
/// entries are evicted beyond this (the default `byte_budget`).
pub const MEMORY_GRAPH_MAX_BYTES: usize = 64 << 20; // 64 MiB

impl Default for MemoryGraph {
    fn default() -> Self {
        Self {
            contexts: Vec::new(),
            sessions: HashMap::new(),
            total_bytes: 0,
            byte_budget: MEMORY_GRAPH_MAX_BYTES,
            count_cap: MEMORY_GRAPH_CAP,
        }
    }
}

/// Approximate in-memory cost of an entry: total bytes of its string fields
/// (id, session_id, content, and every file path / decision / error).
fn context_cost(ctx: &CrossAgentContext) -> usize {
    ctx.id.len()
        + ctx.session_id.len()
        + ctx.content.len()
        + ctx.file_paths.iter().map(String::len).sum::<usize>()
        + ctx.decisions.iter().map(String::len).sum::<usize>()
        + ctx.errors.iter().map(String::len).sum::<usize>()
}

impl MemoryGraph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn store_context(&mut self, ctx: &CrossAgentContext) {
        let cost = context_cost(ctx);
        // Replace same-id entries so repeated stores don't duplicate results
        // or grow the store.
        if let Some(pos) = self.contexts.iter().position(|c| c.id == ctx.id) {
            self.total_bytes = self
                .total_bytes
                .saturating_sub(context_cost(&self.contexts[pos]));
            self.contexts.remove(pos);
        }
        self.contexts.push(ctx.clone());
        self.total_bytes = self.total_bytes.saturating_add(cost);
        // Enforce the caps in one O(n log n) pass (sort + truncate) rather
        // than O(n) evictions, since this runs while the storage mutex is
        // held and every request shares it.
        if self.total_bytes > self.byte_budget || self.contexts.len() > self.count_cap {
            self.contexts.sort_by_key(|c| c.timestamp); // ascending: oldest first
                                                        // Keep the newest entries that fit under both caps.
            let mut bytes = 0usize;
            let mut first_kept = self.contexts.len();
            for i in (0..self.contexts.len()).rev() {
                let count_ok = self.contexts.len() - i <= self.count_cap;
                let next_bytes = bytes.saturating_add(context_cost(&self.contexts[i]));
                if !count_ok || next_bytes > self.byte_budget {
                    break;
                }
                bytes = next_bytes;
                first_kept = i;
            }
            if first_kept < self.contexts.len() {
                self.contexts.drain(..first_kept);
                self.total_bytes = bytes;
            }
        }
    }

    /// Lower (or raise) the eviction budgets. Used by the memory manager to
    /// shrink the graph under soft memory pressure.
    pub fn set_budgets(&mut self, byte_budget: usize, count_cap: usize) {
        self.byte_budget = byte_budget;
        self.count_cap = count_cap;
    }

    /// Current approximate string-data footprint (bytes).
    pub fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    /// Evict the oldest entries until the footprint is at most `target_bytes`
    /// (always keeping at least the newest entry).
    pub fn shrink_to(&mut self, target_bytes: usize) {
        if self.total_bytes <= target_bytes {
            return;
        }
        self.contexts.sort_by_key(|c| c.timestamp); // ascending: oldest first
                                                    // Walk from the newest backwards, keeping entries while they fit.
        let mut bytes = 0usize;
        let mut first_kept = self.contexts.len();
        for i in (0..self.contexts.len()).rev() {
            let next = bytes.saturating_add(context_cost(&self.contexts[i]));
            // Always keep the newest entry even if it alone exceeds the target.
            if next > target_bytes && first_kept != self.contexts.len() {
                break;
            }
            bytes = next;
            first_kept = i;
        }
        self.contexts.drain(..first_kept);
        self.total_bytes = bytes;
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

/// Lightweight in-memory backend: the graph store with no persistence.
///
/// Used by tests and for lightweight runs where a database file is unwanted.
/// Reports and evicts real graph bytes, so the memory manager's pressure
/// signals and shrink requests behave the same as the store does in memory.
pub struct InMemoryBackend {
    graph: MemoryGraph,
}

impl InMemoryBackend {
    pub fn new() -> Self {
        Self {
            graph: MemoryGraph::new(),
        }
    }
}

impl Default for InMemoryBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl Storage for InMemoryBackend {
    fn name(&self) -> &'static str {
        "memory"
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

    fn memory_bytes(&self) -> usize {
        self.graph.total_bytes()
    }

    fn shrink_memory(&mut self, target_bytes: usize) {
        self.graph.shrink_to(target_bytes);
    }

    fn set_budgets(&mut self, byte_budget: usize, count_cap: usize) {
        self.graph.set_budgets(byte_budget, count_cap);
    }
}

/// Local SQLite persistence backend.
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
        // Context transcripts are sensitive. Create a missing DB file with
        // 0600 up front (no 0644 window between create and chmod), and tighten
        // pre-existing files too. Windows has no POSIX modes; the file
        // inherits the user's ACLs.
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            if !path.exists() {
                std::fs::OpenOptions::new()
                    .write(true)
                    .create(true)
                    .mode(0o600)
                    .open(path)?;
            }
        }
        let conn = Connection::open(path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        }
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
                 project     TEXT,
                 timestamp   TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS sessions (
                 session_id TEXT PRIMARY KEY,
                 agent_type TEXT NOT NULL,
                 path       TEXT NOT NULL,
                 project    TEXT,
                 created_at TEXT NOT NULL,
                 status     TEXT NOT NULL
             );",
        )?;
        // Migration for databases created before the `project` column:
        // `CREATE TABLE IF NOT EXISTS` leaves existing tables untouched.
        migrate_add_project_column(&conn, "contexts")?;
        migrate_add_project_column(&conn, "sessions")?;
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
        let project: Option<String> = row.get(8)?;
        let timestamp: String = row.get(9)?;

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
            project,
            timestamp,
        })
    }
}

/// Add a `project` column to `table` when it is missing (older DBs).
/// No-op once present; idempotent across restarts.
fn migrate_add_project_column(conn: &Connection, table: &str) -> Result<(), StorageError> {
    let has_column = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(StorageError::from)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(StorageError::from)?
        .filter_map(Result::ok)
        .any(|name| name == "project");
    if has_column {
        return Ok(());
    }
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN project TEXT"))
        .map_err(StorageError::from)?;
    Ok(())
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
                  file_paths, decisions, errors, project, timestamp)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                ctx.id,
                ctx.session_id,
                ctx.agent_type.to_string(),
                serde_json::to_string(&ctx.context_type)?,
                ctx.content,
                serde_json::to_string(&ctx.file_paths)?,
                serde_json::to_string(&ctx.decisions)?,
                serde_json::to_string(&ctx.errors)?,
                ctx.project,
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
                    file_paths, decisions, errors, project, timestamp
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
            "SELECT session_id, agent_type, path, project, created_at, status
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
            let status_raw: String = row.get(5)?;
            let status: SessionStatus =
                serde_json::from_str(&status_raw).unwrap_or(SessionStatus::Active);
            let created_raw: String = row.get(4)?;
            let created_at: DateTime<Utc> = DateTime::parse_from_rfc3339(&created_raw)
                .map(|dt| dt.with_timezone(&Utc))
                .map_err(|err| {
                    rusqlite::Error::FromSqlConversionFailure(
                        4,
                        rusqlite::types::Type::Text,
                        Box::new(err),
                    )
                })?;
            Ok(AgentSession {
                session_id: row.get(0)?,
                agent_type,
                path: PathBuf::from(row.get::<_, String>(2)?),
                project: row.get(3)?,
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
                 (session_id, agent_type, path, project, created_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                session.session_id,
                session.agent_type.to_string(),
                session.path.to_string_lossy(),
                session.project,
                session.created_at.to_rfc3339(),
                serde_json::to_string(&session.status)?,
            ],
        )?;
        Ok(())
    }

    fn memory_bytes(&self) -> usize {
        // SQLite is disk-backed; report the page footprint as a proxy for the
        // stored-data size (the memory manager's write-admission bound).
        let Ok(conn) = self.lock() else { return 0 };
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .unwrap_or(4096);
        let page_count: i64 = conn
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap_or(0);
        (page_size as usize).saturating_mul(page_count as usize)
    }
}

/// Select the storage backend: SQLite at `db_path` (or the default location).
pub fn select_backend(db_path: Option<&Path>) -> Result<Box<dyn Storage>, StorageError> {
    let db = db_path
        .map(Path::to_path_buf)
        .unwrap_or_else(SqliteBackend::default_db_path);
    tracing::info!(db = %db.display(), "using SQLite storage backend");
    Ok(Box::new(SqliteBackend::new(&db)?))
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
            project: None,
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
    fn context_matches_project_via_stamped_project() {
        let mut ctx = sample_context("c1", "sess-a", "src/lib.rs");
        // Without the stamp, a relative path cannot match an absolute root.
        assert!(!context_matches_project(&ctx, "/repo"));
        ctx.project = Some("/repo".into());
        assert!(context_matches_project(&ctx, "/repo"));
        assert!(context_matches_project(&ctx, "/repo/src"));
        assert!(context_matches_project(&ctx, "/repo/src/lib.rs"));
        assert!(!context_matches_project(&ctx, "/other"));
        // Windows spelling differences still match after normalization.
        assert!(context_matches_project(&ctx, "\\repo"));
        // A nested worktree under the workspace also matches the workspace.
        let worktree = CrossAgentContext {
            project: Some("/repo/.worktrees/feature".into()),
            ..sample_context("c2", "sess-b", "src/lib.rs")
        };
        assert!(context_matches_project(&worktree, "/repo"));
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
        // Separator/case normalization: backslash paths match slash queries.
        assert!(path_within("C:\\repo\\src\\lib.rs", "C:/repo"));
        assert!(path_within("C:/repo/src/lib.rs", "C:\\repo"));
        assert!(!path_within("C:\\repo2\\x", "C:/repo"));
        // Trailing-separator bases match after normalization.
        assert!(path_within("C:\\repo\\src", "C:\\repo\\"));
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
            AgentType::Speg,
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
    fn memory_graph_dedups_by_id_and_caps_size() {
        let mut graph = MemoryGraph::new();
        let t0 = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        // Repeated stores of the same id replace, never duplicate.
        graph.store_context(&CrossAgentContext {
            id: "dup".into(),
            timestamp: t0,
            ..sample_context("dup", "s1", "/repo/a.rs")
        });
        graph.store_context(&CrossAgentContext {
            id: "dup".into(),
            content: "replaced".into(),
            timestamp: t0 + chrono::Duration::minutes(1),
            ..sample_context("dup", "s1", "/repo/a.rs")
        });
        let all = graph.query_context("*", 100);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].content, "replaced");

        // Beyond the cap, the oldest entries are evicted.
        let mut graph = MemoryGraph::new();
        for i in 0..MEMORY_GRAPH_CAP + 5 {
            graph.store_context(&CrossAgentContext {
                id: format!("c{i}"),
                timestamp: t0 + chrono::Duration::seconds(i as i64),
                ..sample_context(&format!("c{i}"), "s1", "/repo/a.rs")
            });
        }
        let all = graph.query_context("*", MEMORY_GRAPH_CAP + 10);
        assert_eq!(all.len(), MEMORY_GRAPH_CAP);
        // The five oldest ids (c0..c4) were evicted; newer ones remain.
        let ids: Vec<&str> = all.iter().map(|c| c.id.as_str()).collect();
        for evicted in ["c0", "c1", "c2", "c3", "c4"] {
            assert!(!ids.contains(&evicted), "expected {evicted} to be evicted");
        }
        assert!(ids.contains(&"c5"));
        assert!(ids.contains(&"c10004"));
    }

    #[test]
    fn memory_graph_respects_byte_budget() {
        let mut graph = MemoryGraph::new();
        let t0 = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        // 10 MiB of content per entry × 8 = 80 MiB > 64 MiB budget.
        let big = "x".repeat(10 << 20);
        for i in 0..8 {
            graph.store_context(&CrossAgentContext {
                id: format!("big{i}"),
                content: big.clone(),
                timestamp: t0 + chrono::Duration::seconds(i as i64),
                ..sample_context(&format!("big{i}"), "s1", "/repo/a.rs")
            });
        }
        let all = graph.query_context("*", 100);
        // Budget is 64 MiB / 10 MiB per entry → at most 6 retained.
        assert!(
            all.len() <= 6,
            "expected byte budget to evict, got {}",
            all.len()
        );
    }

    #[test]
    fn memory_graph_budgets_and_shrink_are_controllable() {
        let mut graph = MemoryGraph::new();
        let t0 = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let big = "x".repeat(1 << 20); // 1 MiB per entry
        for i in 0..8 {
            graph.store_context(&CrossAgentContext {
                id: format!("m{i}"),
                content: big.clone(),
                timestamp: t0 + chrono::Duration::seconds(i as i64),
                ..sample_context(&format!("m{i}"), "s1", "/repo/a.rs")
            });
        }
        // context_cost counts all string fields, so ≥ 8 MiB of content.
        assert!(graph.total_bytes() >= 8 << 20);

        // Memory manager lowers the budget → the next store evicts harder.
        graph.set_budgets(4 << 20, 100);
        graph.store_context(&CrossAgentContext {
            id: "m8".into(),
            content: big.clone(),
            timestamp: t0 + chrono::Duration::seconds(8),
            ..sample_context("m8", "s1", "/repo/a.rs")
        });
        assert!(graph.total_bytes() <= 4 << 20);

        // shrink_to evicts the oldest until under the target.
        graph.shrink_to(2 << 20);
        assert!(graph.total_bytes() <= 2 << 20);
        // The newest entries survive.
        let all = graph.query_context("*", 100);
        assert_eq!(all[0].id, "m8");
    }

    #[test]
    fn sqlite_memory_bytes_reflects_stored_pages() {
        let mut backend = SqliteBackend::open_in_memory().unwrap();
        let before = backend.memory_bytes();
        assert!(before > 0, "an empty sqlite db still has pages");
        for i in 0..20 {
            backend
                .store_context(&sample_context(&format!("c{i}"), "s1", "/repo/f.rs"))
                .unwrap();
        }
        // More rows → the page footprint does not shrink.
        let after = backend.memory_bytes();
        assert!(after >= before);
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
                AgentType::Speg,
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
}
