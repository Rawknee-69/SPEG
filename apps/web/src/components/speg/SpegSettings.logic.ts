/**
 * Pure helpers for the SPEG settings panel. Kept framework-free so the
 * parsing/formatting rules are unit-testable without a component harness.
 */
import type { SpegSettings } from "@t3tools/contracts/settings";

export type WatchedAgent = keyof SpegSettings["watchedAgents"];

/** Agent watching toggle order (matches the CACM timeline's agent set). */
export const WATCH_AGENT_ORDER: ReadonlyArray<WatchedAgent> = [
  "jcode",
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "speg",
];

export const AGENT_WATCH_LABELS: Readonly<Record<WatchedAgent, string>> = {
  jcode: "Jcode",
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  speg: "SPEG",
};

/** Render persisted watch paths as one path per line. */
export function watchPathListToText(paths: readonly string[]): string {
  return paths.join("\n");
}

/** Parse the watch-paths editor into trimmed, non-empty lines. */
export function parseWatchPathList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Parse a port from editor text; null when not an integer in 1..65535. */
export function parsePort(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

/** Parse a context-budget token count; null when not a non-negative integer. */
export function parseTokenBudget(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}
