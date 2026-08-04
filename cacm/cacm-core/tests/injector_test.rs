//! Integration tests for the context injector (task 1.7).
//!
//! Exercises `cacm_core::injector` — the exponential-decay recency ranking
//! with the spec weights (`recency×0.5 + relevance×0.3 + confidence×0.2`),
//! per-agent formatting (Jcode/Speg, Claude Code, Codex, OpenCode, Cursor),
//! the 2000-char budget with lowest-ranked truncation, and the empty-context
//! edge case — against an in-memory fake context source with a pinned clock.

use cacm_core::injector::{
    confidence_score, final_score, recency_score, relevance_score, time_ago, ContextInjector,
    ContextSource,
};
use cacm_core::types::{AgentType, ContextType, CrossAgentContext};
use chrono::{DateTime, Utc};

/// Deterministic "now" shared by the fake source and the injector.
const BASE: &str = "2026-06-25T10:00:00Z";

fn base_time() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(BASE)
        .unwrap()
        .with_timezone(&Utc)
}

fn at(seconds_offset: i64) -> DateTime<Utc> {
    base_time() + chrono::Duration::seconds(seconds_offset)
}

/// In-memory context source; `query_context` filters like the daemon's
/// `MemoryGraph` (project match on session_id/file_paths, `*` = everything),
/// newest first, capped at `limit`.
struct FakeSource {
    entries: Vec<CrossAgentContext>,
}

impl ContextSource for FakeSource {
    fn query_context(&self, project: &str, limit: usize) -> Vec<CrossAgentContext> {
        let mut matching: Vec<CrossAgentContext> = self
            .entries
            .iter()
            .filter(|c| {
                project.is_empty()
                    || project == "*"
                    || c.session_id == project
                    || c.file_paths.iter().any(|p| p == project)
            })
            .cloned()
            .collect();
        matching.sort_by_key(|c| std::cmp::Reverse(c.timestamp));
        matching.truncate(limit);
        matching
    }
}

fn entry(
    id: &str,
    session: &str,
    agent: AgentType,
    kind: ContextType,
    content: &str,
    seconds_offset: i64,
) -> CrossAgentContext {
    CrossAgentContext {
        id: id.into(),
        session_id: session.into(),
        agent_type: agent,
        context_type: kind,
        content: content.into(),
        file_paths: vec![],
        decisions: vec![],
        errors: vec![],
        timestamp: at(seconds_offset),
    }
}

fn seeded(entries: Vec<CrossAgentContext>) -> ContextInjector<FakeSource> {
    ContextInjector::new(FakeSource { entries }).with_fixed_now(base_time())
}

// ---------------------------------------------------------------------------
// Ranking algorithm with known scores
// ---------------------------------------------------------------------------

#[test]
fn recency_uses_exponential_decay_with_24h_half_life() {
    let now = base_time();
    assert_eq!(recency_score(at(0), now), 1.0);
    // 24 h old → e⁻¹ ≈ 0.3679; 48 h → e⁻² ≈ 0.1353.
    let one_day = recency_score(at(-86_400), now);
    let two_days = recency_score(at(-172_800), now);
    assert!((one_day - (-1.0f64).exp()).abs() < 1e-12);
    assert!((two_days - (-2.0f64).exp()).abs() < 1e-12);
    assert!(one_day < 0.37 && one_day > 0.36);
    assert!(two_days < 0.14 && two_days > 0.13);
}

#[test]
fn final_score_applies_spec_weights() {
    // recency×0.5 + relevance×0.3 + confidence×0.2
    assert!((final_score(1.0, 1.0, 1.0) - 1.0).abs() < 1e-12);
    assert!((final_score(0.5, 0.8, 0.2) - 0.53).abs() < 1e-12); // 0.25+0.24+0.04
    assert_eq!(final_score(0.0, 0.0, 0.0), 0.0);
}

#[test]
fn ranking_orders_by_final_score_descending() {
    // Same recency (both 1 h old) — rank must follow relevance+confidence.
    let mut structured = entry(
        "a",
        "sess-1",
        AgentType::Jcode,
        ContextType::Decision,
        "dec",
        -3600,
    );
    structured.decisions = vec!["use workspace resolver".into()];
    structured.file_paths = vec!["Cargo.toml".into()];
    let plain = entry(
        "b",
        "sess-2",
        AgentType::ClaudeCode,
        ContextType::Task,
        "task",
        -3600,
    );

    let injector = seeded(vec![]).with_top_n(5);
    let ranked = injector.rank_context(
        vec![plain.clone(), structured.clone()],
        AgentType::Jcode,
        Some("sess-1"),
    );

    assert_eq!(ranked.len(), 2);
    assert_eq!(ranked[0].context.id, "a");
    assert_eq!(ranked[1].context.id, "b");
    // "a": 0.5·e^(−1/24) + 0.3·(0.4+0.3+0.2) + 0.2·1.0 vs "b": 0.5·e^(−1/24) + 0.3·0 + 0.2·0.2
    assert!(ranked[0].final_score > ranked[1].final_score);
    assert!(ranked[0].relevance > ranked[1].relevance);
    assert!(ranked[0].confidence > ranked[1].confidence);
}

#[test]
fn recency_dominates_at_same_relevance_and_confidence() {
    let fresh = entry("new", "s1", AgentType::Codex, ContextType::Task, "fresh", 0);
    let mut old = entry(
        "old",
        "s1",
        AgentType::Codex,
        ContextType::Task,
        "old",
        -7 * 86_400,
    );
    old.file_paths = vec!["a.rs".into()];
    let injector = seeded(vec![]).with_top_n(5);
    let ranked = injector.rank_context(vec![old, fresh], AgentType::Codex, None);
    // Identical relevance (session match + same agent + Task); old has +0.2
    // confidence from file_paths but is ~7 days stale (e⁻⁷ ≈ 0.0009).
    assert_eq!(ranked[0].context.id, "new");
}

#[test]
fn top_n_limits_kept_entries() {
    let entries: Vec<CrossAgentContext> = (0..10)
        .map(|i| {
            entry(
                &format!("e{i}"),
                "s1",
                AgentType::Jcode,
                ContextType::Task,
                "x",
                -i,
            )
        })
        .collect();
    let injector = seeded(entries.clone()).with_top_n(3);
    let ranked = injector.rank_context(entries, AgentType::Jcode, None);
    assert_eq!(ranked.len(), 3);
}

// ---------------------------------------------------------------------------
// Formatting for each agent type
// ---------------------------------------------------------------------------

#[test]
fn speg_and_jcode_format_spec_bullets() {
    let entries = vec![entry(
        "c1",
        "sess-1",
        AgentType::ClaudeCode,
        ContextType::Task,
        "implement the injector",
        -300,
    )];
    for target in [AgentType::Speg, AgentType::Jcode] {
        let formatted = seeded(entries.clone()).inject("sess-1", target, Some("sess-1"));
        assert_eq!(
            formatted,
            "[Cross-Agent Context]\n• Task: implement the injector (claude-code, 5m ago)"
        );
    }
}

#[test]
fn claude_code_formats_for_claude_md_append() {
    let entries = vec![entry(
        "c1",
        "s1",
        AgentType::Codex,
        ContextType::Decision,
        "use the workspace resolver",
        -7_200,
    )];
    let formatted = seeded(entries).inject("s1", AgentType::ClaudeCode, Some("s1"));
    assert_eq!(
        formatted,
        "## Cross-Agent Context\n\n- **Decision**: use the workspace resolver (codex, 2h ago)"
    );
}

#[test]
fn codex_formats_for_first_user_message_prepend() {
    let entries = vec![entry(
        "c1",
        "s1",
        AgentType::Cursor,
        ContextType::Pattern,
        "always run cargo fmt",
        -86_400,
    )];
    let formatted = seeded(entries).inject("s1", AgentType::Codex, Some("s1"));
    assert_eq!(
        formatted,
        "[Cross-Agent Context]\n• Pattern: always run cargo fmt (cursor, 1d ago)"
    );
}

#[test]
fn opencode_formats_for_opencode_md_append() {
    let entries = vec![entry(
        "c1",
        "s1",
        AgentType::Jcode,
        ContextType::Error,
        "missing linker for x86_64-pc-windows-gnu",
        -60,
    )];
    let formatted = seeded(entries).inject("s1", AgentType::OpenCode, Some("s1"));
    assert_eq!(
        formatted,
        "## Cross-Agent Context\n\n- **Error**: missing linker for x86_64-pc-windows-gnu (jcode, 1m ago)"
    );
}

#[test]
fn cursor_formats_for_cursorrules_append() {
    let entries = vec![entry(
        "c1",
        "s1",
        AgentType::OpenCode,
        ContextType::FileChange,
        "moved auth into src/auth/",
        -30,
    )];
    let formatted = seeded(entries).inject("s1", AgentType::Cursor, Some("s1"));
    assert_eq!(
        formatted,
        "# Cross-Agent Context\n\n- File change: moved auth into src/auth/ (opencode, 30s ago)"
    );
}

#[test]
fn every_formatter_includes_source_agent_and_time() {
    let entries = vec![entry(
        "c1",
        "s1",
        AgentType::ClaudeCode,
        ContextType::Task,
        "refactor the watcher",
        -3_600,
    )];
    for target in AgentType::ALL {
        let formatted = seeded(entries.clone()).inject("s1", target, Some("s1"));
        assert!(!formatted.is_empty(), "{target} produced no output");
        assert!(
            formatted.contains("(claude-code, 1h ago)"),
            "{target} output missing (agent, time_ago): {formatted:?}"
        );
        assert!(
            formatted.contains("Task"),
            "{target} output missing type label"
        );
    }
}

// ---------------------------------------------------------------------------
// Budget / truncation
// ---------------------------------------------------------------------------

#[test]
fn truncates_lowest_ranked_when_over_budget() {
    // Five tasks, same agent/session/recency, distinct ids; only "top" carries
    // structured decisions so it wins the rank.
    let mut top = entry(
        "top",
        "s1",
        AgentType::Jcode,
        ContextType::Decision,
        "the winning decision",
        -60,
    );
    top.decisions = vec!["x".into()];
    let mut others: Vec<CrossAgentContext> = (0..4)
        .map(|i| {
            entry(
                &format!("low{i}"),
                "s1",
                AgentType::Jcode,
                ContextType::Task,
                &format!("low-ranked task number {i} with some padding text"),
                -60,
            )
        })
        .collect();
    others.push(top);

    // Budget tight enough that not all five fit.
    let injector = seeded(others).with_max_chars(220);
    let formatted = injector.inject("s1", AgentType::Jcode, Some("s1"));

    assert!(
        formatted.len() <= 220,
        "budget exceeded: {} chars",
        formatted.len()
    );
    assert!(
        formatted.contains("the winning decision"),
        "highest-ranked entry must survive"
    );
    assert!(
        formatted.contains("task number 1"),
        "second-ranked entry should fit"
    );
    assert!(
        !formatted.contains("task number 3"),
        "lowest-ranked entry must be dropped"
    );
}

#[test]
fn keeps_top_entry_even_when_alone_exceeds_budget() {
    let mut huge = entry(
        "huge",
        "s1",
        AgentType::Jcode,
        ContextType::Task,
        "a very long task description that goes on and on "
            .repeat(60)
            .trim(),
        -60,
    );
    huge.decisions = vec!["x".into()];
    let injector = seeded(vec![huge]).with_max_chars(80);
    let formatted = injector.inject("s1", AgentType::Jcode, Some("s1"));
    assert!(formatted.len() <= 80);
    assert!(formatted.starts_with("[Cross-Agent Context]"));
}

// ---------------------------------------------------------------------------
// Empty context
// ---------------------------------------------------------------------------

#[test]
fn empty_store_injects_nothing() {
    let injector = seeded(vec![]);
    for target in AgentType::ALL {
        let formatted = injector.inject("s1", target, Some("s1"));
        assert_eq!(
            formatted, "",
            "{target} should inject nothing for an empty store"
        );
    }
}

#[test]
fn no_matching_project_injects_nothing() {
    let entries = vec![entry(
        "c1",
        "other-project",
        AgentType::Jcode,
        ContextType::Task,
        "x",
        -60,
    )];
    let formatted = seeded(entries).inject("s1", AgentType::Jcode, Some("s1"));
    assert_eq!(formatted, "");
}

// ---------------------------------------------------------------------------
// Scoring helpers through the public API
// ---------------------------------------------------------------------------

#[test]
fn relevance_and_confidence_are_deterministic_heuristics() {
    let base = base_time();
    let ctx = entry("c1", "s1", AgentType::Jcode, ContextType::Decision, "d", 0);
    assert_close(relevance_score(&ctx, AgentType::Jcode, Some("s1")), 0.9); // 0.4+0.3+0.2
    assert_close(relevance_score(&ctx, AgentType::Codex, None), 0.2); // Decision only
    assert_close(confidence_score(&ctx), 0.5); // 0.2 base + 0.3 Decision
    assert_eq!(time_ago(base, at(-3 * 3600)), "3h ago");
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-9,
        "expected {expected}, got {actual}"
    );
}
