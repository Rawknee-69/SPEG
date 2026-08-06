//! Cursor agent-transcript parser.
//!
//! Cursor stores agent transcripts as JSONL files under
//! `~/.cursor/projects/<project>/agent-transcripts/<session-id>/<session-id>.jsonl`.
//! Lines are typed events: `user`, `assistant`, `tool`, `turn_started`,
//! `turn_ended`, etc. The parser keeps the tolerant, line-oriented shape of
//! the other JSONL parsers: `user`/`assistant` lines become turns, and
//! `tool` lines attach to the current turn.

use super::{AgentSessionParser, ParseError, ParseResult};
use crate::types::{AgentSession, AgentTurn, AgentType, FileChangeKind, FileModification, ToolCall};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::path::Path;

/// Cursor agent-transcript parser.
#[derive(Debug, Clone, Copy, Default)]
pub struct CursorSessionParser;

impl CursorSessionParser {
    pub fn new() -> Self {
        Self
    }
}

impl AgentSessionParser for CursorSessionParser {
    fn agent_type(&self) -> AgentType {
        AgentType::Cursor
    }

    fn parse_session_manifest(&self, path: &Path) -> ParseResult<AgentSession> {
        let session_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ParseError::InvalidFormat(format!("no session id in {}", path.display())))?;
        let created_at = file_modified_time(path);
        Ok(AgentSession::new(session_id, AgentType::Cursor, path, created_at))
    }

    fn parse_turn(&self, raw: &str) -> ParseResult<AgentTurn> {
        let line: Value = serde_json::from_str(raw)
            .map_err(|e| ParseError::InvalidFormat(format!("cursor line: {e}")))?;
        let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
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
        match kind {
            "user" => {
                turn.user_message = extract_text(&line);
            }
            "assistant" => {
                let text = extract_text(&line);
                if !text.is_empty() {
                    turn.assistant_response = Some(text);
                }
            }
            "tool" => {
                let name = line
                    .get("tool")
                    .or_else(|| line.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let input = line
                    .get("input")
                    .or_else(|| line.get("args"))
                    .cloned()
                    .unwrap_or(Value::Null);
                if !name.is_empty() {
                    turn.tool_calls.push(ToolCall { name: name.clone(), input: input.clone() });
                }
                record_file_change(&name, &input, &mut turn);
            }
            _ => {}
        }
        Ok(turn)
    }

    fn detect_activity(&self, path: &Path) -> bool {
        path.extension().is_some_and(|e| e == "jsonl")
            && path.to_string_lossy().contains(".cursor")
    }

    fn discover_sessions(&self, root: &Path) -> Vec<AgentSession> {
        let mut out = Vec::new();
        let Ok(projects) = std::fs::read_dir(root) else {
            return out;
        };
        for project in projects.flatten() {
            let transcripts = project.path().join("agent-transcripts");
            let Ok(sessions) = std::fs::read_dir(&transcripts) else {
                continue;
            };
            for session in sessions.flatten() {
                let path = session.path();
                if path.is_dir() {
                    let session_id = path
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if !session_id.is_empty() {
                        out.push(AgentSession::new(
                            session_id,
                            AgentType::Cursor,
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
        // The session "dir" contains <session-id>.jsonl transcripts; read the
        // file named after the session id (or the first .jsonl in the dir).
        let mut path = session.path.clone();
        if path.is_dir() {
            let candidate = path.join(format!("{}.jsonl", session.session_id));
            if candidate.is_file() {
                path = candidate;
            } else {
                let Ok(entries) = std::fs::read_dir(&path) else {
                    return Err(ParseError::InvalidFormat(format!(
                        "no transcript file for cursor session {}",
                        session.session_id
                    )));
                };
                let first = entries.flatten().find(|e| {
                    e.path().extension().is_some_and(|x| x == "jsonl")
                });
                let Some(first) = first else {
                    return Err(ParseError::InvalidFormat(format!(
                        "no transcript file for cursor session {}",
                        session.session_id
                    )));
                };
                path = first.path();
            }
        }
        read_cursor_turns(&path)
    }
}

/// Concatenate text from a cursor line: `content` (string or array of
/// `{type:"text", text}` blocks).
fn extract_text(line: &Value) -> String {
    let content = line.get("content").cloned().unwrap_or(Value::Null);
    if let Some(text) = content.as_str() {
        return text.to_string();
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for block in blocks {
        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
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

/// Map a cursor tool line to a file modification when the input carries a
/// `file_path`/`path`.
fn record_file_change(tool_name: &str, input: &Value, turn: &mut AgentTurn) {
    let path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .map(str::to_string);
    if let Some(path) = path.filter(|p| !p.is_empty()) {
        let change = match tool_name {
            "create_file" | "write_file" => FileChangeKind::Create,
            "delete_file" => FileChangeKind::Delete,
            "rename_file" => FileChangeKind::Rename,
            _ => FileChangeKind::Modify,
        };
        turn.file_modifications.push(FileModification { path, change });
    }
}

/// Read every turn from a cursor agent transcript.
pub fn read_cursor_turns(path: &Path) -> ParseResult<Vec<AgentTurn>> {
    let content = std::fs::read_to_string(path)?;
    let mut turns: Vec<AgentTurn> = Vec::new();
    let mut current: Option<AgentTurn> = None;
    for (index, raw) in content.lines().enumerate() {
        let line: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
        let timestamp = line
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);
        match kind {
            "user" => {
                if let Some(t) = current.take() {
                    turns.push(t);
                }
                current = Some(AgentTurn {
                    turn_index: index as u32,
                    timestamp,
                    user_message: extract_text(&line),
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
                let text = extract_text(&line);
                if !text.is_empty() {
                    let base = turn.assistant_response.take().unwrap_or_default();
                    turn.assistant_response =
                        Some(if base.is_empty() { text } else { format!("{base}\n{text}") });
                }
            }
            "tool" => {
                let turn = current.get_or_insert_with(|| AgentTurn {
                    turn_index: index as u32,
                    timestamp,
                    user_message: String::new(),
                    assistant_response: None,
                    tool_calls: Vec::new(),
                    file_modifications: Vec::new(),
                });
                let name = line
                    .get("tool")
                    .or_else(|| line.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let input = line
                    .get("input")
                    .or_else(|| line.get("args"))
                    .cloned()
                    .unwrap_or(Value::Null);
                if !name.is_empty() {
                    turn.tool_calls.push(ToolCall { name: name.clone(), input: input.clone() });
                }
                record_file_change(&name, &input, turn);
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
    fn parses_user_assistant_lines() {
        let parser = CursorSessionParser::new();
        let user = parser
            .parse_turn(r#"{"type":"user","content":[{"type":"text","text":"hello"}]}"#)
            .unwrap();
        assert_eq!(user.user_message, "hello");
        let assistant = parser
            .parse_turn(r#"{"type":"assistant","content":[{"type":"text","text":"hi"}]}"#)
            .unwrap();
        assert_eq!(assistant.assistant_response.as_deref(), Some("hi"));
    }

    #[test]
    fn parses_tool_line_with_file() {
        let raw = r#"{"type":"tool","tool":"write_file","input":{"file_path":"a.ts","content":"x"}}"#;
        let turn = CursorSessionParser::new().parse_turn(raw).unwrap();
        assert_eq!(turn.tool_calls[0].name, "write_file");
        assert_eq!(turn.file_modifications[0].path, "a.ts");
        assert_eq!(turn.file_modifications[0].change, FileChangeKind::Create);
    }

    #[test]
    fn discover_sessions_finds_agent_transcripts() {
        let dir = std::env::temp_dir().join(format!("cacm-cursor-{}", std::process::id()));
        let session_dir = dir.join("proj").join("agent-transcripts").join("ses-9");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("ses-9.jsonl"), r#"{"type":"user","content":"x"}"#).unwrap();
        let sessions = CursorSessionParser::new().discover_sessions(&dir);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "ses-9");
        assert_eq!(sessions[0].agent_type, AgentType::Cursor);
    }
}
