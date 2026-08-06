//! Cross-session context compaction (task 1.13).
//!
//! Reduces the stored [`CrossAgentContext`] population during the daemon's
//! ambient cycles (or on demand) through four pure, deterministic stages:
//!
//! - **Deduplication** — group entries by `file_path` and keep the
//!   highest-confidence representative of each group (confidence is
//!   [`crate::injector::confidence_score`], the same heuristic the injector
//!   ranks with). Entries without file paths are deduplicated only on exact
//!   content equality, so file-less prose is never collapsed by accident.
//! - **Summarization** — collapse every session's remaining entries into one
//!   *milestone* entry: a deterministic, template-built summary (task line,
//!   unioned decisions, file paths, errors) — the MVP stand-in for
//!   LLM-side summarization of message transcripts. One milestone per
//!   `(agent_type, session_id)`.
//! - **Linking** — emit cross-agent `related_to` edges
//!   ([`ContextLink`]) between entries of *different* agents whose content is
//!   semantically similar (Jaccard over lowercase word tokens), weighted and
//!   thresholded.
//! - **Staleness** — decay confidence exponentially
//!   ([`decayed_confidence`], half-life [`DEFAULT_CONFIDENCE_HALF_LIFE_DAYS`])
//!   and prune entries older than [`DEFAULT_MAX_AGE_DAYS`] or whose decayed
//!   confidence drops below [`DEFAULT_MIN_CONFIDENCE`], so long-stale noise
//!   cannot crowd the store.
//!
//! All stages are free, testable functions; [`Compactor`] composes them into
//! the task's headline pipeline `10 entries from 3 agents → 3 milestone
//! entries`. Pure with respect to the entries — only the pinned `now` clock is
//! carried by the struct, so the daemon can run it deterministically.
//!
//! # Daemon wiring (task 1.14+)
//!
//! The daemon's ambient loop (the 5s interval that already drives the memory
//! sampler in `cacm-daemon/src/main.rs`) can call
//! `Compactor::new(Utc::now()).compact(&entries)` on the backend's context
//! list, then store `report.milestones` and the `report.links` into its
//! memory graph. `cacm-core` stays dependency-free of the daemon: the
//! compactor only needs `&[CrossAgentContext]`.

use crate::injector::confidence_score;
use crate::types::{AgentType, ContextType, CrossAgentContext};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// Confidence decays by half every this many days
/// ([`decayed_confidence`]'s default half-life).
pub const DEFAULT_CONFIDENCE_HALF_LIFE_DAYS: i64 = 30;
/// Entries older than this are pruned regardless of confidence.
pub const DEFAULT_MAX_AGE_DAYS: i64 = 365;
/// Entries whose decayed confidence falls below this floor are pruned.
pub const DEFAULT_MIN_CONFIDENCE: f64 = 0.05;
/// Minimum [`ContextLink::weight`] for a cross-agent `related_to` edge.
pub const DEFAULT_LINK_THRESHOLD: f64 = 0.15;
/// Weight of the file-path term in [`pair_weight`] (shared files are the
/// strongest relatedness signal; content similarity the rest).
pub const LINK_FILE_WEIGHT: f64 = 0.6;
/// Weight of the content-token term in [`pair_weight`].
pub const LINK_CONTENT_WEIGHT: f64 = 0.4;
/// Longest synthesized milestone content in chars; longer summaries are
/// truncated at a UTF-8 char boundary (the memory graph has byte budgets).
pub const MAX_MILESTONE_CHARS: usize = 2048;

/// A cross-agent `related_to` edge between two context entries.
///
/// An undirected, weighted similarity link. `from_id < to_id` always holds
/// (lexicographic), so a pair is emitted at most once.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextLink {
    /// Id of the first endpoint (lexicographically smaller).
    pub from_id: String,
    /// Id of the second endpoint.
    pub to_id: String,
    /// Similarity in `0.0..=1.0` ([`LINK_FILE_WEIGHT`] file Jaccard +
    /// [`LINK_CONTENT_WEIGHT`] token Jaccard).
    pub weight: f64,
}

/// What one [`Compactor::compact`] run did to a context population.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CompactionReport {
    /// Entries fed in.
    pub input_count: usize,
    /// The surviving milestone entries (per session when summarization is on,
    /// otherwise the deduplicated survivors).
    pub milestones: Vec<CrossAgentContext>,
    /// Cross-agent `related_to` edges found on the post-dedup entries.
    pub links: Vec<ContextLink>,
    /// Entries removed as duplicates (kept vs. post-dedup delta).
    pub deduplicated: usize,
    /// Entries pruned as stale (too old, or decayed confidence too low).
    pub pruned: usize,
}

/// Exponential confidence decay: `confidence × 0.5^(age / half_life)`.
///
/// At `age == half_life` the entry's confidence halves; at two half-lives it
/// quarters. Future timestamps clamp to full confidence. Deterministic — the
/// caller pins `now`.
pub fn decayed_confidence(
    ctx: &CrossAgentContext,
    now: DateTime<Utc>,
    half_life: Duration,
) -> f64 {
    let age_ms = (now - ctx.timestamp).num_milliseconds().max(0) as f64;
    let half_ms = half_life.num_milliseconds().max(1) as f64;
    confidence_score(ctx) * 0.5f64.powf(age_ms / half_ms)
}

/// Drop duplicate entries: group by `file_path`, keep the highest-confidence
/// representative per group (spec rule; ties → newest, then lexicographically
/// smallest id).
///
/// - Entries sharing any file path form one group; the highest-confidence
///   member survives (cross-agent — the spec's "deduplicate similar entries
///   from different agents").
/// - Entries *without* file paths are deduplicated only on exact content
///   equality against other file-less entries, so prose is never collapsed by
///   a chance path overlap.
///
/// Output preserves the input order (only duplicates are removed), so callers
/// can rely on a stable, deterministic result.
pub fn deduplicate(entries: &[CrossAgentContext]) -> Vec<CrossAgentContext> {
    let mut ranked: Vec<&CrossAgentContext> = entries.iter().collect();
    ranked.sort_by(|a, b| {
        confidence_score(b)
            .total_cmp(&confidence_score(a))
            .then_with(|| b.timestamp.cmp(&a.timestamp))
            .then_with(|| a.id.cmp(&b.id))
    });

    let mut kept: Vec<&CrossAgentContext> = Vec::new();
    for entry in ranked {
        let duplicate = kept.iter().any(|k| {
            if entry.file_paths.is_empty() {
                // File-less entries: exact content duplicates only.
                k.file_paths.is_empty() && k.content == entry.content
            } else {
                k.file_paths.iter().any(|p| entry.file_paths.contains(p))
            }
        });
        if !duplicate {
            kept.push(entry);
        }
    }

    let kept_ids: HashSet<&str> = kept.iter().map(|e| e.id.as_str()).collect();
    entries
        .iter()
        .filter(|e| kept_ids.contains(e.id.as_str()))
        .cloned()
        .collect()
}

/// Collapse each session's entries into one deterministic *milestone* entry.
///
/// Groups by `(agent_type, session_id)` — the spec's "multi-turn session →
/// milestone". The milestone is a [`ContextType::Task`] entry whose content is
/// a template summary (task line, unioned decisions / file paths / errors),
/// whose `file_paths` / `decisions` / `errors` are the group's unions
/// (first-seen order), and whose timestamp is the group's newest. Deterministic
/// order: groups sort by agent then session id.
///
/// This is the heuristic stand-in for LLM summarization; the swap-in point is
/// the content template (`milestone_content`), exactly like the extractor's
/// documented LLM upgrade path.
pub fn summarize_to_milestones(entries: &[CrossAgentContext]) -> Vec<CrossAgentContext> {
    let mut groups: BTreeMap<(String, String), Vec<&CrossAgentContext>> = BTreeMap::new();
    for entry in entries {
        groups
            .entry((entry.agent_type.to_string(), entry.session_id.clone()))
            .or_default()
            .push(entry);
    }
    groups
        .into_iter()
        .map(|((_agent, session), group)| milestone(&group, session))
        .collect()
}

/// Weighted cross-agent `related_to` edges between entries of *different*
/// agents ([`ContextLink`]).
///
/// Each unordered pair `(a, b)` with `a.agent_type != b.agent_type` is scored
/// by [`pair_weight`]; pairs at or above [`DEFAULT_LINK_THRESHOLD`] become a
/// link, emitted once with `from_id < to_id`. Same-agent pairs are never
/// linked (that is intra-session coherence, not cross-agent context).
pub fn link_related(entries: &[CrossAgentContext]) -> Vec<ContextLink> {
    let mut links = Vec::new();
    for (i, a) in entries.iter().enumerate() {
        for b in &entries[i + 1..] {
            if a.agent_type == b.agent_type {
                continue;
            }
            let weight = pair_weight(a, b);
            if weight >= DEFAULT_LINK_THRESHOLD {
                let (from_id, to_id) = if a.id < b.id { (&a.id, &b.id) } else { (&b.id, &a.id) };
                links.push(ContextLink {
                    from_id: from_id.clone(),
                    to_id: to_id.clone(),
                    weight,
                });
            }
        }
    }
    links
}

/// Relatedness of two entries: `0.6 × file-path Jaccard + 0.4 × content-token
/// Jaccard` (weights [`LINK_FILE_WEIGHT`] / [`LINK_CONTENT_WEIGHT`]). Shared
/// file paths dominate — two entries editing the same file are strongly
/// related — while content similarity catches thematically linked entries
/// (the semantic `RelatesTo` case).
pub fn pair_weight(a: &CrossAgentContext, b: &CrossAgentContext) -> f64 {
    let file_jaccard = jaccard(&string_set(&a.file_paths), &string_set(&b.file_paths));
    let token_jaccard = jaccard(&content_tokens(&a.content), &content_tokens(&b.content));
    LINK_FILE_WEIGHT * file_jaccard + LINK_CONTENT_WEIGHT * token_jaccard
}

/// Split an entry out of the store: returns `(kept, pruned)`.
///
/// An entry is stale — and pruned — when it is older than `max_age`, or when
/// its [`decayed_confidence`] (half-life `half_life`) falls below
/// `min_confidence`. Relative order of both outputs preserves input order.
pub fn prune_stale(
    entries: &[CrossAgentContext],
    now: DateTime<Utc>,
    max_age: Duration,
    half_life: Duration,
    min_confidence: f64,
) -> (Vec<CrossAgentContext>, Vec<CrossAgentContext>) {
    let mut kept = Vec::new();
    let mut pruned = Vec::new();
    for entry in entries {
        let age = (now - entry.timestamp).num_milliseconds().max(0) as f64;
        let too_old = age > max_age.num_milliseconds().max(0) as f64;
        let too_uncertain = decayed_confidence(entry, now, half_life) < min_confidence;
        if too_old || too_uncertain {
            pruned.push(entry.clone());
        } else {
            kept.push(entry.clone());
        }
    }
    (kept, pruned)
}

/// Orchestrates the compaction pipeline over one context population.
///
/// Pipeline: prune stale → deduplicate → link (post-dedup set) → summarize
/// into milestones. Every stage can be disabled via the builder so the daemon
/// can run a partial pass (e.g. link-only on demand).
pub struct Compactor {
    now: DateTime<Utc>,
    half_life: Duration,
    max_age: Duration,
    min_confidence: f64,
    dedup_enabled: bool,
    summarize_enabled: bool,
    link_enabled: bool,
    prune_enabled: bool,
}

impl Compactor {
    /// A fully-enabled compactor pinned to `now`. Defaults: 30-day confidence
    /// half-life, 365-day hard age cap, 0.05 minimum decayed confidence.
    pub fn new(now: DateTime<Utc>) -> Self {
        Self {
            now,
            half_life: Duration::days(DEFAULT_CONFIDENCE_HALF_LIFE_DAYS),
            max_age: Duration::days(DEFAULT_MAX_AGE_DAYS),
            min_confidence: DEFAULT_MIN_CONFIDENCE,
            dedup_enabled: true,
            summarize_enabled: true,
            link_enabled: true,
            prune_enabled: true,
        }
    }

    /// Override the confidence decay half-life.
    pub fn with_half_life(mut self, half_life: Duration) -> Self {
        self.half_life = half_life;
        self
    }

    /// Override the hard staleness age cap.
    pub fn with_max_age(mut self, max_age: Duration) -> Self {
        self.max_age = max_age;
        self
    }

    /// Override the minimum decayed confidence to survive pruning.
    pub fn with_min_confidence(mut self, min_confidence: f64) -> Self {
        self.min_confidence = min_confidence;
        self
    }

    /// Toggle the deduplication stage (default on).
    pub fn with_dedup(mut self, enabled: bool) -> Self {
        self.dedup_enabled = enabled;
        self
    }

    /// Toggle the milestone summarization stage (default on).
    pub fn with_summarize(mut self, enabled: bool) -> Self {
        self.summarize_enabled = enabled;
        self
    }

    /// Toggle the cross-agent linking stage (default on).
    pub fn with_link(mut self, enabled: bool) -> Self {
        self.link_enabled = enabled;
        self
    }

    /// Toggle the staleness pruning stage (default on).
    pub fn with_prune(mut self, enabled: bool) -> Self {
        self.prune_enabled = enabled;
        self
    }

    /// Run the pipeline over `entries`. See [`CompactionReport`].
    pub fn compact(&self, entries: &[CrossAgentContext]) -> CompactionReport {
        let input_count = entries.len();
        let (survivors, pruned) = if self.prune_enabled {
            prune_stale(entries, self.now, self.max_age, self.half_life, self.min_confidence)
        } else {
            (entries.to_vec(), Vec::new())
        };
        let deduped = if self.dedup_enabled {
            deduplicate(&survivors)
        } else {
            survivors.clone()
        };
        let links = if self.link_enabled {
            link_related(&deduped)
        } else {
            Vec::new()
        };
        let milestones = if self.summarize_enabled {
            summarize_to_milestones(&deduped)
        } else {
            deduped.clone()
        };
        CompactionReport {
            input_count,
            milestones,
            links,
            deduplicated: survivors.len().saturating_sub(deduped.len()),
            pruned: pruned.len(),
        }
    }
}

// ---------------------------------------------------------------------------
// Milestone synthesis
// ---------------------------------------------------------------------------

/// Build one milestone entry from a session's surviving entries.
fn milestone(group: &[&CrossAgentContext], session: String) -> CrossAgentContext {
    let agent_type = group.first().map(|e| e.agent_type).unwrap_or(AgentType::Speg);
    let newest = group.iter().map(|e| e.timestamp).max().unwrap_or_else(Utc::now);
    let task = group
        .iter()
        .find(|e| e.context_type == ContextType::Task)
        .map(|e| e.content.clone())
        .or_else(|| group.first().map(|e| e.content.clone()))
        .unwrap_or_default();

    let (file_paths, decisions, errors) = unions(group);
    let content = truncate_chars(&milestone_content(group.len(), agent_type, &session, &task, &file_paths, &decisions, &errors), MAX_MILESTONE_CHARS);

    CrossAgentContext {
        id: format!("milestone:{agent_type}:{session}"),
        session_id: session,
        agent_type,
        context_type: ContextType::Task,
        content,
        file_paths,
        decisions,
        errors,
        timestamp: newest,
    }
}

/// The milestone's template summary. Deterministic; the LLM upgrade path
/// replaces this body with a sidecar call, keeping the entry shape stable.
fn milestone_content(
    entry_count: usize,
    agent: AgentType,
    session: &str,
    task: &str,
    file_paths: &[String],
    decisions: &[String],
    errors: &[String],
) -> String {
    let noun = if entry_count == 1 { "entry" } else { "entries" };
    let mut content = format!(
        "[Milestone] {entry_count} {noun} from {agent} session {session} summarized.\nTask: {task}"
    );
    if !decisions.is_empty() {
        content.push_str(&format!("\nDecisions: {}", decisions.join("; ")));
    }
    if !file_paths.is_empty() {
        content.push_str(&format!("\nFiles: {}", file_paths.join(", ")));
    }
    if !errors.is_empty() {
        content.push_str(&format!("\nErrors: {}", errors.join("; ")));
    }
    content
}

/// Union of a group's `file_paths` / `decisions` / `errors`, each in
/// first-seen order.
fn unions(
    group: &[&CrossAgentContext],
) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut file_paths = Vec::new();
    let mut seen_files = HashSet::new();
    let mut decisions = Vec::new();
    let mut seen_decisions = HashSet::new();
    let mut errors = Vec::new();
    let mut seen_errors = HashSet::new();
    for entry in group {
        for path in &entry.file_paths {
            if seen_files.insert(path.clone()) {
                file_paths.push(path.clone());
            }
        }
        for decision in &entry.decisions {
            if seen_decisions.insert(decision.clone()) {
                decisions.push(decision.clone());
            }
        }
        for error in &entry.errors {
            if seen_errors.insert(error.clone()) {
                errors.push(error.clone());
            }
        }
    }
    (file_paths, decisions, errors)
}

// ---------------------------------------------------------------------------
// Similarity helpers
// ---------------------------------------------------------------------------

/// Lowercase word tokens of a content string (alphanumeric runs of length ≥ 3
/// — filters articles/short connectives deterministically).
fn content_tokens(content: &str) -> HashSet<String> {
    content
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 3)
        .map(|token| token.to_string())
        .collect()
}

/// Jaccard similarity of two sets (`|A∩B| / |A∪B|`, `0.0` when both empty).
fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() && b.is_empty() {
        return 0.0;
    }
    let (small, large) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    let intersection = small.iter().filter(|item| large.contains(*item)).count();
    intersection as f64 / (a.len() + b.len() - intersection).max(1) as f64
}

/// Owned string set for Jaccard comparisons.
fn string_set(values: &[String]) -> HashSet<String> {
    values.iter().cloned().collect()
}

/// Truncate at a UTF-8 char boundary with an ellipsis (keeps the memory-graph
/// byte budgets meaningful for synthesized entries).
fn truncate_chars(text: &str, max_chars: usize) -> String {
    let text = text.trim();
    if text.chars().count() <= max_chars {
        text.to_string()
    } else {
        let head: String = text.chars().take(max_chars).collect();
        format!("{head}…")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_iso(iso: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(iso).unwrap().with_timezone(&Utc)
    }

    fn entry(
        id: &str,
        session: &str,
        agent: AgentType,
        kind: ContextType,
        content: &str,
        files: &[&str],
    ) -> CrossAgentContext {
        CrossAgentContext {
            id: id.into(),
            session_id: session.into(),
            agent_type: agent,
            context_type: kind,
            content: content.into(),
            file_paths: files.iter().map(|f| f.to_string()).collect(),
            decisions: vec![],
            errors: vec![],
            timestamp: at_iso("2026-06-25T10:00:00Z"),
        }
    }

    #[test]
    fn decayed_confidence_halves_each_half_life() {
        let ctx = entry("a", "s", AgentType::Codex, ContextType::Decision, "chose axum", &["Cargo.toml"]);
        let now = at_iso("2026-06-25T10:00:00Z");
        let base = confidence_score(&ctx); // 0.2 + 0.3 + 0.2 = 0.7
        assert_eq!(decayed_confidence(&ctx, now, Duration::days(30)), base);
        // 30 days later: half.
        assert!((decayed_confidence(&ctx, now + Duration::days(30), Duration::days(30)) - base / 2.0).abs() < 1e-9);
        // 60 days later: quarter.
        assert!((decayed_confidence(&ctx, now + Duration::days(60), Duration::days(30)) - base / 4.0).abs() < 1e-9);
        // Future timestamps clamp to full confidence.
        assert_eq!(decayed_confidence(&ctx, now - Duration::days(1), Duration::days(30)), base);
    }

    #[test]
    fn deduplicate_keeps_highest_confidence_per_file_group() {
        // Two entries touch Cargo.toml; the Decision (confidence 0.7) beats the
        // plain FileChange (0.4). A third entry touches only src/lib.rs and survives.
        let low = entry(
            "low", "s1", AgentType::Codex, ContextType::FileChange, "changed Cargo.toml", &["Cargo.toml"],
        );
        let high = entry(
            "high", "s2", AgentType::ClaudeCode, ContextType::Decision, "use the workspace resolver", &["Cargo.toml"],
        );
        let other = entry(
            "other", "s3", AgentType::Codex, ContextType::Task, "add tests", &["src/lib.rs"],
        );
        let out = deduplicate(&[low.clone(), high.clone(), other.clone()]);
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|e| e.id == "high"));
        assert!(out.iter().any(|e| e.id == "other"));
        // Input order preserved.
        assert_eq!(out[0].id, "high"); // low dropped; high was second in input
        assert_eq!(out[1].id, "other");
    }

    #[test]
    fn deduplicate_file_less_entries_only_on_exact_content() {
        let a = entry("a", "s1", AgentType::Codex, ContextType::Task, "same prose", &[]);
        let b = entry("b", "s2", AgentType::Codex, ContextType::Task, "same prose", &[]);
        let c = entry("c", "s3", AgentType::ClaudeCode, ContextType::Task, "different prose", &[]);
        let out = deduplicate(&[a.clone(), b.clone(), c.clone()]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, "a");
        assert_eq!(out[1].id, "c");
    }

    #[test]
    fn deduplicate_preserves_original_order() {
        let entries = vec![
            entry("e1", "s1", AgentType::Codex, ContextType::Task, "task a", &["src/a.rs"]),
            entry("e2", "s2", AgentType::Codex, ContextType::Task, "task b", &["src/b.rs"]),
            entry("e3", "s3", AgentType::ClaudeCode, ContextType::Task, "task c", &["src/a.rs"]),
        ];
        let out = deduplicate(&entries);
        assert_eq!(out.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), vec!["e1", "e2"]);
    }

    #[test]
    fn summarize_groups_by_agent_and_session() {
        let j1a = entry("j1a", "j1", AgentType::Codex, ContextType::Task, "build the extractor", &["src/lib.rs"]);
        let mut j1b = entry("j1b", "j1", AgentType::Codex, ContextType::Decision, "use regex", &["src/lib.rs"]);
        j1b.decisions = vec!["use regex".into()];
        let c1 = entry("c1", "c1", AgentType::ClaudeCode, ContextType::Task, "review the extractor", &["src/main.rs"]);
        let milestones = summarize_to_milestones(&[j1a.clone(), j1b.clone(), c1.clone()]);
        assert_eq!(milestones.len(), 2); // j1 and c1 (agent+session keys)

        let j_milestone = milestones.iter().find(|m| m.session_id == "j1").unwrap();
        assert_eq!(j_milestone.agent_type, AgentType::Codex);
        assert!(j_milestone.content.contains("[Milestone] 2 entries"));
        assert!(j_milestone.content.contains("Task: build the extractor"));
        assert!(j_milestone.content.contains("Decisions: use regex"));
        assert!(j_milestone.content.contains("Files: src/lib.rs"));
        // Unions: both entries touched src/lib.rs → single path.
        assert_eq!(j_milestone.file_paths, vec!["src/lib.rs".to_string()]);
        // Newest timestamp of the group wins.
        assert_eq!(j_milestone.timestamp, j1b.timestamp);
    }

    #[test]
    fn summarize_same_agent_two_sessions_makes_two_milestones() {
        let a = entry("a", "s1", AgentType::Codex, ContextType::Task, "one", &["src/a.rs"]);
        let b = entry("b", "s2", AgentType::Codex, ContextType::Task, "two", &["src/b.rs"]);
        let milestones = summarize_to_milestones(&[a, b]);
        assert_eq!(milestones.len(), 2);
    }

    #[test]
    fn link_related_only_cross_agent_and_thresholded() {
        let j = entry("j1", "j1", AgentType::Codex, ContextType::Decision, "use the workspace resolver config", &["Cargo.toml"]);
        let c = entry("c1", "c1", AgentType::ClaudeCode, ContextType::Task, "set the workspace resolver to version two config", &["src/main.rs"]);
        // Same agent as j → never linked (and content unrelated to the rest).
        let j2 = entry("j2", "j2", AgentType::Codex, ContextType::Task, "add tests for the batch pipeline", &["src/lib.rs"]);
        // Unrelated content, no shared file → below threshold.
        let unrelated = entry("x1", "x1", AgentType::Codex, ContextType::Task, "refactor the ui panel styling", &["src/ui.rs"]);

        let links = link_related(&[j.clone(), c.clone(), j2.clone(), unrelated.clone()]);
        assert_eq!(links.len(), 1);
        let link = &links[0];
        assert_eq!(link.from_id, "c1");
        assert_eq!(link.to_id, "j1");
        assert!(link.weight >= DEFAULT_LINK_THRESHOLD);
        // from_id < to_id lexicographically.
        assert!(link.from_id < link.to_id);
    }

    #[test]
    fn prune_stale_removes_old_and_low_confidence() {
        let now = at_iso("2026-06-25T10:00:00Z");
        let fresh = entry("fresh", "s1", AgentType::Codex, ContextType::Task, "recent work", &["src/lib.rs"]);
        let mut old = entry("old", "s2", AgentType::Codex, ContextType::Task, "ancient work", &["src/old.rs"]);
        old.timestamp = now - Duration::days(400); // past DEFAULT_MAX_AGE_DAYS
        let (kept, pruned) = prune_stale(
            &[fresh.clone(), old.clone()],
            now,
            Duration::days(DEFAULT_MAX_AGE_DAYS),
            Duration::days(DEFAULT_CONFIDENCE_HALF_LIFE_DAYS),
            DEFAULT_MIN_CONFIDENCE,
        );
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, "fresh");
        assert_eq!(pruned.len(), 1);
        assert_eq!(pruned[0].id, "old");
    }

    #[test]
    fn prune_stale_keeps_fresh_low_confidence_below_floor_with_short_half_life() {
        // A plain Task (base confidence 0.2) decays below a 0.05 floor after
        // two 30-day half-lives; with a 5-day half-life it is already stale.
        let now = at_iso("2026-06-25T10:00:00Z");
        let mut entry = entry("e", "s1", AgentType::Codex, ContextType::Task, "plain task", &[]);
        entry.timestamp = now - Duration::days(20);
        let (_kept, pruned) = prune_stale(
            &[entry.clone()],
            now,
            Duration::days(365),
            Duration::days(5),
            0.05,
        );
        assert!(pruned.iter().any(|e| e.id == "e"));
        let (kept2, _) = prune_stale(
            &[entry.clone()],
            now,
            Duration::days(365),
            Duration::days(30),
            0.05,
        );
        assert_eq!(kept2.len(), 1);
    }

    #[test]
    fn compact_pipeline_dedups_links_and_summarizes() {
        let now = at_iso("2026-06-25T10:00:00Z");
        let compactor = Compactor::new(now);
        let entries = vec![
            // codex session j1: 2× src/lib.rs (dup pair), 2× src/main.rs (dup pair)
            entry("j1a", "j1", AgentType::Codex, ContextType::Task, "add tests to the lib module", &["src/lib.rs"]),
            entry("j1b", "j1", AgentType::Codex, ContextType::Decision, "use the workspace resolver config", &["src/lib.rs"]),
            entry("j1c", "j1", AgentType::Codex, ContextType::Task, "wire the main entry point", &["src/main.rs"]),
            entry("j1d", "j1", AgentType::Codex, ContextType::FileChange, "changed the main entry point", &["src/main.rs"]),
            // claude session c1: 2× src/lib.rs (both cross-agent dups of j1a/j1b), 1× src/parser.rs
            entry("c1a", "c1", AgentType::ClaudeCode, ContextType::Task, "review the lib module changes", &["src/lib.rs"]),
            entry("c1b", "c1", AgentType::ClaudeCode, ContextType::Task, "review the lib module changes", &["src/lib.rs"]),
            entry("c1c", "c1", AgentType::ClaudeCode, ContextType::Task, "fix the parser error handling", &["src/parser.rs"]),
            // codex session x1: 1× src/main.rs (cross-agent dup), 2× Cargo.toml (dup pair)
            entry("x1a", "x1", AgentType::OpenCode, ContextType::Task, "set the workspace resolver to version two config", &["src/main.rs"]),
            entry("x1b", "x1", AgentType::OpenCode, ContextType::Decision, "pin the workspace resolver version", &["Cargo.toml"]),
            entry("x1c", "x1", AgentType::OpenCode, ContextType::Decision, "pin the workspace resolver version", &["Cargo.toml"]),
        ];

        let report = compactor.compact(&entries);

        assert_eq!(report.input_count, 10);
        // 10 entries, 3 sessions → 3 milestone entries.
        assert_eq!(report.milestones.len(), 3);
        let mut agents: Vec<String> = report.milestones.iter().map(|m| m.agent_type.to_string()).collect();
        agents.sort();
        assert_eq!(agents, vec!["claude-code", "codex", "opencode"]);
        assert!(report.milestones.iter().all(|m| m.content.contains("[Milestone]")));
        assert!(report.deduplicated >= 5);
        assert_eq!(report.pruned, 0);
        assert!(!report.links.is_empty());
        for link in &report.links {
            assert!(link.from_id < link.to_id);
        }
    }
}
