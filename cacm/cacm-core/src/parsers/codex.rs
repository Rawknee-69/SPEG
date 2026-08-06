//! Codex (OpenAI CLI) session parser.
//!
//! Codex stores each session as a JSONL transcript at
//! `~/.codex/sessions/<date>/<session-id>.jsonl`. The format has evolved:
//! older transcripts use `{"role":"user","content":...}` / `{"role":"assistant",...}`
//! lines; newer ones wrap items as
//! `{"type":"response_item","payload":{"type":"message","role":"user","content":[...]}}`
//! with typed content blocks (`input_text`, `output_text`, `function_call`).
//! The parser tolerates both shapes.

use super::{AgentSessionParser, ParseError, ParseResult};
use crate::types::{AgentSession, AgentTurn, AgentType, FileChangeKind, FileModification, ToolCall};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::path::Path;

/// Codex session parser.
#[derive(Debug, Clone, Copy, Default)]
pub struct CodexSessionParser;

impl CodexSessionParser {
    pub fn new() -> Self {
        Self
    }
}

impl AgentSessionParser for CodexSessionParser {
    fn agent_type(&self) -> AgentType {
        AgentType::Codex
    }

    fn parse_session_manifest(&self, path: &Path) -> ParseResult<AgentSession> {
        let session_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ParseError::InvalidFormat(format!("no session id in {}", path.display())))?;
        let created_at = file_modified_time(path);
        Ok(AgentSession::new(session_id, AgentType::Codex, path, created_at))
    }

    fn parse_turn(&self, raw: &str) -> ParseResult<AgentTurn> {
        let line: Value = serde_json::from_str(raw)
            .map_err(|e| ParseError::InvalidFormat(format!("codex line: {e}")))?;
        let (role, content, timestamp) = parse_line(&line);
        let mut turn = AgentTurn {
            turn_index: 0,
            timestamp: timestamp.unwrap_or_else(Utc::now),
            user_message: String::new(),
            assistant_response: None,
            tool_calls: Vec::new(),
            file_modifications: Vec::new(),
        };
        if role == "user" {
            turn.user_message = extract_text(&content);
        } else if role == "assistant" {
            let text = extract_text(&content);
            if !text.is_empty() {
                turn.assistant_response = Some(text);
            }
            extract_function_calls(&content, &mut turn);
        }
        Ok(turn)
    }

    fn detect_activity(&self, path: &Path) -> bool {
        path.extension().is_some_and(|e| e == "jsonl")
            && path.to_string_lossy().contains(".codex")
            && path.to_string_lossy().contains("sessions")
    }

    fn discover_sessions(&self, root: &Path) -> Vec<AgentSession> {
        let mut out = Vec::new();
        let Ok(dates) = std::fs::read_dir(root) else {
            return out;
        };
        for date in dates.flatten() {
            let Ok(entries) = std::fs::read_dir(date.path()) else {
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
                            AgentType::Codex,
                            &path,
                            file_modified_time(&path),
                        ));
                    }
                }
            }
        }
        out
    }

    fn read_session_turns(&self, session: &AgentSession) -> ParseResult<Vec<AgentTurn>> {
        read_codex_turns(&session.path)
    }
}

/// Extract `(role, content, timestamp)` from either the legacy or the
/// response_item shape.
fn parse_line(line: &Value) -> (String, Value, Option<DateTime<Utc>>) {
    let timestamp = line
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc));
    // Newer shape: {"type":"response_item","payload":{...}}.
    if line.get("type").and_then(Value::as_str) == Some("response_item") {
        if let Some(payload) = line.get("payload") {
            let role = payload.get("role").and_then(Value::as_str).unwrap_or("").to_string();
            let content = payload.get("content").cloned().unwrap_or(Value::Null);
            let ts = payload
                .get("timestamp")
                .and_then(Value::as_str)
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.with_timezone(&Utc))
                .or(timestamp);
            return (role, content, ts);
        }
    }
    let role = line.get("role").and_then(Value::as_str).unwrap_or("").to_string();
    let content = line.get("content").cloned().unwrap_or(Value::Null);
    (role, content, timestamp)
}

/// Concatenate text from content: a string, or an array of blocks with
/// `text` / `input_text` / `output_text` keys.
fn extract_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for block in blocks {
        let text = block
            .get("text")
            .or_else(|| block.get("input_text"))
            .or_else(|| block.get("output_text"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if text.is_empty() {
            continue;
        }
        if !out.is_empty() {
            out.push('\n');
        }
        out.push_str(text);
    }
    out
}

/// `function_call` blocks / items → tool calls + file modifications.
fn extract_function_calls(content: &Value, turn: &mut AgentTurn) {
    let Some(blocks) = content.as_array() else {
        return;
    };
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("function_call") {
            continue;
        }
        let name = block.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let raw_input = block.get("arguments").cloned().unwrap_or(Value::Null);
        let input = raw_input
            .as_str()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .unwrap_or(raw_input);
        if !name.is_empty() {
            turn.tool_calls.push(ToolCall { name: name.clone(), input: input.clone() });
        }
        record_file_change(&name, &input, turn);
    }
}

/// Map a Codex tool name + input to a file modification when the input
/// carries a `file_path`/`path`.
fn record_file_change(tool_name: &str, input: &Value, turn: &mut AgentTurn) {
    let path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        let change = if tool_name == "create_file" {
            FileChangeKind::Create
        } else {
            FileChangeKind::Modify
        };
        turn.file_modifications.push(FileModification { path, change });
    }
}

/// Read every turn from a Codex transcript.
pub fn read_codex_turns(path: &Path) -> ParseResult<Vec<AgentTurn>> {
    let content = std::fs::read_to_string(path)?;
    let mut turns: Vec<AgentTurn> = Vec::new();
    let mut current: Option<AgentTurn> = None;
    for (index, raw) in content.lines().enumerate() {
        let line: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let (role, payload, ts) = parse_line(&line);
        let timestamp = ts.unwrap_or_else(Utc::now);
        match role.as_str() {
            "user" => {
                if let Some(t) = current.take() {
                    turns.push(t);
                }
                current = Some(AgentTurn {
                    turn_index: index as u32,
                    timestamp,
                    user_message: extract_text(&payload),
                    assistant_response: None,
                    tool_calls: Vec::new(),
                    file_modifications: Vec::new(),
                });
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
                let text = extract_text(&payload);
                if !text.is_empty() {
                    let base = turn.assistant_response.take().unwrap_or_default();
                    turn.assistant_response =
                        Some(if base.is_empty() { text } else { format!("{base}\n{text}") });
                }
                extract_function_calls(&payload, turn);
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
    fn parses_legacy_shape() {
        let raw = r#"{"role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":"2026-08-06T12:00:00Z"}"#;
        let turn = CodexSessionParser::new().parse_turn(raw).unwrap();
        assert_eq!(turn.assistant_response.as_deref(), Some("done"));
    }

    #[test]
    fn parses_response_item_shape() {
        let raw = r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[
            {"type":"output_text","text":"ok"},
            {"type":"function_call","name":"edit_file","arguments":"{\"file_path\":\"a.rs\",\"content\":\"x\"}"}
        ]}}"#;
        let turn = CodexSessionParser::new().parse_turn(raw).unwrap();
        assert_eq!(turn.assistant_response.as_deref(), Some("ok"));
        assert_eq!(turn.tool_calls.len(), 1);
        assert_eq!(turn.tool_calls[0].name, "edit_file");
        assert_eq!(turn.tool_calls[0].input["file_path"], "a.rs");
        assert_eq!(turn.file_modifications[0].path, "a.rs");
    }

    #[test]
    fn groups_legacy_lines() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("cacm-codex-test-{}.jsonl", std::process::id()));
        std::fs::write(
            &path,
            concat!(
                r#"{"role":"user","content":"fix build"}"#, "\n",
                r#"{"role":"assistant","content":[{"type":"text","text":"fixed"}]}"#, "\n",
                r#"{"role":"user","content":"thanks"}"#, "\n",
            ),
        )
        .unwrap();
        let turns = read_codex_turns(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].user_message, "fix build");
        assert_eq!(turns[0].assistant_response.as_deref(), Some("fixed"));
    }
}
