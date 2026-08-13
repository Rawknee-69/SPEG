import type { PetFollowMode } from "@speg/contracts";
import type { PetContext } from "./resolver.ts";
import type { PetWorkspaceSummary } from "./follow.ts";

/**
 * Status bubble text (spec §62, §94): short, human, action-oriented. The bubble
 * must never show enum names or full logs.
 */
export function resolveStatusBubble(
  context: PetContext | null,
  options?: {
    readonly mode?: PetFollowMode;
    readonly workspace?: PetWorkspaceSummary;
  },
): string | null {
  if (context === null) {
    if (options?.mode === "workspace" && options.workspace && options.workspace.total > 0) {
      return summarizeWorkspaceBubble(options.workspace);
    }
    return null;
  }

  switch (context.agentState) {
    case "failed":
      return "Task failed";
    case "waiting": {
      switch (context.waitingKind) {
        case "approval":
          return "Needs approval";
        case "plan":
          return "Needs approval";
        case "auth":
          return "Needs sign-in";
        case "input":
        case null:
          return "Needs your input";
      }
    }
    case "review":
      return "Ready for review";
    case "running":
      return "Working…";
    case "queued":
    case "idle":
      return null;
  }
}

export function summarizeWorkspaceBubble(workspace: PetWorkspaceSummary): string | null {
  if (workspace.total === 0) {
    return null;
  }
  if (workspace.attentionCount > 0) {
    return `${workspace.attentionCount} ${workspace.attentionCount === 1 ? "agent" : "agents"} need${workspace.attentionCount === 1 ? "s" : ""} you`;
  }
  if (workspace.reviewCount > 0) {
    return `${workspace.reviewCount} ${workspace.reviewCount === 1 ? "agent" : "agents"} ready for review`;
  }
  if (workspace.runningCount > 0) {
    return `${workspace.runningCount} ${workspace.runningCount === 1 ? "agent" : "agents"} running`;
  }
  return null;
}
