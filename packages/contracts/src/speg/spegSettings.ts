import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  NonNegativeInt,
  PortSchema,
  TrimmedNonEmptyString,
  TrimmedString,
} from "../baseSchemas.ts";
import { AgentType } from "./spegSession.ts";

/**
 * SPEG settings (task 1.12). Client-local configuration for the SPEG
 * integration: where the cacm-daemon lives, how context gets injected into
 * threads, which agents to watch, and (Phase 3) which skills are enabled.
 *
 * Persisted as one `speg` blob inside `ClientSettings` (localStorage), so the
 * whole object is replaced on every edit — patches are built by spreading the
 * current value, mirroring the `sidebarProjectGroupingOverrides` convention.
 */

export const SpegContextInjectionMode = Schema.Literals(["auto", "manual", "off"]);
export type SpegContextInjectionMode = typeof SpegContextInjectionMode.Type;
export const DEFAULT_SPEG_CONTEXT_INJECTION_MODE: SpegContextInjectionMode = "auto";

export const SpegStorageBackend = Schema.Literals(["sqlite", "sled", "memory"]);
export type SpegStorageBackend = typeof SpegStorageBackend.Type;
export const DEFAULT_SPEG_STORAGE_BACKEND: SpegStorageBackend = "sqlite";

export const DEFAULT_SPEG_CACM_HOST = "localhost";
export const DEFAULT_SPEG_CACM_PORT = 9786;
export const DEFAULT_SPEG_MAX_CONTEXT_BUDGET_TOKENS = 8_000;

export const SpegAgentWatchDefaults: Record<AgentType, boolean> = {
  "claude-code": true,
  codex: true,
  opencode: true,
  cursor: true,
  grok: true,
  speg: true,
};

export const SpegSettingsSchema = Schema.Struct({
  cacmHost: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SPEG_CACM_HOST))),
  cacmPort: PortSchema.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_SPEG_CACM_PORT))),
  // Auto-start the cacm-daemon when the app boots.
  cacmAutoStart: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Agent session paths the daemon watches, one per line in the UI.
  cacmWatchPaths: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  cacmStorageBackend: SpegStorageBackend.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SPEG_STORAGE_BACKEND)),
  ),
  contextInjectionMode: SpegContextInjectionMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SPEG_CONTEXT_INJECTION_MODE)),
  ),
  // Max tokens of cross-agent context injected into a thread per turn.
  maxContextBudgetTokens: NonNegativeInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SPEG_MAX_CONTEXT_BUDGET_TOKENS)),
  ),
  watchedAgents: Schema.Record(AgentType, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed(SpegAgentWatchDefaults)),
  ),
  // Phase 3 placeholder: per-skill on/off. Empty until the skill manager lands.
  skillToggles: Schema.Record(TrimmedNonEmptyString, Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type SpegSettings = typeof SpegSettingsSchema.Type;

export const DEFAULT_SPEG_SETTINGS: SpegSettings = Schema.decodeSync(SpegSettingsSchema)({});
