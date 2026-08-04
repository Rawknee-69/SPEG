import * as Schema from "effect/Schema";

import { NonNegativeInt } from "../baseSchemas.ts";
import { SpegSessionId } from "./spegBaseSchemas.ts";

export const SpegChatRole = Schema.Literals(["user", "assistant", "system", "tool"]);
export type SpegChatRole = typeof SpegChatRole.Type;

export const SpegChatMessage = Schema.Struct({
  role: SpegChatRole,
  content: Schema.String,
  // ISO-8601 timestamp of when the message was produced.
  timestamp: Schema.String,
  metadata: Schema.Record(Schema.String, Schema.String),
});
export type SpegChatMessage = typeof SpegChatMessage.Type;

export const SpegTurnRequest = Schema.Struct({
  sessionId: SpegSessionId,
  message: Schema.String,
  modelSelection: Schema.optional(Schema.String),
  skills: Schema.optional(Schema.Array(Schema.String)),
});
export type SpegTurnRequest = typeof SpegTurnRequest.Type;

export const SpegToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  // JSON-encoded tool arguments (matches the tool-call wire convention used by
  // Claude Code / Codex / OpenAI-style providers).
  arguments: Schema.String,
});
export type SpegToolCall = typeof SpegToolCall.Type;

export const SpegTurnUsage = Schema.Struct({
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
});
export type SpegTurnUsage = typeof SpegTurnUsage.Type;

export const SpegTurnResponse = Schema.Struct({
  turnId: Schema.String,
  messages: Schema.Array(SpegChatMessage),
  toolCalls: Schema.Array(SpegToolCall),
  usage: SpegTurnUsage,
});
export type SpegTurnResponse = typeof SpegTurnResponse.Type;
