//! Jcode session parser.
//!
//! Parses jcode's own session artifacts under `~/.jcode/sessions/`:
//!
//! - `<session_id>.json` — full session snapshot: metadata (`id`,
//!   `created_at`, `status`, ...) plus the `messages` transcript.
//! - `<session_id>.journal.jsonl` — append-only journal; each line is a
//!   [`SessionJournalEntry`] carrying `meta` plus newly appended
//!   [`StoredMessage`]s.
//!
//! The on-disk shapes mirror `jcode-session-types` / `jcode-message-types`
//! (see `jcode/crates/` in the SPEG repo): messages use `role` (`user` /
//! `assistant`) and internally-tagged `content` blocks (`text`, `tool_use`,
//! `tool_result`, `image`, ...).
//!
//! Note: real jcode sessions are a *flat* directory of `<id>.json` +
//! `<id>.journal.jsonl` files (no per-session subdirectory), so the parser
//! accepts a snapshot file, a journal file, or a directory containing a
//! single snapshot.

// The structs below mirror jcode's on-disk formats field-for-field. Some
// fields are only parsed (to validate the shape and document the format), not
// read yet; they are kept for future turn extraction from snapshots.
#![allow(dead_code)]

use crate::parsers::{AgentSessionParser, ParseError, ParseResult};
use crate::types::{
    AgentSession, AgentTurn, AgentType, FileChangeKind, FileModification, SessionStatus, ToolCall,
};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Parser for jcode sessions (`AgentType::Jcode`).
#[derive(Debug, Clone, Copy, Default)]
pub struct JcodeSessionParser;

impl JcodeSessionParser {
    pub fn new() -> Self {
        Self
    }
}

// ---------------------------------------------------------------------------
// On-disk formats (mirror jcode-message-types / jcode-session-types)
// ---------------------------------------------------------------------------

/// Role of a stored message. Mirrors `jcode_message_types::Role`.
///
/// `Role::Other` absorbs any role jcode's files may carry that this parser
/// does not model (e.g. `system`/`developer`) so a single such message never
/// fails the whole line — unknown roles are not shown as user prompts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Role {
    #[default]
    User,
    Assistant,
    Other,
}

impl<'de> Deserialize<'de> for Role {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let raw = String::deserialize(deserializer)?;
        Ok(match raw.to_ascii_lowercase().as_str() {
            "user" => Role::User,
            "assistant" => Role::Assistant,
            _ => Role::Other,
        })
    }
}

/// A content block inside a message. Internally tagged by `type` with
/// snake_case names, exactly like `jcode_message_types::ContentBlock`.
/// Unknown block types fall through to `Unknown` so a single exotic block
/// never fails the whole line; the fields of known-but-unconsumed variants
/// are lenient (`#[serde(default)]`) so provider-wire shapes with slightly
/// different field sets still parse.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ContentBlock {
    Text {
        text: String,
    },
    Reasoning {
        #[serde(default)]
        text: String,
    },
    ReasoningTrace {
        #[serde(default)]
        text: String,
    },
    AnthropicThinking {
        #[serde(default)]
        thinking: String,
        #[serde(default)]
        signature: String,
    },
    OpenAIReasoning {
        #[serde(default)]
        id: String,
        #[serde(default)]
        summary: Vec<String>,
    },
    ToolUse {
        #[serde(default)]
        id: String,
        name: String,
        #[serde(default)]
        input: serde_json::Value,
    },
    /// Tool output. `content` is kept untyped: jcode writes plain text, but
    /// some provider wire formats carry an array of blocks; both shapes must
    /// parse without killing the line.
    ToolResult {
        #[serde(default)]
        tool_use_id: String,
        #[serde(default)]
        content: serde_json::Value,
        #[serde(default)]
        is_error: Option<bool>,
    },
    Image {
        #[serde(default)]
        media_type: String,
        #[serde(default)]
        data: String,
    },
    OpenAICompaction {
        #[serde(default)]
        encrypted_content: String,
    },
    /// Any content-block type this parser does not know yet.
    #[serde(other)]
    Unknown,
}

/// One stored message. Mirrors `jcode_session_types::StoredMessage`
/// (the transcript record written to snapshots and journals).
#[derive(Debug, Clone, Deserialize)]
struct StoredMessage {
    #[serde(default)]
    id: String,
    role: Role,
    #[serde(default)]
    content: Vec<ContentBlock>,
    #[serde(default)]
    timestamp: Option<DateTime<Utc>>,
    #[serde(default)]
    tool_duration_ms: Option<u64>,
}

/// `<session_id>.json` snapshot. Mirrors the jcode `Session` header fields
/// the parser cares about (unknown fields are ignored).
#[derive(Debug, Deserialize)]
struct SessionSnapshot {
    id: String,
    #[serde(default)]
    title: Option<String>,
    created_at: DateTime<Utc>,
    #[serde(default)]
    updated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    status: serde_json::Value,
    #[serde(default)]
    messages: Vec<StoredMessage>,
}

/// One line of `<session_id>.journal.jsonl`. Mirrors
/// `jcode_session::journal::SessionJournalEntry` (subsets only).
#[derive(Debug, Deserialize)]
struct SessionJournalEntry {
    meta: SessionJournalMeta,
    #[serde(default)]
    append_messages: Vec<StoredMessage>,
}

#[derive(Debug, Deserialize)]
struct SessionJournalMeta {
    #[serde(default)]
    updated_at: Option<DateTime<Utc>>,
    #[serde(default)]
    status: serde_json::Value,
}

// ---------------------------------------------------------------------------
// AgentSessionParser impl
// ---------------------------------------------------------------------------

impl AgentSessionParser for JcodeSessionParser {
    fn agent_type(&self) -> AgentType {
        AgentType::Jcode
    }

    /// Read a jcode session manifest from a snapshot file, a journal file, or
    /// a directory that contains exactly one snapshot.
    fn parse_session_manifest(&self, path: &Path) -> ParseResult<AgentSession> {
        if path.is_dir() {
            let snapshot = resolve_snapshot_in_dir(path)?;
            return parse_snapshot(&snapshot);
        }
        if path.is_file() {
            let name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            if name.ends_with(".journal.jsonl") {
                return session_from_journal(path);
            }
            if name.ends_with(".json") {
                return parse_snapshot(path);
            }
            return Err(ParseError::InvalidFormat(format!(
                "{}: not a jcode session file (.json snapshot or .journal.jsonl)",
                path.display()
            )));
        }
        Err(ParseError::Io(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("no such jcode session path: {}", path.display()),
        )))
    }

    /// Parse one JSONL line into an [`AgentTurn`].
    ///
    /// Two accepted shapes, matching real jcode files:
    /// - a [`StoredMessage`] line (a transcript record: `role`, `content`,
    ///   `timestamp`), or
    /// - a journal entry line (`meta` + `append_messages`), whose messages are
    ///   combined into one turn.
    ///
    /// `turn_index` is always 0 — this method has no positional context; the
    /// caller (watcher/daemon) assigns real indexes when sequencing turns.
    fn parse_turn(&self, raw: &str) -> ParseResult<AgentTurn> {
        let value: serde_json::Value = serde_json::from_str(raw)
            .map_err(|err| ParseError::InvalidFormat(format!("not valid JSON: {err}")))?;
        if value.get("meta").is_some() {
            let entry: SessionJournalEntry = serde_json::from_value(value).map_err(|err| {
                ParseError::InvalidFormat(format!("invalid jcode journal entry: {err}"))
            })?;
            Ok(turn_from_journal_entry(&entry))
        } else {
            let message: StoredMessage = serde_json::from_value(value).map_err(|err| {
                ParseError::InvalidFormat(format!("invalid jcode transcript line: {err}"))
            })?;
            Ok(turn_from_message(&message, 0))
        }
    }

    /// Cheap activity check: does `path` look like a jcode session artifact
    /// (a `<id>.json` snapshot or `<id>.journal.jsonl` transcript)?
    ///
    /// Intentionally broad (any `.json` under a watched root counts): this is
    /// a cheap pre-filter for the watcher, and the session dir only contains
    /// jcode session files, not app config.
    fn detect_activity(&self, path: &Path) -> bool {
        if !path.is_file() {
            return false;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            return false;
        };
        name.ends_with(".journal.jsonl") || name.ends_with(".json")
    }
}

// ---------------------------------------------------------------------------
// Manifest parsing
// ---------------------------------------------------------------------------

fn parse_snapshot(path: &Path) -> ParseResult<AgentSession> {
    let raw = std::fs::read_to_string(path)?;
    let snapshot: SessionSnapshot = serde_json::from_str(&raw)
        .map_err(|err| ParseError::InvalidFormat(format!("{}: {err}", path.display())))?;
    Ok(AgentSession {
        session_id: snapshot.id,
        agent_type: AgentType::Jcode,
        path: path.to_path_buf(),
        created_at: snapshot.created_at,
        status: map_jcode_status(&snapshot.status),
    })
}

/// Find the single snapshot in a session directory. Prefers a snapshot whose
/// file stem matches the directory name; falls back to "exactly one snapshot"
/// so the flat `~/.jcode/sessions/` layout still resolves per-file.
fn resolve_snapshot_in_dir(dir: &Path) -> ParseResult<PathBuf> {
    let mut snapshots: Vec<PathBuf> = Vec::new();
    let entries = std::fs::read_dir(dir)
        .map_err(|err| ParseError::Io(err))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if name.ends_with(".journal.jsonl") {
            continue;
        }
        if name.ends_with(".json") {
            snapshots.push(path);
        }
    }
    snapshots.sort();

    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if let Some(matching) = snapshots
        .iter()
        .find(|path| path.file_stem().and_then(|s| s.to_str()) == Some(dir_name))
    {
        return Ok(matching.clone());
    }
    match snapshots.len() {
        1 => Ok(snapshots.remove(0)),
        0 => Err(ParseError::InvalidFormat(format!(
            "{}: no jcode session snapshot (.json) found",
            dir.display()
        ))),
        _ => Err(ParseError::InvalidFormat(format!(
            "{}: multiple jcode session snapshots found; pass the .json file directly",
            dir.display()
        ))),
    }
}

/// Best-effort manifest from a journal file: the session id is the file stem
/// and the last journal line's meta supplies status/timestamp. `created_at`
/// is not recorded in journals, so it falls back to the latest `updated_at`.
fn session_from_journal(path: &Path) -> ParseResult<AgentSession> {
    let session_id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|stem| stem.strip_suffix(".journal").unwrap_or(stem).to_string())
        .unwrap_or_default();
    if session_id.is_empty() {
        return Err(ParseError::InvalidFormat(format!(
            "{}: cannot derive session id from journal file name",
            path.display()
        )));
    }

    let raw = std::fs::read_to_string(path)?;
    // Journal lines are append-ordered, so the last parseable entry's status
    // is authoritative; created_at (not stored in journals) falls back to the
    // newest `updated_at` seen.
    let mut created_at: Option<DateTime<Utc>> = None;
    let mut status = SessionStatus::Active;
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Ok(entry) = serde_json::from_str::<SessionJournalEntry>(line) {
            status = map_jcode_status(&entry.meta.status);
            if let Some(ts) = entry.meta.updated_at {
                if created_at.map(|prev| ts > prev).unwrap_or(true) {
                    created_at = Some(ts);
                }
            }
        }
    }

    Ok(AgentSession {
        session_id,
        agent_type: AgentType::Jcode,
        path: path.to_path_buf(),
        created_at: created_at.unwrap_or_else(Utc::now),
        status,
    })
}

/// Map a jcode `SessionStatus` (string or `{"Variant":...}` object form) to
/// cacm's [`SessionStatus`]. Unknown/missing values default to [`Active`].
///
/// [`Active`]: SessionStatus::Active
fn map_jcode_status(value: &serde_json::Value) -> SessionStatus {
    let name = match value {
        serde_json::Value::String(s) => s.to_ascii_lowercase(),
        serde_json::Value::Object(map) => map
            .keys()
            .next()
            .map(|key| key.to_ascii_lowercase())
            .unwrap_or_default(),
        _ => String::new(),
    };
    match name.as_str() {
        "active" | "reloaded" | "compacted" => SessionStatus::Active,
        "closed" => SessionStatus::Completed,
        "crashed" | "error" | "ratelimited" | "rate_limited" => SessionStatus::Failed,
        _ => SessionStatus::Active,
    }
}

// ---------------------------------------------------------------------------
// Turn parsing
// ---------------------------------------------------------------------------

fn turn_from_message(message: &StoredMessage, turn_index: u32) -> AgentTurn {
    let timestamp = message.timestamp.unwrap_or_else(Utc::now);
    let text = blocks_to_text(&message.content);
    let tool_calls = tool_calls_from_blocks(&message.content);
    let file_modifications = file_modifications_from_blocks(&message.content);
    match message.role {
        Role::User => AgentTurn {
            turn_index,
            timestamp,
            user_message: text,
            assistant_response: None,
            tool_calls,
            file_modifications,
        },
        Role::Assistant => AgentTurn {
            turn_index,
            timestamp,
            user_message: String::new(),
            assistant_response: if text.is_empty() { None } else { Some(text) },
            tool_calls,
            file_modifications,
        },
        // System/developer/unknown roles contribute no user prompt or
        // assistant text, but keep any tool calls they carry.
        Role::Other => AgentTurn {
            turn_index,
            timestamp,
            user_message: String::new(),
            assistant_response: None,
            tool_calls,
            file_modifications,
        },
    }
}

/// Combine all messages appended by one journal entry into a single turn:
/// user text from the first user message, assistant text from the last
/// assistant message, and every tool call / file modification seen. The turn
/// timestamp is the newest appended message's (or the journal meta's).
fn turn_from_journal_entry(entry: &SessionJournalEntry) -> AgentTurn {
    let timestamp = entry
        .append_messages
        .iter()
        .rev()
        .find_map(|m| m.timestamp)
        .or(entry.meta.updated_at)
        .unwrap_or_else(Utc::now);

    let mut user_message = String::new();
    let mut assistant_response: Option<String> = None;
    let mut tool_calls: Vec<ToolCall> = Vec::new();
    let mut file_modifications: Vec<FileModification> = Vec::new();

    for message in &entry.append_messages {
        let text = blocks_to_text(&message.content);
        match message.role {
            Role::User if user_message.is_empty() && !text.is_empty() => {
                user_message = text;
            }
            Role::Assistant if !text.is_empty() => {
                assistant_response = Some(text);
            }
            _ => {}
        }
        tool_calls.extend(tool_calls_from_blocks(&message.content));
        file_modifications.extend(file_modifications_from_blocks(&message.content));
    }

    AgentTurn {
        turn_index: 0,
        timestamp,
        user_message,
        assistant_response,
        tool_calls,
        file_modifications,
    }
}

/// Join the textual content blocks of a message (skips reasoning, tool
/// results, images, ...).
fn blocks_to_text(blocks: &[ContentBlock]) -> String {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => {
                let text = text.trim();
                if text.is_empty() {
                    None
                } else {
                    Some(text.to_string())
                }
            }
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Extract `tool_use` blocks as [`ToolCall`]s.
fn tool_calls_from_blocks(blocks: &[ContentBlock]) -> Vec<ToolCall> {
    blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::ToolUse { name, input, .. } => Some(ToolCall {
                name: name.clone(),
                input: input.clone(),
            }),
            _ => None,
        })
        .collect()
}

/// Extract file modifications from `tool_use` blocks whose tool edits files.
///
/// jcode `tool_result` blocks only carry plain text (`tool_use_id` +
/// `content`), so structured file paths live in the matching `tool_use`
/// `input` — that is where modification records come from.
fn file_modifications_from_blocks(blocks: &[ContentBlock]) -> Vec<FileModification> {
    let mut modifications = Vec::new();
    for block in blocks {
        let ContentBlock::ToolUse { name, input, .. } = block else {
            continue;
        };
        if let Some(modification) = file_modification_from_tool_use(name, input) {
            modifications.push(modification);
        }
    }
    modifications
}

/// File-edit tools recognized by jcode, by canonical name
/// (see `jcode_tool_types::resolve_tool_name`).
const FILE_EDIT_TOOLS: &[&str] = &["edit", "write"];
const FILE_DELETE_TOOLS: &[&str] = &["delete", "remove"];
const FILE_RENAME_TOOLS: &[&str] = &["rename", "move_file"];

/// Normalize a tool name as jcode's `resolve_tool_name` does for the
/// file-edit family: lowercase, strip a `functions.` transport prefix, and
/// map Claude Code style aliases (`edit_file` -> `edit`, `write_file` ->
/// `write`).
fn normalize_tool_name(name: &str) -> String {
    let name = name.strip_prefix("functions.").unwrap_or(name);
    match name.to_ascii_lowercase().as_str() {
        "edit_file" | "file_edit" => "edit".to_string(),
        "write_file" | "file_write" => "write".to_string(),
        "delete_file" | "rm" | "rm_file" => "delete".to_string(),
        "move" | "rename_file" => "rename".to_string(),
        other => other.to_string(),
    }
}

fn file_modification_from_tool_use(name: &str, input: &serde_json::Value) -> Option<FileModification> {
    let name = normalize_tool_name(name);
    let change = if FILE_EDIT_TOOLS.contains(&name.as_str()) {
        FileChangeKind::Modify
    } else if FILE_DELETE_TOOLS.contains(&name.as_str()) {
        FileChangeKind::Delete
    } else if FILE_RENAME_TOOLS.contains(&name.as_str()) {
        FileChangeKind::Rename
    } else {
        return None;
    };
    let path = tool_input_path(input)?;
    Some(FileModification { path, change })
}

/// The file path from a tool input, accepting the field names jcode and its
/// provider aliases use (`file_path`, `path`, `file`).
fn tool_input_path(input: &serde_json::Value) -> Option<String> {
    for key in ["file_path", "path", "file"] {
        if let Some(path) = input.get(key).and_then(|v| v.as_str()) {
            let path = path.trim();
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    None
}
