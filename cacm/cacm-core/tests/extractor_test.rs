//! Integration tests for the heuristic context extractor (task 1.6).
//!
//! Exercises `cacm_core::extractor` — the pure heuristic functions
//! (`extract_task`, `extract_decisions`, `extract_file_changes`,
//! `extract_errors`, `extract_patterns`) and the batched
//! `ContextExtractor` — against sample `AgentTurn` data, batching behavior,
//! and edge cases (empty turns, single turn, malformed data).

use cacm_core::extractor::{
    extract_decisions, extract_errors, extract_file_changes, extract_patterns, extract_task,
    looks_like_task, ContextExtractor,
};
use cacm_core::types::{
    AgentTurn, AgentType, ContextType, CrossAgentContext, FileChangeKind, FileModification,
    ToolCall,
};
use chrono::{DateTime, Utc};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn base_time() -> DateTime<Utc> {
    DateTime::parse_from_rfc3339("2026-06-25T10:00:00Z")
        .unwrap()
        .with_timezone(&Utc)
}

fn turn(
    index: u32,
    user: &str,
    assistant: Option<&str>,
    tools: Vec<ToolCall>,
    files: Vec<FileModification>,
) -> AgentTurn {
    AgentTurn {
        turn_index: index,
        timestamp: base_time() + chrono::Duration::seconds(index as i64),
        user_message: user.to_string(),
        assistant_response: assistant.map(String::from),
        tool_calls: tools,
        file_modifications: files,
    }
}

fn simple(index: u32, user: &str, assistant: &str) -> AgentTurn {
    turn(index, user, Some(assistant), vec![], vec![])
}

fn tool(name: &str, input: serde_json::Value) -> ToolCall {
    ToolCall {
        name: name.to_string(),
        input,
    }
}

fn file(path: &str, kind: FileChangeKind) -> FileModification {
    FileModification {
        path: path.to_string(),
        change: kind,
    }
}

/// Distinct context types in `ctxs`, preserving order.
fn types(ctxs: &[CrossAgentContext]) -> Vec<ContextType> {
    ctxs.iter().map(|c| c.context_type).collect()
}

// ---------------------------------------------------------------------------
// Task extraction
// ---------------------------------------------------------------------------

#[test]
fn extract_task_takes_first_non_empty_user_message() {
    let turns = vec![
        simple(0, "", "hi"),
        simple(1, "   ", "more"),
        simple(2, "I want to add a retry loop", "ok"),
    ];
    assert_eq!(
        extract_task(&turns).as_deref(),
        Some("I want to add a retry loop")
    );
}

#[test]
fn extract_task_uses_first_message_when_first_turn_has_one() {
    let turns = vec![simple(0, "first prompt", "ok"), simple(1, "second", "ok")];
    assert_eq!(extract_task(&turns).as_deref(), Some("first prompt"));
}

#[test]
fn extract_task_is_none_without_user_messages() {
    let turns = vec![
        turn(0, "", Some("assistant only"), vec![], vec![]),
        turn(1, "", None, vec![], vec![]),
    ];
    assert_eq!(extract_task(&turns), None);
    assert_eq!(extract_task(&[]), None);
}

#[test]
fn looks_like_task_matches_spec_keywords_case_insensitively() {
    for keyword in [
        "I want to",
        "build",
        "create",
        "fix",
        "implement",
        "refactor",
    ] {
        assert!(
            looks_like_task(&format!("please {keyword} the parser")),
            "expected keyword {keyword:?} to look like a task"
        );
        assert!(
            looks_like_task(&keyword.to_ascii_uppercase()),
            "expected case-insensitive match for {keyword:?}"
        );
    }
    assert!(!looks_like_task("just a passing comment"));
    assert!(!looks_like_task(""));
}

// ---------------------------------------------------------------------------
// Decision extraction
// ---------------------------------------------------------------------------

#[test]
fn extract_decisions_finds_keyword_messages_in_order() {
    let turns = vec![
        simple(0, "we decided to use sqlite", "ok"),
        simple(1, "continue", "going with axum for the server"),
        simple(2, "no decision here", "will use the workspace resolver"),
    ];
    let decisions = extract_decisions(&turns);
    assert_eq!(decisions.len(), 3);
    assert!(decisions[0].contains("decided"));
    assert!(decisions[1].contains("going with"));
    assert!(decisions[2].contains("will use"));
}

#[test]
fn extract_decisions_scans_user_and_assistant_and_dedupes() {
    let turns = vec![
        simple(0, "we decided to use sqlite", "we decided to use sqlite"),
        simple(1, "chose postgres instead", "ok"),
        simple(2, "we decided to use sqlite", "ok"),
    ];
    let decisions = extract_decisions(&turns);
    assert_eq!(decisions.len(), 2, "exact duplicates collapse to one entry");
}

#[test]
fn extract_decisions_empty_when_no_matches() {
    assert!(extract_decisions(&[simple(0, "plain message", "plain reply")]).is_empty());
    assert!(extract_decisions(&[]).is_empty());
}

// ---------------------------------------------------------------------------
// Error extraction
// ---------------------------------------------------------------------------

#[test]
fn extract_errors_finds_failures() {
    let turns = vec![
        simple(0, "the build failed again", "ok"),
        simple(1, "retry", "panic: caught an exception in the watcher"),
        simple(2, "cannot find module './x'", "ok"),
        simple(3, "looks fine", "ok"),
    ];
    let errors = extract_errors(&turns);
    assert_eq!(errors.len(), 3);
    assert!(errors.iter().any(|e| e.contains("failed")));
    assert!(errors.iter().any(|e| e.contains("exception")));
    assert!(errors.iter().any(|e| e.contains("cannot")));
}

#[test]
fn extract_errors_empty_when_no_matches() {
    assert!(extract_errors(&[simple(0, "all good", "all good")]).is_empty());
}

// ---------------------------------------------------------------------------
// Pattern extraction
// ---------------------------------------------------------------------------

#[test]
fn extract_patterns_finds_conventions() {
    let turns = vec![
        simple(0, "we always run tests before committing", "ok"),
        simple(1, "never commit the lockfile", "ok"),
        simple(2, "our convention is kebab-case", "ok"),
        simple(3, "best practice: pure functions", "ok"),
    ];
    let patterns = extract_patterns(&turns);
    assert_eq!(patterns.len(), 4);
    assert!(patterns.iter().any(|p| p.contains("always")));
    assert!(patterns.iter().any(|p| p.contains("never")));
    assert!(patterns.iter().any(|p| p.contains("convention")));
    assert!(patterns.iter().any(|p| p.contains("best practice")));
}

#[test]
fn extract_patterns_empty_when_no_matches() {
    assert!(extract_patterns(&[simple(0, "random chatter", "ok")]).is_empty());
}

// ---------------------------------------------------------------------------
// File-change extraction
// ---------------------------------------------------------------------------

#[test]
fn extract_file_changes_reads_structured_modifications() {
    let turns = vec![
        turn(
            0,
            "fix it",
            Some("done"),
            vec![],
            vec![
                file("src/lib.rs", FileChangeKind::Modify),
                file("src/main.rs", FileChangeKind::Create),
                file("old.rs", FileChangeKind::Delete),
                file("moved.rs", FileChangeKind::Rename),
            ],
        ),
        simple(1, "thanks", "ok"),
    ];
    assert_eq!(
        extract_file_changes(&turns),
        vec![
            "src/lib.rs".to_string(),
            "src/main.rs".to_string(),
            "old.rs".to_string(),
            "moved.rs".to_string(),
        ]
    );
}

#[test]
fn extract_file_changes_reads_tool_call_inputs() {
    let turns = vec![
        turn(
            0,
            "edit the parser",
            Some("done"),
            vec![
                tool("edit_file", serde_json::json!({"path": "src/extractor.rs"})),
                tool("write_file", serde_json::json!({"file_path": "tests/x.rs"})),
                tool("delete", serde_json::json!({"file": "old/y.rs"})),
                tool(
                    "rename",
                    serde_json::json!({"old_path": "a.rs", "new_path": "b.rs"}),
                ),
            ],
            vec![],
        ),
        simple(1, "ok", "done"),
    ];
    let paths = extract_file_changes(&turns);
    // rename records both old and new path.
    assert!(paths.contains(&"a.rs".to_string()));
    assert!(paths.contains(&"b.rs".to_string()));
    assert!(paths.contains(&"src/extractor.rs".to_string()));
    assert!(paths.contains(&"tests/x.rs".to_string()));
    assert!(paths.contains(&"old/y.rs".to_string()));
}

#[test]
fn extract_file_changes_reads_text_patterns() {
    let turns = vec![simple(
        0,
        "thanks",
        "Modified: src/lib.rs\nCreated: tests/integration_test.rs\nWrote to: Cargo.toml\nUpdated src/watcher.rs",
    )];
    let paths = extract_file_changes(&turns);
    assert!(paths.contains(&"src/lib.rs".to_string()));
    assert!(paths.contains(&"tests/integration_test.rs".to_string()));
    assert!(paths.contains(&"Cargo.toml".to_string()));
    assert!(paths.contains(&"src/watcher.rs".to_string()));
}

#[test]
fn extract_file_changes_finds_extension_tokens() {
    let turns = vec![simple(
        0,
        "look at src/main.rs and the doc in docs/guide.md",
        "touched src/extractor.rs too",
    )];
    let paths = extract_file_changes(&turns);
    assert!(paths.contains(&"src/main.rs".to_string()));
    assert!(paths.contains(&"docs/guide.md".to_string()));
    assert!(paths.contains(&"src/extractor.rs".to_string()));
}

#[test]
fn extract_file_changes_rejects_non_path_tokens() {
    // Decimals, URLs, and version strings must not be treated as files.
    let turns = vec![simple(
        0,
        "ratio is 3.14, see example.com and v1.2.3",
        "pi is 3.14159",
    )];
    assert!(extract_file_changes(&turns).is_empty());
}

#[test]
fn extract_file_changes_normalizes_and_dedupes() {
    let turns = vec![
        turn(
            0,
            "edit it",
            Some("Modified: `src/lib.rs`,"),
            vec![tool("edit_file", serde_json::json!({"path": "src/lib.rs"}))],
            vec![file("src/lib.rs", FileChangeKind::Modify)],
        ),
        simple(1, "also", "Wrote to: Cargo.toml."),
    ];
    let paths = extract_file_changes(&turns);
    assert_eq!(
        paths,
        vec!["src/lib.rs".to_string(), "Cargo.toml".to_string()]
    );
}

#[test]
fn extract_file_changes_prefixes_reject_bare_words() {
    // "all"/"the"/"old" are not paths; only path-like tokens survive.
    let turns = vec![simple(
        0,
        "cleanup",
        "Deleted: all the old files\nUpdated: config.json.example\nModified: src/lib.rs",
    )];
    let paths = extract_file_changes(&turns);
    assert_eq!(paths, vec!["src/lib.rs".to_string()]);
}

#[test]
fn extract_file_changes_extension_token_at_sentence_end() {
    // A trailing period is sentence punctuation, not part of the path.
    let turns = vec![simple(0, "i edited src/main.rs.", "done.")];
    assert_eq!(
        extract_file_changes(&turns),
        vec!["src/main.rs".to_string()]
    );
    // ...but a path char after punctuation still continues a longer token.
    let suffix = vec![simple(0, "see x/y.rs.foo", "ok")];
    assert!(extract_file_changes(&suffix).is_empty());
}

#[test]
fn extract_file_changes_tool_inputs_reject_prose() {
    let turns = vec![turn(
        0,
        "merge",
        Some("done"),
        vec![
            tool("some_tool", serde_json::json!({"file": "some prose"})),
            tool(
                "branch",
                serde_json::json!({"source": "main", "destination": "feature"}),
            ),
            tool("edit_file", serde_json::json!({"path": "src/lib.rs"})),
        ],
        vec![],
    )];
    assert_eq!(extract_file_changes(&turns), vec!["src/lib.rs".to_string()]);
}

#[test]
fn extract_file_changes_keeps_structured_paths_verbatim() {
    // Structured (parser-extracted) paths are authoritative: no de-punctuation.
    let turns = vec![turn(
        0,
        "x",
        Some("ok"),
        vec![],
        vec![file("README!", FileChangeKind::Modify)],
    )];
    assert_eq!(extract_file_changes(&turns), vec!["README!".to_string()]);
}

#[test]
fn extract_file_changes_sanitizes_traversal_paths() {
    // `.`/`..` segments collapse and absolute prefixes are stripped, so
    // traversal-style paths never leak verbatim into stored context.
    let turns = vec![
        simple(
            0,
            "hack",
            "Modified: ../../etc/passwd\nCreated: /etc/shadow\nUpdated: C:\\repo\\src\\main.rs",
        ),
        turn(
            1,
            "tool",
            Some("done"),
            vec![tool(
                "edit_file",
                serde_json::json!({"path": "../../../src/evil.rs"}),
            )],
            vec![],
        ),
    ];
    let paths = extract_file_changes(&turns);
    assert_eq!(
        paths,
        vec![
            "etc/passwd".to_string(),
            "etc/shadow".to_string(),
            "repo/src/main.rs".to_string(),
            // The extension token also surfaces the final segment of a
            // backslash path ("C:\repo\src\main.rs") — sanitized to the
            // relative file name.
            "main.rs".to_string(),
            "src/evil.rs".to_string(),
        ]
    );
}

#[test]
fn extract_file_changes_is_empty_for_no_signals() {
    assert!(extract_file_changes(&[simple(0, "hi", "hi")]).is_empty());
    assert!(extract_file_changes(&[]).is_empty());
}

// ---------------------------------------------------------------------------
// extract_context composition
// ---------------------------------------------------------------------------

#[test]
fn extract_context_emits_each_context_type_with_session_metadata() {
    let turns = vec![
        simple(
            0,
            "I want to build a context extractor",
            "we decided to use sqlite",
        ),
        simple(1, "the build failed", "Modified: src/extractor.rs"),
        simple(2, "we always add tests", "ok"),
    ];
    let mut ex = ContextExtractor::new("sess-abc", AgentType::Jcode);
    let ctxs = ex.extract_context(&turns);

    assert_eq!(
        types(&ctxs),
        vec![
            ContextType::Task,
            ContextType::Decision,
            ContextType::FileChange,
            ContextType::Error,
            ContextType::Pattern,
        ]
    );

    for ctx in &ctxs {
        assert_eq!(ctx.session_id, "sess-abc");
        assert_eq!(ctx.agent_type, AgentType::Jcode);
        assert_eq!(ctx.timestamp, turns.last().unwrap().timestamp);
    }

    // Task content is the first user message.
    let task = ctxs
        .iter()
        .find(|c| c.context_type == ContextType::Task)
        .unwrap();
    assert_eq!(task.content, "I want to build a context extractor");

    // File-change entry carries the paths in file_paths (used by project query).
    let file_ctx = ctxs
        .iter()
        .find(|c| c.context_type == ContextType::FileChange)
        .unwrap();
    assert_eq!(file_ctx.file_paths, vec!["src/extractor.rs".to_string()]);

    // Error entry carries the errors in its errors field.
    let err_ctx = ctxs
        .iter()
        .find(|c| c.context_type == ContextType::Error)
        .unwrap();
    assert_eq!(err_ctx.errors.len(), 1);
    assert!(err_ctx.errors[0].contains("failed"));

    // Ids are unique.
    let ids: std::collections::HashSet<&str> = ctxs.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids.len(), ctxs.len());
}

#[test]
fn extract_context_skips_task_without_keywords_but_keeps_other_types() {
    let turns = vec![
        simple(0, "please review the diff", "we decided to use sqlite"),
        simple(1, "ok", "there was an error in the build"),
    ];
    let mut ex = ContextExtractor::new("s1", AgentType::Codex);
    let ctxs = ex.extract_context(&turns);
    assert!(!ctxs.iter().any(|c| c.context_type == ContextType::Task));
    assert!(ctxs.iter().any(|c| c.context_type == ContextType::Decision));
    assert!(ctxs.iter().any(|c| c.context_type == ContextType::Error));
}

#[test]
fn extract_context_empty_and_no_signal_inputs() {
    let mut ex = ContextExtractor::new("s1", AgentType::Jcode);
    assert!(ex.extract_context(&[]).is_empty());
    // Turns with no detectable signals produce nothing either.
    let quiet = vec![simple(0, "hi", "hello"), simple(1, "again", "sure")];
    assert!(ex.extract_context(&quiet).is_empty());
}

#[test]
fn extract_context_emits_task_only_once_per_session() {
    let mut ex = ContextExtractor::new("s1", AgentType::Jcode);
    let first = ex.extract_context(&[simple(0, "I want to build a CLI", "ok")]);
    assert!(first.iter().any(|c| c.context_type == ContextType::Task));
    let second = ex.extract_context(&[simple(1, "I want to add more", "ok")]);
    assert!(
        !second.iter().any(|c| c.context_type == ContextType::Task),
        "task must not be re-emitted in a later batch"
    );
}

#[test]
fn task_is_decided_from_the_session_first_user_message_only() {
    // Batch 1's first user message does not read like a task (no keyword) →
    // no Task entry, and the gate closes so batch 2's message is never
    // mislabeled as the task.
    let mut ex = ContextExtractor::new("s1", AgentType::Jcode);
    let first = ex.extract_context(&[simple(0, "please review the diff", "ok")]);
    assert!(!first.iter().any(|c| c.context_type == ContextType::Task));
    let second = ex.extract_context(&[simple(1, "I want to build a CLI", "ok")]);
    assert!(
        !second.iter().any(|c| c.context_type == ContextType::Task),
        "a later batch's message is not the session's first user message"
    );
}

#[test]
fn oversized_task_is_truncated() {
    let huge = format!("I want to build a CLI {}", "y".repeat(2000));
    let mut ex = ContextExtractor::new("s1", AgentType::Jcode);
    let ctxs = ex.extract_context(&[simple(0, &huge, "ok")]);
    let task = ctxs
        .iter()
        .find(|c| c.context_type == ContextType::Task)
        .unwrap();
    assert!(
        task.content.chars().count() <= 513,
        "task must be truncated"
    );
}

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

#[test]
fn batching_extracts_every_five_turns_or_at_session_end() {
    let mut ex = ContextExtractor::new("sess-batch", AgentType::Jcode);
    assert_eq!(ex.batch_size(), 5);

    let mut flushed = Vec::new();
    let mut flush_points = Vec::new();
    for i in 0..12u32 {
        let user = if i == 0 {
            "I want to build a CLI"
        } else {
            "continue"
        };
        let assistant = if i % 2 == 0 {
            "we decided to use sqlite"
        } else {
            "ok"
        };
        let ctxs = ex.add_turn(simple(i, user, assistant));
        if !ctxs.is_empty() {
            flush_points.push(i);
        }
        flushed.extend(ctxs);
    }

    // Batch of 5 flushes at turn 4, batch of 5 at turn 9; turns 10-11 stay buffered.
    assert_eq!(
        flush_points,
        vec![4, 9],
        "mid-session flushes every 5 turns"
    );
    assert_eq!(ex.buffered_turns(), 2);

    let remaining = ex.flush();
    assert!(
        !remaining.is_empty(),
        "session-end flush extracts the remainder"
    );
    assert_eq!(ex.buffered_turns(), 0);

    // The task appears exactly once across the whole session.
    let all: Vec<CrossAgentContext> = flushed.into_iter().chain(remaining).collect();
    let task_count = all
        .iter()
        .filter(|c| c.context_type == ContextType::Task)
        .count();
    assert_eq!(task_count, 1, "task emitted once per session");

    // Ids stay unique across batches.
    let ids: std::collections::HashSet<&str> = all.iter().map(|c| c.id.as_str()).collect();
    assert_eq!(ids.len(), all.len());
}

#[test]
fn single_turn_extracts_at_session_end() {
    let mut ex = ContextExtractor::new("s1", AgentType::Jcode);
    let turn = simple(0, "I want to fix the crash", "we decided to use sqlite");
    assert!(
        ex.add_turn(turn).is_empty(),
        "one turn is below the batch size"
    );
    let ctxs = ex.flush();
    assert!(!ctxs.is_empty(), "session end extracts a single turn");
    assert!(ctxs.iter().any(|c| c.context_type == ContextType::Task));
}

#[test]
fn custom_batch_size_is_honored() {
    let mut ex = ContextExtractor::new("s1", AgentType::Jcode).with_batch_size(2);
    assert_eq!(ex.batch_size(), 2);

    assert!(ex
        .add_turn(simple(0, "I want to build a CLI", "ok"))
        .is_empty());
    let first = ex.add_turn(simple(1, "continue", "we decided to use sqlite"));
    assert!(!first.is_empty(), "second turn reaches batch size 2");
    assert_eq!(ex.buffered_turns(), 0);
}

#[test]
#[should_panic(expected = "batch size must be >= 1")]
fn zero_batch_size_panics() {
    let _ = ContextExtractor::new("s1", AgentType::Jcode).with_batch_size(0);
}

// ---------------------------------------------------------------------------
// Malformed data
// ---------------------------------------------------------------------------

#[test]
fn malformed_tool_inputs_do_not_panic() {
    let turns = vec![
        turn(
            0,
            "edit stuff",
            Some("Modified: src/lib.rs"),
            vec![
                tool("weird", serde_json::json!({"path": null})),
                tool("weird2", serde_json::json!({"path": 42})),
                tool("weird3", serde_json::json!({"file_path": ""})),
                tool("weird4", serde_json::Value::String("not an object".into())),
                tool("weird5", serde_json::Value::Array(vec![])),
                tool("weird6", serde_json::json!({"nested": {"path": "ignored"}})),
            ],
            vec![],
        ),
        turn(1, "", None, vec![], vec![]),
    ];
    // No panic; the one real text pattern still surfaces.
    assert_eq!(extract_file_changes(&turns), vec!["src/lib.rs".to_string()]);

    let mut ex = ContextExtractor::new("s1", AgentType::Jcode);
    let ctxs = ex.extract_context(&turns);
    assert!(!ctxs.is_empty());
}

#[test]
fn oversized_messages_are_truncated() {
    let big = format!("we decided to use sqlite {}", "x".repeat(2000));
    let turns = vec![simple(0, "hi", &big)];
    let decisions = extract_decisions(&turns);
    assert_eq!(decisions.len(), 1);
    assert!(
        decisions[0].chars().count() <= 513,
        "item must be truncated"
    );
}
