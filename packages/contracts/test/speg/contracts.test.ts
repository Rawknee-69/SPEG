import * as Schema from "effect/Schema";
import * as RpcSchema from "effect/unstable/rpc/RpcSchema";
import { describe, expect, it } from "vite-plus/test";

import {
  AgentSessionDescriptor,
  AgentType,
  ContextQuery,
  ContextType,
  CrossAgentContext,
  MemoryEntrySummary,
  MemoryQueryParams,
  MemorySearchResult,
  SessionStatus,
  SpegCacmInjectContextRpc,
  SpegCacmListSessionsRpc,
  SpegCacmQueryContextRpc,
  SpegChatMessage,
  SpegChatRole,
  SpegChatSendMessageRpc,
  SpegChatSubscribeRpc,
  SpegContextId,
  SpegMemoryId,
  SpegRpcError,
  SpegRpcGroup,
  SpegSessionId,
  SpegToolCall,
  SpegTurnRequest,
  SpegTurnResponse,
  SpegTurnUsage,
  SPEG_METHODS,
} from "../../src/speg/index.ts";

const roundtrip = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
): S["Type"] => {
  // Wire values arrive untyped/branded-as-strings, so decode the literal
  // first, then verify encode → decode returns the identical value.
  const decoded = Schema.decodeUnknownSync(schema)(value);
  const encoded = Schema.encodeSync(schema)(decoded);
  const roundtripped = Schema.decodeUnknownSync(schema)(encoded);
  expect(roundtripped).toEqual(decoded);
  return decoded;
};

const rejects = <S extends Schema.ConstraintCodec<unknown, unknown, never, never>>(
  schema: S,
  value: unknown,
): void => {
  expect(() => Schema.decodeUnknownSync(schema)(value)).toThrow();
};

describe("spegBaseSchemas — branded IDs", () => {
  it.each([
    ["SpegSessionId", SpegSessionId, "session-abc"],
    ["SpegMemoryId", SpegMemoryId, "memory-abc"],
    ["SpegContextId", SpegContextId, "context-abc"],
  ])("%s roundtrips encode → decode", (_name, schema, value) => {
    roundtrip(schema, value);
  });

  it.each([
    ["SpegSessionId", SpegSessionId],
    ["SpegMemoryId", SpegMemoryId],
    ["SpegContextId", SpegContextId],
  ])("%s rejects empty, whitespace-only and non-string inputs", (_name, schema) => {
    rejects(schema, "");
    rejects(schema, "   ");
    rejects(schema, 123);
    rejects(schema, undefined);
  });
});

describe("SessionStatus", () => {
  it.each(["active", "idle", "completed", "failed"])("roundtrips %s", (status) => {
    roundtrip(SessionStatus, status);
  });

  it("rejects unknown statuses", () => {
    rejects(SessionStatus, "paused");
  });
});

describe("AgentType", () => {
  it.each(["claude-code", "codex", "opencode", "cursor", "speg"])("roundtrips %s", (agent) => {
    roundtrip(AgentType, agent);
  });

  it("rejects unknown agent types", () => {
    rejects(AgentType, "gemini");
  });
});

describe("AgentSessionDescriptor", () => {
  const valid = {
    sessionId: "session-1",
    agentType: "codex",
    status: "active",
    path: "/workspace/project",
    metadata: { project: "sparrow", branch: "main" },
  } as const;

  it("roundtrips a full descriptor", () => {
    const decoded = roundtrip(AgentSessionDescriptor, valid);
    expect(decoded.agentType).toBe("codex");
    expect(decoded.metadata).toEqual(valid.metadata);
  });

  it("accepts an empty metadata record", () => {
    const decoded = roundtrip(AgentSessionDescriptor, { ...valid, metadata: {} });
    expect(decoded.metadata).toEqual({});
  });

  it("rejects invalid agent types, statuses and missing fields", () => {
    rejects(AgentSessionDescriptor, { ...valid, agentType: "gemini" });
    rejects(AgentSessionDescriptor, { ...valid, status: "paused" });
    rejects(AgentSessionDescriptor, { ...valid, status: undefined });
    rejects(AgentSessionDescriptor, { ...valid, path: "   " });
    rejects(AgentSessionDescriptor, { ...valid, sessionId: "" });
    rejects(AgentSessionDescriptor, { agentType: "codex" });
  });
});

describe("ContextType", () => {
  it.each(["task", "decision", "file-change", "error", "pattern"])("roundtrips %s", (type) => {
    roundtrip(ContextType, type);
  });

  it("rejects unknown context types", () => {
    rejects(ContextType, "question");
  });
});

describe("CrossAgentContext", () => {
  const valid = {
    id: "context-1",
    sessionId: "session-1",
    agentType: "claude-code",
    contentType: "file-change",
    content: "Refactored auth to JWT",
    filePaths: ["src/auth.ts", "src/auth.test.ts"],
    decisions: ["adopt JWT over sessions"],
    errors: [],
    timestamp: "2026-08-04T12:00:00Z",
  } as const;

  it("roundtrips a full context entry", () => {
    const decoded = roundtrip(CrossAgentContext, valid);
    expect(decoded.contentType).toBe("file-change");
    expect(decoded.filePaths).toEqual(valid.filePaths);
  });

  it("roundtrips entries with empty collection fields", () => {
    const decoded = roundtrip(CrossAgentContext, {
      ...valid,
      filePaths: [],
      decisions: [],
      errors: [],
    });
    expect(decoded.errors).toEqual([]);
  });

  it("rejects invalid content types, missing fields and non-array collections", () => {
    rejects(CrossAgentContext, { ...valid, contentType: "question" });
    rejects(CrossAgentContext, { ...valid, content: undefined });
    rejects(CrossAgentContext, { ...valid, sessionId: "" });
    rejects(CrossAgentContext, { ...valid, filePaths: "src/auth.ts" });
    rejects(CrossAgentContext, { ...valid, timestamp: undefined });
  });
});

describe("ContextQuery", () => {
  it("roundtrips a fully-specified query", () => {
    const decoded = roundtrip(ContextQuery, {
      projectPath: "/workspace/project",
      limit: 25,
      recencyHours: 24,
      agentTypes: ["codex", "claude-code"],
    });
    expect(decoded.limit).toBe(25);
    expect(decoded.agentTypes).toEqual(["codex", "claude-code"]);
  });

  it("roundtrips a minimal query with only projectPath", () => {
    const decoded = roundtrip(ContextQuery, { projectPath: "/workspace/project" });
    expect(decoded.limit).toBeUndefined();
    expect(decoded.agentTypes).toBeUndefined();
  });

  it("rejects empty project paths and non-positive limits", () => {
    rejects(ContextQuery, { projectPath: "   " });
    rejects(ContextQuery, {});
    rejects(ContextQuery, { projectPath: "/workspace/project", limit: 0 });
    rejects(ContextQuery, { projectPath: "/workspace/project", limit: -3 });
    rejects(ContextQuery, { projectPath: "/workspace/project", recencyHours: 0 });
    rejects(ContextQuery, { projectPath: "/workspace/project", agentTypes: ["gemini"] });
  });
});

describe("MemoryQueryParams", () => {
  it("roundtrips a fully-specified query", () => {
    const decoded = roundtrip(MemoryQueryParams, {
      query: "jwt auth refactor",
      limit: 10,
      threshold: 0.7,
      tags: ["auth", "refactor"],
      scope: "project",
    });
    expect(decoded.threshold).toBe(0.7);
  });

  it("roundtrips a minimal query with only query", () => {
    const decoded = roundtrip(MemoryQueryParams, { query: "" });
    expect(decoded.limit).toBeUndefined();
    expect(decoded.tags).toBeUndefined();
  });

  it("rejects non-positive limits", () => {
    rejects(MemoryQueryParams, { query: "x", limit: 0 });
    rejects(MemoryQueryParams, { query: "x", limit: -1 });
  });
});

describe("MemoryEntrySummary", () => {
  const valid = {
    id: "memory-1",
    content: "Refactored auth module to use JWT",
    memoryType: "procedure",
    confidence: 0.85,
    tags: ["auth", "refactor", "jwt"],
    source: "claude-code",
  } as const;

  it("roundtrips a full entry", () => {
    const decoded = roundtrip(MemoryEntrySummary, valid);
    expect(decoded.confidence).toBe(0.85);
  });

  it("rejects missing fields and invalid ids", () => {
    rejects(MemoryEntrySummary, { ...valid, id: "" });
    rejects(MemoryEntrySummary, { ...valid, content: undefined });
    rejects(MemoryEntrySummary, { ...valid, confidence: "high" });
    rejects(MemoryEntrySummary, { ...valid, tags: "auth" });
  });
});

describe("MemorySearchResult", () => {
  const valid = {
    entries: [
      {
        id: "memory-1",
        content: "Refactored auth module to use JWT",
        memoryType: "procedure",
        confidence: 0.85,
        tags: ["auth"],
        source: "claude-code",
      },
    ],
    totalCount: 1,
    searchTimeMs: 12,
  } as const;

  it("roundtrips a full result", () => {
    const decoded = roundtrip(MemorySearchResult, valid);
    expect(decoded.totalCount).toBe(1);
    expect(decoded.searchTimeMs).toBe(12);
  });

  it("roundtrips empty result sets", () => {
    const decoded = roundtrip(MemorySearchResult, { entries: [], totalCount: 0, searchTimeMs: 0 });
    expect(decoded.entries).toEqual([]);
  });

  it("rejects negative counts and invalid entries", () => {
    rejects(MemorySearchResult, { ...valid, totalCount: -1 });
    rejects(MemorySearchResult, { ...valid, searchTimeMs: -1 });
    rejects(MemorySearchResult, {
      entries: [{ ...valid.entries[0], id: "" }],
      totalCount: 1,
      searchTimeMs: 1,
    });
  });
});

describe("SpegChatRole", () => {
  it.each(["user", "assistant", "system", "tool"])("roundtrips %s", (role) => {
    roundtrip(SpegChatRole, role);
  });

  it("rejects unknown roles", () => {
    rejects(SpegChatRole, "admin");
  });
});

describe("SpegChatMessage", () => {
  const valid = {
    role: "assistant",
    content: "I refactored auth to use JWT.",
    timestamp: "2026-08-04T12:00:00Z",
    metadata: { model: "codex-1" },
  } as const;

  it("roundtrips a full message", () => {
    const decoded = roundtrip(SpegChatMessage, valid);
    expect(decoded.role).toBe("assistant");
    expect(decoded.metadata).toEqual(valid.metadata);
  });

  it("rejects invalid roles and missing fields", () => {
    rejects(SpegChatMessage, { ...valid, role: "admin" });
    rejects(SpegChatMessage, { ...valid, content: undefined });
    rejects(SpegChatMessage, { ...valid, timestamp: undefined });
  });
});

describe("SpegTurnRequest", () => {
  it("roundtrips a fully-specified request", () => {
    const decoded = roundtrip(SpegTurnRequest, {
      sessionId: "session-1",
      message: "Summarize the auth refactor",
      modelSelection: "codex-1",
      skills: ["context-query", "memory-search"],
    });
    expect(decoded.modelSelection).toBe("codex-1");
    expect(decoded.skills).toEqual(["context-query", "memory-search"]);
  });

  it("roundtrips a minimal request", () => {
    const decoded = roundtrip(SpegTurnRequest, { sessionId: "session-1", message: "Hi" });
    expect(decoded.modelSelection).toBeUndefined();
    expect(decoded.skills).toBeUndefined();
  });

  it("rejects missing session ids", () => {
    rejects(SpegTurnRequest, { message: "Hi" });
    rejects(SpegTurnRequest, { sessionId: "", message: "Hi" });
  });
});

describe("SpegToolCall", () => {
  const valid = { id: "tool-1", name: "search_context", arguments: '{"query":"jwt"}' } as const;

  it("roundtrips a tool call", () => {
    const decoded = roundtrip(SpegToolCall, valid);
    expect(decoded.name).toBe("search_context");
  });

  it("rejects missing fields", () => {
    rejects(SpegToolCall, { ...valid, name: undefined });
    rejects(SpegToolCall, { id: "tool-1" });
  });
});

describe("SpegTurnUsage", () => {
  const valid = { inputTokens: 100, outputTokens: 50, totalTokens: 150 } as const;

  it("roundtrips usage counters", () => {
    const decoded = roundtrip(SpegTurnUsage, valid);
    expect(decoded.totalTokens).toBe(150);
  });

  it("rejects negative counters", () => {
    rejects(SpegTurnUsage, { ...valid, inputTokens: -1 });
    rejects(SpegTurnUsage, { ...valid, totalTokens: 149.5 });
  });
});

describe("SpegTurnResponse", () => {
  const valid = {
    turnId: "turn-1",
    messages: [
      { role: "assistant", content: "Done.", timestamp: "2026-08-04T12:00:00Z", metadata: {} },
    ],
    toolCalls: [{ id: "tool-1", name: "search_context", arguments: "{}" }],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  } as const;

  it("roundtrips a full response", () => {
    const decoded = roundtrip(SpegTurnResponse, valid);
    expect(decoded.turnId).toBe("turn-1");
    expect(decoded.messages[0]?.content).toBe("Done.");
    expect(decoded.usage).toEqual(valid.usage);
  });

  it("roundtrips empty messages and tool calls", () => {
    const decoded = roundtrip(SpegTurnResponse, {
      ...valid,
      messages: [],
      toolCalls: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
    expect(decoded.messages).toEqual([]);
    expect(decoded.toolCalls).toEqual([]);
  });

  it("rejects missing fields and invalid messages", () => {
    rejects(SpegTurnResponse, { ...valid, turnId: undefined });
    rejects(SpegTurnResponse, { ...valid, messages: "not-an-array" });
    rejects(SpegTurnResponse, { ...valid, messages: [{ ...valid.messages[0], role: "admin" }] });
    rejects(SpegTurnResponse, {
      ...valid,
      usage: { inputTokens: -1, outputTokens: 0, totalTokens: 0 },
    });
  });
});

describe("SpegRpcError", () => {
  it("roundtrips a tagged error", () => {
    const decoded = roundtrip(SpegRpcError, {
      _tag: "SpegRpcError",
      message: "context query failed",
    });
    expect(decoded._tag).toBe("SpegRpcError");
  });

  it("rejects errors without a message", () => {
    rejects(SpegRpcError, { _tag: "SpegRpcError" });
    rejects(SpegRpcError, { message: "boom" });
  });
});

describe("SPEG RPC surface", () => {
  it("exposes the expected method names", () => {
    expect(SPEG_METHODS).toEqual({
      spegChatSendMessage: "speg.chat.sendMessage",
      spegChatSubscribe: "speg.chat.subscribe",
      spegCacmQueryContext: "speg.cacm.queryContext",
      spegCacmListSessions: "speg.cacm.listSessions",
      spegCacmInjectContext: "speg.cacm.injectContext",
    });
  });

  it("registers all five rpcs with the expected tags", () => {
    expect(SpegChatSendMessageRpc._tag).toBe("speg.chat.sendMessage");
    expect(SpegChatSubscribeRpc._tag).toBe("speg.chat.subscribe");
    expect(SpegCacmQueryContextRpc._tag).toBe("speg.cacm.queryContext");
    expect(SpegCacmListSessionsRpc._tag).toBe("speg.cacm.listSessions");
    expect(SpegCacmInjectContextRpc._tag).toBe("speg.cacm.injectContext");
  });

  it("groups all five rpcs under SpegRpcGroup", () => {
    expect(SpegRpcGroup.requests.size).toBe(5);
    expect(SpegRpcGroup.requests.get("speg.chat.sendMessage")).toBeDefined();
    expect(SpegRpcGroup.requests.get("speg.cacm.injectContext")).toBeDefined();
  });

  it("declares the chat subscription as a stream", () => {
    expect(RpcSchema.isStreamSchema(SpegChatSubscribeRpc.successSchema)).toBe(true);
    expect(RpcSchema.isStreamSchema(SpegChatSendMessageRpc.successSchema)).toBe(false);
  });
});
