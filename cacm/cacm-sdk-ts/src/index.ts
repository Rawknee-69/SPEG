/**
 * @cacm/sdk — TypeScript client for the CACM daemon.
 *
 * ```ts
 * import { CacmClient } from "@cacm/sdk";
 *
 * const client = new CacmClient(); // ws://localhost:9786 → /ws
 * await client.connect();
 *
 * const { entries } = await client.query({ project: "/repo", limit: 10 });
 * const { sessions } = await client.sessions({ project: "/repo" });
 * const { formatted } = await client.inject({ sessionId: "ses_abc", agent: "jcode" });
 *
 * const unsubscribe = client.onActivity((activity) => {
 *   console.log(activity.session_id, activity.event_type);
 * });
 *
 * client.close();
 * ```
 */

export { CacmClient, CacmError, normalizeDaemonUrl, DEFAULT_DAEMON_URL } from "./client.js";
export type { CacmErrorKind, ClientOptions, WebSocketLike, WebSocketLikeEvent } from "./client.js";
export type {
  AgentSession,
  AgentTurn,
  AgentType,
  CacmInjectParams,
  CacmInjectResult,
  CacmQueryParams,
  CacmQueryResult,
  CacmSessionParams,
  CacmSessionResult,
  ContextType,
  CrossAgentContext,
  FileChangeKind,
  FileModification,
  SessionActivity,
  SessionEventType,
  SessionStatus,
  ToolCall,
} from "./types.js";
