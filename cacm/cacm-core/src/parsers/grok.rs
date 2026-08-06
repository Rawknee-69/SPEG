//! Grok CLI session parser.
//!
//! Grok CLI stores each session as a directory under
//! `~/.grok/sessions/<url-encoded-cwd>/<session-id>/` containing a
//! `chat_history.jsonl` transcript. Lines are typed messages
//! (`{"type":"system",...}`, `{"type":"user","content":[...]}`,
//! `{"type":"assistant","content":[...]}`); `content` may be a string or an
//! array of `{type:"text", text}` blocks.

use super::{AgentSessionParser, ParseError, ParseResult};
use crate::types::{AgentSession, AgentTurn, AgentType, FileChangeKind, FileModification, ToolCall};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::path::Path;

/// Transcript file name inside a grok session directory.
pub const GROK_CHAT_HISTORY_FILE: &str = "chat_history.jsonl";

/// Grok CLI session parser.
#[derive(Debug, Clone, Copy, Default)]
pub struct GrokSessionParser;

impl GrokSessionParser {
    pub fn new() -> Self {
        Self
    }
}

impl AgentSessionParser for GrokSessionParser {
    fn agent_type(&self) -> AgentType {
        AgentType::Grok
    }

    fn parse_session_manifest(&self, path: &Path) -> ParseResult<AgentSession> {
        // `path` is the session directory (see `discover_sessions`).
        let session_id = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ParseError::InvalidFormat(format!("no session id in {}", path.display())))?;
        let created_at = file_modified_time(path);
        Ok(AgentSession::new(session_id, AgentType::Grok, path, created_at))
    }

    fn parse_turn(&self, raw: &str) -> ParseResult<AgentTurn> {
        let line: Value = serde_json::from_str(raw)
            .map_err(|e| ParseError::InvalidFormat(format!("grok line: {e}")))?;
        let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
        let ts = line
            .get("ts")
            .and_then(Value::as_str)
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);
        let mut turn = AgentTurn {
            turn_index: 0,
            timestamp: ts,
            user_message: String::new(),
            assistant_response: None,
            tool_calls: Vec::new(),
            file_modifications: Vec::new(),
        };
        match kind {
            "user" => turn.user_message = extract_text(&line),
            "assistant" => {
                let text = extract_text(&line);
                if !text.is_empty() {
                    turn.assistant_response = Some(text);
                }
                extract_tool_uses(&line, &mut turn);
            }
            _ => {}
        }
        Ok(turn)
    }

    fn detect_activity(&self, path: &Path) -> bool {
        path.file_name().is_some_and(|n| n == GROK_CHAT_HISTORY_FILE)
    }

    fn discover_sessions(&self, root: &Path) -> Vec<AgentSession> {
        let mut out = Vec::new();
        let Ok(cwds) = std::fs::read_dir(root) else {
            return out;
        };
        for cwd in cwds.flatten() {
            if !cwd.path().is_dir() {
                continue;
            }
            let Ok(sessions) = std::fs::read_dir(cwd.path()) else {
                continue;
            };
            for session in sessions.flatten() {
                let path = session.path();
                if path.is_dir() && path.join(GROK_CHAT_HISTORY_FILE).is_file() {
                    let session_id = path
                        .file_name()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default();
                    if !session_id.is_empty() {
                        out.push(AgentSession::new(
                            session_id,
                            AgentType::Grok,
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
        let path = if session.path.is_dir() {
            session.path.join(GROK_CHAT_HISTORY_FILE)
        } else {
            session.path.clone()
        };
        read_grok_turns(&path)
    }
}

/// Concatenate `content` (string or `{type:"text", text}` blocks).
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

/// Assistant lines may embed tool invocations (e.g. XML-style blocks or a
/// `tool_calls` array). Best-effort: record `tool_calls` arrays.
fn extract_tool_uses(line: &Value, turn: &mut AgentTurn) {
    let Some(calls) = line.get("tool_calls").and_then(Value::as_array) else {
        return;
    };
    for call in calls {
        let name = call.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let input = call.get("arguments").cloned().unwrap_or(Value::Null);
        if !name.is_empty() {
            turn.tool_calls.push(ToolCall { name: name.clone(), input: input.clone() });
        }
        let path = input
            .get("file_path")
            .or_else(|| input.get("path"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(path) = path.filter(|p| !p.is_empty()) {
            turn.file_modifications.push(FileModification {
                path,
                change: FileChangeKind::Modify,
            });
        }
    }
}

/// Read every turn from a grok `chat_history.jsonl`.
pub fn read_grok_turns(path: &Path) -> ParseResult<Vec<AgentTurn>> {
    let content = std::fs::read_to_string(path)?;
    let mut turns: Vec<AgentTurn> = Vec::new();
    let mut current: Option<AgentTurn> = None;
    for (index, raw) in content.lines().enumerate() {
        let line: Value = match serde_json::from_str(raw) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let kind = line.get("type").and_then(Value::as_str).unwrap_or("");
        let ts = line
            .get("ts")
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
                    timestamp: ts,
                    user_message: extract_text(&line),
                    assistant_response: None,
                    tool_calls: Vec::new(),
                    file_modifications: Vec::new(),
                });
            }
            "assistant" => {
                let turn = current.get_or_insert_with(|| AgentTurn {
                    turn_index: index as u32,
                    timestamp: ts,
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
                extract_tool_uses(&line, turn);
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
        let parser = GrokSessionParser::new();
        let user = parser
            .parse_turn(r#"{"type":"user","content":[{"type":"text","text":"hello"}]}"#)
            .unwrap();
        assert_eq!(user.user_message, "hello");
        let assistant = parser
            .parse_turn(r#"{"type":"assistant","content":"plain reply"}"#)
            .unwrap();
        assert_eq!(assistant.assistant_response.as_deref(), Some("plain reply"));
    }

    #[test]
    fn discover_sessions_finds_chat_history_dirs() {
        let root = std::env::temp_dir().join(format!("cacm-grok-{}", std::process::id()));
        let session_dir = root.join("C%3A%5Crepo").join("019f-session-1");
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join(GROK_CHAT_HISTORY_FILE), r#"{"type":"user","content":"x"}"#).unwrap();
        let sessions = GrokSessionParser::new().discover_sessions(&root);
        let _ = std::fs::remove_dir_all(&root);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, "019f-session-1");
        assert_eq!(sessions[0].agent_type, AgentType::Grok);
    }

    #[test]
    fn detect_activity_matches_chat_history() {
        let parser = GrokSessionParser::new();
        assert!(parser.detect_activity(Path::new(
            "/home/u/.grok/sessions/C%3Arepo/s1/chat_history.jsonl"
        )));
        assert!(!parser.detect_activity(Path::new("/tmp/x.jsonl")));
    }
}
