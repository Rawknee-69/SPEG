import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import type { VcsDriverKind, VcsError, VcsRepositoryIdentity } from "@speg/contracts";
import { VcsRepositoryNotFoundError, VcsUnsupportedOperationError } from "@speg/contracts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriver from "./VcsDriver.ts";

const DETECTION_CACHE_CAPACITY = 2_048;
const DETECTION_CACHE_TTL = Duration.seconds(2);

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriver.VcsDriver["Service"];
}

export class VcsDriverRegistry extends Context.Service<
  VcsDriverRegistry,
  {
    readonly get: (kind: VcsDriverKind) => Effect.Effect<VcsDriver.VcsDriver["Service"], VcsError>;
    readonly detect: (
      input: VcsDriverResolveInput,
    ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
    readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
  }
>()("speg/vcs/VcsDriverRegistry") {}

function detectionCacheKey(input: {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
}): string {
  return `${input.requestedKind}\0${input.cwd}`;
}

function parseDetectionCacheKey(key: string): {
  readonly cwd: string;
  readonly requestedKind: VcsDriverKind | "auto";
} {
  const separatorIndex = key.indexOf("\0");
  if (separatorIndex === -1) {
    return {
      cwd: key,
      requestedKind: "auto",
    };
  }
  return {
    requestedKind: key.slice(0, separatorIndex) as VcsDriverKind | "auto",
    cwd: key.slice(separatorIndex + 1),
  };
}

export const make = Effect.gen(function* () {
  const projectConfig = yield* VcsProjectConfig.VcsProjectConfig;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const git = yield* GitVcsDriver.makeVcsDriver;
  const drivers: Partial<Record<VcsDriverKind, VcsDriver.VcsDriver["Service"]>> = {
    git,
  };

  const get: VcsDriverRegistry["Service"]["get"] = (kind) => {
    const driver = drivers[kind];
    if (!driver) {
      return Effect.fail(
        new VcsUnsupportedOperationError({
          operation: "VcsDriverRegistry.get",
          kind,
          detail: `No ${kind} VCS driver is registered.`,
        }),
      );
    }
    return Effect.succeed(driver);
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriver.VcsDriver["Service"],
    cwd: string,
  ) {
    const repository = yield* driver.detectRepository(cwd);
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
    } satisfies VcsDriverHandle;
  });

  const detectResolvedKind = Effect.fn("VcsDriverRegistry.detectResolvedKind")(function* (input: {
    readonly cwd: string;
    readonly requestedKind: VcsDriverKind | "auto";
  }) {
    const requestedKind = input.requestedKind;

    if (requestedKind !== "auto" && requestedKind !== "unknown") {
      const driver = yield* get(requestedKind);
      return yield* detectWithDriver(requestedKind, driver, input.cwd);
    }

    return yield* detectWithDriver("git", git, input.cwd);
  });

  const detectionCache = yield* Cache.makeWith<string, VcsDriverHandle | null, VcsError>(
    (key) => detectResolvedKind(parseDetectionCacheKey(key)),
    {
      capacity: DETECTION_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (detected) => (detected === null ? Duration.zero : DETECTION_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const detect: VcsDriverRegistry["Service"]["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      const requestedKind = yield* projectConfig.resolveKind(input);
      return yield* Cache.get(detectionCache, detectionCacheKey({ cwd: input.cwd, requestedKind }));
    },
  );

  const resolve: VcsDriverRegistry["Service"]["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      const autoInitEligible = requestedKind === "auto" || requestedKind === "unknown";

      // With "auto" git initialization, initialize a repository at the target
      // directory and retry detection. Detection already walks the ancestor
      // chain (see GitVcsDriver.detectRepository), so reaching this point means
      // no repository exists in the directory or any of its ancestors — a
      // nested folder inside an existing repo is never re-initialized.
      if (autoInitEligible) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(
            () =>
              new VcsRepositoryNotFoundError({
                operation: "VcsDriverRegistry.resolve",
                cwd: input.cwd,
                detail: "Unable to read settings while resolving the VCS driver.",
              }),
          ),
        );
        if (settings.vcsGitInitMode === "auto") {
          const initialized = yield* git
            .initRepository({
              cwd: input.cwd,
              kind: "git",
            })
            .pipe(
              Effect.matchCauseEffect({
                onFailure: () =>
                  Effect.fail(
                    new VcsRepositoryNotFoundError({
                      operation: "VcsDriverRegistry.resolve",
                      cwd: input.cwd,
                      detail: "Failed to initialize a Git repository.",
                    }),
                  ),
                onSuccess: () => Effect.succeed(true),
              }),
            );
          if (initialized) {
            yield* Cache.invalidate(
              detectionCache,
              detectionCacheKey({ cwd: input.cwd, requestedKind }),
            );
            const afterInit = yield* detect(input);
            if (afterInit) {
              return afterInit;
            }
          }
        }
      }

      return yield* new VcsRepositoryNotFoundError({
        operation: "VcsDriverRegistry.resolve",
        cwd: input.cwd,
        detail:
          requestedKind === "auto"
            ? "No supported VCS repository was detected."
            : `No ${requestedKind} repository was detected.`,
      });
    },
  );

  return VcsDriverRegistry.of({
    get,
    detect,
    resolve,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make).pipe(
  Layer.provide(VcsProjectConfig.layer),
);
