import { describe, expect, it } from "vite-plus/test";
import type { PetFollowMode } from "@speg/contracts";

import { resolveFollow, type PetThreadSnapshot } from "./follow.ts";
import type { PetContext } from "./resolver.ts";
import type { PetAgentState } from "./state.ts";

function context(agentState: PetAgentState, updatedAt: number, title = "Thread"): PetContext {
  return {
    threadId: title,
    title,
    agentState,
    waitingKind: agentState === "waiting" ? "approval" : null,
    progress: null,
    updatedAt,
    attentionTier:
      agentState === "waiting" || agentState === "failed"
        ? "blocking"
        : agentState === "review"
          ? "attention"
          : "none",
    requiresAttention: agentState === "waiting" || agentState === "failed",
  };
}

function snapshot(
  threadId: string,
  agentState: PetAgentState,
  updatedAt: number,
): PetThreadSnapshot {
  return { threadId, updatedAt, context: context(agentState, updatedAt, threadId) };
}

describe("resolveFollow", () => {
  it("returns an empty selection with no threads", () => {
    const selection = resolveFollow([], { mode: "highest-priority" });
    expect(selection.threadId).toBeNull();
    expect(selection.context).toBeNull();
    expect(selection.workspace.total).toBe(0);
  });

  it("picks the highest-priority thread (spec §89: running + review + waiting -> waiting)", () => {
    const selection = resolveFollow(
      [snapshot("a", "running", 100), snapshot("b", "review", 200), snapshot("c", "waiting", 300)],
      { mode: "highest-priority" },
    );
    expect(selection.threadId).toBe("c");
    expect(selection.context?.agentState).toBe("waiting");
  });

  it("falls back to review when the waiting thread goes idle (spec §89)", () => {
    const selection = resolveFollow(
      [snapshot("a", "running", 100), snapshot("b", "review", 200), snapshot("c", "idle", 300)],
      { mode: "highest-priority" },
    );
    expect(selection.threadId).toBe("b");
    expect(selection.context?.agentState).toBe("review");
  });

  it("never lets a running thread hide a failed one", () => {
    const selection = resolveFollow([snapshot("a", "running", 999), snapshot("b", "failed", 100)], {
      mode: "highest-priority",
    });
    expect(selection.threadId).toBe("b");
  });

  it("breaks priority ties by recency", () => {
    const selection = resolveFollow([snapshot("a", "review", 100), snapshot("b", "review", 500)], {
      mode: "highest-priority",
    });
    expect(selection.threadId).toBe("b");
  });

  it("follows the selected thread when present", () => {
    const selection = resolveFollow([snapshot("a", "running", 100), snapshot("b", "idle", 200)], {
      mode: "selected",
      selectedThreadId: "b",
    });
    expect(selection.threadId).toBe("b");
  });

  it("falls back to highest priority when the selected thread is unknown", () => {
    const selection = resolveFollow(
      [snapshot("a", "running", 100), snapshot("b", "waiting", 200)],
      { mode: "selected", selectedThreadId: "missing" },
    );
    expect(selection.threadId).toBe("b");
  });

  it("follows the pinned thread", () => {
    const selection = resolveFollow([snapshot("a", "waiting", 100), snapshot("b", "idle", 200)], {
      mode: "pinned",
      pinnedThreadId: "b",
    });
    expect(selection.threadId).toBe("b");
  });

  it("follows the most recently active thread", () => {
    const selection = resolveFollow([snapshot("a", "review", 100), snapshot("b", "running", 900)], {
      mode: "recent",
    });
    expect(selection.threadId).toBe("b");
  });

  it("workspace mode shows the top context and aggregate counts", () => {
    const selection = resolveFollow(
      [snapshot("a", "running", 100), snapshot("b", "running", 200), snapshot("c", "waiting", 300)],
      { mode: "workspace" },
    );
    expect(selection.threadId).toBe("c");
    expect(selection.workspace.total).toBe(3);
    expect(selection.workspace.runningCount).toBe(2);
    expect(selection.workspace.attentionCount).toBe(1);
  });
});

describe("summarizeWorkspace", () => {
  it("counts states across all snapshots", () => {
    const selection = resolveFollow(
      [
        snapshot("a", "failed", 100),
        snapshot("b", "waiting", 200),
        snapshot("c", "review", 300),
        snapshot("d", "idle", 400),
      ],
      { mode: "workspace" },
    );
    expect(selection.workspace.attentionCount).toBe(2);
    expect(selection.workspace.reviewCount).toBe(1);
    expect(selection.workspace.runningCount).toBe(0);
  });
});

// Keeps the mode union exercised so a new follow mode forces a decision here.
const ALL_MODES: readonly PetFollowMode[] = [
  "selected",
  "highest-priority",
  "recent",
  "pinned",
  "workspace",
];

describe("resolveFollow mode coverage", () => {
  it("handles every follow mode", () => {
    for (const mode of ALL_MODES) {
      const selection = resolveFollow([snapshot("a", "running", 100)], { mode });
      expect(selection.mode).toBe(mode);
      expect(selection.threadId).toBe("a");
    }
  });
});
