import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "../baseSchemas.ts";
import { SpegContextId, SpegSessionId } from "./spegBaseSchemas.ts";
import { AgentType } from "./spegSession.ts";

export const ContextType = Schema.Literals(["task", "decision", "file-change", "error", "pattern"]);
export type ContextType = typeof ContextType.Type;

export const CrossAgentContext = Schema.Struct({
  id: SpegContextId,
  sessionId: SpegSessionId,
  agentType: AgentType,
  contentType: ContextType,
  content: Schema.String,
  filePaths: Schema.Array(Schema.String),
  decisions: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
  // ISO-8601 timestamp of when the context entry was recorded.
  timestamp: Schema.String,
});
export type CrossAgentContext = typeof CrossAgentContext.Type;

export const ContextQuery = Schema.Struct({
  projectPath: TrimmedNonEmptyString,
  limit: Schema.optional(PositiveInt),
  recencyHours: Schema.optional(PositiveInt),
  agentTypes: Schema.optional(Schema.Array(AgentType)),
});
export type ContextQuery = typeof ContextQuery.Type;
