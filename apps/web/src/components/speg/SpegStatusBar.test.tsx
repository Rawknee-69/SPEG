import { Children, isValidElement, type ReactNode } from "react";
import type { SpegSettings } from "@t3tools/contracts/settings";
import { DEFAULT_SPEG_SETTINGS } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { SpegStatusBar, type SpegStatusBarProps } from "./SpegStatusBar";
import { STATUS_BAR_ITEM_ORDER } from "./SpegStatusBar.logic";

// Slot-based react hooks harness (repo pattern for compiled components; see
// CacmPanel.test.tsx / SpegSettings.test.tsx).
const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemo<T>(factory: () => T): T {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = factory();
      }
      return slots[index] as T;
    },
    useMemoCache(size: number): unknown[] {
      const index = cursor++;
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useMemo: hooks.useMemo,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

const testState = vi.hoisted(() => {
  const state = {
    speg: null as SpegSettings | null,
  };
  return state;
});

vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (
    selector?: ((settings: { speg: SpegSettings | null }) => unknown) | undefined,
  ) => (selector ? selector({ speg: testState.speg }) : { speg: testState.speg }),
}));

function collectItems(node: ReactNode): string[] {
  const items: string[] = [];
  const visit = (current: ReactNode) => {
    for (const child of Children.toArray(current)) {
      if (!isValidElement(child)) continue;
      if ((child.props as Record<string, unknown>)["data-speg-status-bar-item"]) {
        items.push((child.props as Record<string, unknown>)["data-speg-status-bar-item"] as string);
      }
      visit((child.props as { children?: ReactNode }).children);
    }
  };
  visit(node);
  return items;
}

const BASE_PROPS: SpegStatusBarProps = {
  activities: [
    {
      id: "evt-1",
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: {
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
      },
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "evt-2",
      tone: "info",
      kind: "turn.completed",
      summary: "Turn completed",
      payload: { state: "completed", totalCostUsd: 0.0016 },
      turnId: "turn-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "evt-3",
      tone: "info",
      kind: "account.rate-limits.updated",
      summary: "Account rate limits updated",
      payload: { rateLimits: { credits: { balance: "$4.04" } } },
      turnId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ] as unknown as SpegStatusBarProps["activities"],
  model: "deepseek-v4-flash",
  workspaceRoot: "E:\\SPEG",
  gitBranch: "main",
};

describe("SpegStatusBar", () => {
  beforeEach(() => {
    testState.speg = structuredClone(DEFAULT_SPEG_SETTINGS);
  });
  afterEach(() => {
    hooks.reset();
  });

  it("renders the enabled chips from live activities", () => {
    hooks.beginRender();
    const tree = SpegStatusBar(BASE_PROPS) as ReactNode;
    const items = collectItems(tree);
    expect(items).toContain("model");
    expect(items).toContain("workspace");
    expect(items).toContain("gitBranch");
    expect(items).toContain("turnHit");
    expect(items).toContain("sessionTokens");
    expect(items).toContain("turnCost");
    expect(items).toContain("ctx");
    expect(items).toContain("compactAt");
    expect(items).toContain("balance");
  });

  it("renders nothing when the master switch is off", () => {
    testState.speg = {
      ...testState.speg!,
      statusBar: { ...testState.speg!.statusBar, enabled: false },
    };
    hooks.beginRender();
    const tree = SpegStatusBar(BASE_PROPS) as ReactNode;
    expect(tree).toBeNull();
  });

  it("respects per-item visibility toggles", () => {
    testState.speg = {
      ...testState.speg!,
      statusBar: {
        ...testState.speg!.statusBar,
        items: { ...testState.speg!.statusBar.items, balance: false, ctx: false },
      },
    };
    hooks.beginRender();
    const tree = SpegStatusBar(BASE_PROPS) as ReactNode;
    const items = collectItems(tree);
    expect(items).not.toContain("balance");
    expect(items).not.toContain("ctx");
    expect(items).toContain("model");
  });

  it("omits chips the harness does not report", () => {
    hooks.beginRender();
    const tree = SpegStatusBar({ ...BASE_PROPS, model: null, gitBranch: null }) as ReactNode;
    const items = collectItems(tree);
    expect(items).not.toContain("model");
    expect(items).not.toContain("gitBranch");
  });

  it("renders nothing with no activities and no model", () => {
    hooks.beginRender();
    const tree = SpegStatusBar({
      activities: [],
      model: null,
      workspaceRoot: null,
      gitBranch: null,
    }) as ReactNode;
    expect(tree).toBeNull();
  });

  it("covers every status bar item id in the settings schema", () => {
    // The schema and the renderer must stay in sync: each id the settings
    // panel can toggle has a corresponding chip slot.
    expect(STATUS_BAR_ITEM_ORDER).toHaveLength(13);
    expect(testState.speg!.statusBar.items).toMatchObject(
      Object.fromEntries(STATUS_BAR_ITEM_ORDER.map((id) => [id, true])),
    );
  });
});
