//! Heuristic context extraction from [`AgentTurn`] data (task 1.6).
//!
//! The MVP is template/keyword heuristics — pure functions over
//! `&[AgentTurn]`, no LLM dependency. Each heuristic is a free, testable
//! function ([`extract_task`], [`extract_decisions`], [`extract_file_changes`],
//! [`extract_errors`], [`extract_patterns`]); [`ContextExtractor`] composes
//! them into [`CrossAgentContext`] entries, stamps session metadata, and
//! batches extraction every [`DEFAULT_BATCH_SIZE`] turns or at session end.
//!
//! # LLM upgrade path
//!
//! The eventual LLM-based extraction mirrors Jcode's sidecar model
//! (`jcode/crates/jcode-base/src/sidecar.rs`): a lightweight model client
//! that turns raw turns into structured context instead of keyword matching.
//! The swap-in point is [`ContextExtractor::extract_context`] — keep the
//! public surface stable and replace the heuristic bodies with sidecar calls
//! behind a trait. Nothing downstream (storage, batching, ids, timestamps)
//! needs to change.
//!
//! # Known heuristic limits
//!
//! - Keyword matching is a case-insensitive substring test; it does not
//!   handle synonyms, stemming, or negation ("we did NOT choose X" still
//!   matches a decision keyword), and short keywords match inside longer
//!   words (`"fix"` matches `"prefix"`/`"fixture"`).
//! - `"using"` is a deliberately noisy decision keyword (spec-listed); it
//!   over-matches phrases like "we are using the axum framework".
//! - File paths are recognized from structured `file_modifications`, from
//!   path-shaped tool inputs, and from text patterns (`Modified:` /
//!   `Created:` / `Wrote to:` prefixes and file-extension tokens). Path
//!   sanitization (strip `.`/`..`, absolute prefixes) lives in the parsers;
//!   here paths are only de-quoted and de-punctuated. Extension tokens are
//!   case-sensitive (`README.MD` is missed), and text tokens starting with a
//!   separator (`.hidden` / `/src/main.rs` in prose) are rejected by the
//!   boundary checks — the structured sources carry those paths reliably.
//!   Extensionless file names mentioned in prose (`Created: Makefile`) are
//!   likewise only picked up from the structured sources.

use crate::types::{AgentTurn, AgentType, ContextType, CrossAgentContext};
use chrono::{DateTime, Utc};
use regex::Regex;
use std::collections::HashSet;
use std::sync::OnceLock;

/// Extraction runs every this many accumulated turns, or at session end.
pub const DEFAULT_BATCH_SIZE: usize = 5;

/// Longest stored item (a decision, error, pattern, ...) in chars; longer
/// messages are truncated so one noisy turn cannot bloat the context store.
pub const MAX_ITEM_CHARS: usize = 512;

/// Task-detection keywords (spec-listed). Substring match, case-insensitive.
pub const TASK_KEYWORDS: &[&str] = &[
    "I want to",
    "build",
    "create",
    "fix",
    "implement",
    "refactor",
];

/// Decision-detection keywords (spec-listed).
pub const DECISION_KEYWORDS: &[&str] = &["decided", "chose", "going with", "will use", "using"];

/// Error-detection keywords (spec-listed).
pub const ERROR_KEYWORDS: &[&str] = &["error", "failed", "broke", "exception", "cannot"];

/// Pattern/convention-detection keywords (spec-listed).
pub const PATTERN_KEYWORDS: &[&str] =
    &["always", "never", "convention", "best practice", "pattern"];

/// Code-file extensions recognized when scanning message text for path
/// tokens. Keeping a known set avoids false positives from numbers
/// (`3.14`), URLs (`example.com`), and version strings (`v1.2.3`).
pub const FILE_EXTENSIONS: &[&str] = &[
    "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "c", "h", "cpp", "hpp", "cc", "cs",
    "java", "kt", "kts", "swift", "rb", "php", "sh", "bash", "zsh", "json", "toml", "yaml", "yml",
    "md", "txt", "css", "scss", "html", "sql", "xml", "lock", "gradle", "mk", "cmake", "proto",
];

/// Path-shaped keys probed inside tool-call JSON inputs.
const TOOL_PATH_KEYS: &[&str] = &[
    "path",
    "file_path",
    "file",
    "old_path",
    "new_path",
    "source",
    "destination",
];

// ---------------------------------------------------------------------------
// Pure heuristic functions
// ---------------------------------------------------------------------------

/// The session's task description: the first non-empty user message, in turn
/// order. Returns `None` when no turn carries a user message.
///
/// This implements the spec's headline rule ("first user message = task
/// description"). Whether the message is worth emitting as a
/// [`ContextType::Task`] entry is decided by [`looks_like_task`], which gates
/// on the spec's keyword list.
pub fn extract_task(turns: &[AgentTurn]) -> Option<String> {
    turns
        .iter()
        .map(|t| t.user_message.trim())
        .find(|m| !m.is_empty())
        .map(|m| m.to_string())
}

/// Does `text` read like a task, i.e. contain any [`TASK_KEYWORDS`]?
/// Case-insensitive substring match.
pub fn looks_like_task(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    TASK_KEYWORDS
        .iter()
        .any(|k| lower.contains(&k.to_ascii_lowercase()))
}

/// Messages (user or assistant) containing a decision keyword
/// ([`DECISION_KEYWORDS`]), in turn order, deduplicated.
pub fn extract_decisions(turns: &[AgentTurn]) -> Vec<String> {
    extract_by_keywords(turns, DECISION_KEYWORDS)
}

/// File paths touched across the turns, deduplicated in first-seen order.
///
/// Sources, most authoritative first:
/// 1. structured [`crate::types::FileModification`] records on each turn;
/// 2. path-shaped string values in tool-call JSON inputs;
/// 3. message-text patterns — `Modified:`/`Created:`/`Wrote to:`/etc.
///    prefixes and tokens ending in a known [`FILE_EXTENSIONS`] extension.
pub fn extract_file_changes(turns: &[AgentTurn]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for turn in turns {
        // 1. Structured modifications (authoritative; includes Delete/Rename).
        for fm in &turn.file_modifications {
            push_path(&mut out, &mut seen, &fm.path);
        }
        // 2. Path-shaped tool inputs ("parse tool calls for file paths").
        for tool in &turn.tool_calls {
            for path in paths_from_tool_input(&tool.input) {
                push_path(&mut out, &mut seen, &path);
            }
        }
        // 3. Text patterns: "Modified: x", "Created: x", "Wrote to: x", and
        //    file-extension tokens.
        for text in message_texts(turn) {
            for path in paths_from_text(text) {
                push_path(&mut out, &mut seen, &path);
            }
        }
    }

    out
}

/// Messages (user or assistant) containing an error keyword
/// ([`ERROR_KEYWORDS`]), in turn order, deduplicated.
pub fn extract_errors(turns: &[AgentTurn]) -> Vec<String> {
    extract_by_keywords(turns, ERROR_KEYWORDS)
}

/// Messages (user or assistant) mentioning a convention or reusable pattern
/// ([`PATTERN_KEYWORDS`]), in turn order, deduplicated.
pub fn extract_patterns(turns: &[AgentTurn]) -> Vec<String> {
    extract_by_keywords(turns, PATTERN_KEYWORDS)
}

// ---------------------------------------------------------------------------
// ContextExtractor: composition + batching
// ---------------------------------------------------------------------------

/// Composes the heuristic functions into [`CrossAgentContext`] entries for
/// one agent session, with batched extraction.
///
/// Usage (watcher/daemon side):
/// ```ignore
/// let mut ex = ContextExtractor::new("sess-abc", AgentType::Jcode);
/// // ...as turns arrive (extraction runs every 5 turns):
/// for ctx in ex.add_turn(turn) { /* store via daemon */ }
/// // ...at session end:
/// for ctx in ex.flush() { /* store via daemon */ }
/// ```
///
/// Batching follows the spec: extraction runs every [`DEFAULT_BATCH_SIZE`]
/// accumulated turns, and any remainder is extracted on [`ContextExtractor::flush`]
/// (session end). A single turn therefore still produces context when the
/// session ends.
pub struct ContextExtractor {
    session_id: String,
    agent_type: AgentType,
    buffer: Vec<AgentTurn>,
    batch_size: usize,
    next_seq: u64,
    /// Whether the session's task has been decided. Set the first time a
    /// batch contains the session's first user message, so a later batch's
    /// message can never be mislabeled as the task.
    task_decided: bool,
}

impl ContextExtractor {
    /// Start a session-scoped extractor. Default batch size is
    /// [`DEFAULT_BATCH_SIZE`].
    pub fn new(session_id: impl Into<String>, agent_type: AgentType) -> Self {
        Self {
            session_id: session_id.into(),
            agent_type,
            buffer: Vec::new(),
            batch_size: DEFAULT_BATCH_SIZE,
            next_seq: 0,
            task_decided: false,
        }
    }

    /// Override the number of turns accumulated before extraction runs.
    /// Panics on `0` (a batch must contain at least one turn).
    pub fn with_batch_size(mut self, batch_size: usize) -> Self {
        assert!(batch_size >= 1, "batch size must be >= 1");
        self.batch_size = batch_size;
        self
    }

    /// The configured batch size.
    pub fn batch_size(&self) -> usize {
        self.batch_size
    }

    /// Turns buffered but not yet extracted.
    pub fn buffered_turns(&self) -> usize {
        self.buffer.len()
    }

    /// Accumulate a turn. When the buffer reaches the batch size, extraction
    /// runs and the produced contexts are returned; otherwise empty.
    pub fn add_turn(&mut self, turn: AgentTurn) -> Vec<CrossAgentContext> {
        self.buffer.push(turn);
        if self.buffer.len() >= self.batch_size {
            self.flush()
        } else {
            Vec::new()
        }
    }

    /// Extract context from every buffered turn ("session end") and clear the
    /// buffer. Returns an empty vec when nothing was buffered or nothing was
    /// extracted.
    pub fn flush(&mut self) -> Vec<CrossAgentContext> {
        let turns = std::mem::take(&mut self.buffer);
        self.extract_context(&turns)
    }

    /// One-shot extraction over `turns` (a full batch, the remainder, or the
    /// whole session). Pure w.r.t. the heuristics; only the per-extractor id
    /// sequence and the once-per-session task gate mutate state.
    pub fn extract_context(&mut self, turns: &[AgentTurn]) -> Vec<CrossAgentContext> {
        if turns.is_empty() {
            return Vec::new();
        }
        let timestamp = turns.last().map(|t| t.timestamp).unwrap_or_else(Utc::now);
        let file_paths = extract_file_changes(turns);
        let mut out = Vec::new();

        // Task: the session's first user message, judged exactly once. If it
        // reads like a task (keyword gate) a Task entry is emitted; either
        // way the gate closes so a later batch's message is never mislabeled
        // as the task.
        if !self.task_decided {
            if let Some(task) = extract_task(turns) {
                self.task_decided = true;
                if looks_like_task(&task) {
                    out.push(self.context(
                        ContextType::Task,
                        truncate_item(&task),
                        file_paths.clone(),
                        Vec::new(),
                        Vec::new(),
                        timestamp,
                    ));
                }
            }
        }

        let decisions = extract_decisions(turns);
        if !decisions.is_empty() {
            out.push(self.context(
                ContextType::Decision,
                decisions.join("\n"),
                file_paths.clone(),
                decisions,
                Vec::new(),
                timestamp,
            ));
        }

        if !file_paths.is_empty() {
            out.push(self.context(
                ContextType::FileChange,
                file_paths.join("\n"),
                file_paths.clone(),
                Vec::new(),
                Vec::new(),
                timestamp,
            ));
        }

        let errors = extract_errors(turns);
        if !errors.is_empty() {
            out.push(self.context(
                ContextType::Error,
                errors.join("\n"),
                file_paths.clone(),
                Vec::new(),
                errors,
                timestamp,
            ));
        }

        let patterns = extract_patterns(turns);
        if !patterns.is_empty() {
            out.push(self.context(
                ContextType::Pattern,
                patterns.join("\n"),
                file_paths,
                Vec::new(),
                Vec::new(),
                timestamp,
            ));
        }

        out
    }

    fn context(
        &mut self,
        context_type: ContextType,
        content: String,
        file_paths: Vec<String>,
        decisions: Vec<String>,
        errors: Vec<String>,
        timestamp: DateTime<Utc>,
    ) -> CrossAgentContext {
        CrossAgentContext {
            id: self.next_id(),
            session_id: self.session_id.clone(),
            agent_type: self.agent_type,
            context_type,
            content,
            file_paths,
            decisions,
            errors,
            timestamp,
        }
    }

    fn next_id(&mut self) -> String {
        self.next_seq += 1;
        format!("{}-{}", self.session_id, self.next_seq)
    }
}

// ---------------------------------------------------------------------------
// Keyword scanning
// ---------------------------------------------------------------------------

/// Shared scan over every user/assistant message of the turns.
fn extract_by_keywords(turns: &[AgentTurn], keywords: &[&str]) -> Vec<String> {
    let lower_keywords: Vec<String> = keywords.iter().map(|k| k.to_ascii_lowercase()).collect();
    let mut seen = HashSet::new();
    let mut out = Vec::new();

    for turn in turns {
        for text in message_texts(turn) {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                continue;
            }
            let lower = trimmed.to_ascii_lowercase();
            if lower_keywords.iter().any(|k| lower.contains(k.as_str()))
                && seen.insert(trimmed.to_string())
            {
                out.push(truncate_item(trimmed));
            }
        }
    }

    out
}

/// Both message channels of a turn, in user-then-assistant order.
fn message_texts(turn: &AgentTurn) -> impl Iterator<Item = &str> {
    std::iter::once(turn.user_message.as_str()).chain(
        turn.assistant_response
            .iter()
            .map(|response| response.as_str()),
    )
}

/// Truncate over-long items so one message cannot bloat the context store.
fn truncate_item(text: &str) -> String {
    let text = text.trim();
    if text.chars().count() <= MAX_ITEM_CHARS {
        text.to_string()
    } else {
        let head: String = text.chars().take(MAX_ITEM_CHARS).collect();
        format!("{head}…")
    }
}

// ---------------------------------------------------------------------------
// File path extraction
// ---------------------------------------------------------------------------

/// Normalize an extracted path: strip surrounding whitespace and quoting
/// (`"` `'` backtick) and trailing sentence punctuation (`.`, `,`, `;`, `:`,
/// closing brackets, `!`, `?`).
fn normalize_path(raw: &str) -> String {
    let s = raw.trim().trim_matches(|c| matches!(c, '"' | '\'' | '`'));
    let trimmed = s.trim_end_matches(['.', ',', ';', ':', ')', ']', '}', '!', '?']);
    trimmed.to_string()
}

/// Add a normalized path to the output unless it is empty, has no alphabetic
/// character (rejects `"3.14"`-style tokens), or is a duplicate.
fn push_path(out: &mut Vec<String>, seen: &mut HashSet<String>, raw: &str) {
    let path = normalize_path(raw);
    if path.is_empty() || !path.chars().any(|c| c.is_ascii_alphabetic()) {
        return;
    }
    if seen.insert(path.clone()) {
        out.push(path);
    }
}

/// Extract paths from a tool-call input: every string value found under a
/// [`TOOL_PATH_KEYS`] key (e.g. `edit_file` → `{"path": "src/lib.rs"}`,
/// `rename` → `{"old_path": "a.rs", "new_path": "b.rs"}`). Non-object
/// inputs, non-string values, empty strings, and duplicate keys yield
/// nothing extra.
fn paths_from_tool_input(input: &serde_json::Value) -> Vec<String> {
    let Some(obj) = input.as_object() else {
        return Vec::new();
    };
    let mut seen = HashSet::new();
    let mut paths = Vec::new();
    for key in TOOL_PATH_KEYS {
        if let Some(text) = obj.get(*key).and_then(|v| v.as_str()) {
            let trimmed = text.trim();
            if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                paths.push(trimmed.to_string());
            }
        }
    }
    paths
}

/// Extract candidate paths from message text: `Modified:`/`Created:`/
/// `Wrote to:`-style prefixed paths and file-extension tokens.
fn paths_from_text(text: &str) -> Vec<String> {
    let mut paths = Vec::new();
    for caps in prefix_path_re().captures_iter(text) {
        if let Some(m) = caps.get(1) {
            // Same boundary + path-like guards the extension tokens get: a
            // bare word after the prefix ("Deleted: all the old files") is
            // not a path. Normalize first so trailing sentence punctuation
            // ("Wrote to: Cargo.toml.") cannot defeat the extension check.
            if token_boundaries_ok(text, m.start(), m.end()) {
                let path = normalize_path(m.as_str());
                if is_path_like(&path) {
                    paths.push(path);
                }
            }
        }
    }
    for m in extension_path_re().find_iter(text) {
        if token_boundaries_ok(text, m.start(), m.end()) {
            paths.push(m.as_str().to_string());
        }
    }
    paths
}

/// The regex crate has no look-around, so token boundaries are enforced in
/// code: the characters immediately before/after `[start, end)` must not be
/// path chars.
fn token_boundaries_ok(text: &str, start: usize, end: usize) -> bool {
    let prev_ok =
        start == 0 || !is_path_char(text[..start].chars().next_back().expect("byte boundary"));
    let next_ok =
        end == text.len() || !is_path_char(text[end..].chars().next().expect("byte boundary"));
    prev_ok && next_ok
}

/// A text token is path-like when it contains a path separator (`/` or `\`)
/// or ends in a known [`FILE_EXTENSIONS`] extension — this rejects bare
/// words ("Deleted: all the old files") and dot-chains that are not files
/// ("Updated: config.json.example").
fn is_path_like(token: &str) -> bool {
    if token.contains('/') || token.contains('\\') {
        return true;
    }
    FILE_EXTENSIONS.iter().any(|ext| {
        token
            .strip_suffix(ext)
            .is_some_and(|stem| stem.ends_with('.'))
    })
}

/// Path-token characters — the same set the extension regex matches on
/// (alphanumerics plus `_ . / ~ -`). Used for the boundary checks that
/// replace look-around.
fn is_path_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '~' | '-')
}

/// `Modified: src/lib.rs` — a change prefix followed by a path token. The
/// colon is optional (`Modified src/lib.rs`) but whitespace is required, the
/// path allows `/`, `\` and `:` so Windows drive paths survive, and a
/// leading quote/backtick (common in transcripts) is skipped.
fn prefix_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)\b(?:modified|created|wrote to|wrote|updated|deleted|renamed):?\s+[`'"]*([A-Za-z0-9_./\\~:-]+)"#,
        )
        .expect("static prefix path regex must compile")
    })
}

/// A token ending in a known code-file extension, e.g. `src/main.rs`.
/// The regex itself is a plain `path-chars + "." + extension` match (the
/// `regex` crate has no look-around); the token boundaries — rejecting
/// suffixes of longer tokens (`x/y.rs.foo`), version strings (`v1.2.3`), and
/// decimals (`3.14`) — are enforced by [`paths_from_text`] via
/// [`is_path_char`]. Backslash-separated paths (Windows) match on their final
/// `name.ext` segment; the structured `file_modifications` / tool-input
/// sources carry full paths.
fn extension_path_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let extensions = FILE_EXTENSIONS.join("|");
        // No backslashes in this pattern: format! literals cannot contain
        // escape syntax, and the char classes are written with explicit ASCII
        // ranges + `[.]`.
        Regex::new(&format!(r"([A-Za-z0-9_./~-]+[.](?:{extensions}))"))
            .expect("static extension path regex must compile")
    })
}
