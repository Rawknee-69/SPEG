import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { SpegSessionId } from "./spegBaseSchemas.ts";
import { AgentSessionDescriptor, AgentType } from "./spegSession.ts";
import { ContextQuery } from "./spegContext.ts";
import { MemorySearchResult } from "./spegMemory.ts";
import { SpegChatMessage, SpegTurnRequest, SpegTurnResponse } from "./spegChat.ts";

export const SPEG_METHODS = {
  spegChatSendMessage: "speg.chat.sendMessage",
  spegChatSubscribe: "speg.chat.subscribe",
  spegCacmQueryContext: "speg.cacm.queryContext",
  spegCacmListSessions: "speg.cacm.listSessions",
  spegCacmInjectContext: "speg.cacm.injectContext",
} as const;

export class SpegRpcError extends Schema.TaggedErrorClass<SpegRpcError>()("SpegRpcError", {
  message: Schema.String,
}) {}

export const SpegChatSendMessageRpc = Rpc.make(SPEG_METHODS.spegChatSendMessage, {
  payload: SpegTurnRequest,
  success: SpegTurnResponse,
  error: SpegRpcError,
});

export const SpegChatSubscribeRpc = Rpc.make(SPEG_METHODS.spegChatSubscribe, {
  payload: Schema.Struct({}),
  success: SpegChatMessage,
  error: SpegRpcError,
  stream: true,
});

export const SpegCacmQueryContextRpc = Rpc.make(SPEG_METHODS.spegCacmQueryContext, {
  payload: ContextQuery,
  success: MemorySearchResult,
  error: SpegRpcError,
});

export const SpegCacmListSessionsRpc = Rpc.make(SPEG_METHODS.spegCacmListSessions, {
  payload: Schema.Struct({}),
  success: Schema.Array(AgentSessionDescriptor),
  error: SpegRpcError,
});

export const SpegCacmInjectContextRpc = Rpc.make(SPEG_METHODS.spegCacmInjectContext, {
  payload: Schema.Struct({
    sessionId: SpegSessionId,
    targetAgent: AgentType,
  }),
  error: SpegRpcError,
});

/**
 * Standalone RPC group for the SPEG wire surface (chat + CACM). Kept separate
 * from `WsRpcGroup` (packages/contracts/src/rpc.ts) so the existing SPEG
 * contract surface stays untouched; consumers can merge it into their own
 * transport groups or register it as its own group.
 */
export const SpegRpcGroup = RpcGroup.make(
  SpegChatSendMessageRpc,
  SpegChatSubscribeRpc,
  SpegCacmQueryContextRpc,
  SpegCacmListSessionsRpc,
  SpegCacmInjectContextRpc,
);
