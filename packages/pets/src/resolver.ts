import type { OrchestrationThreadShell } from "@speg/contracts";
import {
  AGENT_STATE_TO_ATTENTION,
  type PetAgentState,
  type PetAttentionTier,
  type PetWaitingKind,
} from "./state.ts";

/**
 * Normalized pet context for one thread (spec §60). The pet consumes only this
 * shape; it never inspects provider internals directly.
 */
export interface PetContext {
  readonly threadId: string;
  readonly title: string;
  readonly agentState: PetAgentState;
  readonly waitingKind: PetWaitingKind | null;
  readonly progress: {
    readonly step: string;
    readonly completedSteps: number;
    readonly totalSteps: number;
  } | null;
  /** Epoch ms of the last thread update, used for recency tie-breaks. */
  readonly updatedAt: number;
  readonly attentionTier: PetAttentionTier;
  readonly requiresAttention: boolean;
}

/**
 * A completed turn stays "ready for review" for this long after the thread last
 * changed; older completed work decays to idle so stale threads never keep the
 * pet in the review state (spec §62 "idle → no bubble").
 */
export const REVIEW_ATTENTION_WINDOW_MS = 30 * 60 * 1000;

export function isThreadEligibleForFollow(thread: OrchestrationThreadShell, now: number): boolean {
  if (thread.archivedAt !== null) {
    return false;
  }
  if (thread.snoozedUntil !== null && thread.snoozedUntil !== undefined) {
    const snoozedUntilMs = toIsoTime(thread.snoozedUntil);
    if (snoozedUntilMs > now) {
      return false;
    }
  }
  return true;
}

function toIsoTime(value: string | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * Resolve the pet state for a single thread from the provider-agnostic read
 * model (spec §61). Order matters: blocking states beat running states so a
 * low-priority running task never hides a high-priority waiting task (§9).
 */
export function resolvePetContext(thread: OrchestrationThreadShell, now: number): PetContext {
  const base: PetContext = {
    threadId: thread.id,
    title: thread.title,
    agentState: "idle",
    waitingKind: null,
    progress: null,
    updatedAt: toIsoTime(thread.updatedAt),
    attentionTier: "none",
    requiresAttention: false,
  };

  const sessionStatus = thread.session?.status ?? null;

  if (sessionStatus === "error" || thread.latestTurn?.state === "error") {
    return finalize(base, "failed");
  }

  // Blocking waits first: approval > user input > actionable proposed plan.
  if (thread.hasPendingApprovals) {
    return finalize(base, "waiting", "approval");
  }
  if (thread.hasPendingUserInput) {
    return finalize(base, "waiting", "input");
  }
  if (thread.hasActionableProposedPlan) {
    return finalize(base, "waiting", "plan");
  }

  // Native background work keeps the pet working even after the turn settles.
  if (thread.backgroundLiveness === "working" || thread.backgroundLiveness === "monitoring") {
    return finalize(base, "running", null, thread.planProgress ?? null);
  }

  const turnState = thread.latestTurn?.state ?? null;
  if (turnState === "running") {
    return finalize(base, "running", null, thread.planProgress ?? null);
  }
  if (turnState === "completed") {
    const recentlyCompleted = now - base.updatedAt <= REVIEW_ATTENTION_WINDOW_MS;
    return finalize(base, recentlyCompleted ? "review" : "idle");
  }
  if (turnState === "interrupted") {
    return finalize(base, "idle");
  }

  if (sessionStatus === "starting") {
    return finalize(base, "queued");
  }

  return finalize(base, "idle");
}

function finalize(
  base: PetContext,
  agentState: PetAgentState,
  waitingKind: PetWaitingKind | null = null,
  progress: PetContext["progress"] = null,
): PetContext {
  const attentionTier = AGENT_STATE_TO_ATTENTION[agentState];
  return {
    ...base,
    agentState,
    waitingKind,
    progress,
    attentionTier,
    requiresAttention: attentionTier === "blocking",
  };
}
