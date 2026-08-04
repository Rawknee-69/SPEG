//! Codex session parser (placeholder — Phase 2).
//!
//! Watches `~/.codex/sessions/`. The real parser lands in a later task; for
//! now every parsing method returns [`ParseError::NotImplemented`].

use crate::parsers::{not_implemented, AgentSessionParser, ParseResult};
use crate::types::{AgentSession, AgentTurn, AgentType};
use std::path::Path;

/// Stub parser for Codex sessions.
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

    fn parse_session_manifest(&self, _path: &Path) -> ParseResult<AgentSession> {
        Err(not_implemented(self.agent_type(), "parse_session_manifest"))
    }

    fn parse_turn(&self, _raw: &str) -> ParseResult<AgentTurn> {
        Err(not_implemented(self.agent_type(), "parse_turn"))
    }

    fn detect_activity(&self, _path: &Path) -> bool {
        false
    }
}
