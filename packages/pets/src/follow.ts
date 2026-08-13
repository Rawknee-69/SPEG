import type { PetFollowMode } from "@speg/contracts";
import { PET_AGENT_STATES, type PetAgentState } from "./state.ts";
import type { PetContext } from "./resolver.ts";

/**
 * Multi-agent following (spec §8-9). Priority resolution never lets a
 * low-priority running task hide a high-priority waiting task.
 */
export const PET_STATE_PRIORITY: Readonly<Record<PetAgentState, number>> = {
  idle: 0,
  queued: 20,
  running: 40,
  review: 60,
  waiting: 90,
  failed: 100,
};

export interface PetThreadSnapshot {
  readonly threadId: string;
  readonly updatedAt: number;
  readonly context: PetContext;
}

export interface PetWorkspaceSummary {
  readonly total: number;
  readonly counts: Readonly<Record<PetAgentState, number>>;
  /** Threads in blocking states (waiting or failed): the user must act. */
  readonly attentionCount: number;
  readonly reviewCount: number;
  readonly runningCount: number;
}

export function summarizeWorkspace(
  snapshots: ReadonlyArray<PetThreadSnapshot>,
): PetWorkspaceSummary {
  const counts: Record<PetAgentState, number> = {
    idle: 0,
    queued: 0,
    running: 0,
    waiting: 0,
    review: 0,
    failed: 0,
  };
  for (const snapshot of snapshots) {
    counts[snapshot.context.agentState] += 1;
  }
  return {
    total: snapshots.length,
    counts,
    attentionCount: counts.waiting + counts.failed,
    reviewCount: counts.review,
    runningCount: counts.running,
  };
}

export interface PetFollowSelection {
  readonly mode: PetFollowMode;
  /** The thread the pet follows; null when there is nothing to follow. */
  readonly threadId: string | null;
  readonly context: PetContext | null;
  readonly workspace: PetWorkspaceSummary;
}

function emptySelection(mode: PetFollowMode): PetFollowSelection {
  return {
    mode,
    threadId: null,
    context: null,
    workspace: {
      total: 0,
      counts: { idle: 0, queued: 0, running: 0, waiting: 0, review: 0, failed: 0 },
      attentionCount: 0,
      reviewCount: 0,
      runningCount: 0,
    },
  };
}

function byPriority(snapshots: ReadonlyArray<PetThreadSnapshot>): PetThreadSnapshot | null {
  let best: PetThreadSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (best === null) {
      best = snapshot;
      continue;
    }
    const bestPriority = PET_STATE_PRIORITY[best.context.agentState];
    const candidatePriority = PET_STATE_PRIORITY[snapshot.context.agentState];
    if (
      candidatePriority > bestPriority ||
      (candidatePriority === bestPriority && snapshot.updatedAt > best.updatedAt)
    ) {
      best = snapshot;
    }
  }
  return best;
}

function byRecency(snapshots: ReadonlyArray<PetThreadSnapshot>): PetThreadSnapshot | null {
  let best: PetThreadSnapshot | null = null;
  for (const snapshot of snapshots) {
    if (best === null || snapshot.updatedAt > best.updatedAt) {
      best = snapshot;
    }
  }
  return best;
}

/**
 * Pick which thread the pet follows (spec §8, §89).
 *
 * - "selected": the currently selected thread, falling back to highest priority
 *   when nothing is selected.
 * - "pinned": an explicitly pinned thread, falling back to highest priority.
 * - "recent": the thread that changed most recently.
 * - "highest-priority": priority order, ties broken by recency.
 * - "workspace": pet represents the whole environment; the followed context is
 *   the highest-priority thread while the bubble reports aggregate counts.
 */
export function resolveFollow(
  snapshots: ReadonlyArray<PetThreadSnapshot>,
  options: {
    readonly mode: PetFollowMode;
    readonly selectedThreadId?: string | null;
    readonly pinnedThreadId?: string | null;
  },
): PetFollowSelection {
  const workspace = summarizeWorkspace(snapshots);

  if (snapshots.length === 0) {
    return emptySelection(options.mode);
  }

  const findById = (threadId: string | null | undefined) => {
    if (threadId === null || threadId === undefined) {
      return null;
    }
    return snapshots.find((snapshot) => snapshot.threadId === threadId) ?? null;
  };

  let picked: PetThreadSnapshot | null = null;

  switch (options.mode) {
    case "selected": {
      picked = findById(options.selectedThreadId) ?? byPriority(snapshots);
      break;
    }
    case "pinned": {
      picked = findById(options.pinnedThreadId) ?? byPriority(snapshots);
      break;
    }
    case "recent": {
      picked = byRecency(snapshots);
      break;
    }
    case "workspace": {
      picked = byPriority(snapshots);
      break;
    }
    case "highest-priority":
    default: {
      picked = byPriority(snapshots);
      break;
    }
  }

  if (picked === null) {
    return emptySelection(options.mode);
  }

  return {
    mode: options.mode,
    threadId: picked.threadId,
    context: picked.context,
    workspace,
  };
}
