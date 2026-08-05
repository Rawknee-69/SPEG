//! cacm-core — core types, watcher infrastructure, and parser trait for the
//! Cross-Agent Context Manager (CACM).
//!
//! CACM is a standalone package under `t3code/cacm/` (its own Cargo workspace,
//! separate from `jcode/crates/`). This crate defines the shared vocabulary
//! (`types`), the filesystem watcher that feeds the daemon (`watcher`), the
//! parser interface + registry that per-agent parsers plug into (`parsers`),
//! and the cross-session compactor that deduplicates, summarizes, and links
//! stored context (`compactor`).

pub mod compactor;
pub mod extractor;
pub mod injector;
pub mod parsers;
pub mod types;
pub mod watcher;

pub use compactor::{CompactionReport, Compactor, ContextLink};
pub use extractor::ContextExtractor;
pub use injector::{ContextInjector, RankedContext};
pub use parsers::{AgentSessionParser, ParseError, ParseResult, ParserRegistry};
pub use types::{
    AgentSession, AgentTurn, AgentType, ContextType, CrossAgentContext, FileChangeKind,
    FileModification, SessionStatus, ToolCall,
};
pub use watcher::{SessionActivity, SessionEventType, SessionWatcher, WatcherError};
