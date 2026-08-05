/**
 * JcodeAdapterLive — live implementation of the Jcode provider adapter.
 *
 * Wraps `@1jehuang/jcode-sdk`'s `JcodeClient` behind the generic provider
 * adapter contract. Each adapter instance talks to one private jcode daemon
 * (owned by the `JcodeProcessManager` from `Drivers/JcodeDriver`), manages a
 * jcode session per thread, and translates jcode harness API events onto the
 * canonical `ProviderRuntimeEvent` stream.
 *
 * Event translation matrix (jcode → canonical):
 *
 *   text_delta            → content.delta (assistant_text)
 *   reasoning_delta       → content.delta (reasoning_text)
 *   tool_start            → item.started
 *   tool_input_delta/tool_exec → item.updated
 *   tool_done             → item.completed
 *   permission_request    → request.opened
 *   token_usage           → thread.token-usage.updated
 *   turn_done             → turn.completed
 *   error (harness_error) → runtime.error
 *   session_status        → session.state.changed
 *   session_renamed       → thread.metadata.updated
 *   background_progress   → task.progress
 *
 * @module JcodeAdapterLive
 */
import {
  HarnessError,
  type ApiEvent,
  type JcodeClient,
  type PermissionDecision,
} from "@1jehuang/jcode-sdk";
import {
  type ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ChatAttachment,
  type JcodeSettings,
  type ModelSelection,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type JcodeAdapterShape } from "../Services/JcodeAdapter.ts";
import type {
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("jcode");

const JCODE_RESUME_VERSION = 1 as const;

interface JcodeResumeCursor {
  readonly schemaVersion: typeof JCODE_RESUME_VERSION;
  readonly sessionId: string;
}

function parseJcodeResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== JCODE_RESUME_VERSION || typeof record.sessionId !== "string") {
    return undefined;
  }
  return { sessionId: record.sessionId };
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

interface JcodeTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

interface JcodeToolInputState {
  readonly callId: string;
  readonly name: string;
  readonly inputJson: string;
}

interface JcodeSessionContext {
  session: ProviderSession;
  readonly client: JcodeClient;
  readonly jcodeSessionId: string;
  readonly directory: string;
  readonly pendingPermissions: Map<string, ApiEvent & { readonly ev: "permission_request" }>;
  /** Accumulated assistant text per active turn id (for delta dedup + completion). */
  readonly assistantTextByTurnId: Map<TurnId, string>;
  /** Accumulated reasoning text per active turn id. */
  readonly reasoningTextByTurnId: Map<TurnId, string>;
  /** In-flight tool call input accumulation (call_id → state). */
  readonly toolInputByCallId: Map<string, JcodeToolInputState>;
  readonly turns: Array<JcodeTurnSnapshot>;
  activeTurnId: TurnId | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Scope;
}

export interface JcodeAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  /**
   * Returns a connected `JcodeClient` for this adapter. Supplied by the
   * driver (`JcodeProcessManager`); tests inject a fake. Absent only in
   * misconfigured call sites, which fail `startSession` with a process error.
   */
  readonly clientSource?: () => Promise<JcodeClient>;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isJcodeUnknownSessionError(cause: unknown): boolean {
  const inner = Schema.is(ProviderAdapterRequestError)(cause) ? cause.cause : cause;
  return inner instanceof HarnessError && inner.code === "unknown_session";
}

function jcodePermissionDecision(decision: ProviderApprovalDecision): PermissionDecision {
  switch (decision) {
    case "accept":
      return "allow";
    case "acceptForSession":
      return "allow_always";
    case "decline":
    case "cancel":
      return "deny";
  }
}

function jcodeToolItemType(toolName: string): CanonicalItemType {
  return toolName.startsWith("mcp") ? "mcp_tool_call" : "dynamic_tool_call";
}

function jcodeRequestType(toolName: string): CanonicalRequestType {
  switch (toolName) {
    case "bash":
    case "shell":
    case "exec":
    case "run_command":
    case "terminal":
      return "command_execution_approval";
    case "edit":
    case "write_file":
    case "apply_patch":
      return "file_change_approval";
    case "read":
    case "read_file":
    case "glob":
      return "file_read_approval";
    default:
      return "dynamic_tool_call";
  }
}

function truncatedToolOutput(output: string): string | undefined {
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Bounded detail so a huge tool output never floods the canonical stream.
  return trimmed.length > 4_000 ? `${trimmed.slice(0, 4_000)}…` : trimmed;
}

function usageSnapshotFromTokenUsage(
  event: Extract<ApiEvent, { readonly ev: "token_usage" }>,
): ThreadTokenUsageSnapshot {
  const input = typeof event.input === "number" ? event.input : 0;
  const output = typeof event.output === "number" ? event.output : 0;
  const usedTokens = input + output;
  return {
    usedTokens,
    ...(input > 0 ? { inputTokens: input } : {}),
    ...(output > 0 ? { outputTokens: output } : {}),
    ...(typeof event.cache_read_input === "number" && event.cache_read_input > 0
      ? { cachedInputTokens: event.cache_read_input }
      : {}),
  };
}

export function makeJcodeAdapter(jcodeSettings: JcodeSettings, options?: JcodeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("jcode");
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const clientSource = options?.clientSource;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, JcodeSessionContext>();
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Jcode runtime identifier.",
            cause,
          }),
      ),
    );

    const buildEventBase = (input: {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly taskId?: string | undefined;
      readonly createdAt?: string | undefined;
      readonly raw?: unknown;
      readonly providerItemId?: string | undefined;
    }) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.taskId ? { taskId: RuntimeTaskId.make(input.taskId) } : {}),
          ...(input.providerItemId
            ? { providerRefs: { providerItemId: input.providerItemId as ProviderItemId } }
            : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "jcode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    // Layer-level finalizer: when the adapter layer shuts down, stop every
    // session and close the queue so consumers observe a clean end.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopJcodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) =>
      (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void).pipe(
        Effect.catchCause(() => Effect.void),
      );

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: JcodeSessionContext,
      message: string,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId = context.activeTurnId;
      sessions.delete(context.session.threadId);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "runtime.error",
        payload: {
          message,
          class: "transport_error",
        },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    const completeActiveTurn = Effect.fn("completeActiveTurn")(function* (
      context: JcodeSessionContext,
      status: "completed" | "failed",
      errorMessage?: string,
    ) {
      const turnId = context.activeTurnId;
      context.activeTurnId = undefined;
      context.session = {
        ...context.session,
        status: "ready",
        updatedAt: yield* nowIso,
      } as ProviderSession & Record<string, unknown>;
      delete (context.session as Record<string, unknown>).activeTurnId;
      if (!turnId) {
        return;
      }
      const assistantText = context.assistantTextByTurnId.get(turnId);
      if (assistantText !== undefined && assistantText.length > 0) {
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: `jcode-assistant-${turnId}`,
          })),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: status === "completed" ? "completed" : "failed",
            title: "Assistant message",
            detail: assistantText,
          },
        });
        context.assistantTextByTurnId.delete(turnId);
      }
      context.reasoningTextByTurnId.delete(turnId);
      context.toolInputByCallId.clear();
      // A completed turn's permission prompts are defunct; drop them so a
      // later respondToRequest rejects stale request ids.
      context.pendingPermissions.clear();
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
        })),
        type: "turn.completed",
        payload: {
          state: status,
          ...(errorMessage ? { errorMessage } : {}),
        },
      });
    });

    const handleJcodeEvent = Effect.fn("handleJcodeEvent")(function* (
      context: JcodeSessionContext,
      event: ApiEvent,
    ) {
      if ("session_id" in event && event.session_id !== context.jcodeSessionId) {
        return;
      }
      const turnId = context.activeTurnId;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.jcodeSessionId,
          type: event.ev,
          ...(turnId ? { turnId } : {}),
          payload: event,
        },
      });

      switch (event.ev) {
        case "text_delta": {
          if (!turnId) {
            break;
          }
          const previous = context.assistantTextByTurnId.get(turnId) ?? "";
          context.assistantTextByTurnId.set(turnId, `${previous}${event.text}`);
          if (event.text.length === 0) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: `jcode-assistant-${turnId}`,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: event.text,
            },
          });
          break;
        }

        case "reasoning_delta": {
          if (!turnId) {
            break;
          }
          const previous = context.reasoningTextByTurnId.get(turnId) ?? "";
          context.reasoningTextByTurnId.set(turnId, `${previous}${event.text}`);
          if (event.text.length === 0) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: `jcode-reasoning-${turnId}`,
              raw: event,
            })),
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: event.text,
            },
          });
          break;
        }

        case "tool_start": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: `jcode-tool-${event.call_id}`,
              raw: event,
              providerItemId: event.call_id,
            })),
            type: "item.started",
            payload: {
              itemType: jcodeToolItemType(event.name),
              status: "inProgress",
              title: event.name,
              data: { tool: event.name, callId: event.call_id },
            },
          });
          break;
        }

        case "tool_input_delta": {
          const existing = context.toolInputByCallId.get(event.call_id);
          if (!existing) {
            break;
          }
          const nextState = {
            ...existing,
            inputJson: `${existing.inputJson}${event.delta}`,
          };
          context.toolInputByCallId.set(event.call_id, nextState);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: `jcode-tool-${event.call_id}`,
              raw: event,
              providerItemId: event.call_id,
            })),
            type: "item.updated",
            payload: {
              itemType: jcodeToolItemType(existing.name),
              status: "inProgress",
              title: existing.name,
              detail: nextState.inputJson,
            },
          });
          break;
        }

        case "tool_exec": {
          if (!context.toolInputByCallId.has(event.call_id)) {
            context.toolInputByCallId.set(event.call_id, {
              callId: event.call_id,
              name: event.name,
              inputJson: "",
            });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: `jcode-tool-${event.call_id}`,
              raw: event,
              providerItemId: event.call_id,
            })),
            type: "item.updated",
            payload: {
              itemType: jcodeToolItemType(event.name),
              status: "inProgress",
              title: event.name,
            },
          });
          break;
        }

        case "tool_done": {
          const existing = context.toolInputByCallId.get(event.call_id);
          const name = existing?.name ?? event.name;
          context.toolInputByCallId.delete(event.call_id);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: `jcode-tool-${event.call_id}`,
              raw: event,
              providerItemId: event.call_id,
            })),
            type: "item.completed",
            payload: {
              itemType: jcodeToolItemType(name),
              status: event.error ? "failed" : "completed",
              title: name,
              ...(truncatedToolOutput(event.output ?? "") !== undefined
                ? { detail: truncatedToolOutput(event.output ?? "") }
                : {}),
              data: {
                tool: name,
                callId: event.call_id,
                ...(event.error ? { error: event.error } : {}),
              },
            },
          });
          break;
        }

        case "permission_request": {
          context.pendingPermissions.set(event.request_id, event);
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              requestId: event.request_id,
              raw: event,
            })),
            type: "request.opened",
            payload: {
              requestType: jcodeRequestType(event.tool_name),
              detail: event.description || event.tool_name,
              args: { tool: event.tool_name },
            },
          });
          break;
        }

        case "token_usage": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "thread.token-usage.updated",
            payload: { usage: usageSnapshotFromTokenUsage(event) },
          });
          break;
        }

        case "message_accepted": {
          // The daemon has taken the message; nothing canonical to emit — the
          // turn was already announced by `sendTurn`.
          break;
        }

        case "session_status": {
          const status = event.status;
          const updatedAt = yield* nowIso;
          if (status === "idle" || status === "ready") {
            context.session = {
              ...context.session,
              status: "ready",
              updatedAt,
            } as ProviderSession & Record<string, unknown>;
            delete (context.session as Record<string, unknown>).activeTurnId;
          } else if (status === "error") {
            context.session = {
              ...context.session,
              status: "error",
              lastError: "jcode session reported status 'error'.",
              updatedAt,
            } as ProviderSession & Record<string, unknown>;
          } else {
            // busy / running / working
            context.session = {
              ...context.session,
              status: "running",
              ...(turnId ? { activeTurnId: turnId } : {}),
              updatedAt,
            } as ProviderSession & Record<string, unknown>;
          }
          break;
        }

        case "turn_done": {
          yield* completeActiveTurn(context, "completed");
          break;
        }

        case "background_progress": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              turnId,
              taskId: event.task_id,
              raw: event,
            })),
            type: "task.progress",
            payload: {
              taskId: RuntimeTaskId.make(event.task_id),
              description: event.label,
              ...(event.summary ? { summary: event.summary } : {}),
            },
          });
          if (event.done) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                taskId: event.task_id,
                raw: event,
              })),
              type: "task.completed",
              payload: {
                taskId: RuntimeTaskId.make(event.task_id),
                status: "completed",
                ...(event.summary ? { summary: event.summary } : {}),
              },
            });
          }
          break;
        }

        case "session_renamed": {
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "thread.metadata.updated",
            payload: {
              name: event.display_title,
              metadata: { sessionId: context.jcodeSessionId },
            },
          });
          break;
        }

        case "error": {
          const message = event.message || "jcode harness reported an error.";
          if (turnId) {
            yield* completeActiveTurn(context, "failed", message);
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "runtime.error",
            payload: {
              message,
              class: "provider_error",
              detail: { code: event.code },
            },
          });
          break;
        }

        default:
          // Forward-compat: protocol v1 may add event kinds at any time.
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (context: JcodeSessionContext) {
      // The SDK's `events(sessionId)` iterator ends when the client closes;
      // interrupting this fiber (scope close) calls `return()` on the
      // iterator, which detaches the listeners. No AbortController needed.
      yield* Stream.fromAsyncIterable(
        context.client.events(context.jcodeSessionId),
        (cause) => new Error(`jcode event stream failed: ${String(cause)}`),
      ).pipe(
        Stream.runForEach((event) => handleJcodeEvent(context, event)),
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            if (yield* Ref.get(context.stopped)) {
              return;
            }
            if (Exit.isFailure(exit)) {
              yield* emitUnexpectedExit(
                context,
                `jcode event stream ended unexpectedly: ${errorMessage(Cause.squash(exit.cause))}`,
              );
            } else {
              // The stream ended without an error but we did not stop it —
              // that means the harness connection closed.
              yield* emitUnexpectedExit(context, "jcode harness connection closed.");
            }
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );
    });

    const startSession: JcodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        if (!clientSource) {
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: "No jcode client source configured for this adapter instance.",
          });
        }
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopJcodeContext(existing);
          sessions.delete(input.threadId);
        }

        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseJcodeResume(input.resumeCursor)?.sessionId;

        const client = yield* Effect.tryPromise({
          try: () => clientSource(),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Failed to obtain jcode client: ${errorMessage(cause)}`,
              cause,
            }),
        });

        const sessionScope = yield* Scope.make();
        const startedExit = yield* Effect.exit(
          Effect.gen(function* () {
            const resolved = yield* resumeSessionId
              ? Effect.tryPromise({
                  try: () => client.attachSession(resumeSessionId),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "attach_session",
                      detail: errorMessage(cause),
                      cause,
                    }),
                }).pipe(
                  Effect.catchIf(isJcodeUnknownSessionError, () =>
                    Effect.gen(function* () {
                      yield* Effect.logWarning(
                        `jcode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                      );
                      return yield* Effect.tryPromise({
                        try: () => client.createSession(directory),
                        catch: (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "create_session",
                            detail: errorMessage(cause),
                            cause,
                          }),
                      });
                    }),
                  ),
                )
              : Effect.tryPromise({
                  try: () => client.createSession(directory),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "create_session",
                      detail: errorMessage(cause),
                      cause,
                    }),
                });
            const jcodeSessionId = resolved.session_id;

            if (input.modelSelection?.model) {
              yield* Effect.tryPromise({
                try: () => client.setModel(jcodeSessionId, input.modelSelection!.model),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "set_model",
                    detail: errorMessage(cause),
                    cause,
                  }),
              }).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning(
                    `jcode setModel('${input.modelSelection?.model}') rejected; keeping the session's current model.`,
                    { cause },
                  ),
                ),
              );
            }

            return { jcodeSessionId };
          }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
        );
        if (Exit.isFailure(startedExit)) {
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: `Failed to start jcode session: ${errorMessage(Cause.squash(startedExit.cause))}`,
            cause: startedExit.cause,
          });
        }

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: JCODE_RESUME_VERSION,
            sessionId: startedExit.value.jcodeSessionId,
          } satisfies JcodeResumeCursor,
          createdAt,
          updatedAt: createdAt,
        };

        const context: JcodeSessionContext = {
          session,
          client,
          jcodeSessionId: startedExit.value.jcodeSessionId,
          directory,
          pendingPermissions: new Map(),
          assistantTextByTurnId: new Map(),
          reasoningTextByTurnId: new Map(),
          toolInputByCallId: new Map(),
          turns: [],
          activeTurnId: undefined,
          stopped: yield* Ref.make(false),
          sessionScope,
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "Jcode session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: startedExit.value.jcodeSessionId,
          },
        });

        return session;
      },
    );

    const sendTurn: JcodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      // A sendTurn while a turn is active is a steer: jcode queues the prompt
      // into the busy session, so the active turn id is reused.
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`jcode-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Jcode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }

      const text = input.input?.trim();
      if (!text || text.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Jcode turns require text input.",
        });
      }

      const images = yield* toJcodeImages({
        attachments: input.attachments ?? [],
        attachmentsDir: serverConfig.attachmentsDir,
        fileSystem,
      });

      context.activeTurnId = turnId;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        model: modelSelection?.model ?? context.session.model,
        updatedAt: yield* nowIso,
      } as ProviderSession & Record<string, unknown>;
      delete (context.session as Record<string, unknown>).lastError;

      if (steeringTurnId === undefined) {
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
          },
        });
      }

      const sendOptions = images.length > 0 ? ({ images } as const) : undefined;
      yield* Effect.tryPromise({
        try: () => context.client.sendMessage(context.jcodeSessionId, text, sendOptions),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "send_message",
            detail: errorMessage(cause),
            cause,
          }),
      }).pipe(
        Effect.tapError((requestError) =>
          steeringTurnId !== undefined
            ? Effect.void
            : Effect.gen(function* () {
                context.activeTurnId = undefined;
                context.session = {
                  ...context.session,
                  status: "ready",
                  lastError: requestError.detail,
                  updatedAt: yield* nowIso,
                } as ProviderSession & Record<string, unknown>;
                delete (context.session as Record<string, unknown>).activeTurnId;
                yield* emit({
                  ...(yield* buildEventBase({
                    threadId: input.threadId,
                    turnId,
                  })),
                  type: "turn.aborted",
                  payload: {
                    reason: requestError.detail,
                  },
                });
              }),
        ),
      );

      return {
        threadId: input.threadId,
        turnId,
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      } satisfies ProviderTurnStartResult;
    });

    const interruptTurn: JcodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        yield* Effect.tryPromise({
          try: () => context.client.cancel(context.jcodeSessionId),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "cancel",
              detail: errorMessage(cause),
              cause,
            }),
        });
        const interruptedTurnId = turnId ?? context.activeTurnId;
        if (interruptedTurnId) {
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId: interruptedTurnId,
            })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
          context.activeTurnId = undefined;
        }
      },
    );

    const respondToRequest: JcodeAdapterShape["respondToRequest"] = Effect.fn("respondToRequest")(
      function* (threadId, requestId, decision) {
        const context = yield* ensureSessionContext(sessions, threadId);
        if (!context.pendingPermissions.has(requestId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "permission_response",
            detail: `Unknown pending permission request: ${requestId}`,
          });
        }
        yield* Effect.tryPromise({
          try: () =>
            context.client.respondToPermission(
              context.jcodeSessionId,
              requestId,
              jcodePermissionDecision(decision),
            ),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "permission_response",
              detail: errorMessage(cause),
              cause,
            }),
        });
        context.pendingPermissions.delete(requestId);
        yield* emit({
          ...(yield* buildEventBase({
            threadId,
            requestId,
          })),
          type: "request.resolved",
          payload: {
            requestType: "unknown",
            decision,
          },
        });
      },
    );

    const respondToUserInput: JcodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId) {
      // jcode's harness protocol v1 has no structured user-input prompt; it
      // only raises permission prompts. Surface this as a request error so
      // the orchestrator never hangs waiting for an answer.
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "user_input",
        detail: `jcode does not support user-input prompts for thread '${threadId}'.`,
      });
    });

    const stopSession: JcodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        yield* stopJcodeContext(context);
        sessions.delete(threadId);
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: JcodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: JcodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: JcodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const history = yield* Effect.tryPromise({
          try: () => context.client.getHistory(context.jcodeSessionId),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "get_history",
              detail: errorMessage(cause),
              cause,
            }),
        });
        const turns: Array<ProviderThreadTurnSnapshot> = [];
        history.forEach((message, index) => {
          if (message.role === "assistant") {
            turns.push({
              id: TurnId.make(`jcode-msg-${index}`),
              items: [message],
            });
          }
        });
        return { threadId, turns } satisfies ProviderThreadSnapshot;
      },
    );

    const rollbackThread: JcodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const history = yield* Effect.tryPromise({
          try: () => context.client.getHistory(context.jcodeSessionId),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "get_history",
              detail: errorMessage(cause),
              cause,
            }),
        });
        const messageIndex = Math.max(0, history.length - numTurns - 1);
        yield* Effect.tryPromise({
          try: () => context.client.rewind(context.jcodeSessionId, messageIndex),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "rewind",
              detail: errorMessage(cause),
              cause,
            }),
        });
        return yield* readThread(threadId);
      },
    );

    const stopAll: JcodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopJcodeContext(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies JcodeAdapterShape;
  });
}

function ensureSessionContext(
  sessions: Map<ThreadId, JcodeSessionContext>,
  threadId: ThreadId,
): Effect.Effect<JcodeSessionContext, ProviderAdapterSessionNotFoundError> {
  return Effect.gen(function* () {
    const context = sessions.get(threadId);
    if (!context) {
      return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
    }
    return context;
  });
}

function stopJcodeContext(context: JcodeSessionContext): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (yield* Ref.getAndSet(context.stopped, true)) {
      return;
    }
    // Closing the scope interrupts the forked event pump (removing its
    // listeners from the client). Best-effort cancel so an in-flight turn
    // stops on the daemon side too.
    yield* Effect.tryPromise({
      try: () => context.client.cancel(context.jcodeSessionId),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "cancel",
          detail: errorMessage(cause),
          cause,
        }),
    }).pipe(Effect.ignore({ log: true }));
    yield* Scope.close(context.sessionScope, Exit.void);
  });
}

function toJcodeImages(input: {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly attachmentsDir: string;
  readonly fileSystem: FileSystem.FileSystem;
}): Effect.Effect<Array<[string, string]>, ProviderAdapterRequestError> {
  return Effect.forEach(input.attachments, (attachment) =>
    Effect.gen(function* () {
      const resolved = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment,
      });
      if (!resolved) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "attachments/read",
          detail: `Attachment '${attachment.id}' is not a supported image.`,
        });
      }
      const bytes = yield* input.fileSystem.readFile(resolved).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "attachments/read",
              detail: `Failed to read attachment '${attachment.id}'.`,
              cause,
            }),
        ),
      );
      return [attachment.mimeType, Buffer.from(bytes).toString("base64")] as [string, string];
    }),
  );
}
