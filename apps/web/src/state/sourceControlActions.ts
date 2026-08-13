import { useAtomValue } from "@effect/atom-react";
import type {
  AtomCommandFailure,
  AtomCommandResult,
  AtomCommandSuccess,
} from "@speg/client-runtime/state/runtime";
import { runAtomCommand } from "@speg/client-runtime/state/runtime";
import { VcsActionUnavailableError, type VcsActionOperation } from "@speg/client-runtime/state/vcs";
import type {
  EnvironmentId,
  GitActionProgressEvent,
  GitResolvePullRequestResult,
  GitStackedAction,
  SourceControlCloneProtocol,
  SourceControlRepositoryVisibility,
  ThreadId,
} from "@speg/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { ensureLocalApi, readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { gitEnvironment } from "./git";
import { useEnvironmentQuery } from "./query";
import { primaryServerSettingsAtom } from "./server";
import { sourceControlEnvironment } from "./sourceControl";
import { useAtomCommand } from "./use-atom-command";
import { vcsActionManager, vcsEnvironment } from "./vcs";

export type SourceControlActionKind =
  | "init"
  | "pull"
  | "publishRepository"
  | "runStackedAction"
  | "preparePullRequestThread";

export interface SourceControlActionScope {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

interface SourceControlActionState<
  TArgs extends ReadonlyArray<unknown>,
  R extends AtomCommandResult<unknown, unknown>,
> {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly run: (
    ...args: TArgs
  ) => Promise<
    AtomCommandResult<
      AtomCommandSuccess<R>,
      AtomCommandFailure<R> | VcsActionUnavailableError | GitRepositoryNotInitializedError
    >
  >;
  readonly resetError: () => void;
}

const ACTION_OPERATION = {
  init: "init",
  pull: "pull",
  publishRepository: "publish_repository",
  runStackedAction: "run_change_request",
  preparePullRequestThread: "prepare_pull_request_thread",
} as const satisfies Record<SourceControlActionKind, VcsActionOperation>;

function useAction<
  TArgs extends ReadonlyArray<unknown>,
  R extends AtomCommandResult<unknown, unknown>,
>(input: {
  readonly kind: SourceControlActionKind;
  readonly label: string;
  readonly scope: SourceControlActionScope;
  readonly action: (...args: TArgs) => Promise<R>;
  readonly onSuccess?: () => void;
  readonly managedExternally?: boolean;
}): SourceControlActionState<TArgs, R> {
  const operation = ACTION_OPERATION[input.kind];
  const state = useAtomValue(vcsActionManager.stateAtom(input.scope));
  const ownsState = state.operation === operation;

  const resetError = useCallback(() => {
    vcsActionManager.resetError(appAtomRegistry, input.scope, operation);
  }, [input.scope, operation]);

  const run = useCallback(
    async (...args: TArgs) => {
      const provisioning = await ensureRepositoryInitialized(input.scope, input.kind);
      if (provisioning === "declined") {
        const target = resolveScope(input.scope);
        return AsyncResult.failure<never, GitRepositoryNotInitializedError>(
          Cause.fail(new GitRepositoryNotInitializedError(target?.cwd ?? "this folder")),
        );
      }
      const execute = async (): Promise<
        AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R>>
      > => {
        const result = await input.action(...args);
        if (AsyncResult.isSuccess(result)) {
          input.onSuccess?.();
        }
        return result as AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R>>;
      };
      return input.managedExternally === true
        ? execute()
        : vcsActionManager.track(
            appAtomRegistry,
            input.scope,
            {
              operation,
              label: input.label,
            },
            execute,
          );
    },
    [input.action, input.label, input.managedExternally, input.onSuccess, input.scope, operation],
  );

  return {
    error: ownsState ? state.error : null,
    isPending: ownsState && state.isRunning,
    resetError,
    run,
  };
}

function resolveScope(scope: SourceControlActionScope) {
  if (scope.environmentId === null || scope.cwd === null) {
    return null;
  }
  return {
    environmentId: scope.environmentId,
    cwd: scope.cwd,
  };
}

export class GitRepositoryNotInitializedError extends Error {
  constructor(readonly cwd: string) {
    super(`No Git repository was detected at ${cwd}. Initialize Git to use source control.`);
    this.name = "GitRepositoryNotInitializedError";
  }
}

async function initializeRepository(target: { environmentId: EnvironmentId; cwd: string }) {
  await runAtomCommand(
    appAtomRegistry,
    vcsEnvironment.init,
    {
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    },
    { reportFailure: false },
  );
}

/**
 * Ensures a repository exists for the scope before a source-control action
 * runs, honoring the "vcsGitInitMode" setting:
 *
 * - "auto": initialize Git automatically when no repository exists in the
 *   directory or any ancestor (the server performs the same check, so a
 *   nested folder inside an existing repo is never re-initialized).
 * - "ask": prompt the user first; only initialize on approval. A declined
 *   prompt reports "not initialized" and does not run the action.
 * - "off": never initialize; the action runs and surfaces the server's
 *   "no repository detected" error.
 *
 * Returns "ready" when the action may proceed, "declined" when the user
 * declined to initialize, and "unknown" when the repository state is not
 * known yet (the action runs and the server decides).
 */
async function ensureRepositoryInitialized(
  scope: SourceControlActionScope,
  kind: SourceControlActionKind,
): Promise<"ready" | "declined" | "unknown"> {
  if (kind === "init") {
    return "ready";
  }
  const target = resolveScope(scope);
  if (target === null) {
    return "unknown";
  }

  const mode = appAtomRegistry.get(primaryServerSettingsAtom).vcsGitInitMode;
  if (mode === "off") {
    return "ready";
  }

  const status = appAtomRegistry.get(
    vcsEnvironment.status({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    }),
  );
  const current = Option.getOrNull(AsyncResult.value(status));
  // `current` may be null until the status subscription has produced a
  // snapshot; an existing repository is also "ready".
  if (current?.isRepo === true) {
    return "ready";
  }
  if (current === null) {
    return "unknown";
  }

  // No repository exists in the directory or any of its ancestors.
  if (mode === "auto") {
    await initializeRepository(target);
    return "ready";
  }

  const api = readLocalApi() ?? ensureLocalApi();
  const confirmed = await api.dialogs.confirm(
    `No Git repository was found in ${target.cwd}.\n\nInitialize Git here so you can use source control?`,
  );
  if (!confirmed) {
    return "declined";
  }
  await initializeRepository(target);
  return "ready";
}

export function useSourceControlActionRunning(
  scope: SourceControlActionScope,
  kinds: ReadonlyArray<SourceControlActionKind>,
): boolean {
  const state = useAtomValue(vcsActionManager.stateAtom(scope));
  return (
    state.isRunning &&
    state.operation !== null &&
    kinds.some((kind) => ACTION_OPERATION[kind] === state.operation)
  );
}

export function useVcsInitAction(scope: SourceControlActionScope) {
  const init = useAtomCommand(vcsEnvironment.init, { reportFailure: false });
  const action = useCallback(async () => {
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "init",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    return init({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  }, [init, scope]);
  return useAction({ kind: "init", label: "Initializing repository", scope, action });
}

export function useVcsPullAction(scope: SourceControlActionScope) {
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = useCallback(async () => {
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "pull",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    return pull({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  }, [pull, scope]);
  return useAction({
    kind: "pull",
    label: "Pulling latest changes",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export function useGitStackedAction(scope: SourceControlActionScope) {
  const runStackedAction = useAtomCommand(vcsActionManager.runStackedAction(scope), {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );

  const action = useCallback(
    async (input: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      if (resolveScope(scope) === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "run_change_request",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return runStackedAction({
        actionId: input.actionId,
        action: input.action,
        ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
        ...(input.featureBranch ? { featureBranch: true } : {}),
        ...(input.filePaths?.length ? { filePaths: input.filePaths } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      });
    },
    [runStackedAction, scope],
  );

  return useAction({
    kind: "runStackedAction",
    label: "Running source control action",
    scope,
    action,
    onSuccess: status.refresh,
    managedExternally: true,
  });
}

export function useSourceControlPublishRepositoryAction(scope: SourceControlActionScope) {
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = useCallback(
    async (input: {
      provider: "github" | "gitlab" | "bitbucket" | "azure-devops";
      repository: string;
      visibility: SourceControlRepositoryVisibility;
      remoteName: string;
      protocol: SourceControlCloneProtocol;
    }) => {
      const target = resolveScope(scope);
      if (target === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "publish_repository",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return publishRepository({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          ...input,
        },
      });
    },
    [publishRepository, scope],
  );
  return useAction({
    kind: "publishRepository",
    label: "Publishing repository",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export function usePreparePullRequestThreadAction(scope: SourceControlActionScope) {
  const preparePullRequestThread = useAtomCommand(gitEnvironment.preparePullRequestThread, {
    reportFailure: false,
  });
  const action = useCallback(
    async (input: { reference: string; mode: "local" | "worktree"; threadId?: ThreadId }) => {
      const target = resolveScope(scope);
      if (target === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "prepare_pull_request_thread",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return preparePullRequestThread({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          reference: input.reference,
          mode: input.mode,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      });
    },
    [preparePullRequestThread, scope],
  );
  return useAction({
    kind: "preparePullRequestThread",
    label: "Preparing pull request thread",
    scope,
    action,
  });
}

export interface PullRequestResolutionTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
}

export function readCachedPullRequestResolution(
  target: PullRequestResolutionTarget,
): GitResolvePullRequestResult | null {
  if (target.environmentId === null || target.cwd === null || target.reference === null) {
    return null;
  }
  return Option.getOrNull(
    AsyncResult.value(
      appAtomRegistry.get(
        gitEnvironment.pullRequestResolution({
          environmentId: target.environmentId,
          input: { cwd: target.cwd, reference: target.reference },
        }),
      ),
    ),
  );
}

export function usePullRequestResolutionState(target: PullRequestResolutionTarget) {
  const query = useEnvironmentQuery(
    target.environmentId !== null && target.cwd !== null && target.reference !== null
      ? gitEnvironment.pullRequestResolution({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            reference: target.reference,
          },
        })
      : null,
  );
  const cached = readCachedPullRequestResolution(target);

  return {
    data: query.data ?? cached,
    error: query.error,
    isPending: query.isPending && cached === null,
    isFetching: query.isPending,
    refresh: query.refresh,
  };
}
