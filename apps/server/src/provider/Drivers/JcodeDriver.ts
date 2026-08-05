/**
 * JcodeDriver — `ProviderDriver` for the jcode agent runtime.
 *
 * Mirrors `OpenCodeDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `JcodeSettings`.
 *
 * The instance owns one private jcode daemon via `JcodeProcessManager`
 * (embedded `JcodeClient.launch`, one daemon per instance — no shared mutable
 * state between instances). The adapter and the text-generation service both
 * pull their client from the same manager, and closing the instance scope
 * shuts the daemon down.
 *
 * The snapshot probe runs `jcode --version` through the spawner and
 * enumerates live models through the instance's own daemon (cached for 5
 * minutes so the periodic health refresh stays cheap).
 *
 * @module provider/Drivers/JcodeDriver
 */
import { JcodeSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeJcodeTextGeneration } from "../../textGeneration/JcodeTextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeJcodeAdapter } from "../Layers/JcodeAdapter.ts";
import {
  checkJcodeProviderStatus,
  makePendingJcodeProvider,
  probeJcodeModels,
} from "../Layers/JcodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { makeJcodeProcessManager } from "./JcodeProcessManager.ts";

const DRIVER_KIND = ProviderDriverKind.make("jcode");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

const decodeJcodeSettings = Schema.decodeSync(JcodeSettings);

export type JcodeDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const JcodeDriver: ProviderDriver<JcodeSettings, JcodeDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Jcode",
    supportsMultipleInstances: true,
  },
  configSchema: JcodeSettings,
  defaultConfig: (): JcodeSettings => decodeJcodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const crypto = yield* Crypto.Crypto;
      const { cwd } = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies JcodeSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      // One private daemon per instance. Closing the instance scope shuts it
      // down (and removes the ephemeral home, if one was used).
      const processManager = yield* makeJcodeProcessManager(effectiveConfig, {
        environment: processEnv,
        workingDir: cwd,
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => processManager.close()));

      const adapterOptions = {
        instanceId,
        environment: processEnv,
        clientSource: () => processManager.getClient(),
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      };
      const adapter = yield* makeJcodeAdapter(effectiveConfig, adapterOptions);
      const textGeneration = yield* makeJcodeTextGeneration(processManager);

      // Per-instance model inventory cache: live enumeration requires the
      // daemon, so cache it and only refresh on the health interval.
      const modelsCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: (key: string) => probeJcodeModels(processManager, cwd),
      });

      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: "@1jehuang/jcode-sdk",
      });

      const checkProvider = checkJcodeProviderStatus(
        effectiveConfig,
        Cache.get(modelsCache, "models"),
        processEnv,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Crypto.Crypto, crypto),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<JcodeSettings>>({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingJcodeProvider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Jcode snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
