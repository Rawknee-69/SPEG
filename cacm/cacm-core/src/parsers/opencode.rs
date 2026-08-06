//! OpenCode session parser (SQLite backend).
//!
//! Modern OpenCode (>= 1.x) stores its session store in a SQLite database at
//! the platform opencode data dir (e.g. `~/.local/share/opencode/opencode.db`
//! on Linux/Windows, `~/Library/Application Support/opencode/opencode.db` on
//! macOS). Tables:
//!
//! - `session` — one row per session (`id`, `directory`, `title`, `model`,
//!   `agent`, `time_created`, `time_updated`, ...).
//! - `message` — one row per message (`id`, `session_id`, `data` JSON with
//!   `role` + `time`).
//! - `part` — one row per content part (`message_id`, `session_id`, `data`
//!   JSON with `type`: `text`, `tool`, `reasoning`, `step-start`, ...).
//!
//! The parser opens the DB read-only (SQLite WAL mode supports concurrent
//! readers while the opencode process is running) and rebuilds turns as
//! user→assistant cycles with text + tool parts attached.

use super::{AgentSessionParser, ParseError, ParseResult};
use crate::types::{AgentSession, AgentTurn, AgentType, FileChangeKind, FileModification, ToolCall};
use chrono::{DateTime, Utc};
use rusqlite::Connection;
use serde_json::Value;
use std::path::Path;

/// The database file name inside the opencode data dir.
pub const OPENCODE_DB_FILE: &str = "opencode.db";

/// OpenCode session parser (reads the SQLite session store).
#[derive(Debug, Clone, Copy, Default)]
pub struct OpenCodeSessionParser;

impl OpenCodeSessionParser {
    pub fn new() -> Self {
        Self
    }

    /// Locate the opencode DB under `root` (the opencode data dir).
    fn db_path(root: &Path) -> std::path::PathBuf {
        root.join(OPENCODE_DB_FILE)
    }
}

impl AgentSessionParser for OpenCodeSessionParser {
    fn agent_type(&self) -> AgentType {
        AgentType::OpenCode
    }

    fn parse_session_manifest(&self, path: &Path) -> ParseResult<AgentSession> {
        // `path` here is a *session row*'s synthetic path (see
        // `discover_sessions`): `<opencode-dir>/<session-id>`. The DB file is
        // `<opencode-dir>/opencode.db`; the session id is the file name.
        let dir = path.parent().unwrap_or(path);
        let session_id = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ParseError::InvalidFormat(format!("no session id in {}", path.display())))?;
        let conn = open_read_only(&dir.join(OPENCODE_DB_FILE))?;
        let created_at = query_session_created(&conn, &session_id)?.unwrap_or_else(Utc::now);
        let project = query_session_directory(&conn, &session_id)?.filter(|d| !d.is_empty());
        Ok(AgentSession::new(session_id, AgentType::OpenCode, path, created_at)
            .with_project(project))
    }

    fn parse_turn(&self, raw: &str) -> ParseResult<AgentTurn> {
        // OpenCode is a database, not a line format — a single "raw" payload
        // is one message row's `data` JSON.
        let data: Value = serde_json::from_str(raw)
            .map_err(|e| ParseError::InvalidFormat(format!("opencode message: {e}")))?;
        let role = data.get("role").and_then(Value::as_str).unwrap_or("");
        let ts = data
            .get("time")
            .and_then(|t| t.get("created"))
            .and_then(Value::as_i64)
            .map(ms_to_utc)
            .unwrap_or_else(Utc::now);
        let mut turn = AgentTurn {
            turn_index: 0,
            timestamp: ts,
            user_message: String::new(),
            assistant_response: None,
            tool_calls: Vec::new(),
            file_modifications: Vec::new(),
        };
        if role == "user" {
            turn.user_message = data.get("text").and_then(Value::as_str).unwrap_or("").to_string();
        } else if role == "assistant" {
            let text = data.get("text").and_then(Value::as_str).unwrap_or("").to_string();
            if !text.is_empty() {
                turn.assistant_response = Some(text);
            }
        }
        Ok(turn)
    }

    fn detect_activity(&self, path: &Path) -> bool {
        path.file_name()
            .is_some_and(|n| n == OPENCODE_DB_FILE)
    }

    fn discover_sessions(&self, root: &Path) -> Vec<AgentSession> {
        let db = Self::db_path(root);
        if !db.is_file() {
            return Vec::new();
        }
        let Ok(conn) = open_read_only(&db) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let Ok(mut stmt) = conn.prepare(
            "SELECT id, directory, time_created FROM session ORDER BY time_updated DESC",
        ) else {
            return out;
        };
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1).ok().flatten(),
                    row.get::<_, i64>(2).ok(),
                ))
            })
            .ok();
        for row in rows.into_iter().flatten().flatten() {
            let (session_id, directory, created_ms) = row;
            // Synthetic path `<opencode-dir>/<session-id>` so
            // parse_session_manifest / read_session_turns can recover both
            // the DB location (dir + OPENCODE_DB_FILE) and the session id.
            let path = root.join(&session_id);
            let created_at = created_ms.map(ms_to_utc).unwrap_or_else(Utc::now);
            // The session's real working directory is the workspace root it
            // ran under — use it for the per-workspace CACM filters.
            let project = directory.filter(|d| !d.is_empty());
            out.push(
                AgentSession::new(session_id, AgentType::OpenCode, path, created_at)
                    .with_project(project),
            );
        }
        out
    }

    fn read_session_turns(&self, session: &AgentSession) -> ParseResult<Vec<AgentTurn>> {
        // session.path is `<opencode-dir>/<session-id>`; the DB is
        // `<opencode-dir>/opencode.db`.
        let dir = session.path.parent().unwrap_or(session.path.as_path());
        let db = dir.join(OPENCODE_DB_FILE);
        let session_id = session
            .path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        read_opencode_turns(&db, &session_id)
    }
}

/// Open the DB read-only (WAL mode: safe with a running opencode process).
fn open_read_only(db: &Path) -> Result<Connection, ParseError> {
    Connection::open_with_flags(
        db,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| ParseError::Io(std::io::Error::other(format!("opencode db: {e}"))))
}

fn query_session_created(conn: &Connection, session_id: &str) -> Result<Option<DateTime<Utc>>, ParseError> {
    let ms = conn
        .query_row(
            "SELECT time_created FROM session WHERE id = ?1",
            [session_id],
            |row| row.get::<_, i64>(0),
        )
        .ok();
    Ok(ms.map(ms_to_utc))
}

fn query_session_directory(conn: &Connection, session_id: &str) -> Result<Option<String>, ParseError> {
    let dir = conn
        .query_row(
            "SELECT directory FROM session WHERE id = ?1",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten();
    Ok(dir)
}

/// Read every turn from one opencode session: messages joined with their
/// parts, grouped into user→assistant cycles.
pub fn read_opencode_turns(db: &Path, session_id: &str) -> ParseResult<Vec<AgentTurn>> {
    let conn = open_read_only(db)?;
    let mut turns: Vec<AgentTurn> = Vec::new();
    let mut current: Option<AgentTurn> = None;

    let mut stmt = conn
        .prepare(
            "SELECT m.id, m.data, m.time_created \
             FROM message m WHERE m.session_id = ?1 ORDER BY m.time_created, m.id",
        )
        .map_err(|e| ParseError::Io(std::io::Error::other(format!("opencode messages: {e}"))))?;
    let messages = stmt
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .ok();

    for message in messages.into_iter().flatten().flatten() {
        let (message_id, data_json) = message;
        let data: Value = serde_json::from_str(&data_json).unwrap_or(Value::Null);
        let role = data.get("role").and_then(Value::as_str).unwrap_or("").to_string();
        let ts = data
            .get("time")
            .and_then(|t| t.get("created"))
            .and_then(Value::as_i64)
            .map(ms_to_utc)
            .unwrap_or_else(Utc::now);

        match role.as_str() {
            "user" => {
                if let Some(t) = current.take() {
                    turns.push(t);
                }
                let mut turn = AgentTurn {
                    turn_index: 0,
                    timestamp: ts,
                    user_message: String::new(),
                    assistant_response: None,
                    tool_calls: Vec::new(),
                    file_modifications: Vec::new(),
                };
                collect_parts(&conn, session_id, &message_id, &mut turn, true);
                current = Some(turn);
            }
            "assistant" => {
                let turn = current.get_or_insert_with(|| AgentTurn {
                    turn_index: 0,
                    timestamp: ts,
                    user_message: String::new(),
                    assistant_response: None,
                    tool_calls: Vec::new(),
                    file_modifications: Vec::new(),
                });
                collect_parts(&conn, session_id, &message_id, turn, false);
            }
            _ => {}
        }
    }
    if let Some(t) = current.take() {
        turns.push(t);
    }
    for (i, turn) in turns.iter_mut().enumerate() {
        turn.turn_index = i as u32;
    }
    Ok(turns)
}

/// Attach a message's parts to `turn`. For user messages only `text` parts
/// become the user message; for assistant messages text parts accumulate as
/// the response and `tool` parts become tool calls + file modifications.
fn collect_parts(
    conn: &Connection,
    session_id: &str,
    message_id: &str,
    turn: &mut AgentTurn,
    is_user: bool,
) {
    let mut stmt = match conn.prepare(
        "SELECT data FROM part WHERE message_id = ?1 AND session_id = ?2 ORDER BY time_created, id",
    ) {
        Ok(s) => s,
        Err(_) => return,
    };
    let parts = stmt
        .query_map(rusqlite::params![message_id, session_id], |row| {
            row.get::<_, String>(0)
        })
        .ok();
    for part in parts.into_iter().flatten().flatten() {
        let data: Value = serde_json::from_str(&part).unwrap_or(Value::Null);
        let kind = data.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "text" => {
                let text = data.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                if is_user {
                    if !turn.user_message.is_empty() {
                        turn.user_message.push('\n');
                    }
                    turn.user_message.push_str(&text);
                } else {
                    if !text.is_empty() {
                        let base = turn.assistant_response.take().unwrap_or_default();
                        turn.assistant_response =
                            Some(if base.is_empty() { text } else { format!("{base}\n{text}") });
                    }
                }
            }
            "tool" => {
                let name = data.get("tool").and_then(Value::as_str).unwrap_or("").to_string();
                let input = data
                    .get("state")
                    .and_then(|s| s.get("input"))
                    .cloned()
                    .unwrap_or(Value::Null);
                if !name.is_empty() {
                    turn.tool_calls.push(ToolCall { name: name.clone(), input: input.clone() });
                }
                record_tool_file(&name, &input, turn);
            }
            _ => {}
        }
    }
}

/// Map an opencode tool part's `state.input` to a file modification when it
/// carries a `filePath` (write/edit tools).
fn record_tool_file(tool_name: &str, input: &Value, turn: &mut AgentTurn) {
    let path = input
        .get("filePath")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        let change = match tool_name {
            "write" | "create" => FileChangeKind::Create,
            "delete" => FileChangeKind::Delete,
            "rename" => FileChangeKind::Rename,
            _ => FileChangeKind::Modify,
        };
        turn.file_modifications.push(FileModification { path, change });
    }
}

/// OpenCode stores times as epoch milliseconds.
fn ms_to_utc(ms: i64) -> DateTime<Utc> {
    let secs = ms.div_euclid(1000);
    let nanos = (ms.rem_euclid(1000) as u32) * 1_000_000;
    DateTime::<Utc>::from_timestamp(secs, nanos).unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn insert_session(conn: &Connection, id: &str, dir: &str, created: i64) {
        conn.execute(
            "INSERT INTO session (id, project_id, slug, directory, title, version,
                time_created, time_updated) VALUES (?1,'p','s',?2,'t','1',?3,?3)",
            rusqlite::params![id, dir, created],
        )
        .unwrap();
    }

    fn insert_message(conn: &Connection, id: &str, session: &str, role: &str, created: i64) {
        let data = format!(r#"{{"role":"{role}","time":{{"created":{created}}}}}"#);
        conn.execute(
            "INSERT INTO message (id, session_id, time_created, time_updated, data)
             VALUES (?1,?2,?3,?3,?4)",
            rusqlite::params![id, session, created, data],
        )
        .unwrap();
    }

    fn insert_part(conn: &Connection, id: &str, msg: &str, session: &str, data: &str, created: i64) {
        conn.execute(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
             VALUES (?1,?2,?3,?4,?4,?5)",
            rusqlite::params![id, msg, session, created, data],
        )
        .unwrap();
    }

    #[test]
    fn discover_sessions_reads_db_rows() {
        let dir = std::env::temp_dir().join(format!("cacm-opencode-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join(OPENCODE_DB_FILE);
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
                workspace_id TEXT, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
                path TEXT, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
                summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
                summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL,
                tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
                tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
                tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT,
                agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
                time_compacting INTEGER, time_archived INTEGER);",
        )
        .unwrap();
        insert_session(&conn, "ses_abc", "/repo", 1786046000000);
        drop(conn);

        let sessions = OpenCodeSessionParser::new().discover_sessions(&dir);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "ses_abc");
        assert_eq!(sessions[0].agent_type, AgentType::OpenCode);
        assert_eq!(sessions[0].project.as_deref(), Some("/repo"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_turns_joins_messages_and_parts() {
        let db = std::env::temp_dir().join(format!("cacm-opencode-turns-{}.db", std::process::id()));
        let _ = fs::remove_file(&db);
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch(dump_schema()).unwrap();
            insert_session(&conn, "ses_1", "/repo", 1786046000000);
            insert_message(&conn, "m1", "ses_1", "user", 1786046001000);
            insert_part(
                &conn,
                "p1",
                "m1",
                "ses_1",
                r#"{"type":"text","text":"make hello.js"}"#,
                1786046001000,
            );
            insert_message(&conn, "m2", "ses_1", "assistant", 1786046002000);
            insert_part(
                &conn,
                "p2",
                "m2",
                "ses_1",
                r#"{"type":"text","text":"Created hello.js"}"#,
                1786046002000,
            );
            insert_part(
                &conn,
                "p3",
                "m2",
                "ses_1",
                r#"{"type":"tool","tool":"write","state":{"input":{"filePath":"hello.js"}}}"#,
                1786046002000,
            );
        }

        let turns = read_opencode_turns(&db, "ses_1").unwrap();
        let _ = fs::remove_file(&db);
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].user_message, "make hello.js");
        assert_eq!(turns[0].assistant_response.as_deref(), Some("Created hello.js"));
        assert_eq!(turns[0].tool_calls.len(), 1);
        assert_eq!(turns[0].tool_calls[0].name, "write");
        assert_eq!(turns[0].file_modifications[0].path, "hello.js");
    }

    fn dump_schema() -> &'static str {
        "CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
            workspace_id TEXT, parent_id TEXT, slug TEXT NOT NULL, directory TEXT NOT NULL,
            path TEXT, title TEXT NOT NULL, version TEXT NOT NULL, share_url TEXT,
            summary_additions INTEGER, summary_deletions INTEGER, summary_files INTEGER,
            summary_diffs TEXT, metadata TEXT, cost REAL DEFAULT 0 NOT NULL,
            tokens_input INTEGER DEFAULT 0 NOT NULL, tokens_output INTEGER DEFAULT 0 NOT NULL,
            tokens_reasoning INTEGER DEFAULT 0 NOT NULL, tokens_cache_read INTEGER DEFAULT 0 NOT NULL,
            tokens_cache_write INTEGER DEFAULT 0 NOT NULL, revert TEXT, permission TEXT,
            agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
            time_compacting INTEGER, time_archived INTEGER);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);"
    }

    #[test]
    fn detect_activity_matches_db_file() {
        let parser = OpenCodeSessionParser::new();
        assert!(parser.detect_activity(Path::new("/home/u/.local/share/opencode/opencode.db")));
        assert!(!parser.detect_activity(Path::new("/home/u/.local/share/opencode/opencode.db-shm")));
        assert!(!parser.detect_activity(Path::new("/tmp/x.jsonl")));
    }
}
