/**
 * CACM wire types.
 *
 * These mirror `cacm-core/src/types.rs` exactly — they are the protocol types
 * shared over the daemon's WebSocket JSON surface (task 1.14). Naming and
 * string encodings follow the SPEG contracts (task 1.2): agent and context
 * types serialize as kebab-case strings (`claude-code`, `file-change`),
 * statuses and event kinds as lowercase strings, timestamps as RFC 3339
 * (chrono `DateTime<Utc>` serialization).
 */

/** The coding agents CACM watches and shares context between. */
export type AgentType = "claude-code" | "codex" | "opencode" | "cursor" | "grok" | "speg";

/** Lifecycle status of a watched agent session. */
export type SessionStatus = "active" | "idle" | "completed" | "failed";

/** A single agent session, as discovered by a parser or the watcher. */
export interface AgentSession {
  session_id: string;
  agent_type: AgentType;
  /** Filesystem path of the session (manifest, JSONL transcript, or dir). */
  path: string;
  /**
   * Workspace/project root this session ran under, when the agent records it
   * (OpenCode stores the cwd in its DB). `null` when unknown.
   */
  project: string | null;
  /** ISO-8601 timestamp (RFC 3339) as serialized by chrono. */
  created_at: string;
  status: SessionStatus;
}

/** One user→assistant cycle within a session. */
export interface AgentTurn {
  /** 0-based position of this turn within its session. */
  turn_index: number;
  timestamp: string;
  user_message: string;
  assistant_response: string | null;
  tool_calls: ToolCall[];
  file_modifications: FileModification[];
}

/** A tool invocation recorded in a turn. */
export interface ToolCall {
  name: string;
  /** Tool input as raw JSON (kept untyped; parsers may specialize). */
  input: unknown;
}

/** Kind of a file modification. */
export type FileChangeKind = "create" | "modify" | "delete" | "rename";

/** A file change recorded in a turn. */
export interface FileModification {
  path: string;
  change: FileChangeKind;
}

/** What kind of context a {@link CrossAgentContext} carries. */
export type ContextType = "task" | "decision" | "file-change" | "error" | "pattern";

/**
 * A unit of cross-agent context: a task, decision, file change, error, or
 * reusable pattern extracted from one agent session for reuse by others.
 */
export interface CrossAgentContext {
  id: string;
  session_id: string;
  agent_type: AgentType;
  context_type: ContextType;
  content: string;
  /** File paths this context touches (relative to the session project). */
  file_paths: string[];
  /** Decisions recorded while this context was produced. */
  decisions: string[];
  /** Errors encountered while this context was produced. */
  errors: string[];
  /**
   * Workspace/project root the source session ran under (mirrors
   * {@link AgentSession.project}). Used by the per-workspace filters.
   */
  project: string | null;
  timestamp: string;
}

/** Kind of filesystem activity observed in a session (watcher events). */
export type SessionEventType = "created" | "modified" | "deleted" | "renamed" | "other";

/** A single observed session-activity event, pushed by the daemon. */
export interface CacmSessionActivity {
  session_id: string;
  agent_type: AgentType;
  event_type: SessionEventType;
  /** Turn number if it can be inferred from the path; `null` otherwise. */
  turn: number | null;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// RPC params/results (the daemon's WebSocket wire surface, task 1.4)
// ---------------------------------------------------------------------------

/** `cacm.query` params. `limit` is optional; the daemon defaults to 10 and clamps 1..=100. */
export interface CacmQueryParams {
  project: string;
  limit?: number;
}

/** `cacm.query` result — stored cross-agent context, newest first. */
export interface CacmQueryResult {
  entries: CrossAgentContext[];
}

/** `cacm.sessions` params. Omit `project` for all sessions. */
export interface CacmSessionsParams {
  project?: string;
}

/** `cacm.sessions` result — live agent sessions. */
export interface CacmSessionsResult {
  sessions: AgentSession[];
}

/** `cacm.inject` params. `agent` defaults to the plain-text style when omitted. */
export interface CacmInjectParams {
  sessionId: string;
  agent?: string;
}

/** `cacm.inject` result — formatted context ready to paste as a reminder. */
export interface CacmInjectResult {
  formatted: string;
}
