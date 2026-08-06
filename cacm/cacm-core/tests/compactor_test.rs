//! Integration tests for the cross-session compactor (task 1.13).
//!
//! Exercises the public surface of `cacm_core::compactor` — deduplication by
//! file path (highest confidence wins), per-session milestone summarization,
//! cross-agent `related_to` linking, staleness pruning with exponential
//! confidence decay — and the task's headline verification: *10 entries from 3
//! agents → 3 milestone entries*.

use cacm_core::compactor::{
    decayed_confidence, deduplicate, link_related, prune_stale, summarize_to_milestones,
    Compactor,
};
use cacm_core::types::{AgentType, ContextType, CrossAgentContext};
use chrono::{DateTime, Duration, Utc};

const BASE: &str = "2026-06-25T10:00:00Z";

fn base_time() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(BASE)
        .unwrap()
        .with_timezone(&Utc)
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
        timestamp: base_time(),
    }
}

/// The task's verification scenario: 10 entries from 3 agents (with
/// intra- and cross-agent duplicates) compact to exactly 3 milestone entries.
#[test]
fn compact_verification_ten_entries_three_agents_to_three_milestones() {
    let now = base_time();
    let compactor = Compactor::new(now);
    let entries = vec![
        // codex session j1 — 4 entries, 2 duplicated pairs (src/lib.rs, src/main.rs).
        entry("j1a", "j1", AgentType::Codex, ContextType::Task, "add tests to the lib module", &["src/lib.rs"]),
        entry("j1b", "j1", AgentType::Codex, ContextType::Decision, "use the workspace resolver config", &["src/lib.rs"]),
        entry("j1c", "j1", AgentType::Codex, ContextType::Task, "wire the main entry point", &["src/main.rs"]),
        entry("j1d", "j1", AgentType::Codex, ContextType::FileChange, "changed the main entry point", &["src/main.rs"]),
        // claude-code session c1 — 3 entries, 2 cross-agent dups of j1's
        // src/lib.rs group plus one unique file.
        entry("c1a", "c1", AgentType::ClaudeCode, ContextType::Task, "review the lib module changes", &["src/lib.rs"]),
        entry("c1b", "c1", AgentType::ClaudeCode, ContextType::Task, "review the lib module changes", &["src/lib.rs"]),
        entry("c1c", "c1", AgentType::ClaudeCode, ContextType::Task, "fix the parser error handling", &["src/parser.rs"]),
        // opencode session x1 — 3 entries, one cross-agent dup of j1's src/main.rs
        // group and one duplicated pair on Cargo.toml.
        entry("x1a", "x1", AgentType::OpenCode, ContextType::Task, "set the workspace resolver to version two config", &["src/main.rs"]),
        entry("x1b", "x1", AgentType::OpenCode, ContextType::Decision, "pin the workspace resolver version", &["Cargo.toml"]),
        entry("x1c", "x1", AgentType::OpenCode, ContextType::Decision, "pin the workspace resolver version", &["Cargo.toml"]),
    ];

    let report = compactor.compact(&entries);

    assert_eq!(report.input_count, 10);
    assert_eq!(report.milestones.len(), 3, "3 agents/sessions → 3 milestone entries");
    let mut agents: Vec<String> = report
        .milestones
        .iter()
        .map(|m| m.agent_type.to_string())
        .collect();
    agents.sort();
    assert_eq!(agents, vec!["claude-code", "codex", "opencode"]);

    // Each milestone is a self-describing summary carrying its group's union.
    for milestone in &report.milestones {
        assert!(milestone.content.contains("[Milestone]"), "milestone marker");
        assert!(milestone.content.contains("Task:"), "task line");
        assert_eq!(milestone.context_type, ContextType::Task);
    }
    // The codex milestone unions its two surviving file paths.
    let codex = report
        .milestones
        .iter()
        .find(|m| m.agent_type == AgentType::Codex)
        .unwrap();
    assert!(codex.file_paths.contains(&"src/lib.rs".to_string()));
    assert!(codex.file_paths.contains(&"src/main.rs".to_string()));

    // 10 in, 3 milestones → at least 5 duplicates were removed; nothing stale.
    assert!(report.deduplicated >= 5);
    assert_eq!(report.pruned, 0);

    // Cross-agent related_to edges: at least the j1↔x1 resolver pair.
    assert!(!report.links.is_empty(), "cross-agent links exist");
    for link in &report.links {
        assert!(link.from_id < link.to_id, "canonical ordering");
        assert!(link.weight >= 0.0 && link.weight <= 1.0);
    }
}

#[test]
fn deduplicate_keeps_highest_confidence_entry_per_file_group() {
    let low = entry("low", "s1", AgentType::Codex, ContextType::FileChange, "changed Cargo.toml", &["Cargo.toml"]);
    let high = entry("high", "s2", AgentType::ClaudeCode, ContextType::Decision, "use the workspace resolver", &["Cargo.toml"]);
    let other = entry("other", "s3", AgentType::Codex, ContextType::Task, "add tests", &["src/lib.rs"]);

    let out = deduplicate(&[low, high, other]);

    assert_eq!(out.len(), 2);
    assert_eq!(out[0].id, "high"); // Cargo.toml group keeps the Decision
    assert_eq!(out[1].id, "other");
}

#[test]
fn summarize_creates_one_milestone_per_session_with_unions() {
    let mut a = entry("a", "j1", AgentType::Codex, ContextType::Task, "build the extractor", &["src/lib.rs"]);
    let mut b = entry("b", "j1", AgentType::Codex, ContextType::Decision, "use regex", &["src/parser.rs"]);
    a.decisions = vec!["keep it deterministic".into()];
    b.decisions = vec!["use regex".into()];
    let c = entry("c", "c1", AgentType::ClaudeCode, ContextType::Task, "review the extractor", &["src/main.rs"]);

    let milestones = summarize_to_milestones(&[a, b, c]);

    assert_eq!(milestones.len(), 2); // sessions j1 and c1
    let j1 = milestones.iter().find(|m| m.session_id == "j1").unwrap();
    assert_eq!(j1.agent_type, AgentType::Codex);
    assert!(j1.content.contains("2 entries"));
    assert!(j1.content.contains("Task: build the extractor"));
    // Decisions and file paths are the group's unions, in first-seen order.
    assert_eq!(j1.decisions, vec!["keep it deterministic", "use regex"]);
    assert_eq!(j1.file_paths, vec!["src/lib.rs", "src/parser.rs"]);
    // Milestone ids are namespaced and unique.
    assert_eq!(j1.id, "milestone:codex:j1");
}

#[test]
fn link_related_connects_different_agents_with_similar_content() {
    let a = entry("a1", "s1", AgentType::Codex, ContextType::Decision, "use the workspace resolver config", &["Cargo.toml"]);
    let b = entry("b1", "s2", AgentType::ClaudeCode, ContextType::Task, "set the workspace resolver to version two config", &["src/main.rs"]);
    // Same agent as a1, unrelated content → must not link.
    let a2 = entry("a2", "s3", AgentType::Codex, ContextType::Task, "add tests for the batch pipeline", &["src/lib.rs"]);

    let links = link_related(&[a, b, a2]);

    assert_eq!(links.len(), 1);
    assert_eq!(links[0].from_id, "a1"); // canonical: from_id < to_id
    assert_eq!(links[0].to_id, "b1");
    assert!(links[0].weight >= 0.15);
}

#[test]
fn prune_stale_removes_entries_past_max_age_or_below_decayed_floor() {
    let now = base_time();
    let mut old = entry("old", "s1", AgentType::Codex, ContextType::Task, "ancient work", &["src/old.rs"]);
    old.timestamp = now - Duration::days(400); // past the 365-day default cap
    let fresh = entry("fresh", "s2", AgentType::Codex, ContextType::Task, "recent work", &["src/lib.rs"]);

    let (kept, pruned) = prune_stale(
        &[old.clone(), fresh.clone()],
        now,
        Duration::days(365),
        Duration::days(30),
        0.05,
    );

    assert_eq!(kept, vec![fresh]);
    assert_eq!(pruned, vec![old]);
}

#[test]
fn decayed_confidence_falls_exponentially_with_age() {
    let ctx = entry("e", "s1", AgentType::Codex, ContextType::Decision, "chose axum", &["Cargo.toml"]);
    let now = base_time();
    let base = decayed_confidence(&ctx, now, Duration::days(30));
    let one_half_life = decayed_confidence(&ctx, now + Duration::days(30), Duration::days(30));
    let two_half_lives = decayed_confidence(&ctx, now + Duration::days(60), Duration::days(30));
    assert!((one_half_life - base / 2.0).abs() < 1e-9);
    assert!((two_half_lives - base / 4.0).abs() < 1e-9);
}

#[test]
fn compactor_stages_can_be_disabled_independently() {
    let now = base_time();
    // A stale entry plus a duplicate pair: with everything off, nothing changes.
    let mut stale = entry("stale", "s1", AgentType::Codex, ContextType::Task, "old task", &["src/old.rs"]);
    stale.timestamp = now - Duration::days(400);
    let dup_a = entry("dup-a", "s2", AgentType::Codex, ContextType::Decision, "use the workspace resolver config", &["Cargo.toml"]);
    let dup_b = entry("dup-b", "s3", AgentType::ClaudeCode, ContextType::Task, "set the workspace resolver to version two config", &["Cargo.toml"]);
    let entries = vec![stale.clone(), dup_a.clone(), dup_b.clone()];

    let passthrough = Compactor::new(now)
        .with_dedup(false)
        .with_summarize(false)
        .with_link(false)
        .with_prune(false)
        .compact(&entries);
    assert_eq!(passthrough.milestones.len(), 3);
    assert_eq!(passthrough.deduplicated, 0);
    assert_eq!(passthrough.pruned, 0);
    assert!(passthrough.links.is_empty());

    // Prune only: the stale entry goes, everything else stays.
    let pruned_only = Compactor::new(now)
        .with_dedup(false)
        .with_summarize(false)
        .with_link(false)
        .compact(&entries);
    assert_eq!(pruned_only.milestones.len(), 2);
    assert_eq!(pruned_only.pruned, 1);

    // Link only (dedup off): the Cargo.toml pair links across agents.
    let link_only = Compactor::new(now)
        .with_dedup(false)
        .with_summarize(false)
        .with_prune(false)
        .compact(&entries);
    assert_eq!(link_only.links.len(), 1);
}
