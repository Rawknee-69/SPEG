import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ServerSettings as ServerSettingsType,
  VcsRepositoryNotFoundError,
  VcsGitInitMode,
} from "@speg/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerSettings from "../serverSettings.ts";
import * as VcsProcess from "./VcsProcess.ts";
import * as VcsProjectConfig from "./VcsProjectConfig.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

const processOutput = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const normalizeGitArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> =>
  args[0] === "-C" && args.length >= 2 ? args.slice(2) : args;

const notARepository = () => ({
  ...processOutput(""),
  exitCode: ChildProcessSpawner.ExitCode(128),
  stderr: "fatal: not a git repository",
});

const registryTestLayer = (input: {
  readonly vcsGitInitMode?: VcsGitInitMode;
  readonly run: VcsProcess.VcsProcess["Service"]["run"];
}) =>
  Layer.effect(VcsDriverRegistry.VcsDriverRegistry, VcsDriverRegistry.make).pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(VcsProjectConfig.VcsProjectConfig)({
        resolveKind: (input) => Effect.succeed(input.requestedKind ?? "auto"),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsProcess.VcsProcess)({
        run: input.run,
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        vcsGitInitMode: input.vcsGitInitMode ?? "ask",
      } as Partial<ServerSettingsType>),
    ),
  );

describe("VcsDriverRegistry", () => {
  it.effect("routes directly by VCS driver kind for non-repository workflows", () => {
    const layer = registryTestLayer({
      run: () => Effect.succeed(processOutput("")),
    });

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const driver = yield* registry.get("git");

      assert.strictEqual(driver.capabilities.kind, "git");
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches repository detection for repeated resolves in the same cwd and kind", () => {
    const calls: VcsProcess.VcsProcessInput[] = [];
    const layer = registryTestLayer({
      run: (input) => {
        calls.push(input);
        const normalizedArgs =
          input.args[0] === "-C" && input.args.length >= 2 ? input.args.slice(2) : input.args;
        const command = normalizedArgs.join(" ");
        if (command === "rev-parse --is-inside-work-tree") {
          return Effect.succeed(processOutput("true\n"));
        }
        if (command === "rev-parse --show-toplevel") {
          return Effect.succeed(processOutput("/repo\n"));
        }
        if (command === "rev-parse --git-common-dir") {
          return Effect.succeed(processOutput("/repo/.git\n"));
        }
        return Effect.succeed(processOutput(""));
      },
    });

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const first = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });
      const second = yield* registry.resolve({ cwd: "/repo", requestedKind: "git" });

      assert.equal(first.repository.rootPath, "/repo");
      assert.equal(second.repository.rootPath, "/repo");
      assert.deepStrictEqual(
        calls.map((call) => normalizeGitArgs(call.args).join(" ")),
        [
          "rev-parse --is-inside-work-tree",
          "rev-parse --show-toplevel",
          "rev-parse --git-common-dir",
        ],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("detects a repository created after a negative lookup", () => {
    let insideWorkTreeChecks = 0;
    const layer = registryTestLayer({
      run: (input) =>
        Effect.sync(() => {
          const command = normalizeGitArgs(input.args).join(" ");
          if (command === "rev-parse --is-inside-work-tree") {
            insideWorkTreeChecks += 1;
            return insideWorkTreeChecks === 1 ? notARepository() : processOutput("true\n");
          }
          if (command === "rev-parse --show-toplevel") {
            return processOutput("/repo\n");
          }
          if (command === "rev-parse --git-common-dir") {
            return processOutput("/repo/.git\n");
          }
          return processOutput("");
        }),
    });

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

      assert.equal(yield* registry.detect({ cwd: "/repo" }), null);
      assert.equal((yield* registry.detect({ cwd: "/repo" }))?.repository.rootPath, "/repo");
      assert.equal(insideWorkTreeChecks, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "auto-initializes a repository on resolve when no repo is detected and mode is auto",
    () => {
      let insideWorkTreeChecks = 0;
      const initCalls: VcsProcess.VcsProcessInput[] = [];
      const layer = registryTestLayer({
        vcsGitInitMode: "auto",
        run: (input) =>
          Effect.sync(() => {
            const command = normalizeGitArgs(input.args).join(" ");
            if (command === "rev-parse --is-inside-work-tree") {
              insideWorkTreeChecks += 1;
              return insideWorkTreeChecks === 1 ? notARepository() : processOutput("true\n");
            }
            if (command === "init") {
              initCalls.push(input);
              return processOutput("");
            }
            if (command === "rev-parse --show-toplevel") {
              return processOutput("/repo\n");
            }
            if (command === "rev-parse --git-common-dir") {
              return processOutput("/repo/.git\n");
            }
            return processOutput("");
          }),
      });

      return Effect.gen(function* () {
        const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
        const handle = yield* registry.resolve({ cwd: "/repo" });

        assert.equal(handle.kind, "git");
        assert.equal(handle.repository.rootPath, "/repo");
        assert.equal(initCalls.length, 1);
        assert.deepStrictEqual(normalizeGitArgs(initCalls[0]!.args), ["init"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("does not auto-initialize when mode is ask and no repo is detected", () => {
    const initCalls: VcsProcess.VcsProcessInput[] = [];
    const layer = registryTestLayer({
      vcsGitInitMode: "ask",
      run: (input) =>
        Effect.sync(() => {
          const command = normalizeGitArgs(input.args).join(" ");
          if (command === "init") {
            initCalls.push(input);
            return processOutput("");
          }
          return notARepository();
        }),
    });

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const error = yield* registry.resolve({ cwd: "/repo" }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "VcsRepositoryNotFoundError");
      if (!Schema.is(VcsRepositoryNotFoundError)(error)) {
        throw new Error("Expected VcsRepositoryNotFoundError");
      }
      assert.equal(error.cwd, "/repo");
      assert.equal(error.message, "No supported VCS repository was detected at /repo.");
      assert.equal(initCalls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not auto-initialize when mode is off and no repo is detected", () => {
    const initCalls: VcsProcess.VcsProcessInput[] = [];
    const layer = registryTestLayer({
      vcsGitInitMode: "off",
      run: (input) =>
        Effect.sync(() => {
          const command = normalizeGitArgs(input.args).join(" ");
          if (command === "init") {
            initCalls.push(input);
            return processOutput("");
          }
          return notARepository();
        }),
    });

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const error = yield* registry.resolve({ cwd: "/repo" }).pipe(Effect.flip);

      assert.strictEqual(error._tag, "VcsRepositoryNotFoundError");
      assert.equal(initCalls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not auto-initialize when a specific kind was requested but not found", () => {
    const initCalls: VcsProcess.VcsProcessInput[] = [];
    const layer = registryTestLayer({
      vcsGitInitMode: "auto",
      run: (input) =>
        Effect.sync(() => {
          const command = normalizeGitArgs(input.args).join(" ");
          if (command === "init") {
            initCalls.push(input);
            return processOutput("");
          }
          return notARepository();
        }),
    });

    return Effect.gen(function* () {
      const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
      const error = yield* registry
        .resolve({ cwd: "/repo", requestedKind: "git" })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "VcsRepositoryNotFoundError");
      assert.equal(initCalls.length, 0);
    }).pipe(Effect.provide(layer));
  });
});
