//! Core CACM data types.
//!
//! These types are the wire/protocol shape shared by the `cacm-daemon`,
//! `cacm-sdk-rs`, and the TS SDK (`cacm-sdk-ts` mirrors them exactly). All
//! types are `Serialize`/`Deserialize` so sessions and cross-agent context can
//! move between the daemon and its clients as JSON.
//!
//! Naming follows the SPEG contracts (task 1.2): agent types and context types
//! serialize as kebab-case strings (`claude-code`, `file-change`), statuses as
//! lowercase strings.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;

/// The coding agents CACM watches and shares context between.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AgentType {
    /// Jcode's own sessions (watch `~/.jcode/sessions/`).
    #[serde(rename = "jcode")]
    Jcode,
    /// Claude Code sessions (watch `~/.claude/projects/`).
    #[serde(rename = "claude-code")]
    ClaudeCode,
    /// Codex sessions (watch `~/.codex/sessions/`).
    #[serde(rename = "codex")]
    Codex,
    /// OpenCode sessions (watch the platform opencode data dir).
    #[serde(rename = "opencode")]
    OpenCode,
    /// Cursor agent transcripts (watch `~/.cursor/projects/`).
    #[serde(rename = "cursor")]
    Cursor,
    /// SPEG's own agent (watch `~/.speg/sessions/`).
    #[serde(rename = "speg")]
    Speg,
}

impl AgentType {
    /// All known agent types, in a stable order (used for defaults/iteration).
    pub const ALL: [AgentType; 6] = [
        AgentType::Jcode,
        AgentType::ClaudeCode,
        AgentType::Codex,
        AgentType::OpenCode,
        AgentType::Cursor,
        AgentType::Speg,
    ];

    /// Directory name used inside `~/.jcode/sessions/<agent>/...`.
    pub fn dir_name(self) -> &'static str {
        match self {
            AgentType::Jcode => "jcode",
            AgentType::ClaudeCode => "claude-code",
            AgentType::Codex => "codex",
            AgentType::OpenCode => "opencode",
            AgentType::Cursor => "cursor",
            AgentType::Speg => "speg",
        }
    }
}

impl fmt::Display for AgentType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Matches the kebab-case serde representation.
        let s = match self {
            AgentType::Jcode => "jcode",
            AgentType::ClaudeCode => "claude-code",
            AgentType::Codex => "codex",
            AgentType::OpenCode => "opencode",
            AgentType::Cursor => "cursor",
            AgentType::Speg => "speg",
        };
        f.write_str(s)
    }
}

impl FromStr for AgentType {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.trim().to_ascii_lowercase().as_str() {
            "jcode" => Ok(AgentType::Jcode),
            "claude-code" | "claude" => Ok(AgentType::ClaudeCode),
            "codex" => Ok(AgentType::Codex),
            "opencode" | "open-code" => Ok(AgentType::OpenCode),
            "cursor" => Ok(AgentType::Cursor),
            "speg" => Ok(AgentType::Speg),
            other => Err(format!("unknown agent type: {other}")),
        }
    }
}

/// Lifecycle status of a watched agent session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    /// Session is currently being written to / active.
    #[default]
    Active,
    /// Session exists but no activity for a while.
    Idle,
    /// Session ended normally.
    Completed,
    /// Session ended abnormally.
    Failed,
}

/// A single agent session, as discovered by a parser or the watcher.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSession {
    pub session_id: String,
    pub agent_type: AgentType,
    /// Filesystem path of the session (manifest, JSONL transcript, or dir).
    pub path: std::path::PathBuf,
    pub created_at: DateTime<Utc>,
    pub status: SessionStatus,
}

impl AgentSession {
    pub fn new(
        session_id: impl Into<String>,
        agent_type: AgentType,
        path: impl Into<std::path::PathBuf>,
        created_at: DateTime<Utc>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            agent_type,
            path: path.into(),
            created_at,
            status: SessionStatus::Active,
        }
    }
}

/// One user→assistant cycle within a session.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentTurn {
    /// 0-based position of this turn within its session.
    pub turn_index: u32,
    pub timestamp: DateTime<Utc>,
    pub user_message: String,
    pub assistant_response: Option<String>,
    pub tool_calls: Vec<ToolCall>,
    pub file_modifications: Vec<FileModification>,
}

/// A tool invocation recorded in a turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub name: String,
    /// Tool input as raw JSON (kept untyped; parsers may specialize).
    pub input: serde_json::Value,
}

/// A file change recorded in a turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileModification {
    pub path: String,
    pub change: FileChangeKind,
}

/// Kind of a file modification.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileChangeKind {
    Create,
    Modify,
    Delete,
    Rename,
}

/// A unit of cross-agent context: a task, decision, file change, error, or
/// reusable pattern extracted from one agent session for reuse by others.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrossAgentContext {
    pub id: String,
    pub session_id: String,
    pub agent_type: AgentType,
    pub context_type: ContextType,
    pub content: String,
    /// File paths this context touches (relative to the session project).
    pub file_paths: Vec<String>,
    /// Decisions recorded while this context was produced.
    pub decisions: Vec<String>,
    /// Errors encountered while this context was produced.
    pub errors: Vec<String>,
    pub timestamp: DateTime<Utc>,
}

/// What kind of context a [`CrossAgentContext`] carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ContextType {
    Task,
    Decision,
    FileChange,
    Error,
    Pattern,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_type_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&AgentType::ClaudeCode).unwrap(),
            "\"claude-code\""
        );
        assert_eq!(
            serde_json::to_string(&AgentType::OpenCode).unwrap(),
            "\"opencode\""
        );
        assert_eq!(serde_json::to_string(&AgentType::Jcode).unwrap(), "\"jcode\"");
    }

    #[test]
    fn agent_type_roundtrip() {
        for agent in AgentType::ALL {
            let json = serde_json::to_string(&agent).unwrap();
            let back: AgentType = serde_json::from_str(&json).unwrap();
            assert_eq!(back, agent);
        }
    }

    #[test]
    fn agent_type_from_str_accepts_aliases() {
        assert_eq!("claude".parse::<AgentType>().unwrap(), AgentType::ClaudeCode);
        assert_eq!(
            "open-code".parse::<AgentType>().unwrap(),
            AgentType::OpenCode
        );
        assert!("nope".parse::<AgentType>().is_err());
    }

    #[test]
    fn session_status_serializes_lowercase() {
        assert_eq!(
            serde_json::to_string(&SessionStatus::Completed).unwrap(),
            "\"completed\""
        );
    }

    #[test]
    fn context_type_serializes_kebab_case() {
        assert_eq!(
            serde_json::to_string(&ContextType::FileChange).unwrap(),
            "\"file-change\""
        );
    }

    #[test]
    fn agent_session_roundtrip() {
        let session = AgentSession::new(
            "sess-123",
            AgentType::ClaudeCode,
            "/home/u/.claude/projects/demo/sess-123.jsonl",
            chrono::Utc::now(),
        );
        let json = serde_json::to_string(&session).unwrap();
        let back: AgentSession = serde_json::from_str(&json).unwrap();
        assert_eq!(back, session);
        assert_eq!(back.path, std::path::PathBuf::from("/home/u/.claude/projects/demo/sess-123.jsonl"));
    }

    #[test]
    fn agent_turn_roundtrip_with_tools_and_files() {
        let turn = AgentTurn {
            turn_index: 0,
            timestamp: chrono::Utc::now(),
            user_message: "add tests".into(),
            assistant_response: Some("done".into()),
            tool_calls: vec![ToolCall {
                name: "edit_file".into(),
                input: serde_json::json!({"path": "src/lib.rs"}),
            }],
            file_modifications: vec![FileModification {
                path: "src/lib.rs".into(),
                change: FileChangeKind::Modify,
            }],
        };
        let json = serde_json::to_string(&turn).unwrap();
        let back: AgentTurn = serde_json::from_str(&json).unwrap();
        assert_eq!(back, turn);
        assert_eq!(back.tool_calls[0].input["path"], "src/lib.rs");
    }

    #[test]
    fn cross_agent_context_roundtrip() {
        let ctx = CrossAgentContext {
            id: "ctx-1".into(),
            session_id: "sess-123".into(),
            agent_type: AgentType::Codex,
            context_type: ContextType::Decision,
            content: "use the workspace resolver".into(),
            file_paths: vec!["Cargo.toml".into()],
            decisions: vec!["resolver = 2".into()],
            errors: vec![],
            timestamp: chrono::Utc::now(),
        };
        let json = serde_json::to_string(&ctx).unwrap();
        let back: CrossAgentContext = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ctx);
    }
}
