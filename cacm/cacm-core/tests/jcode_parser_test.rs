//! Integration tests for the jcode session parser.
//!
//! Exercises `cacm_core::parsers::jcode::JcodeSessionParser` against sample
//! transcripts shaped like real jcode session files
//! (`~/.jcode/sessions/<id>.json` snapshots and `<id>.journal.jsonl` lines).

use cacm_core::parsers::{AgentSessionParser, ParseError, ParserRegistry};
use cacm_core::types::{AgentType, FileChangeKind, SessionStatus};
use std::fs;
use std::path::{Path, PathBuf};

/// Unique temp dir per test run to avoid cross-test collisions.
fn temp_dir(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("cacm-jcode-{tag}-{}-{nanos}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, contents: &str) {
    fs::write(path, contents).unwrap();
}

// ---------------------------------------------------------------------------
// Session manifest extraction
// ---------------------------------------------------------------------------

const SNAPSHOT_JSON: &str = r#"{
  "id": "sess-abc123",
  "parent_id": null,
  "title": "Fix the parser",
  "custom_title": null,
  "created_at": "2026-06-25T10:00:00Z",
  "updated_at": "2026-06-25T10:05:00Z",
  "status": "Active",
  "working_dir": "/workspace/demo",
  "messages": [
    {
      "id": "msg-1",
      "role": "user",
      "content": [{"type": "text", "text": "first prompt"}],
      "timestamp": "2026-06-25T10:00:00Z"
    }
  ]
}"#;

#[test]
fn parses_snapshot_manifest() {
    let dir = temp_dir("manifest");
    let snapshot = dir.join("sess-abc123.json");
    write(&snapshot, SNAPSHOT_JSON);

    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let session = parser.parse_session_manifest(&snapshot).unwrap();

    assert_eq!(session.session_id, "sess-abc123");
    assert_eq!(session.agent_type, AgentType::Jcode);
    assert_eq!(session.path, snapshot);
    assert_eq!(session.status, SessionStatus::Active);
    assert_eq!(
        session.created_at.to_rfc3339(),
        "2026-06-25T10:00:00+00:00"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn parses_manifest_from_directory_with_single_snapshot() {
    let dir = temp_dir("manifest-dir");
    let sub = dir.join("sess-dir-1");
    fs::create_dir_all(&sub).unwrap();
    write(&sub.join("sess-dir-1.json"), SNAPSHOT_JSON);

    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let session = parser.parse_session_manifest(&sub).unwrap();
    assert_eq!(session.session_id, "sess-abc123");
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn maps_jcode_status_to_cacm_status() {
    let dir = temp_dir("status");
    let closed = dir.join("closed.json");
    let crashed = dir.join("crashed.json");
    write(
        &closed,
        r#"{"id":"closed","created_at":"2026-06-25T10:00:00Z","status":"Closed"}"#,
    );
    write(
        &crashed,
        r#"{"id":"crashed","created_at":"2026-06-25T10:00:00Z","status":{"Crashed":{"message":"boom"}}}"#,
    );

    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    assert_eq!(
        parser.parse_session_manifest(&closed).unwrap().status,
        SessionStatus::Completed
    );
    assert_eq!(
        parser.parse_session_manifest(&crashed).unwrap().status,
        SessionStatus::Failed
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn manifest_from_journal_file_uses_stem_and_last_meta() {
    let dir = temp_dir("journal-manifest");
    let journal = dir.join("sess-j1.journal.jsonl");
    write(
        &journal,
        "{\"meta\":{\"updated_at\":\"2026-06-25T10:00:00Z\",\"status\":\"Active\"},\"append_messages\":[]}\n\
         {\"meta\":{\"updated_at\":\"2026-06-25T10:01:00Z\",\"status\":\"Closed\"},\"append_messages\":[]}\n",
    );

    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let session = parser.parse_session_manifest(&journal).unwrap();
    assert_eq!(session.session_id, "sess-j1");
    assert_eq!(session.status, SessionStatus::Completed);
    assert_eq!(
        session.created_at.to_rfc3339(),
        "2026-06-25T10:01:00+00:00"
    );
    fs::remove_dir_all(&dir).ok();
}

#[test]
fn directory_with_multiple_snapshots_is_rejected() {
    let dir = temp_dir("multi-snapshot");
    write(&dir.join("a.json"), SNAPSHOT_JSON);
    write(&dir.join("b.json"), SNAPSHOT_JSON);

    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let err = parser.parse_session_manifest(&dir).unwrap_err();
    assert!(matches!(err, ParseError::InvalidFormat(_)));
    fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------------------------
// Turn parsing: transcript lines
// ---------------------------------------------------------------------------

const USER_LINE: &str = r#"{"id":"msg-1","role":"user","content":[{"type":"text","text":"add tests for the parser"}],"timestamp":"2026-06-25T10:00:00Z"}"#;

const ASSISTANT_LINE: &str = r#"{"id":"msg-2","role":"assistant","content":[
  {"type":"text","text":"I'll add the tests."},
  {"type":"tool_use","id":"tc-1","name":"edit","input":{"file_path":"src/parser.rs","old_string":"x","new_string":"y"}},
  {"type":"tool_use","id":"tc-2","name":"write","input":{"file_path":"tests/parser_test.rs","content":"// tests"}}
],"timestamp":"2026-06-25T10:00:01Z"}"#;

const TOOL_RESULT_LINE: &str = r#"{"id":"msg-3","role":"user","content":[{"type":"tool_result","tool_use_id":"tc-1","content":"patched ok"}],"timestamp":"2026-06-25T10:00:02Z"}"#;

#[test]
fn parses_user_message_line() {
    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let turn = parser.parse_turn(USER_LINE).unwrap();
    assert_eq!(turn.user_message, "add tests for the parser");
    assert_eq!(turn.assistant_response, None);
    assert!(turn.tool_calls.is_empty());
    assert!(turn.file_modifications.is_empty());
    assert_eq!(turn.turn_index, 0);
}

#[test]
fn parses_assistant_line_with_tool_calls_and_file_modifications() {
    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let turn = parser.parse_turn(ASSISTANT_LINE).unwrap();
    assert_eq!(turn.user_message, "");
    assert_eq!(turn.assistant_response.as_deref(), Some("I'll add the tests."));

    assert_eq!(turn.tool_calls.len(), 2);
    assert_eq!(turn.tool_calls[0].name, "edit");
    assert_eq!(turn.tool_calls[0].input["file_path"], "src/parser.rs");
    assert_eq!(turn.tool_calls[1].name, "write");

    assert_eq!(turn.file_modifications.len(), 2);
    assert_eq!(turn.file_modifications[0].path, "src/parser.rs");
    assert_eq!(turn.file_modifications[0].change, FileChangeKind::Modify);
    assert_eq!(turn.file_modifications[1].path, "tests/parser_test.rs");
    assert_eq!(turn.file_modifications[1].change, FileChangeKind::Modify);
}

#[test]
fn tool_result_lines_yield_no_user_text() {
    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let turn = parser.parse_turn(TOOL_RESULT_LINE).unwrap();
    assert_eq!(turn.user_message, "");
    assert!(turn.tool_calls.is_empty());
    assert!(turn.file_modifications.is_empty());
}

#[test]
fn parses_journal_entry_line_into_one_turn() {
    let journal_line = r##"{"meta":{"parent_id":null,"title":null,"updated_at":"2026-06-25T10:00:03Z","status":"Active","is_canary":false,"is_debug":false,"saved":false},"append_messages":[
      {"id":"m1","role":"user","content":[{"type":"text","text":"hello"}],"timestamp":"2026-06-25T10:00:03Z"},
      {"id":"m2","role":"assistant","content":[{"type":"text","text":"hi"},{"type":"tool_use","id":"t2","name":"write","input":{"file_path":"notes.md","content":"# hi"}}],"timestamp":"2026-06-25T10:00:04Z"}
    ]}"##;

    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let turn = parser.parse_turn(journal_line).unwrap();
    assert_eq!(turn.user_message, "hello");
    assert_eq!(turn.assistant_response.as_deref(), Some("hi"));
    assert_eq!(turn.tool_calls.len(), 1);
    assert_eq!(turn.tool_calls[0].name, "write");
    assert_eq!(turn.file_modifications.len(), 1);
    assert_eq!(turn.file_modifications[0].path, "notes.md");
}

#[test]
fn parse_turn_rejects_garbage() {
    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    assert!(matches!(
        parser.parse_turn("this is not json"),
        Err(ParseError::InvalidFormat(_))
    ));
    assert!(matches!(
        parser.parse_turn(r#"{"some":"object"}"#),
        Err(ParseError::InvalidFormat(_))
    ));
}

#[test]
fn unknown_content_block_type_does_not_kill_the_line() {
    let line = r#"{"id":"msg-x","role":"assistant","content":[
      {"type":"text","text":"kept"},
      {"type":"future_block","whatever":{"nested":true}}
    ],"timestamp":"2026-06-25T10:00:00Z"}"#;
    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let turn = parser.parse_turn(line).unwrap();
    assert_eq!(turn.assistant_response.as_deref(), Some("kept"));
}

#[test]
fn system_role_message_does_not_kill_the_line_or_read_as_user_text() {
    let line = r#"{"id":"msg-sys","role":"system","content":[{"type":"text","text":"You are helpful."}],"timestamp":"2026-06-25T10:00:00Z"}"#;
    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let turn = parser.parse_turn(line).unwrap();
    assert_eq!(turn.user_message, "");
    assert_eq!(turn.assistant_response, None);
}

#[test]
fn tool_result_with_array_content_parses() {
    // Provider wire shapes can carry tool_result.content as an array of
    // blocks; the line must still parse (content is not read by this parser).
    let line = r#"{"id":"msg-tr","role":"user","content":[
      {"type":"tool_result","tool_use_id":"tc-9","content":[{"type":"text","text":"done"}]}
    ],"timestamp":"2026-06-25T10:00:00Z"}"#;
    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    let turn = parser.parse_turn(line).unwrap();
    assert_eq!(turn.user_message, "");
    assert!(turn.tool_calls.is_empty());
}

// ---------------------------------------------------------------------------
// Activity detection
// ---------------------------------------------------------------------------

#[test]
fn detect_activity_matches_jcode_session_files() {
    let dir = temp_dir("activity");
    let snapshot = dir.join("sess-1.json");
    let journal = dir.join("sess-1.journal.jsonl");
    let other = dir.join("notes.txt");
    write(&snapshot, SNAPSHOT_JSON);
    write(&journal, "{}\n");
    write(&other, "hi");

    let parser = cacm_core::parsers::jcode::JcodeSessionParser::new();
    assert!(parser.detect_activity(&snapshot));
    assert!(parser.detect_activity(&journal));
    assert!(!parser.detect_activity(&other));
    assert!(!parser.detect_activity(&dir.join("missing.json")));
    fs::remove_dir_all(&dir).ok();
}

// ---------------------------------------------------------------------------
// Registry integration
// ---------------------------------------------------------------------------

#[test]
fn default_registry_registers_jcode_and_stubs() {
    let registry = ParserRegistry::with_defaults();
    assert_eq!(registry.len(), 5);
    assert!(registry.get(AgentType::Jcode).is_some());
    assert!(registry.get(AgentType::ClaudeCode).is_some());
    assert!(registry.get(AgentType::Codex).is_some());
    assert!(registry.get(AgentType::OpenCode).is_some());
    assert!(registry.get(AgentType::Cursor).is_some());
    assert!(registry.get(AgentType::Speg).is_none());
}

#[test]
fn stubs_return_not_implemented() {
    let registry = ParserRegistry::with_defaults();
    for agent in [
        AgentType::ClaudeCode,
        AgentType::Codex,
        AgentType::OpenCode,
        AgentType::Cursor,
    ] {
        let parser = registry.get(agent).unwrap();
        assert!(matches!(
            parser.parse_turn(USER_LINE),
            Err(ParseError::NotImplemented(_))
        ));
    }
}

#[test]
fn jcode_parser_works_through_the_registry() {
    let registry = ParserRegistry::with_defaults();
    let parser = registry.get(AgentType::Jcode).unwrap();
    let turn = parser.parse_turn(ASSISTANT_LINE).unwrap();
    assert_eq!(turn.assistant_response.as_deref(), Some("I'll add the tests."));
    assert_eq!(turn.tool_calls.len(), 2);
}
