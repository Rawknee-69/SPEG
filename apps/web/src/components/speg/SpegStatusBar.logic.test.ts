import type { OrchestrationThreadActivity } from "@speg/contracts";
import { EventId, TurnId } from "@speg/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveAvgHit,
  deriveBalance,
  deriveCtx,
  deriveStatusBarChips,
  deriveTokenUsage,
  deriveTurnCosts,
  deriveTurnHit,
  deriveTurnTokens,
  formatPercent,
  formatTokenCount,
  formatUsd,
  workspaceLabel,
  type StatusBarInput,
} from "./SpegStatusBar.logic";

let nextActivityId = 0;

function activity(
  kind: string,
  payload: unknown,
  extra?: { turnId?: string },
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`evt-${kind}-${nextActivityId++}`),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: extra?.turnId ? TurnId.make(extra.turnId) : null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const USAGE_ACTIVITY = activity("context-window.updated", {
  usedTokens: 23_040,
  totalProcessedTokens: 3_124_786,
  maxTokens: 128_000,
  inputTokens: 1_000_000,
  cachedInputTokens: 2_124_786,
  outputTokens: 10_000,
  reasoningOutputTokens: 2_000,
  lastUsedTokens: 23_040,
  lastInputTokens: 2_500,
  lastCachedInputTokens: 181_000,
  lastOutputTokens: 437,
  lastReasoningOutputTokens: 1_500,
  compactsAutomatically: true,
});

describe("deriveTokenUsage", () => {
  it("reads the latest context-window.updated payload", () => {
    const usage = deriveTokenUsage([
      activity("context-window.updated", {
        usedTokens: 10,
        totalProcessedTokens: 99,
        maxTokens: 1000,
        lastUsedTokens: 10,
        compactsAutomatically: false,
      }),
      USAGE_ACTIVITY,
    ]);
    expect(usage?.usedTokens).toBe(23_040);
    expect(usage?.totalProcessedTokens).toBe(3_124_786);
    expect(usage?.maxTokens).toBe(128_000);
    expect(usage?.lastInputTokens).toBe(2_500);
    expect(usage?.lastCachedInputTokens).toBe(181_000);
    expect(usage?.compactsAutomatically).toBe(true);
  });

  it("returns null when no context-window.updated activity exists", () => {
    expect(deriveTokenUsage([])).toBeNull();
    expect(deriveTokenUsage([activity("turn.started", {})])).toBeNull();
  });
});

describe("cache hit rates", () => {
  it("computes turn hit from last cached vs total input", () => {
    const usage = deriveTokenUsage([USAGE_ACTIVITY]);
    // 181000 / (2500 + 181000)
    expect(deriveTurnHit(usage)).toBeCloseTo(181000 / 183_500, 6);
  });

  it("computes session avg hit from cumulative cached vs input", () => {
    const usage = deriveTokenUsage([USAGE_ACTIVITY]);
    // 2124786 / (1000000 + 2124786)
    expect(deriveAvgHit(usage)).toBeCloseTo(2_124_786 / 3_124_786, 6);
  });

  it("returns null when cache fields are missing", () => {
    const usage = deriveTokenUsage([
      activity("context-window.updated", { usedTokens: 5, lastUsedTokens: 5 }),
    ]);
    expect(deriveTurnHit(usage)).toBeNull();
    expect(deriveAvgHit(usage)).toBeNull();
  });
});

describe("deriveTurnTokens / deriveCtx", () => {
  it("sums last input + output + reasoning", () => {
    const usage = deriveTokenUsage([USAGE_ACTIVITY]);
    expect(deriveTurnTokens(usage)).toBe(2500 + 437 + 1500);
  });

  it("computes context share from used/max", () => {
    const usage = deriveTokenUsage([USAGE_ACTIVITY]);
    expect(deriveCtx(usage)).toBeCloseTo(23_040 / 128_000, 6);
  });
});

describe("deriveTurnCosts", () => {
  it("uses the latest turn cost and sums session cost", () => {
    const costs = deriveTurnCosts([
      activity("turn.completed", { state: "completed", totalCostUsd: 0.0016 }, { turnId: "t1" }),
      activity("turn.completed", { state: "completed", totalCostUsd: 0.0356 }, { turnId: "t2" }),
    ]);
    expect(costs.turnCostUsd).toBe(0.0356);
    expect(costs.sessionCostUsd).toBeCloseTo(0.0372, 6);
    expect(costs.turnCount).toBe(2);
  });

  it("ignores missing/negative costs", () => {
    const costs = deriveTurnCosts([
      activity("turn.completed", { state: "completed" }, { turnId: "t1" }),
      activity("turn.completed", { state: "failed" }, { turnId: "t2" }),
    ]);
    expect(costs.turnCostUsd).toBeNull();
    expect(costs.sessionCostUsd).toBeNull();
    expect(costs.turnCount).toBe(2);
  });

  it("counts distinct turns across started/completed", () => {
    const costs = deriveTurnCosts([
      activity("turn.started", { model: "deepseek-v4-flash" }, { turnId: "t1" }),
      activity("turn.completed", { state: "completed" }, { turnId: "t1" }),
      activity("turn.started", { model: "deepseek-v4-flash" }, { turnId: "t2" }),
    ]);
    expect(costs.turnCount).toBe(2);
  });
});

describe("deriveBalance", () => {
  it("reads credits.balance from account.rate-limits.updated (Codex shape)", () => {
    const balance = deriveBalance([
      activity("account.rate-limits.updated", {
        rateLimits: { credits: { balance: "$4.04", hasCredits: true, unlimited: false } },
      }),
    ]);
    expect(balance).toBe("$4.04");
  });

  it("reads balance from account.updated", () => {
    const balance = deriveBalance([activity("account.updated", { account: { balance: "$9.99" } })]);
    expect(balance).toBe("$9.99");
  });

  it("returns null when no balance data exists", () => {
    expect(deriveBalance([])).toBeNull();
    expect(
      deriveBalance([activity("account.rate-limits.updated", { rateLimits: { limitId: "x" } })]),
    ).toBeNull();
  });
});

describe("formatters", () => {
  it("formats percents with up to 2 decimals", () => {
    expect(formatPercent(0.9866)).toBe("98.66%");
    expect(formatPercent(0.18)).toBe("18%");
    expect(formatPercent(0.8)).toBe("80%");
    expect(formatPercent(null)).toBeNull();
  });

  it("formats token counts with grouping", () => {
    expect(formatTokenCount(3_124_786)).toBe("3,124,786");
    expect(formatTokenCount(null)).toBeNull();
  });

  it("formats usd with 2-4 decimals", () => {
    expect(formatUsd(0.0016)).toBe("$0.0016");
    expect(formatUsd(0.0372)).toBe("$0.0372");
    expect(formatUsd(4.04)).toBe("$4.04");
    expect(formatUsd(null)).toBeNull();
  });

  it("derives workspace basename + detail path", () => {
    expect(workspaceLabel("E:\\SPEG\\")).toEqual({ value: "SPEG", detail: "E:\\SPEG\\" });
    expect(workspaceLabel("/home/user/proj")).toEqual({ value: "proj", detail: "/home/user/proj" });
    expect(workspaceLabel(null)).toEqual({ value: null });
  });
});

describe("deriveStatusBarChips", () => {
  const base: StatusBarInput = {
    activities: [],
    model: "deepseek-v4-flash",
    workspaceRoot: "E:\\SPEG",
    gitBranch: "main",
    compactAtPercent: 80,
  };

  it("renders model, workspace, git branch, and null-aware chips", () => {
    const chips = deriveStatusBarChips(base);
    const byId = Object.fromEntries(chips.map((chip) => [chip.id, chip]));
    expect(byId.model?.value).toBe("deepseek-v4-flash");
    expect(byId.workspace?.value).toBe("SPEG");
    expect(byId.workspace?.detail).toBe("E:\\SPEG");
    expect(byId.gitBranch?.value).toBe("main");
    // No token usage yet → these chips are null and filtered out at render.
    expect(byId.turnHit?.value).toBeNull();
    expect(byId.ctx?.value).toBeNull();
    expect(byId.compactAt?.value).toBeNull();
  });

  it("renders live usage data from activities", () => {
    const chips = deriveStatusBarChips({
      ...base,
      activities: [
        USAGE_ACTIVITY,
        activity("turn.completed", { state: "completed", totalCostUsd: 0.0016 }, { turnId: "t1" }),
        activity("account.rate-limits.updated", {
          rateLimits: { credits: { balance: "$4.04" } },
        }),
      ],
    });
    const byId = Object.fromEntries(chips.map((chip) => [chip.id, chip]));
    expect(byId.turnHit?.value).toBe("98.64%");
    expect(byId.avgHit?.value).toBe("68%");
    expect(byId.sessionTokens?.value).toBe("3,124,786");
    expect(byId.turnTokens?.value).toBe("4,437");
    expect(byId.turnCost?.value).toBe("$0.0016");
    expect(byId.sessionCost?.value).toBe("$0.0016");
    expect(byId.sessions?.value).toBe("1");
    expect(byId.ctx?.value).toBe("18%");
    expect(byId.compactAt?.value).toBe("80%");
    expect(byId.balance?.value).toBe("$4.04");
  });

  it("respects the harness not reporting a datum", () => {
    const chips = deriveStatusBarChips({ ...base, model: null, gitBranch: null });
    const ids = chips.map((chip) => chip.id);
    expect(ids).not.toContain("model");
    expect(ids).not.toContain("gitBranch");
  });
});
