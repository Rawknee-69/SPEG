/**
 * JcodeProvider — snapshot probe for the Jcode provider driver.
 *
 * Mirrors `OpenCodeProvider`: builds `ServerProviderDraft` snapshots from a
 * `jcode --version` probe plus a live model inventory (queried through the
 * instance's own jcode daemon). Model enumeration is expensive (it requires a
 * running daemon), so `JcodeDriver` wraps it in a TTL cache keyed on the
 * instance's settings.
 *
 * @module provider/Layers/JcodeProvider
 */
import { type JcodeSettings, type ServerProviderModel } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { JcodeProcessManager } from "../Drivers/JcodeProcessManager.ts";
import {
  buildServerProvider,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderPresentation,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

/**
 * The minimum jcode release we support. The harness API is protocol-versioned
 * (v1) and the SDK rejects an unsupported bridge, so this is a floor for the
 * CLI version reported by `jcode --version`, not a protocol negotiation.
 */
export const MINIMUM_JCODE_VERSION = "1.0.0";

export const JCODE_PRESENTATION: ServerProviderPresentation = {
  displayName: "Jcode",
  showInteractionModeToggle: false,
};

const DEFAULT_JCODE_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
});

/**
 * Internal tagged error for best-effort daemon interactions in the model
 * probe. Never escapes `probeJcodeModels` — every failure is caught and
 * logged, degrading to an empty model list.
 */
export class JcodeProbeError extends Schema.TaggedErrorClass<JcodeProbeError>()("JcodeProbeError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `jcode probe ${this.operation} failed: ${this.detail}`;
  }
}

const probeClient = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new JcodeProbeError({ operation, detail: String(cause), cause }),
  });

const runJcodeVersion = Effect.fn("runJcodeVersion")(function* (
  jcodeSettings: JcodeSettings,
  environment?: NodeJS.ProcessEnv,
) {
  const resolvedEnvironment = environment ?? process.env;
  const spawnCommand = yield* resolveSpawnCommand(jcodeSettings.binaryPath, ["--version"], {
    env: resolvedEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: resolvedEnvironment,
    shell: spawnCommand.shell,
  });
  return yield* spawnAndCollect(jcodeSettings.binaryPath, command);
});

/**
 * Live model inventory from the instance's jcode daemon. Enumerates models on
 * a throwaway session, then clears it so the probe leaves no transcript
 * behind. Never fails: every daemon interaction degrades to an empty list
 * (callers fall back to custom models).
 */
export const probeJcodeModels = (
  processManager: JcodeProcessManager,
  cwd: string,
): Effect.Effect<ReadonlyArray<ServerProviderModel>, never> =>
  Effect.gen(function* () {
    const client = yield* probeClient("getClient", () => processManager.getClient()).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "jcode model probe could not obtain a client; using custom models only.",
          {
            cause,
          },
        ).pipe(Effect.as(undefined)),
      ),
    );
    if (!client) {
      return [];
    }
    const session = yield* probeClient("createSession", () => client.createSession(cwd)).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "jcode model probe could not create a session; using custom models only.",
          {
            cause,
          },
        ).pipe(Effect.as(undefined)),
      ),
    );
    if (!session) {
      return [];
    }
    try {
      const listed = yield* probeClient("listModels", () =>
        client.listModels(session.session_id),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("jcode model probe listModels failed; using custom models only.", {
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      );
      if (!listed) {
        return [];
      }
      return listed.models.map((model) => ({
        slug: model,
        name: model,
        isCustom: false,
        capabilities: DEFAULT_JCODE_MODEL_CAPABILITIES,
      }));
    } finally {
      yield* probeClient("clear", () => client.clear(session.session_id)).pipe(Effect.ignore);
    }
  });

export const makePendingJcodeProvider = (
  jcodeSettings: JcodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      jcodeSettings.customModels,
      DEFAULT_JCODE_MODEL_CAPABILITIES,
    );

    if (!jcodeSettings.enabled) {
      return buildServerProvider({
        presentation: JCODE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Jcode is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: JCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Jcode provider status has not been checked in this session yet.",
      },
    });
  });

export const checkJcodeProviderStatus = Effect.fn("checkJcodeProviderStatus")(function* (
  jcodeSettings: JcodeSettings,
  resolveModels: Effect.Effect<ReadonlyArray<ServerProviderModel>, never>,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = jcodeSettings.customModels;

  const fallback = (cause: unknown, version: string | null = null) =>
    buildServerProvider({
      presentation: JCODE_PRESENTATION,
      enabled: jcodeSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_JCODE_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: cause instanceof Error ? cause.message : String(cause),
      },
    });

  if (!jcodeSettings.enabled) {
    return buildServerProvider({
      presentation: JCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_JCODE_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Jcode is disabled in T3 Code settings.",
      },
    });
  }

  const versionExit = yield* Effect.exit(runJcodeVersion(jcodeSettings, resolvedEnvironment));
  if (versionExit._tag === "Failure") {
    return fallback(Cause.squash(versionExit.cause));
  }
  const version = parseGenericCliVersion(versionExit.value.stdout) ?? null;

  if (!version) {
    return fallback(
      new Error(
        `Unable to determine jcode version from \`jcode --version\` output. T3 Code requires jcode v${MINIMUM_JCODE_VERSION} or newer.`,
      ),
      null,
    );
  }
  if (compareSemverVersions(version, MINIMUM_JCODE_VERSION) < 0) {
    return buildServerProvider({
      presentation: JCODE_PRESENTATION,
      enabled: jcodeSettings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_JCODE_MODEL_CAPABILITIES),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `jcode v${version} is too old. Upgrade to v${MINIMUM_JCODE_VERSION} or newer.`,
      },
    });
  }

  // Model inventory comes from the live daemon when it is reachable;
  // otherwise fall back to user-configured custom models only.
  const liveModels = yield* resolveModels;
  const models = providerModelsFromSettings(
    liveModels,
    customModels,
    DEFAULT_JCODE_MODEL_CAPABILITIES,
  );

  return buildServerProvider({
    presentation: JCODE_PRESENTATION,
    enabled: jcodeSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth: { status: "unknown" },
      message: `jcode v${version} is available.`,
    },
  });
});
