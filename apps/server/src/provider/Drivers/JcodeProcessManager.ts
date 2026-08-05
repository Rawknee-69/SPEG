/**
 * JcodeProcessManager — lifecycle owner of the private jcode daemon for one
 * provider instance.
 *
 * Embeds jcode as an agent engine: `JcodeClient.launch()` starts a private
 * `jcode api-bridge` (the Rust daemon shipped by `@1jehuang/jcode-sdk`, or the
 * binary selected via `JcodeSettings.binaryPath`) with its own state
 * directory, sockets, and sessions — it cannot see or disturb the jcode the
 * user runs in a terminal. `close()` shuts it down.
 *
 * Responsibilities:
 *   - **Spawn** — resolve the binary (settings → SDK-bundled platform package
 *     → `jcode` on PATH) and launch the daemon on first use.
 *   - **Health check** — `ping()` round-trips through the harness socket.
 *   - **Auto-restart** — when the transport closes unexpectedly, the daemon
 *     is re-launched after a bounded backoff; a failed restart leaves the
 *     manager ready for the next `getClient()` to retry.
 *   - **Shutdown** — `close()` stops the daemon and (for an ephemeral home)
 *     removes the temporary state directory.
 *
 * One manager per provider instance: `Drivers/JcodeDriver.create()` builds
 * one and passes `getClient` to the adapter as its `clientSource`. With a
 * persistent `jcodeHome`, transcripts survive daemon restarts and the
 * adapter's resume cursor re-adopts the same session id afterwards.
 *
 * The SDK is promise/EventEmitter-based, so the manager's public surface is
 * async; the auto-restart timer runs through the Effect runtime captured at
 * construction so the codebase's Effect-only timer/log rules hold.
 *
 * @module provider/Drivers/JcodeProcessManager
 */
import { JcodeClient, type LaunchOptions } from "@1jehuang/jcode-sdk";
import type { JcodeSettings } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const RESTART_BACKOFF_MS = 1_000;
const MAX_RESTART_ATTEMPTS = 3;

export interface JcodeProcessManagerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly workingDir?: string;
}

export interface JcodeProcessManager {
  /**
   * The current connected client, (re)launching the daemon if needed.
   * Rejects when the binary cannot be started.
   */
  readonly getClient: () => Promise<JcodeClient>;
  /** Liveness probe through the harness socket; re-launches once on failure. */
  readonly ping: () => Promise<void>;
  /** State directory of the launched instance, if any. */
  readonly instanceHome: () => string | undefined;
  /** Stop the daemon and release its resources. Idempotent. */
  readonly close: () => Promise<void>;
}

/**
 * Resolve the binary to hand to `JcodeClient.launch`. The settings default
 * (`"jcode"`) means "let the SDK decide" — bundled platform package first,
 * then `jcode` on PATH — so we return `undefined` for it and only pin a
 * concrete path when the user configured one.
 */
function resolveBinary(binaryPath: string): string | undefined {
  const trimmed = binaryPath.trim();
  return trimmed.length > 0 && trimmed !== "jcode" ? trimmed : undefined;
}

function cleanProcessEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export const makeJcodeProcessManager = Effect.fn("makeJcodeProcessManager")(function* (
  jcodeSettings: JcodeSettings,
  options?: JcodeProcessManagerOptions,
): Effect.fn.Return<JcodeProcessManager, never> {
  // Effect runtime for the auto-restart timer + error logging, which fire
  // from inside an SDK EventEmitter callback (no Effect context there).
  const runtimeContext = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(runtimeContext);

  let client: JcodeClient | undefined;
  let launching: Promise<JcodeClient> | undefined;
  let restartFiber: ReturnType<typeof runFork> | undefined;
  let restartAttempts = 0;
  let closed = false;
  // The SDK exposes no public "closed" flag; track transport closure here so
  // getClient can detect a stale client without waiting for a request to fail.
  const closedClients = new WeakSet<JcodeClient>();

  const launchOptions = (inheritLogins: boolean): LaunchOptions => {
    const binary = resolveBinary(jcodeSettings.binaryPath);
    const jcodeHome = jcodeSettings.jcodeHome.trim();
    return {
      workingDir: options?.workingDir ?? process.cwd(),
      ...(binary !== undefined ? { binary } : {}),
      ...(jcodeHome.length > 0 ? { jcodeHome } : {}),
      inheritLogins,
      startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
      ...(options?.environment ? { env: cleanProcessEnv(options.environment) } : {}),
    };
  };

  const launch = (): Promise<JcodeClient> => {
    if (launching) {
      return launching;
    }
    launching = (async () => {
      // Credential inheritance symlinks the user's provider auth files into
      // the instance home. On Windows without Developer Mode (or on other
      // restricted platforms) that symlink can fail with EPERM, so fall back
      // to an empty instance rather than failing the whole provider. The
      // user can still supply credentials via `set_api_key` later.
      const launched = await JcodeClient.launch(launchOptions(true)).catch(
        async (cause: unknown) => {
          if (!isCredentialInheritanceFailure(cause)) {
            throw cause;
          }
          runFork(
            Effect.logWarning(
              `[jcode] credential inheritance is unavailable on this platform (${errorMessage(cause)}); launching without inherited logins.`,
            ),
          );
          return JcodeClient.launch(launchOptions(false));
        },
      );
      // A transport-level close (daemon crash / socket drop) triggers an
      // auto-restart. `close()` detaches this handler first.
      launched.once("close", () => onUnexpectedClose(launched));
      client = launched;
      return launched;
    })().finally(() => {
      launching = undefined;
    });
    return launching;
  };

  const launchOrExisting = (): Promise<JcodeClient> => {
    if (closed) {
      return Promise.reject(new Error("jcode process manager is closed."));
    }
    if (client && !closedClients.has(client)) {
      return Promise.resolve(client);
    }
    if (client) {
      client = undefined;
    }
    return launch();
  };

  const scheduleRestart = (): void => {
    if (restartFiber || restartAttempts >= MAX_RESTART_ATTEMPTS) {
      // A restart is already scheduled, or we gave up on eager restarts
      // (the next getClient() retries on demand).
      return;
    }
    restartAttempts += 1;
    restartFiber = runFork(
      Effect.sleep(Duration.millis(RESTART_BACKOFF_MS * restartAttempts)).pipe(
        Effect.andThen(() =>
          Effect.promise(() => launch()).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(
                `[jcode] daemon restart attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS} failed`,
                { cause },
              ),
            ),
          ),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            restartFiber = undefined;
          }),
        ),
      ),
    );
  };

  const onUnexpectedClose = (closedClient: JcodeClient): void => {
    if (closed || client !== closedClient) {
      return;
    }
    closedClients.add(closedClient);
    client = undefined;
    scheduleRestart();
  };

  return {
    getClient: launchOrExisting,
    ping: async () => {
      const current = await launchOrExisting();
      try {
        await current.ping();
      } catch (cause) {
        // One transparent retry through a fresh launch before surfacing.
        if (!(cause instanceof Error) || !clientClosedCause(cause)) {
          throw cause;
        }
        const relaunched = await launch();
        await relaunched.ping();
      }
    },
    instanceHome: () => client?.instanceHome,
    close: async () => {
      closed = true;
      if (restartFiber) {
        runFork(Fiber.interrupt(restartFiber).pipe(Effect.ignore));
        restartFiber = undefined;
      }
      // If a launch is in flight, wait for it to settle and close the result
      // so we never orphan a freshly spawned daemon after shutdown.
      const inflight = launching;
      if (inflight) {
        try {
          const launched = await inflight;
          closedClients.add(launched);
          await launched.close();
        } catch {
          // The in-flight launch failed; nothing to tear down.
        }
      }
      const current = client;
      client = undefined;
      if (current) {
        closedClients.add(current);
        await current.close();
      }
    },
  };
});

function clientClosedCause(cause: Error): boolean {
  const message = cause.message.toLowerCase();
  return message.includes("closed") || message.includes("disconnected");
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Whether a launch failure is the credential-inheritance symlink step. */
export function isCredentialInheritanceFailure(cause: unknown): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }
  const message = cause.message;
  return (
    (cause as Error & { code?: string }).code === "EPERM" &&
    (message.includes("symlink") || message.includes("credential") || message.includes("inherit"))
  );
}
