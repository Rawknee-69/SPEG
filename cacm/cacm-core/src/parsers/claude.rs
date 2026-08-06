//! Claude Code session parser.
//!
//! Claude Code stores each session as a JSONL transcript at
//! `~/.claude/projects/<project>/<session-id>.jsonl`. Every line is one
//! message: `{"type":"user","message":{"role":"user","content":[...]}}`,
//! `{"type":"assistant","message":{"role":"assistant","content":[...]}}`,
//! or `{"type":"summary",...}`. Content blocks are typed
//! (`text`, `tool_use`, `tool_result`, `thinking`).
//!
//! The parser groups consecutive messages into turns (a user message opens a
//! turn; assistant messages + tool results fill it), extracts text/tool
//! calls, and maps `Edit`/`Write`/`MultiEdit`/`Bash`-style tool inputs to
//! file modifications for the extractor.

use super::{AgentSessionParser, ParseError, ParseResult};
use crate::types::{AgentSession, AgentTurn, AgentType, FileChangeKind, FileModification, ToolCall};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::path::Path;

/// Stub-free Claude Code session parser.
#[derive(Debug, Clone, Copy, Default)]
pub struct ClaudeCodeSessionParser;

impl ClaudeCodeSessionParser {
    pub fn new() -> Self {
        Self
    }
}

impl AgentSessionParser for ClaudeCodeSessionParser {
    fn agent_type(&self) -> AgentType {
        AgentType::ClaudeCode
    }

    fn parse_session_manifest(&self, path: &Path) -> ParseResult<AgentSession> {
        let session_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ParseError::InvalidFormat(format!("no session id in {}", path.display())))?;
        let created_at = file_modified_time(path);
        Ok(AgentSession::new(session_id, AgentType::ClaudeCode, path, created_at))
    }

    fn parse_turn(&self, raw: &str) -> ParseResult<AgentTurn> {
        let line: Value = serde_json::from_str(raw)
            .map_err(|e| ParseError::InvalidFormat(format!("claude line: {e}")))?;
        let message = line.get("message").unwrap_or(&line);
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let timestamp = line
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);
        let mut turn = AgentTurn {
            turn_index: 0,
            timestamp,
            user_message: String::new(),
            assistant_response: None,
            tool_calls: Vec::new(),
            file_modifications: Vec::new(),
        };
        if role == "user" {
            turn.user_message = extract_text(message);
            apply_tool_results(message, &mut turn);
        } else if role == "assistant" {
            let text = extract_text(message);
            if !text.is_empty() {
                turn.assistant_response = Some(text);
            }
            extract_tool_uses(message, &mut turn);
        }
        Ok(turn)
    }

    fn detect_activity(&self, path: &Path) -> bool {
        path.extension().is_some_and(|e| e == "jsonl")
            && path
                .to_string_lossy()
                .contains(".claude")
            && path.to_string_lossy().contains("projects")
    }

    fn discover_sessions(&self, root: &Path) -> Vec<AgentSession> {
        discover_jsonl_sessions(root, AgentType::ClaudeCode)
    }

    fn read_session_turns(&self, session: &AgentSession) -> ParseResult<Vec<AgentTurn>> {
        read_claude_turns(&session.path)
    }
}

/// Enumerate `<root>/<project>/<session-id>.jsonl` transcripts.
fn discover_jsonl_sessions(root: &Path, agent: AgentType) -> Vec<AgentSession> {
    let mut out = Vec::new();
    let Ok(projects) = std::fs::read_dir(root) else {
        return out;
    };
    for project in projects.flatten() {
        let Ok(entries) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_some_and(|e| e == "jsonl") && path.is_file() {
                let session_id = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                if !session_id.is_empty() {
                    out.push(AgentSession::new(
                        session_id,
                        agent,
                        &path,
                        file_modified_time(&path),
                    ));
                }
            }
        }
    }
    out
}

/// Read every turn from a Claude Code transcript (JSONL lines grouped into
/// user→assistant cycles).
pub fn read_claude_turns(path: &Path) -> ParseResult<Vec<AgentTurn>> {
    let content = std::fs::read_to_string(path)?;
    let mut turns: Vec<AgentTurn> = Vec::new();
    let mut current: Option<AgentTurn> = None;
    for (index, raw) in content.lines().enumerate() {
        let line: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let message = line.get("message").unwrap_or(&line);
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        let timestamp = line
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);

        match role {
            "user" => {
                if let Some(t) = current.take() {
                    turns.push(t);
                }
                let mut turn = AgentTurn {
                    turn_index: index as u32,
                    timestamp,
                    user_message: extract_text(message),
                    assistant_response: None,
                    tool_calls: Vec::new(),
                    file_modifications: Vec::new(),
                };
                apply_tool_results(message, &mut turn);
                current = Some(turn);
            }
            "assistant" => {
                let turn = current.get_or_insert_with(|| AgentTurn {
                    turn_index: index as u32,
                    timestamp,
                    user_message: String::new(),
                    assistant_response: None,
                    tool_calls: Vec::new(),
                    file_modifications: Vec::new(),
                });
                let text = extract_text(message);
                if !text.is_empty() {
                    let base = turn.assistant_response.take().unwrap_or_default();
                    turn.assistant_response = Some(if base.is_empty() { text } else { format!("{base}\n{text}") });
                }
                extract_tool_uses(message, turn);
            }
            _ => {}
        }
    }
    if let Some(t) = current.take() {
        turns.push(t);
    }
    // Reindex turns sequentially so the extractor sees 0-based ordering.
    for (i, turn) in turns.iter_mut().enumerate() {
        turn.turn_index = i as u32;
    }
    Ok(turns)
}

/// Concatenate `text` blocks (and `thinking` text) from a message content array.
fn extract_text(message: &Value) -> String {
    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
        // Some messages carry a plain string content.
        return message
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
    };
    let mut out = String::new();
    for block in blocks {
        let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "text" => {
                if let Some(t) = block.get("text").and_then(Value::as_str) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
            "thinking" => {
                if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
            _ => {}
        }
    }
    out
}

/// Assistant `tool_use` blocks → tool calls (and file modifications for
/// edit/write tools).
fn extract_tool_uses(message: &Value, turn: &mut AgentTurn) {
    let Some(blocks) = message.get("content").and_then(Value::as_array) else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let name = block.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        if !name.is_empty() {
            turn.tool_calls.push(ToolCall { name: name.clone(), input: input.clone() });
        }
        record_file_change(&name, &input, turn);
    }
}

/// User `tool_result` blocks: some transcripts annotate the file written;
/// when the content looks like a diff/result for a known tool we skip (the
/// assistant-side tool_use already recorded the path). Kept as a no-op hook
/// for symmetry with the assistant-side extraction.
fn apply_tool_results(_message: &Value, _turn: &mut AgentTurn) {}

/// Map a Claude tool name + input to a [`FileModification`] when the input
/// carries a `file_path`/`path` (Edit, Write, MultiEdit, NotebookEdit, ...).
fn record_file_change(tool_name: &str, input: &Value, turn: &mut AgentTurn) {
    let path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(path) = path {
        if !path.is_empty() {
            let change = match tool_name {
                "Write" | "NotebookEdit" | "MultiEdit" => FileChangeKind::Create,
                _ => FileChangeKind::Modify,
            };
            turn.file_modifications.push(FileModification { path, change });
        }
    }
}

/// Best-effort mtime → UTC (fallback now).
fn file_modified_time(path: &Path) -> DateTime<Utc> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .map(DateTime::<Utc>::from)
        .unwrap_or_else(Utc::now)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_assistant_turn_with_tool() {
        let raw = r#"{"type":"assistant","message":{"role":"assistant","content":[
            {"type":"text","text":"I'll fix it."},
            {"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"src/lib.rs","old_string":"a","new_string":"b"}}
        ]},"timestamp":"2026-08-06T12:00:00Z"}"#;
        let turn = ClaudeCodeSessionParser::new().parse_turn(raw).unwrap();
        assert_eq!(turn.assistant_response.as_deref(), Some("I'll fix it."));
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "Edit");
        assert_eq!(turn.file_modifications.len(), 1);
        assert_eq!(turn.file_modifications[0].path, "src/lib.rs");
    }

    #[test]
    fn groups_lines_into_turns() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("cacm-claude-test-{}.jsonl", std::process::id()));
        std::fs::write(
            &path,
            concat!(
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"fix the build"}]},"timestamp":"2026-08-06T12:00:00Z"}"#,
                "\n",
                r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]},"timestamp":"2026-08-06T12:00:05Z"}"#,
                "\n",
                r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"now add tests"}]},"timestamp":"2026-08-06T12:01:00Z"}"#,
                "\n",
            ),
        )
        .unwrap();
        let turns = read_claude_turns(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].user_message, "fix the build");
        assert_eq!(turns[0].assistant_response.as_deref(), Some("done"));
        assert_eq!(turns[1].user_message, "now add tests");
        assert_eq!(turns[0].turn_index, 0);
        assert_eq!(turns[1].turn_index, 1);
    }

    #[test]
    fn detect_activity_matches_claude_transcripts() {
        let parser = ClaudeCodeSessionParser::new();
        assert!(parser.detect_activity(Path::new(
            "/home/u/.claude/projects/demo/abc-123.jsonl"
        )));
        assert!(!parser.detect_activity(Path::new("/tmp/other.jsonl")));
    }
}
