//! Parser trait + registry.
//!
//! [`AgentSessionParser`] defines the interface every per-agent session parser
//! (Claude Code, Codex, OpenCode, Cursor, ...) implements. Concrete
//! parsers live in this crate's `parsers/` directory:
//!
//! - [`claude`], [`codex`], [`opencode`], [`cursor`] — stubs that return
//!   [`ParseError::NotImplemented`] until their Phase 2 tasks land.
//!
//! [`ParserRegistry`] holds one parser per [`AgentType`];
//! [`ParserRegistry::with_defaults`] registers the full default set.

pub mod claude;
pub mod codex;
pub mod cursor;
pub mod opencode;

use crate::types::{AgentSession, AgentTurn, AgentType};
use std::collections::HashMap;
use std::path::Path;

/// Errors produced while parsing a session.
#[derive(Debug)]
pub enum ParseError {
    /// Underlying I/O failure while reading the session file.
    Io(std::io::Error),
    /// The file exists but is not a recognized session format.
    InvalidFormat(String),
    /// The parser does not support the given agent type.
    UnsupportedAgent(AgentType),
    /// The parser is a placeholder and does not implement parsing yet.
    NotImplemented(String),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Io(err) => write!(f, "io error: {err}"),
            ParseError::InvalidFormat(detail) => write!(f, "invalid session format: {detail}"),
            ParseError::UnsupportedAgent(agent) => write!(f, "unsupported agent: {agent}"),
            ParseError::NotImplemented(detail) => write!(f, "not implemented: {detail}"),
        }
    }
}

/// Build the [`ParseError::NotImplemented`] error used by Phase-2 stub parsers.
pub(crate) fn not_implemented(agent: AgentType, method: &str) -> ParseError {
    ParseError::NotImplemented(format!(
        "{method} for agent {agent} (planned for Phase 2)"
    ))
}

impl std::error::Error for ParseError {}

impl From<std::io::Error> for ParseError {
    fn from(err: std::io::Error) -> Self {
        ParseError::Io(err)
    }
}

/// Result alias used by all parser methods.
pub type ParseResult<T> = Result<T, ParseError>;

/// Interface implemented by per-agent session parsers.
///
/// Note: `agent_type` takes `&self` (not an associated function) so it is
/// callable on a trait object (`Box<dyn AgentSessionParser>`), which the
/// registry relies on to key parsers by agent.
pub trait AgentSessionParser: Send + Sync {
    /// The agent this parser handles.
    fn agent_type(&self) -> AgentType;

    /// Parse a session manifest file (or session directory) into an
    /// [`AgentSession`].
    fn parse_session_manifest(&self, path: &Path) -> ParseResult<AgentSession>;

    /// Parse one raw turn payload (e.g. a JSONL line) into an [`AgentTurn`].
    fn parse_turn(&self, raw: &str) -> ParseResult<AgentTurn>;

    /// Cheap check: does `path` look like an active session for this agent?
    fn detect_activity(&self, path: &Path) -> bool;
}

/// Holds one registered parser per [`AgentType`].
#[derive(Default)]
pub struct ParserRegistry {
    parsers: HashMap<AgentType, Box<dyn AgentSessionParser>>,
}

impl ParserRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// A registry pre-populated with the default parser set:
    /// Phase-2 stubs for Claude Code, Codex, OpenCode, and Cursor.
    pub fn with_defaults() -> Self {
        let mut registry = Self::new();
        let _ = registry.register(Box::new(claude::ClaudeCodeSessionParser::new()));
        let _ = registry.register(Box::new(codex::CodexSessionParser::new()));
        let _ = registry.register(Box::new(opencode::OpenCodeSessionParser::new()));
        let _ = registry.register(Box::new(cursor::CursorSessionParser::new()));
        registry
    }

    /// Register a parser, keyed by its own [`AgentSessionParser::agent_type`].
    ///
    /// Returns an error if a parser for the same agent is already registered.
    pub fn register(
        &mut self,
        parser: Box<dyn AgentSessionParser>,
    ) -> Result<(), ParseError> {
        let agent_type = parser.agent_type();
        if self.parsers.contains_key(&agent_type) {
            return Err(ParseError::InvalidFormat(format!(
                "a parser for agent {agent_type} is already registered"
            )));
        }
        self.parsers.insert(agent_type, parser);
        Ok(())
    }

    /// Get the parser registered for `agent_type`, if any.
    pub fn get(&self, agent_type: AgentType) -> Option<&(dyn AgentSessionParser + '_)> {
        self.parsers.get(&agent_type).map(|p| p.as_ref())
    }

    /// Get a mutable reference to the parser registered for `agent_type`.
    pub fn get_mut<'a>(
        &'a mut self,
        agent_type: AgentType,
    ) -> Option<&'a mut (dyn AgentSessionParser + 'a)> {
        self.parsers
            .get_mut(&agent_type)
            .map(|p| p.as_mut() as &mut (dyn AgentSessionParser + 'a))
    }

    /// Number of registered parsers.
    pub fn len(&self) -> usize {
        self.parsers.len()
    }

    /// Whether no parsers are registered.
    pub fn is_empty(&self) -> bool {
        self.parsers.is_empty()
    }

    /// Agent types with a registered parser.
    pub fn agents(&self) -> impl Iterator<Item = AgentType> + '_ {
        self.parsers.keys().copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};

    #[derive(Debug)]
    struct MockParser(AgentType);

    impl AgentSessionParser for MockParser {
        fn agent_type(&self) -> AgentType {
            self.0
        }

        fn parse_session_manifest(&self, path: &Path) -> ParseResult<AgentSession> {
            Ok(AgentSession::new(
                "mock-session",
                self.0,
                path,
                Utc::now(),
            ))
        }

        fn parse_turn(&self, raw: &str) -> ParseResult<AgentTurn> {
            Err(ParseError::InvalidFormat(format!(
                "mock parser cannot parse: {raw}"
            )))
        }

        fn detect_activity(&self, _path: &Path) -> bool {
            false
        }
    }

    #[test]
    fn register_and_get() {
        let mut registry = ParserRegistry::new();
        assert!(registry.is_empty());
        registry.register(Box::new(MockParser(AgentType::ClaudeCode))).unwrap();
        assert_eq!(registry.len(), 1);
        assert!(registry.get(AgentType::ClaudeCode).is_some());
        assert!(registry.get(AgentType::Codex).is_none());
        assert_eq!(registry.agents().collect::<Vec<_>>(), vec![AgentType::ClaudeCode]);
    }

    #[test]
    fn duplicate_registration_is_rejected() {
        let mut registry = ParserRegistry::new();
        registry.register(Box::new(MockParser(AgentType::Codex))).unwrap();
        let dup = registry.register(Box::new(MockParser(AgentType::Codex)));
        assert!(dup.is_err());
        assert_eq!(registry.len(), 1);
    }

    #[test]
    fn parser_parses_manifest() {
        let parser = MockParser(AgentType::Codex);
        let session = parser
            .parse_session_manifest(Path::new("/tmp/session"))
            .unwrap();
        assert_eq!(session.agent_type, AgentType::Codex);
        assert_eq!(session.session_id, "mock-session");
    }

    #[test]
    fn registry_keys_parser_by_its_agent_type() {
        let mut registry = ParserRegistry::new();
        // The key is derived from the parser, not passed by the caller.
        registry.register(Box::new(MockParser(AgentType::OpenCode))).unwrap();
        assert!(registry.get(AgentType::OpenCode).is_some());
    }

    #[test]
    fn datetime_is_send_sync_for_channel() {
        // Compile-time smoke check: the types we ship over tokio channels
        // must be Send (used by SessionWatcher's mpsc).
        fn assert_send<T: Send>(_: &T) {}
        let now: DateTime<Utc> = Utc::now();
        assert_send(&now);
    }
}
