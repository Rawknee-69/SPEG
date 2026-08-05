// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { JcodeSettings } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";

import { isCredentialInheritanceFailure, makeJcodeProcessManager } from "./JcodeProcessManager.ts";

const decodeJcodeSettings = Schema.decodeSync(JcodeSettings);

class FakeSdkClient {
  public closed = false;
  public closeCalls = 0;
  public pingCalls = 0;
  public readonly handlers: Record<string, (error?: Error) => void> = {};

  once(name: string, handler: (error?: Error) => void) {
    this.handlers[name] = handler;
    return this;
  }

  fireClose(error?: Error) {
    this.handlers.close?.(error);
  }

  close() {
    this.closeCalls += 1;
    this.closed = true;
    return Promise.resolve();
  }

  ping() {
    this.pingCalls += 1;
    return Promise.resolve();
  }

  get instanceHome(): string | undefined {
    return undefined;
  }
}

function epermSymlinkError(): Error & { code: string } {
  const error = new Error(
    "EPERM: operation not permitted, symlink 'C:\\Users\\x\\.codex\\auth.json' -> 'C:\\Users\\x\\AppData\\Local\\Temp\\jcode-sdk-instance-abc\\external\\.codex\\auth.json'",
  ) as Error & { code: string };
  error.code = "EPERM";
  return error;
}

it("isCredentialInheritanceFailure detects EPERM symlink failures only", () => {
  NodeAssert.equal(isCredentialInheritanceFailure(epermSymlinkError()), true);
  NodeAssert.equal(
    isCredentialInheritanceFailure(new Error("EPERM: operation not permitted, mkdir")),
    false,
  );
  NodeAssert.equal(
    isCredentialInheritanceFailure(new Error("startup_failed: jcode exited")),
    false,
  );
  NodeAssert.equal(isCredentialInheritanceFailure("not an error"), false);
});

const launchMock = vi.hoisted(() =>
  vi.fn<(args: { inheritLogins: boolean }) => Promise<unknown>>(),
);
vi.mock("@1jehuang/jcode-sdk", () => ({
  JcodeClient: { launch: (args: { inheritLogins: boolean }) => launchMock(args) },
}));

it("JcodeProcessManager: getClient is lazy, reuses the client, and closes it on close()", () =>
  Effect.gen(function* () {
    const client = new FakeSdkClient();
    launchMock.mockReset();
    launchMock.mockResolvedValue(client);
    const manager = yield* makeJcodeProcessManager(decodeJcodeSettings({}));

    NodeAssert.equal(launchMock.mock.calls.length, 0, "launch must be lazy");
    const first = yield* Effect.promise(() => manager.getClient());
    NodeAssert.equal(launchMock.mock.calls.length, 1);
    const second = yield* Effect.promise(() => manager.getClient());
    NodeAssert.equal(launchMock.mock.calls.length, 1, "second getClient reuses the client");
    NodeAssert.equal(first, second);

    yield* Effect.promise(() => manager.ping());
    NodeAssert.equal(client.pingCalls, 1);

    yield* Effect.promise(() => manager.close());
    NodeAssert.equal(client.closeCalls, 1);
    // After close, getClient rejects instead of launching again.
    const result = yield* Effect.promise(() => manager.getClient()).pipe(Effect.result);
    NodeAssert.equal(result._tag, "Failure");
    NodeAssert.equal(launchMock.mock.calls.length, 1);
  }));

it("JcodeProcessManager: falls back to inheritLogins:false on EPERM credential failure", () =>
  Effect.gen(function* () {
    const client = new FakeSdkClient();
    launchMock.mockReset();
    launchMock.mockRejectedValueOnce(epermSymlinkError());
    launchMock.mockResolvedValueOnce(client);
    const manager = yield* makeJcodeProcessManager(decodeJcodeSettings({}));

    const resolved = yield* Effect.promise(() => manager.getClient());
    NodeAssert.equal(resolved, client);
    NodeAssert.equal(launchMock.mock.calls.length, 2);
    NodeAssert.equal(launchMock.mock.calls[0]![0].inheritLogins, true);
    NodeAssert.equal(launchMock.mock.calls[1]![0].inheritLogins, false);

    yield* Effect.promise(() => manager.close());
  }));

it("JcodeProcessManager: a non-credential launch failure propagates", () =>
  Effect.gen(function* () {
    launchMock.mockReset();
    launchMock.mockRejectedValueOnce(new Error("startup_failed: jcode exited during startup"));
    const manager = yield* makeJcodeProcessManager(decodeJcodeSettings({}));

    const result = yield* Effect.promise(() => manager.getClient()).pipe(Effect.result);
    NodeAssert.equal(result._tag, "Failure");
    NodeAssert.equal(launchMock.mock.calls.length, 1, "no retry for non-EPERM failures");
  }));

it("JcodeProcessManager: close() during an in-flight launch closes the spawned daemon", () =>
  Effect.gen(function* () {
    const client = new FakeSdkClient();
    let resolveLaunch: ((value: FakeSdkClient) => void) | undefined;
    launchMock.mockReset();
    launchMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLaunch = resolve;
        }),
    );
    const manager = yield* makeJcodeProcessManager(decodeJcodeSettings({}));

    const pendingGet = manager.getClient();
    yield* Effect.promise(() => manager.close());
    // The in-flight launch resolves after close() finished.
    resolveLaunch!(client);
    const result = yield* Effect.promise(() => pendingGet).pipe(Effect.result);
    NodeAssert.equal(result._tag, "Success", "in-flight launch still resolves");
    NodeAssert.equal(client.closeCalls, 1, "the daemon spawned during close() is closed");
  }));

it("JcodeProcessManager: an unexpected transport close triggers a bounded auto-restart", () =>
  Effect.gen(function* () {
    const first = new FakeSdkClient();
    const second = new FakeSdkClient();
    launchMock.mockReset();
    launchMock.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const manager = yield* makeJcodeProcessManager(decodeJcodeSettings({}));

    yield* Effect.promise(() => manager.getClient());
    NodeAssert.equal(launchMock.mock.calls.length, 1);
    first.fireClose();

    // Wait for the restart backoff (1s for the first attempt) to elapse.
    yield* Effect.sleep(Duration.millis(1500));
    const restarted = yield* Effect.promise(() => manager.getClient());
    NodeAssert.equal(restarted, second);
    NodeAssert.equal(launchMock.mock.calls.length, 2);

    yield* Effect.promise(() => manager.close());
  }));
