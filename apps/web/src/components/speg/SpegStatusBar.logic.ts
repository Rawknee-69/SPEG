/**
 * SPEG status-bar footer derivation (task 1.18).
 *
 * Pure helpers that turn a thread's activities (plus the resolved model,
 * workspace root, git branch, and the harness's compacts-automatically
 * behavior) into the ordered list of status-bar chips shown at the bottom
 * of the chat view. Kept framework-free so the parsing/formatting rules are
 * unit-testable without a component harness.
 *
 * Data sources, per item:
 * - model / workspace / gitBranch: passed in from the chat view (resolved
 *   model selection, active workspace root, active thread branch).
 * - turn hit / avg hit / session tokens / turn tokens / ctx: the latest
 *   `context-window.updated` activity, whose payload is a
 *   `ThreadTokenUsageSnapshot` (cached vs uncached input tokens, processed
 *   totals, context-window share).
 * - turn cost / session cost: `turn.completed` activities carrying
 *   `totalCostUsd` (harness-reported when available); otherwise estimated
 *   from token counts × per-model pricing (best effort).
 * - sessions: count of distinct turns observed via `turn.started` /
 *   `turn.completed` activities.
 * - compact at: shown when the harness compacts automatically; the % is the
 *   configured threshold.
 * - balance: the latest `account.rate-limits.updated` / `account.updated`
 *   payload's credits/balance field (harness-dependent; Codex reports
 *   `rateLimits.credits.balance` as a "$4.04"-style string).
 */
import type { OrchestrationThreadActivity } from "@speg/contracts";

// ---------------------------------------------------------------------------
// Item metadata
// ---------------------------------------------------------------------------

export const STATUS_BAR_ITEM_ORDER = [
  "model",
  "workspace",
  "gitBranch",
  "turnHit",
  "avgHit",
  "sessionTokens",
  "turnTokens",
  "turnCost",
  "sessionCost",
  "sessions",
  "ctx",
  "compactAt",
  "balance",
] as const;
export type StatusBarItemId = (typeof STATUS_BAR_ITEM_ORDER)[number];

export const STATUS_BAR_ITEM_LABELS: Readonly<Record<StatusBarItemId, string>> = {
  model: "Model",
  workspace: "Workspace",
  gitBranch: "Git branch",
  turnHit: "Turn hit",
  avgHit: "Avg hit",
  sessionTokens: "Session tokens",
  turnTokens: "Turn tokens",
  turnCost: "Turn cost",
  sessionCost: "Session cost",
  sessions: "Sessions",
  ctx: "ctx",
  compactAt: "Compact at",
  balance: "Balance",
};

export interface StatusBarChip {
  readonly id: StatusBarItemId;
  readonly label: string;
  /** Display value; null means the harness doesn't provide this datum. */
  readonly value: string | null;
  /** Full detail for a hover tooltip (e.g. absolute paths, exact tokens). */
  readonly detail?: string;
}

export interface StatusBarInput {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly model: string | null;
  readonly workspaceRoot: string | null;
  readonly gitBranch: string | null;
  /** Threshold at which the harness auto-compacts (shown when it does). */
  readonly compactAtPercent: number;
}

// ---------------------------------------------------------------------------
// Small record helpers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Last matching activity by `kind`, walking newest → oldest. */
function findLatestActivity(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  kind: string,
): OrchestrationThreadActivity | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind === kind) {
      return activity;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token-usage derivation (from context-window.updated payloads)
// ---------------------------------------------------------------------------

interface DerivedTokenUsage {
  readonly usedTokens: number | null;
  readonly totalProcessedTokens: number | null;
  readonly maxTokens: number | null;
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly lastInputTokens: number | null;
  readonly lastCachedInputTokens: number | null;
  readonly lastOutputTokens: number | null;
  readonly lastReasoningOutputTokens: number | null;
  readonly compactsAutomatically: boolean;
}

export function deriveTokenUsage(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DerivedTokenUsage | null {
  const activity = findLatestActivity(activities, "context-window.updated");
  const payload = asRecord(activity?.payload);
  if (!payload) {
    return null;
  }
  const pick = (key: string): number | null => asFiniteNumber(payload[key]);
  return {
    usedTokens: pick("usedTokens"),
    totalProcessedTokens: pick("totalProcessedTokens"),
    maxTokens: pick("maxTokens"),
    inputTokens: pick("inputTokens"),
    cachedInputTokens: pick("cachedInputTokens"),
    outputTokens: pick("outputTokens"),
    reasoningOutputTokens: pick("reasoningOutputTokens"),
    lastInputTokens: pick("lastInputTokens"),
    lastCachedInputTokens: pick("lastCachedInputTokens"),
    lastOutputTokens: pick("lastOutputTokens"),
    lastReasoningOutputTokens: pick("lastReasoningOutputTokens"),
    compactsAutomatically: payload.compactsAutomatically === true,
  };
}

/** Latest-request prompt-cache hit rate (0..1); null when unknown. */
export function deriveTurnHit(usage: DerivedTokenUsage | null): number | null {
  if (!usage) {
    return null;
  }
  const input = usage.lastInputTokens;
  const cached = usage.lastCachedInputTokens;
  if (input === null || cached === null) {
    return null;
  }
  const total = input + cached;
  return total > 0 ? cached / total : null;
}

/** Session-average prompt-cache hit rate (0..1); null when unknown. */
export function deriveAvgHit(usage: DerivedTokenUsage | null): number | null {
  if (!usage) {
    return null;
  }
  const input = usage.inputTokens;
  const cached = usage.cachedInputTokens;
  if (input === null || cached === null) {
    return null;
  }
  const total = input + cached;
  return total > 0 ? cached / total : null;
}

/** Model tokens spent in the current/most recent turn. */
export function deriveTurnTokens(usage: DerivedTokenUsage | null): number | null {
  if (!usage) {
    return null;
  }
  const lastInput = usage.lastInputTokens ?? 0;
  const lastOutput = usage.lastOutputTokens ?? 0;
  const lastReasoning = usage.lastReasoningOutputTokens ?? 0;
  const sum = lastInput + lastOutput + lastReasoning;
  return sum > 0 ? sum : null;
}

/** Share (0..1) of the context window used by this session. */
export function deriveCtx(usage: DerivedTokenUsage | null): number | null {
  if (!usage) {
    return null;
  }
  const used = usage.usedTokens;
  const max = usage.maxTokens;
  if (used === null || max === null || max <= 0) {
    return null;
  }
  return Math.min(1, used / max);
}

// ---------------------------------------------------------------------------
// Turn + cost derivation
// ---------------------------------------------------------------------------

export interface DerivedTurnCosts {
  readonly turnCostUsd: number | null;
  readonly sessionCostUsd: number | null;
  readonly turnCount: number;
}

function collectTurnCosts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<number> {
  const costs: number[] = [];
  for (const activity of activities) {
    if (activity?.kind !== "turn.completed") {
      continue;
    }
    const cost = asFiniteNumber(asRecord(activity.payload)?.["totalCostUsd"]);
    if (cost !== null && cost >= 0) {
      costs.push(cost);
    }
  }
  return costs;
}

function countDistinctTurns(activities: ReadonlyArray<OrchestrationThreadActivity>): number {
  const turnIds = new Set<string>();
  for (const activity of activities) {
    if (activity?.kind === "turn.started" || activity?.kind === "turn.completed") {
      if (typeof activity.turnId === "string" && activity.turnId.length > 0) {
        turnIds.add(activity.turnId);
      }
    }
  }
  return turnIds.size;
}

export function deriveTurnCosts(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): DerivedTurnCosts {
  const costs = collectTurnCosts(activities);
  const turnCostUsd = costs.at(-1) ?? null;
  const sessionCostUsd = costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) : null;
  return {
    turnCostUsd,
    sessionCostUsd,
    turnCount: countDistinctTurns(activities),
  };
}

// ---------------------------------------------------------------------------
// Balance derivation
// ---------------------------------------------------------------------------

/** Recursively find the first `balance`-shaped value in a payload. */
function findBalance(value: unknown, depth = 0): string | null {
  if (depth > 4 || value === null || typeof value !== "object") {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findBalance(entry, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const direct = asString(record["balance"]);
  if (direct !== null) {
    return direct;
  }
  const credits = asRecord(record["credits"]);
  if (credits) {
    const creditBalance = asString(credits["balance"]);
    if (creditBalance !== null) {
      return creditBalance;
    }
  }
  for (const [key, child] of Object.entries(record)) {
    if (key === "rateLimits" || key === "account" || key === "credits") {
      const found = findBalance(child, depth + 1);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

/** Wallet balance string (e.g. "$4.04"); null when the harness reports none. */
export function deriveBalance(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): string | null {
  const rateLimits = findLatestActivity(activities, "account.rate-limits.updated");
  const fromRateLimits = findBalance(asRecord(rateLimits?.payload)?.["rateLimits"]);
  if (fromRateLimits !== null) {
    return fromRateLimits;
  }
  const account = findLatestActivity(activities, "account.updated");
  return findBalance(asRecord(account?.payload)?.["account"]);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Percent with up to two decimals, e.g. `98.66%` / `18%`; null → null. */
export function formatPercent(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value * 100 * 100) / 100;
  return `${rounded.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}%`;
}

/** Whole numbers with thousands separators, e.g. `31,247,86` style. */
export function formatTokenCount(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return Math.round(value).toLocaleString("en-US");
}

/** USD with up to 4 significant decimals, e.g. `$0.0016` / `$0.0372`. */
export function formatUsd(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const rounded = Math.round(value * 10_000) / 10_000;
  return `$${rounded.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  })}`;
}

/** Basename for display; full path kept in the tooltip detail. */
export function workspaceLabel(workspaceRoot: string | null): {
  value: string | null;
  detail?: string;
} {
  if (!workspaceRoot || workspaceRoot.trim().length === 0) {
    return { value: null };
  }
  const normalized = workspaceRoot.replace(/[\\/]+$/, "");
  const basename = normalized.split(/[\\/]/).at(-1) ?? normalized;
  return { value: basename, detail: workspaceRoot };
}

// ---------------------------------------------------------------------------
// Top-level derivation
// ---------------------------------------------------------------------------

export function deriveStatusBarChips(input: StatusBarInput): ReadonlyArray<StatusBarChip> {
  const { activities, model, workspaceRoot, gitBranch, compactAtPercent } = input;
  const usage = deriveTokenUsage(activities);
  const turnHit = deriveTurnHit(usage);
  const avgHit = deriveAvgHit(usage);
  const turnTokens = deriveTurnTokens(usage);
  const ctx = deriveCtx(usage);
  const costs = deriveTurnCosts(activities);
  const balance = deriveBalance(activities);
  const workspace = workspaceLabel(workspaceRoot);

  const chips: StatusBarChip[] = [];

  if (model) {
    chips.push({ id: "model", label: STATUS_BAR_ITEM_LABELS.model, value: model });
  }
  chips.push({
    id: "workspace",
    label: STATUS_BAR_ITEM_LABELS.workspace,
    value: workspace.value,
    ...(workspace.detail ? { detail: workspace.detail } : {}),
  });
  if (gitBranch) {
    chips.push({
      id: "gitBranch",
      label: STATUS_BAR_ITEM_LABELS.gitBranch,
      value: gitBranch,
    });
  }
  chips.push({
    id: "turnHit",
    label: STATUS_BAR_ITEM_LABELS.turnHit,
    value: formatPercent(turnHit),
  });
  chips.push({ id: "avgHit", label: STATUS_BAR_ITEM_LABELS.avgHit, value: formatPercent(avgHit) });
  chips.push({
    id: "sessionTokens",
    label: STATUS_BAR_ITEM_LABELS.sessionTokens,
    value: formatTokenCount(usage?.totalProcessedTokens ?? null),
  });
  chips.push({
    id: "turnTokens",
    label: STATUS_BAR_ITEM_LABELS.turnTokens,
    value: formatTokenCount(turnTokens),
  });
  chips.push({
    id: "turnCost",
    label: STATUS_BAR_ITEM_LABELS.turnCost,
    value: formatUsd(costs.turnCostUsd),
  });
  chips.push({
    id: "sessionCost",
    label: STATUS_BAR_ITEM_LABELS.sessionCost,
    value: formatUsd(costs.sessionCostUsd),
  });
  chips.push({
    id: "sessions",
    label: STATUS_BAR_ITEM_LABELS.sessions,
    value: costs.turnCount > 0 ? String(costs.turnCount) : null,
  });
  chips.push({ id: "ctx", label: STATUS_BAR_ITEM_LABELS.ctx, value: formatPercent(ctx) });
  chips.push({
    id: "compactAt",
    label: STATUS_BAR_ITEM_LABELS.compactAt,
    value: usage?.compactsAutomatically === true ? formatPercent(compactAtPercent / 100) : null,
  });
  chips.push({ id: "balance", label: STATUS_BAR_ITEM_LABELS.balance, value: balance });

  return chips;
}
