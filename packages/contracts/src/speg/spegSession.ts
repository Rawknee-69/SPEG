import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";
import { SpegSessionId } from "./spegBaseSchemas.ts";

export const SessionStatus = Schema.Literals(["active", "idle", "completed", "failed"]);
export type SessionStatus = typeof SessionStatus.Type;

export const AgentType = Schema.Literals([
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "grok",
  "speg",
]);
export type AgentType = typeof AgentType.Type;

export const AgentSessionDescriptor = Schema.Struct({
  sessionId: SpegSessionId,
  agentType: AgentType,
  status: SessionStatus,
  path: TrimmedNonEmptyString,
  metadata: Schema.Record(Schema.String, Schema.String),
});
export type AgentSessionDescriptor = typeof AgentSessionDescriptor.Type;
