import type { PetVisualState } from "./atlas.ts";

/**
 * Semantic pet state model (spec §5).
 *
 * Many semantic states map onto a single visual state — e.g. THINKING,
 * TOOL_CALL, STARTING and RUNNING all render as the "running" animation — so
 * the system carries precise meaning without forcing artists to draw dozens of
 * animations. The client resolver emits the six-state `PetAgentState` (spec §60);
 * this richer union is the vocabulary used to describe events internally and by
 * future raw-event sources.
 */
export const PET_SEMANTIC_STATES = [
  "hidden",
  "idle",
  "queued",
  "starting",
  "running",
  "thinking",
  "tool-call",
  "waiting-input",
  "waiting-approval",
  "waiting-auth",
  "waiting-plan",
  "review",
  "success",
  "failed",
  "cancelled",
  "paused",
  "blocked",
] as const;
export type PetSemanticState = (typeof PET_SEMANTIC_STATES)[number];

/** The six-state normalized agent context the renderer consumes (spec §60). */
export const PET_AGENT_STATES = [
  "idle",
  "queued",
  "running",
  "waiting",
  "review",
  "failed",
] as const;
export type PetAgentState = (typeof PET_AGENT_STATES)[number];

/** Waiting sub-kinds, surfaced in the status bubble (spec §7, §62). */
export const PET_WAITING_KINDS = ["approval", "input", "auth", "plan"] as const;
export type PetWaitingKind = (typeof PET_WAITING_KINDS)[number];

/** Why the pet is drawing attention (spec §11). */
export const PET_ATTENTION_TIERS = ["none", "attention", "blocking"] as const;
export type PetAttentionTier = (typeof PET_ATTENTION_TIERS)[number];

export const SEMANTIC_TO_AGENT_STATE: Readonly<Record<PetSemanticState, PetAgentState>> = {
  hidden: "idle",
  idle: "idle",
  queued: "queued",
  starting: "running",
  running: "running",
  thinking: "running",
  "tool-call": "running",
  "waiting-input": "waiting",
  "waiting-approval": "waiting",
  "waiting-auth": "waiting",
  "waiting-plan": "waiting",
  review: "review",
  success: "review",
  failed: "failed",
  cancelled: "idle",
  paused: "idle",
  blocked: "failed",
};

export const AGENT_STATE_TO_VISUAL: Readonly<Record<PetAgentState, PetVisualState>> = {
  idle: "idle",
  queued: "idle",
  running: "running",
  waiting: "waiting",
  review: "review",
  failed: "failed",
};

export const AGENT_STATE_TO_ATTENTION: Readonly<Record<PetAgentState, PetAttentionTier>> = {
  idle: "none",
  queued: "none",
  running: "none",
  waiting: "blocking",
  review: "attention",
  failed: "blocking",
};

export function agentStateRequiresAttention(state: PetAgentState): boolean {
  return AGENT_STATE_TO_ATTENTION[state] === "blocking";
}
