import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as ServerConfig from "../config.ts";
import * as CacmDaemonProcess from "./CacmDaemonProcess.ts";

const TEST_PID = ChildProcessSpawner.ProcessId(4242);

function makeHandle(input: {
  readonly onKill?: (options?: ChildProcess.KillOptions) => void;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode>;
  readonly stderr?: Stream.Stream<Uint8Array>;
}) {
  return ChildProcessSpawner.makeHandle({
    pid: TEST_PID,
    exitCode: input.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: (options) => Effect.sync(() => input.onKill?.(options)),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: input.stderr ?? Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function makeSpawner(input: {
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onKill?: (options?: ChildProcess.KillOptions) => void;
  readonly failSpawn?: boolean;
}) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      assert.equal(ChildProcess.isStandardCommand(command), true);
      if (!ChildProcess.isStandardCommand(command)) {
        throw new Error("Expected a standard command");
      }
      input.onSpawn?.(command);
      if (input.failSpawn) {
        return Effect.fail(
          PlatformError.systemError({
            _tag: "Unknown",
            module: "ChildProcessSpawner",
            method: "spawn",
            description: "injected spawn failure",
          }),
        );
      }
      return Effect.succeed(makeHandle(input.onKill ? { onKill: input.onKill } : {}));
    }),
  );
}

/** Probe responses: 200 = daemon healthy; anything else = not reachable. */
function makeHttpClient(status = 200) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status })),
      ),
    ),
  );
}

function makeServerConfig(overrides: Partial<ServerConfig.ServerConfig["Service"]> = {}) {
  const base: ServerConfig.ServerConfig["Service"] = {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-server",
    cwd: process.cwd(),
    baseDir: process.cwd(),
    stateDir: "/tmp/cacm-test/state",
    dbPath: "/tmp/cacm-test/state/state.sqlite",
    keybindingsConfigPath: "/tmp/cacm-test/state/keybindings.json",
    settingsPath: "/tmp/cacm-test/state/settings.json",
    providerStatusCacheDir: "/tmp/cacm-test/caches",
    worktreesDir: "/tmp/cacm-test/worktrees",
    attachmentsDir: "/tmp/cacm-test/state/attachments",
    logsDir: "/tmp/cacm-test/state/logs",
    serverLogPath: "/tmp/cacm-test/state/logs/server.log",
    serverTracePath: "/tmp/cacm-test/state/logs/server.trace.ndjson",
    providerLogsDir: "/tmp/cacm-test/state/logs/provider",
    providerEventLogPath: "/tmp/cacm-test/state/logs/provider/events.log",
    terminalLogsDir: "/tmp/cacm-test/state/logs/terminals",
    anonymousIdPath: "/tmp/cacm-test/state/anonymous-id",
    environmentIdPath: "/tmp/cacm-test/state/environment-id",
    serverRuntimeStatePath: "/tmp/cacm-test/state/server-runtime.json",
    secretsDir: "/tmp/cacm-test/state/secrets",
    mode: "web",
    port: 0,
    host: undefined,
    staticDir: undefined,
    devUrl: undefined,
    devAllowedOrigins: [],
    noBrowser: false,
    startupPresentation: "browser",
    desktopBootstrapToken: undefined,
    desktopTelemetryFd: undefined,
    desktopTelemetryControlFd: undefined,
    resourceMonitorPath: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  };
  return ServerConfig.layer({ ...base, ...overrides });
}

function runStart(input: {
  readonly config?: Partial<ServerConfig.ServerConfig["Service"]>;
  readonly env?: Record<string, string>;
  readonly platform?: NodeJS.Platform;
  readonly httpStatus?: number;
  readonly onSpawn?: (command: ChildProcess.StandardCommand) => void;
  readonly onKill?: (options?: ChildProcess.KillOptions) => void;
  readonly failSpawn?: boolean;
}) {
  return Effect.service(CacmDaemonProcess.CacmDaemonProcess).pipe(
    Effect.flatMap((daemonProcess) => daemonProcess.start),
    Effect.provide(
      CacmDaemonProcess.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeServerConfig(input.config),
            Layer.succeed(HostProcessPlatform, input.platform ?? "win32"),
            Layer.succeed(HostProcessEnvironment, input.env ?? {}),
            makeSpawner({
              ...(input.onSpawn ? { onSpawn: input.onSpawn } : {}),
              ...(input.onKill ? { onKill: input.onKill } : {}),
              ...(input.failSpawn ? { failSpawn: true } : {}),
            }),
            makeHttpClient(input.httpStatus ?? 200),
          ),
        ),
      ),
    ),
  );
}

describe("resolveBinaryCandidates", () => {
  it("prefers the env override and appends repo cargo target dirs", () => {
    assert.deepEqual(
      CacmDaemonProcess.resolveBinaryCandidates(
        "win32",
        "E:/SPEG/t3code/apps/server/src/speg",
        { T3CODE_CACM_DAEMON_PATH: "C:/custom/cacm-daemon.exe" },
      ),
      [
        "C:/custom/cacm-daemon.exe",
        "E:/SPEG/t3code/apps/server/src/speg/../../../../cacm/target/release/cacm-daemon.exe",
        "E:/SPEG/t3code/apps/server/src/speg/../../../../cacm/target/debug/cacm-daemon.exe",
        "E:/SPEG/t3code/apps/server/src/speg/cacm-daemon.exe",
      ],
    );
  });

  it("drops the override when empty and uses the platform binary name", () => {
    const candidates = CacmDaemonProcess.resolveBinaryCandidates(
      "darwin",
      "/repo/apps/server/src/speg",
    );
    assert.equal(candidates.length, 3);
    assert.ok(candidates[0]!.endsWith("cacm/target/release/cacm-daemon"));
    assert.ok(candidates[1]!.endsWith("cacm/target/debug/cacm-daemon"));
    assert.equal(candidates[2], "/repo/apps/server/src/speg/cacm-daemon");
  });
});

describe("resolveAllowedOrigins", () => {
  it("includes the dev URL, both loopback spellings of the web port, and tailnet origins", () => {
    assert.deepEqual(
      CacmDaemonProcess.resolveAllowedOrigins({
        mode: "web",
        devUrl: new URL("http://localhost:5733"),
        devAllowedOrigins: ["https://machine.tailnet.ts.net"],
        webPort: 5733,
      }),
      ["http://localhost:5733", "https://machine.tailnet.ts.net", "http://127.0.0.1:5733"],
    );
  });

  it("allows the null origin for the production desktop renderer only", () => {
    assert.deepEqual(
      CacmDaemonProcess.resolveAllowedOrigins({
        mode: "desktop",
        devUrl: undefined,
        devAllowedOrigins: [],
        webPort: undefined,
      }),
      ["null"],
    );
    assert.deepEqual(
      CacmDaemonProcess.resolveAllowedOrigins({
        mode: "desktop",
        devUrl: new URL("http://127.0.0.1:5733"),
        devAllowedOrigins: [],
        webPort: 5733,
      }),
      ["http://127.0.0.1:5733", "http://localhost:5733"],
    );
  });
});

describe("CacmDaemonProcess start", () => {
  it.effect("returns disabled when the autostart env kill-switch is set", () =>
    Effect.gen(function* () {
      let spawned = false;
      const status = yield* runStart({
        env: { T3CODE_CACM_DAEMON_AUTOSTART: "0" },
        onSpawn: () => {
          spawned = true;
        },
      });

      assert.deepEqual(status, { status: "disabled" });
      assert.equal(spawned, false);
    }),
  );

  it.effect("reuses an already-running daemon instead of spawning", () =>
    Effect.gen(function* () {
      let spawned = false;
      const status = yield* runStart({
        httpStatus: 200,
        onSpawn: () => {
          spawned = true;
        },
      });

      assert.deepEqual(status, { status: "already-running" });
      assert.equal(spawned, false);
    }),
  );

  it.effect("spawns the daemon with the expected args and kills it when the scope closes", () =>
    Effect.gen(function* () {
      let spawnedCommand: ChildProcess.StandardCommand | undefined;
      let killed = false;
      let killOptions: ChildProcess.KillOptions | undefined;

      const status = yield* Effect.scoped(
        runStart({
          env: { T3CODE_CACM_DAEMON_PATH: process.execPath, PORT: "5733" },
          config: { mode: "web", devUrl: new URL("http://localhost:5733") },
          httpStatus: 503,
          onSpawn: (command) => {
            spawnedCommand = command;
          },
          onKill: (options) => {
            killed = true;
            killOptions = options;
          },
        }),
      );

      assert.deepEqual(status, { status: "started", pid: TEST_PID });
      assert.equal(killed, true, "the daemon child must be killed on scope close");
      assert.ok(
        killOptions?.forceKillAfter !== undefined,
        "kill must carry forceKillAfter so a SIGTERM-ignoring daemon cannot hang shutdown",
      );
      assert.ok(spawnedCommand);
      assert.equal(spawnedCommand!.command, process.execPath);
      assert.deepEqual(spawnedCommand!.args, [
        "--host",
        "127.0.0.1",
        "--port",
        "9786",
        "--allow-origin",
        "http://localhost:5733",
        "--allow-origin",
        "http://127.0.0.1:5733",
      ]);
    }),
  );

  it.effect("reports a failed spawn without throwing", () =>
    Effect.gen(function* () {
      const status = yield* Effect.scoped(
        runStart({
          env: { T3CODE_CACM_DAEMON_PATH: process.execPath },
          httpStatus: 503,
          failSpawn: true,
        }),
      );

      assert.ok(status.status === "failed");
      assert.match(status.reason, /Failed to start cacm-daemon/);
    }),
  );

  it.effect("restart kills the owned child and spawns a fresh one", () =>
    Effect.gen(function* () {
      let spawnCount = 0;
      let killCount = 0;

      // First start spawns a daemon (healthz 503 → spawn). The restart's
      // kill lands on the owned child; the port is then free (healthz 503),
      // so a second spawn happens.
      const status = yield* Effect.scoped(
        Effect.gen(function* () {
          const daemonProcess = yield* CacmDaemonProcess.CacmDaemonProcess;
          const first = yield* daemonProcess.start;
          assert.deepEqual(first, { status: "started", pid: TEST_PID });
          const second = yield* daemonProcess.restart;
          assert.deepEqual(second, { status: "started", pid: TEST_PID });
        }).pipe(
          Effect.provide(
            CacmDaemonProcess.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  makeServerConfig({
                    mode: "web",
                    devUrl: new URL("http://localhost:5733"),
                  }),
                  Layer.succeed(HostProcessPlatform, "win32"),
                  Layer.succeed(HostProcessEnvironment, {
                    T3CODE_CACM_DAEMON_PATH: process.execPath,
                    PORT: "5733",
                  }),
                  makeSpawner({
                    onSpawn: () => {
                      spawnCount += 1;
                    },
                    onKill: () => {
                      killCount += 1;
                    },
                  }),
                  makeHttpClient(503),
                ),
              ),
            ),
          ),
        ),
      );

      assert.equal(spawnCount, 2, "restart must spawn a fresh daemon");
      assert.ok(killCount >= 1, "restart must stop the owned child");
    }),
  );

  it.effect("restart without an owned child kills the stale daemon by pid", () =>
    Effect.gen(function* () {
      let spawnCount = 0;
      let pidServedRef = false;
      // No prior start → no owned child. The /healthz json carries a stale
      // pid; restart must kill it by pid, then spawn a fresh daemon.
      const status = yield* Effect.scoped(
        Effect.gen(function* () {
          const daemonProcess = yield* CacmDaemonProcess.CacmDaemonProcess;
          return yield* daemonProcess.restart;
        }).pipe(
          Effect.provide(
            CacmDaemonProcess.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  makeServerConfig({
                    mode: "web",
                    devUrl: new URL("http://localhost:5733"),
                  }),
                  Layer.succeed(HostProcessPlatform, "win32"),
                  Layer.succeed(HostProcessEnvironment, {
                    T3CODE_CACM_DAEMON_PATH: process.execPath,
                    PORT: "5733",
                  }),
                  makeSpawner({
                    onSpawn: () => {
                      spawnCount += 1;
                    },
                  }),
                  // Healthz answers with a stale pid body once (probePid),
                  // then 503 so waitForPortFree sees the port free.
                  Layer.succeed(
                    HttpClient.HttpClient,
                    HttpClient.make((request) => {
                      if (!pidServedRef) {
                        pidServedRef = true;
                        return Effect.succeed(
                          HttpClientResponse.fromWeb(
                            request,
                            new Response(JSON.stringify({ status: "ok", pid: 9999 }), {
                              status: 200,
                            }),
                          ),
                        );
                      }
                      return Effect.succeed(
                        HttpClientResponse.fromWeb(request, new Response(null, { status: 503 })),
                      );
                    }),
                  ),
                ),
              ),
            ),
          ),
        ),
      );

      assert.deepEqual(status, { status: "started", pid: TEST_PID });
      // One spawn for taskkill (killing the stale daemon) + one for the
      // fresh daemon process itself.
      assert.equal(spawnCount, 2, "stale daemon must be replaced by a fresh spawn");
    }),
  );

  it.effect("start and restart are serialized so they cannot interleave", () =>
    Effect.gen(function* () {
      let spawnCount = 0;
      const status = yield* Effect.scoped(
        Effect.gen(function* () {
          const daemonProcess = yield* CacmDaemonProcess.CacmDaemonProcess;
          // Fire start and restart concurrently: the mutex serializes them.
          const [a, b] = yield* Effect.all(
            [daemonProcess.start, daemonProcess.restart],
            { concurrency: "unbounded" },
          );
          assert.deepEqual(a, { status: "started", pid: TEST_PID });
          assert.deepEqual(b, { status: "started", pid: TEST_PID });
        }).pipe(
          Effect.provide(
            CacmDaemonProcess.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  makeServerConfig({
                    mode: "web",
                    devUrl: new URL("http://localhost:5733"),
                  }),
                  Layer.succeed(HostProcessPlatform, "win32"),
                  Layer.succeed(HostProcessEnvironment, {
                    T3CODE_CACM_DAEMON_PATH: process.execPath,
                    PORT: "5733",
                  }),
                  makeSpawner({
                    onSpawn: () => {
                      spawnCount += 1;
                    },
                  }),
                  makeHttpClient(503),
                ),
              ),
            ),
          ),
        ),
      );

      // Serialized: exactly two spawns total (one per operation), never a
      // third interleaved one, and no deadlock.
      assert.equal(spawnCount, 2);
    }),
  );
});
