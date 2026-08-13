import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { OrchestrationThreadShell } from "@speg/contracts";

import { isThreadEligibleForFollow, resolvePetContext } from "./resolver.ts";

const decodeShell = Schema.decodeUnknownSync(OrchestrationThreadShell);

const NOW = Date.parse("2026-02-01T00:00:00.000Z");
const NOW_ISO = "2026-02-01T00:00:00.000Z";

const BASE = {
  id: "thread-1",
  projectId: "project-1",
  title: "Test thread",
  modelSelection: { provider: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

function makeThread(overrides: Record<string, unknown> = {}) {
  return decodeShell({ ...BASE, ...overrides });
}

describe("resolvePetContext", () => {
  it("is idle with no turn and no session", () => {
    const context = resolvePetContext(makeThread(), NOW);
    expect(context.agentState).toBe("idle");
    expect(context.requiresAttention).toBe(false);
  });

  it("maps a running turn to running", () => {
    const context = resolvePetContext(
      makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "running",
          requestedAt: NOW_ISO,
          startedAt: NOW_ISO,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      NOW,
    );
    expect(context.agentState).toBe("running");
  });

  it("maps an error turn to failed", () => {
    const context = resolvePetContext(
      makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "error",
          requestedAt: NOW_ISO,
          startedAt: NOW_ISO,
          completedAt: NOW_ISO,
          assistantMessageId: null,
        },
      }),
      NOW,
    );
    expect(context.agentState).toBe("failed");
    expect(context.requiresAttention).toBe(true);
  });

  it("maps an errored session to failed even without a turn", () => {
    const context = resolvePetContext(
      makeThread({
        session: {
          threadId: "thread-1",
          status: "error",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "boom",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      }),
      NOW,
    );
    expect(context.agentState).toBe("failed");
  });

  it("pending approval beats a running turn (waiting)", () => {
    const context = resolvePetContext(
      makeThread({
        hasPendingApprovals: true,
        latestTurn: {
          turnId: "turn-1",
          state: "running",
          requestedAt: NOW_ISO,
          startedAt: NOW_ISO,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
      NOW,
    );
    expect(context.agentState).toBe("waiting");
    expect(context.waitingKind).toBe("approval");
  });

  it("pending user input maps to waiting/input", () => {
    const context = resolvePetContext(makeThread({ hasPendingUserInput: true }), NOW);
    expect(context.agentState).toBe("waiting");
    expect(context.waitingKind).toBe("input");
  });

  it("actionable proposed plan maps to waiting/plan", () => {
    const context = resolvePetContext(makeThread({ hasActionableProposedPlan: true }), NOW);
    expect(context.agentState).toBe("waiting");
    expect(context.waitingKind).toBe("plan");
  });

  it("background liveness keeps the pet running", () => {
    const context = resolvePetContext(makeThread({ backgroundLiveness: "working" }), NOW);
    expect(context.agentState).toBe("running");
  });

  it("recently completed turn maps to review", () => {
    const context = resolvePetContext(
      makeThread({
        updatedAt: "2026-02-01T00:10:00.000Z",
        latestTurn: {
          turnId: "turn-1",
          state: "completed",
          requestedAt: NOW_ISO,
          startedAt: NOW_ISO,
          completedAt: "2026-02-01T00:10:00.000Z",
          assistantMessageId: "msg-1",
        },
      }),
      Date.parse("2026-02-01T00:20:00.000Z"),
    );
    expect(context.agentState).toBe("review");
  });

  it("old completed work decays to idle", () => {
    const context = resolvePetContext(
      makeThread({
        updatedAt: "2026-01-01T00:00:00.000Z",
        latestTurn: {
          turnId: "turn-1",
          state: "completed",
          requestedAt: "2026-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
          assistantMessageId: "msg-1",
        },
      }),
      NOW,
    );
    expect(context.agentState).toBe("idle");
  });

  it("an interrupted turn maps to idle", () => {
    const context = resolvePetContext(
      makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "interrupted",
          requestedAt: NOW_ISO,
          startedAt: NOW_ISO,
          completedAt: NOW_ISO,
          assistantMessageId: null,
        },
      }),
      NOW,
    );
    expect(context.agentState).toBe("idle");
  });

  it("a starting session maps to queued", () => {
    const context = resolvePetContext(
      makeThread({
        session: {
          threadId: "thread-1",
          status: "starting",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      }),
      NOW,
    );
    expect(context.agentState).toBe("queued");
  });

  it("surfaces plan progress while running", () => {
    const context = resolvePetContext(
      makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "running",
          requestedAt: NOW_ISO,
          startedAt: NOW_ISO,
          completedAt: null,
          assistantMessageId: null,
        },
        planProgress: { step: "Implement auth", completedSteps: 1, totalSteps: 5 },
      }),
      NOW,
    );
    expect(context.agentState).toBe("running");
    expect(context.progress?.step).toBe("Implement auth");
  });
});

describe("isThreadEligibleForFollow", () => {
  it("excludes archived threads", () => {
    expect(isThreadEligibleForFollow(makeThread({ archivedAt: NOW_ISO }), NOW)).toBe(false);
  });

  it("excludes snoozed threads", () => {
    expect(
      isThreadEligibleForFollow(makeThread({ snoozedUntil: "2099-01-01T00:00:00.000Z" }), NOW),
    ).toBe(false);
  });

  it("includes active and past-snooze threads", () => {
    expect(isThreadEligibleForFollow(makeThread(), NOW)).toBe(true);
    expect(
      isThreadEligibleForFollow(makeThread({ snoozedUntil: "2020-01-01T00:00:00.000Z" }), NOW),
    ).toBe(true);
  });
});
