import { describe, expect, it } from "vite-plus/test";

import { resolveStatusBubble, summarizeWorkspaceBubble } from "./bubble.ts";
import type { PetContext } from "./resolver.ts";

function context(partial: Partial<PetContext>): PetContext {
  return {
    threadId: "t1",
    title: "Thread",
    agentState: "idle",
    waitingKind: null,
    progress: null,
    updatedAt: 0,
    attentionTier: "none",
    requiresAttention: false,
    ...partial,
  };
}

describe("resolveStatusBubble", () => {
  it("returns null for idle and queued", () => {
    expect(resolveStatusBubble(context({ agentState: "idle" }))).toBeNull();
    expect(resolveStatusBubble(context({ agentState: "queued" }))).toBeNull();
  });

  it("returns short human messages per state", () => {
    expect(resolveStatusBubble(context({ agentState: "running" }))).toBe("Working…");
    expect(resolveStatusBubble(context({ agentState: "review" }))).toBe("Ready for review");
    expect(resolveStatusBubble(context({ agentState: "failed" }))).toBe("Task failed");
    expect(resolveStatusBubble(context({ agentState: "waiting", waitingKind: "approval" }))).toBe(
      "Needs approval",
    );
    expect(resolveStatusBubble(context({ agentState: "waiting", waitingKind: "plan" }))).toBe(
      "Needs approval",
    );
    expect(resolveStatusBubble(context({ agentState: "waiting", waitingKind: "input" }))).toBe(
      "Needs your input",
    );
    expect(resolveStatusBubble(context({ agentState: "waiting", waitingKind: "auth" }))).toBe(
      "Needs sign-in",
    );
  });

  it("never leaks enum names into the bubble", () => {
    for (const agentState of ["idle", "running", "waiting", "review", "failed"] as const) {
      const text = resolveStatusBubble(context({ agentState }));
      if (text !== null) {
        expect(text).not.toContain("_");
        expect(text).not.toContain("WAITING");
      }
    }
  });

  it("is null without a context outside workspace mode", () => {
    expect(resolveStatusBubble(null)).toBeNull();
  });

  it("summarizes the workspace in workspace mode", () => {
    const workspace = {
      total: 3,
      counts: { idle: 0, queued: 0, running: 2, waiting: 1, review: 0, failed: 0 } as const,
      attentionCount: 1,
      reviewCount: 0,
      runningCount: 2,
    };
    expect(resolveStatusBubble(null, { mode: "workspace", workspace })).toBe("1 agent needs you");
  });

  it("returns null when there is nothing to summarize", () => {
    const workspace = {
      total: 0,
      counts: { idle: 0, queued: 0, running: 0, waiting: 0, review: 0, failed: 0 } as const,
      attentionCount: 0,
      reviewCount: 0,
      runningCount: 0,
    };
    expect(resolveStatusBubble(null, { mode: "workspace", workspace })).toBeNull();
  });
});

describe("summarizeWorkspaceBubble", () => {
  it("reports attention first, then review, then running", () => {
    const base = {
      total: 2,
      counts: { idle: 0, queued: 0, running: 0, waiting: 0, review: 0, failed: 0 } as const,
      attentionCount: 0,
      reviewCount: 0,
      runningCount: 0,
    };
    expect(summarizeWorkspaceBubble({ ...base, attentionCount: 2, runningCount: 3 })).toBe(
      "2 agents need you",
    );
    expect(summarizeWorkspaceBubble({ ...base, attentionCount: 1, total: 1 })).toBe(
      "1 agent needs you",
    );
    expect(summarizeWorkspaceBubble({ ...base, reviewCount: 2, total: 2 })).toBe(
      "2 agents ready for review",
    );
    expect(summarizeWorkspaceBubble({ ...base, runningCount: 3, total: 3 })).toBe(
      "3 agents running",
    );
  });
});
