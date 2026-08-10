/**
 * cacm-daemon sidecar auto-start (the SPEG "harness" wiring).
 *
 * The CACM tab in the editor UI talks to a local `cacm-daemon` process over
 * WebSocket (default `ws://localhost:9786/ws`, see `@cacm/sdk`). The daemon
 * is a Rust binary (`cacm/cacm-daemon`) that does not start by itself, so it
 * must be launched alongside the app. This module spawns it whenever the SPEG
 * Code server runs — the editor's runtime in every mode: browser dev via
 * `bun run dev`, the desktop app, and local production.
 *
 * Lifecycle:
 * - Probes the daemon's `/healthz` first; an instance the user already
 *   started (or a previous run left behind) is reused instead of spawned.
 * - Spawns the binary as a child of the server (SIGTERM on server shutdown),
 *   so the daemon lives exactly as long as the app.
 * - Auto-start is best-effort: a missing binary, a busy port, or a probe
 *   failure never fail server startup — they are logged and the panel shows
 *   its existing connection error.
 *
 * The daemon is unauthenticated and refuses WebSocket upgrades from browser
 * `Origin` headers that are not on its allow-list (see
 * `cacm/cacm-daemon/src/server.rs`), so every origin this server can
 * plausibly serve (dev URL, shared tailnet origins, the web dev port, and
 * the desktop renderer's `file://` origin) is passed via `--allow-origin`.
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { DEFAULT_SPEG_CACM_PORT } from "@speg/contracts/settings";
import { HostProcessEnvironment, HostProcessPlatform } from "@speg/shared/hostProcess";
import * as ServerConfig from "../config.ts";

/** The daemon's own default bind address (loopback; the client dials localhost). */
export const DEFAULT_CACM_DAEMON_BIND_HOST = "127.0.0.1";

/**
 * Env override for the daemon executable path (e.g. a bundled release
 * binary). Mirrors `SPEG_RESOURCE_MONITOR_PATH`.
 */
export const CACM_DAEMON_PATH_ENV = "SPEG_CACM_DAEMON_PATH";

/**
 * Env kill-switch for auto-start. Any of `0`/`false` disables it; the
 * default is on, matching the client-local `speg.cacmAutoStart` default.
 */
export const CACM_DAEMON_AUTOSTART_ENV = "SPEG_CACM_DAEMON_AUTOSTART";

const HEALTH_PROBE_TIMEOUT = Duration.millis(1500);
const DAEMON_KILL_TIMEOUT = Duration.seconds(2);

export class CacmDaemonBinaryNotFound extends Error {
  readonly _tag = "CacmDaemonBinaryNotFound";
  readonly candidates: ReadonlyArray<string>;

  constructor(candidates: ReadonlyArray<string>) {
    super(
      `cacm-daemon binary not found; build it with \`cargo build -p cacm-daemon\` (in cacm/) or set ${CACM_DAEMON_PATH_ENV} (tried: ${candidates.join(", ")})`,
    );
    this.candidates = candidates;
  }
}

export class CacmDaemonSpawnFailed extends Error {
  readonly _tag = "CacmDaemonSpawnFailed";
  readonly executablePath: string;
  readonly underlying: unknown;

  constructor(executablePath: string, underlying: unknown) {
    super(`Failed to start cacm-daemon '${executablePath}': ${String(underlying)}`);
    this.executablePath = executablePath;
    this.underlying = underlying;
  }
}

export type CacmDaemonStartStatus =
  | { readonly status: "disabled" }
  | { readonly status: "already-running" }
  | { readonly status: "started"; readonly pid: ChildProcessSpawner.ProcessId }
  | { readonly status: "failed"; readonly reason: string };

export class CacmDaemonProcess extends Context.Service<
  CacmDaemonProcess,
  {
    /**
     * Best-effort auto-start of the cacm-daemon sidecar. Never fails: every
     * failure is logged and reported in the returned status. When a daemon is
     * spawned, it is registered in the caller's scope and killed when that
     * scope closes (i.e. when the server shuts down).
     */
    readonly start: Effect.Effect<CacmDaemonStartStatus, never, Scope.Scope>;
    /**
     * Restart the sidecar: stop any daemon currently answering on the CACM
     * port (the one we spawned, or a stale instance from an earlier run),
     * wait until the port is free, then re-run `start`. Useful after a
     * crash-loop or when a stale daemon was started with an outdated
     * origin list. Like `start`, never fails.
     */
    readonly restart: Effect.Effect<CacmDaemonStartStatus, never, Scope.Scope>;
  }
>()("speg/speg/CacmDaemonProcess") {}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cacm-daemon.exe" : "cacm-daemon";
}

/**
 * Candidate locations for the daemon executable, in resolution order. The
 * env override wins; otherwise the repo's cargo target dirs are tried
 * (release first). `import.meta.dirname` is `apps/server/{src,dist}/speg`,
 * so four levels up is the monorepo root.
 */
export function resolveBinaryCandidates(
  platform: NodeJS.Platform,
  dirname: string,
  environment: NodeJS.ProcessEnv = {},
): ReadonlyArray<string> {
  const executableName = binaryName(platform);
  const repoRootCandidates = [
    `${dirname}/../../../../cacm/target/release/${executableName}`,
    `${dirname}/../../../../cacm/target/debug/${executableName}`,
  ];
  // Bundled layouts may place the sidecar next to the server bundle itself.
  const sameDirCandidate = `${dirname}/${executableName}`;
  const override = environment[CACM_DAEMON_PATH_ENV]?.trim();
  return [override, ...repoRootCandidates, sameDirCandidate].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
}

/**
 * Browser `Origin`s the spawned daemon must accept, derived from what this
 * server can serve. Exact matches only (the daemon allow-list is literal), so
 * both loopback spellings of the web dev port are included.
 */
export function resolveAllowedOrigins(input: {
  readonly mode: ServerConfig.RuntimeMode;
  readonly devUrl: URL | undefined;
  readonly devAllowedOrigins: ReadonlyArray<string>;
  readonly webPort?: number | undefined;
}): ReadonlyArray<string> {
  const origins = new Set<string>();
  if (input.devUrl) {
    origins.add(input.devUrl.origin);
  }
  for (const origin of input.devAllowedOrigins) {
    const trimmed = origin.trim();
    if (trimmed.length > 0) {
      origins.add(trimmed);
    }
  }
  const webPort = input.webPort;
  if (webPort !== undefined && Number.isInteger(webPort) && webPort > 0 && webPort <= 65535) {
    origins.add(`http://localhost:${webPort}`);
    origins.add(`http://127.0.0.1:${webPort}`);
  }
  // The production desktop renderer loads the client from disk; browsers
  // send `Origin: null` for file:// pages on WebSocket upgrades.
  if (input.mode === "desktop" && input.devUrl === undefined) {
    origins.add("null");
  }
  return [...origins];
}

export const make = Effect.fn("speg.cacmDaemonProcess.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // The child we spawned, so `restart` can stop exactly the process we own.
  const currentChild = yield* Ref.make<Option.Option<ChildProcessSpawner.ChildProcessHandle>>(
    Option.none(),
  );
  // Serialize start/restart so a concurrent POST cannot double-kill or
  // double-spawn.
  const lifecycleMutex = yield* Semaphore.make(1);

  const probe = (url: string) =>
    httpClient.get(url).pipe(
      Effect.map((response) => response.status === 200),
      Effect.timeout(HEALTH_PROBE_TIMEOUT),
      Effect.orElseSucceed(() => false),
    );

  /** Read the daemon's own pid from /healthz (present since v0.1.0 restart work). */
  const probePid = (url: string): Effect.Effect<number | undefined, never> =>
    httpClient.get(url).pipe(
      Effect.flatMap((response) => response.json),
      Effect.map((body) => {
        if (!body || typeof body !== "object" || !("pid" in body)) return undefined;
        const pid = Number((body as { pid: unknown }).pid);
        // Defensive: only ever target a real process id (never 0/negative,
        // which could signal the caller's own process group).
        return Number.isInteger(pid) && pid > 1 ? pid : undefined;
      }),
      Effect.orElseSucceed(() => undefined),
      Effect.timeout(HEALTH_PROBE_TIMEOUT),
      Effect.orElseSucceed(() => undefined),
    );

  /** Kill an arbitrary daemon process by pid (stale instance we did not spawn). */
  const killPid = (pid: number) =>
    Effect.gen(function* () {
      const command = ChildProcess.make(
        platform === "win32" ? "taskkill" : "kill",
        platform === "win32"
          ? ["/PID", String(pid), "/T", "/F"]
          : ["-9", String(pid)],
        {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      yield* spawner
        .spawn(command)
        .pipe(
          Effect.flatMap((child) => child.exitCode),
          Effect.catch((error) =>
            Effect.logDebug("failed to kill stale cacm-daemon by pid", { pid, error }),
          ),
          Effect.asVoid,
        );
    });

  /**
   * Poll until nothing answers /healthz (the old daemon has released the
   * port), so the fresh spawn cannot race a still-exiting process.
   */
  const waitForPortFree = (url: string, attempts: number): Effect.Effect<void> => {
    const tryProbe = (remaining: number): Effect.Effect<void> =>
      probe(url).pipe(
        Effect.flatMap((stillHealthy) => {
          if (!stillHealthy) return Effect.void;
          if (remaining <= 0) {
            return Effect.logWarning("timed out waiting for cacm-daemon port to free", { url });
          }
          return Effect.sleep("200 millis").pipe(Effect.andThen(() => tryProbe(remaining - 1)));
        }),
      );
    return tryProbe(attempts);
  };

  const candidates = resolveBinaryCandidates(platform, import.meta.dirname, environment);
  const resolveBinary: Effect.Effect<string, CacmDaemonBinaryNotFound> = Effect.gen(function* () {
    for (const candidate of candidates) {
      const resolved = path.resolve(candidate);
      if (yield* fileSystem.exists(resolved).pipe(Effect.orElseSucceed(() => false))) {
        return resolved;
      }
    }
    return yield* Effect.fail(new CacmDaemonBinaryNotFound(candidates));
  });

  const startUnlocked: Effect.Effect<CacmDaemonStartStatus, never, Scope.Scope> =
    Effect.gen(function* () {
    const autostart = environment[CACM_DAEMON_AUTOSTART_ENV];
    if (autostart !== undefined && (autostart === "0" || autostart.toLowerCase() === "false")) {
      yield* Effect.logInfo("cacm-daemon auto-start is disabled", {
        key: CACM_DAEMON_AUTOSTART_ENV,
      });
      return { status: "disabled" } as const;
    };

    const host = DEFAULT_CACM_DAEMON_BIND_HOST;
    const port = DEFAULT_SPEG_CACM_PORT;
    const healthUrl = `http://${host}:${port}/healthz`;

    if (yield* probe(healthUrl)) {
      yield* Effect.logInfo("cacm-daemon already running; reusing it", { url: healthUrl });
      return { status: "already-running" } as const;
    }

    const binary = yield* resolveBinary.pipe(
      Effect.match({
        onFailure: () => Option.none<string>(),
        onSuccess: (value) => Option.some(value),
      }),
    );
    if (Option.isNone(binary)) {
      const message = new CacmDaemonBinaryNotFound(candidates).message;
      yield* Effect.logWarning(message);
      return { status: "failed", reason: message } as const;
    }
    const binaryPath = binary.value;

    const rawWebPort = Number(environment.PORT);
    const origins = resolveAllowedOrigins({
      mode: config.mode,
      devUrl: config.devUrl,
      devAllowedOrigins: config.devAllowedOrigins,
      webPort: Number.isInteger(rawWebPort) && rawWebPort > 0 ? rawWebPort : undefined,
    });
    const args = [
      "--host",
      host,
      "--port",
      String(port),
      ...origins.flatMap((origin) => ["--allow-origin", origin]),
    ];

    const command = ChildProcess.make(binaryPath, args, {
      cwd: config.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: DAEMON_KILL_TIMEOUT,
    });
    const handle = yield* Effect.acquireRelease(
      spawner.spawn(command).pipe(
        Effect.mapError((cause) => new CacmDaemonSpawnFailed(binaryPath, cause)),
      ),
      // `kill()` does not inherit the command's `forceKillAfter`; pass it
      // explicitly so a daemon that ignores SIGTERM cannot hang shutdown.
      (child) => child.kill({ forceKillAfter: DAEMON_KILL_TIMEOUT }).pipe(Effect.ignore),
    );
    // Remember the child so `restart` can stop exactly this process.
    yield* Ref.set(currentChild, Option.some(handle));

    // Keep the daemon's own output out of the server's stdout but visible in
    // server logs; the drainers die with the server scope.
    yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Effect.logDebug("cacm-daemon stderr", { line })),
      Effect.catchCause((cause) =>
        Effect.logDebug("cacm-daemon stderr stream closed", { cause }),
      ),
      Effect.forkScoped,
    );
    yield* handle.stdout.pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.runForEach((line) => Effect.logDebug("cacm-daemon stdout", { line })),
      Effect.catchCause((cause) =>
        Effect.logDebug("cacm-daemon stdout stream closed", { cause }),
      ),
      Effect.forkScoped,
    );

    // Report an unexpected daemon exit; completes when the daemon stops.
    yield* handle.exitCode.pipe(
      Effect.flatMap((exitCode) =>
        Effect.logWarning("cacm-daemon exited", { exitCode: Number(exitCode) }),
      ),
      Effect.catchCause((cause) =>
        Effect.logDebug("cacm-daemon exit wait interrupted", { cause }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.logInfo("cacm-daemon started", {
      pid: Number(handle.pid),
      executable: binaryPath,
      url: `ws://${host}:${port}/ws`,
      allowOrigins: origins,
    });

    return { status: "started", pid: handle.pid } as const;
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("failed to auto-start cacm-daemon", { error });
        return { status: "failed", reason: error.message } as const;
      }),
    ),
  );

  // Serialized entry: the daemon is a single-instance sidecar, so start and
  // restart must never interleave (double-spawn / kill-the-fresh-child).
  const start: Effect.Effect<CacmDaemonStartStatus, never, Scope.Scope> =
    lifecycleMutex.withPermits(1)(startUnlocked);

  /**
   * Restart the sidecar: stop whatever daemon currently answers /healthz
   * (our child, or a stale instance left by an earlier run), wait for the
   * port to be released, then start fresh with the current origin list.
   * Never fails — every outcome is reported as a status.
   */
  const restart: Effect.Effect<CacmDaemonStartStatus, never, Scope.Scope> = lifecycleMutex
    .withPermits(1)(
      Effect.gen(function* () {
        const host = DEFAULT_CACM_DAEMON_BIND_HOST;
        const port = DEFAULT_SPEG_CACM_PORT;
        const healthUrl = `http://${host}:${port}/healthz`;

        // 1. Stop the daemon we own, if any.
        const owned = yield* Ref.get(currentChild);
        if (Option.isSome(owned)) {
          yield* owned.value.kill({ forceKillAfter: DAEMON_KILL_TIMEOUT }).pipe(Effect.ignore);
          yield* Ref.set(currentChild, Option.none());
          yield* Effect.logInfo("cacm-daemon restart: stopped owned instance");
        } else {
          // 2. No owned child — a stale daemon may still hold the port. Probe
          //    healthz; when it answers, kill it by the pid it reports.
          const stalePid = yield* probePid(healthUrl);
          if (stalePid !== undefined) {
            yield* Effect.logInfo("cacm-daemon restart: killing stale instance", { stalePid });
            yield* killPid(stalePid);
          }
        }

        // 3. Give the old process a moment to release the socket, then spawn a
        //    fresh one with the current origins. (We already hold the
        //    lifecycle permit, so call the unlocked start to avoid deadlock.)
        yield* waitForPortFree(healthUrl, 25);
        return yield* startUnlocked;
      }),
    );

  return CacmDaemonProcess.of({ start, restart });
});

export const layer = Layer.effect(CacmDaemonProcess, make());
