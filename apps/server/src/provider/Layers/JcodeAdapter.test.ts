// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { HarnessError, type ApiEvent, type JcodeClient } from "@1jehuang/jcode-sdk";
import {
  ApprovalRequestId,
  JcodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { createModelSelection } from "@t3tools/shared/model";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { JcodeAdapterShape } from "../Services/JcodeAdapter.ts";
import { makeJcodeAdapter } from "./JcodeAdapter.ts";

const decodeJcodeSettings = Schema.decodeSync(JcodeSettings);

// Test-local service tag so the rest of the file can keep using `yield* JcodeAdapter`.
class JcodeAdapter extends Context.Service<JcodeAdapter, JcodeAdapterShape>()(
  "t3/provider/Layers/JcodeAdapter.test/JcodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asApprovalRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);

interface FakeJcodeEventStream {
  readonly push: (event: ApiEvent) => void;
  readonly end: () => void;
  readonly [Symbol.asyncIterator]: () => AsyncIterator<ApiEvent>;
}

/**
 * Minimal fake of the `JcodeClient` surface the adapter uses. The real SDK
 * class has private members, so the fake is cast at the injection boundary.
 */
class FakeJcodeClient {
  public createdSessions: Array<{ session_id: string; working_dir: string | undefined }> = [];
  public attachedSessions: Array<string> = [];
  public unknownAttachSessions: Set<string> = new Set();
  public sentMessages: Array<{ sessionId: string; text: string }> = [];
  public cancelledSessions: Array<string> = [];
  public permissionReplies: Array<{ sessionId: string; requestId: string; decision: string }> = [];
  public setModels: Array<{ sessionId: string; model: string }> = [];
  public rewound: Array<{ sessionId: string; messageIndex: number }> = [];
  public historyMessages: Array<{ role: string; content: string }> = [];
  public closed = false;

  private nextSessionId = 0;
  private readonly streams = new Map<string, FakeJcodeEventStream>();

  createSession(workingDir?: string): Promise<{ session_id: string; status: string }> {
    this.nextSessionId += 1;
    const session = { session_id: `jcode-session-${this.nextSessionId}`, status: "ready" as const };
    this.createdSessions.push({ session_id: session.session_id, working_dir: workingDir });
    return Promise.resolve(session);
  }

  attachSession(sessionId: string): Promise<{ session_id: string; status: string }> {
    this.attachedSessions.push(sessionId);
    if (this.unknownAttachSessions.has(sessionId)) {
      return Promise.reject(new HarnessError("unknown_session", `Unknown session: ${sessionId}`));
    }
    return Promise.resolve({ session_id: sessionId, status: "ready" as const });
  }

  setModel(sessionId: string, model: string): Promise<void> {
    this.setModels.push({ sessionId, model });
    return Promise.resolve();
  }

  sendMessage(sessionId: string, text: string): Promise<void> {
    this.sentMessages.push({ sessionId, text });
    return Promise.resolve();
  }

  cancel(sessionId: string): Promise<void> {
    this.cancelledSessions.push(sessionId);
    return Promise.resolve();
  }

  respondToPermission(sessionId: string, requestId: string, decision: string): Promise<void> {
    this.permissionReplies.push({ sessionId, requestId, decision });
    return Promise.resolve();
  }

  getHistory(sessionId: string): Promise<Array<{ role: string; content: string }>> {
    return Promise.resolve(this.historyMessages);
  }

  rewind(sessionId: string, messageIndex: number): Promise<void> {
    this.rewound.push({ sessionId, messageIndex });
    return Promise.resolve();
  }

  ping(): Promise<void> {
    return Promise.resolve();
  }

  get instanceHome(): string | undefined {
    return undefined;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  events(sessionId: string): AsyncIterableIterator<ApiEvent> {
    const existing = this.streams.get(sessionId);
    if (existing) {
      return existing as unknown as AsyncIterableIterator<ApiEvent>;
    }
    const stream = makeEventStream();
    this.streams.set(sessionId, stream);
    return stream as unknown as AsyncIterableIterator<ApiEvent>;
  }

  eventStream(sessionId: string): FakeJcodeEventStream {
    const existing = this.streams.get(sessionId);
    if (existing) {
      return existing;
    }
    const stream = makeEventStream();
    this.streams.set(sessionId, stream);
    return stream;
  }

  /** Session id of the most recent startSession (created or attached). */
  get currentSessionId(): string {
    return this.createdSessions.at(-1)?.session_id ?? this.attachedSessions.at(-1) ?? "";
  }
}

function makeEventStream(): FakeJcodeEventStream {
  const queue: ApiEvent[] = [];
  let resolveNext: ((value: IteratorResult<ApiEvent>) => void) | undefined;
  let done = false;
  const next = (): Promise<IteratorResult<ApiEvent>> => {
    if (queue.length > 0) {
      return Promise.resolve({ value: queue.shift()!, done: false });
    }
    if (done) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => {
      resolveNext = resolve;
    });
  };
  return {
    push(event) {
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve({ value: event, done: false });
      } else {
        queue.push(event);
      }
    },
    end() {
      done = true;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return { next, return: () => Promise.resolve({ value: undefined, done: true }) };
    },
  };
}

function makeHarness(fake: FakeJcodeClient) {
  return Layer.effect(
    JcodeAdapter,
    Effect.gen(function* () {
      const jcodeConfig = decodeJcodeSettings({});
      return yield* makeJcodeAdapter(jcodeConfig, {
        clientSource: () => Promise.resolve(fake as unknown as JcodeClient),
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest("/tmp/jcode-adapter-test", "/tmp")),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(NodeServices.layer),
  );
}

/**
 * Build a fresh adapter instance (fresh event queue + session map) for one
 * test, so event-count assertions never observe leftovers from sibling tests.
 */
const withAdapter = <A>(
  fake: FakeJcodeClient,
  use: (adapter: JcodeAdapterShape) => Effect.Effect<A, ProviderAdapterError>,
) =>
  Effect.gen(function* () {
    const adapter = yield* JcodeAdapter.pipe(Effect.provide(makeHarness(fake)));
    return yield* use(adapter);
  });

/** Collect exactly `count` runtime events from the adapter's queue. */
const collectEvents = (adapter: JcodeAdapterShape, count: number) =>
  Stream.take(adapter.streamEvents, count).pipe(Stream.runCollect, Effect.forkChild);

function startSessionInput(
  threadId: string,
  overrides?: Partial<Parameters<JcodeAdapterShape["startSession"]>[0]>,
) {
  return {
    threadId: asThreadId(threadId),
    runtimeMode: "full-access" as const,
    ...overrides,
  };
}

const lifecycleFake = new FakeJcodeClient();

it("JcodeAdapterLive lifecycle: starts a session and emits session.started + thread.started", () =>
  withAdapter(lifecycleFake, (adapter) =>
    Effect.gen(function* () {
      const eventsFiber = yield* collectEvents(adapter, 2);
      const session = yield* adapter.startSession(startSessionInput("life-start"));

      NodeAssert.equal(session.provider, "jcode");
      NodeAssert.equal(session.threadId, asThreadId("life-start"));
      NodeAssert.equal(session.cwd, "/tmp/jcode-adapter-test");
      NodeAssert.equal(lifecycleFake.createdSessions.length, 1);
      NodeAssert.deepStrictEqual(lifecycleFake.createdSessions[0], {
        session_id: "jcode-session-1",
        working_dir: "/tmp/jcode-adapter-test",
      });

      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(events[0]!.type, "session.started");
      NodeAssert.equal(events[1]!.type, "thread.started");
      NodeAssert.deepStrictEqual(
        (events[1] as Extract<ProviderRuntimeEvent, { type: "thread.started" }>).payload,
        { providerThreadId: "jcode-session-1" },
      );
    }),
  ));

it("JcodeAdapterLive lifecycle: sendTurn emits turn.started, deltas, item + turn completion", () =>
  withAdapter(lifecycleFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("life-send"));
      const stream = lifecycleFake.eventStream(lifecycleFake.currentSessionId);
      const eventsFiber = yield* collectEvents(adapter, 7);

      const started = yield* adapter.sendTurn({
        threadId: asThreadId("life-send"),
        input: "hello jcode",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("jcode"), "some-model"),
      });
      NodeAssert.equal(started.turnId, TurnId.make(started.turnId));
      NodeAssert.equal(lifecycleFake.sentMessages[0]?.text, "hello jcode");

      stream.push({ ev: "text_delta", session_id: lifecycleFake.currentSessionId, text: "Hello" });
      stream.push({ ev: "text_delta", session_id: lifecycleFake.currentSessionId, text: " world" });
      stream.push({ ev: "turn_done", session_id: lifecycleFake.currentSessionId });

      const events = yield* Fiber.join(eventsFiber);
      const byType = new Map(events.map((event) => [event.type, event]));
      const turnStarted = byType.get("turn.started") as Extract<
        ProviderRuntimeEvent,
        { type: "turn.started" }
      >;
      NodeAssert.equal(turnStarted.payload.model, "some-model");
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.equal(deltas.length, 2);
      NodeAssert.deepStrictEqual(
        (deltas[0] as Extract<ProviderRuntimeEvent, { type: "content.delta" }>).payload,
        { streamKind: "assistant_text", delta: "Hello" },
      );
      NodeAssert.deepStrictEqual(
        (deltas[1] as Extract<ProviderRuntimeEvent, { type: "content.delta" }>).payload,
        { streamKind: "assistant_text", delta: " world" },
      );
      const itemCompleted = byType.get("item.completed") as Extract<
        ProviderRuntimeEvent,
        { type: "item.completed" }
      >;
      NodeAssert.equal(itemCompleted.payload.itemType, "assistant_message");
      const turnCompleted = byType.get("turn.completed") as Extract<
        ProviderRuntimeEvent,
        { type: "turn.completed" }
      >;
      NodeAssert.deepStrictEqual(turnCompleted.payload, { state: "completed" });
    }),
  ));

it("JcodeAdapterLive lifecycle: steering sendTurn reuses the active turn id", () =>
  withAdapter(lifecycleFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("life-steer"));
      const first = yield* adapter.sendTurn({
        threadId: asThreadId("life-steer"),
        input: "first",
      });
      const second = yield* adapter.sendTurn({
        threadId: asThreadId("life-steer"),
        input: "steer",
      });
      NodeAssert.equal(second.turnId, first.turnId);
    }),
  ));

it("JcodeAdapterLive lifecycle: turn_done without text still emits turn.completed", () =>
  withAdapter(lifecycleFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("life-turndone"));
      const stream = lifecycleFake.eventStream(lifecycleFake.currentSessionId);
      const eventsFiber = yield* collectEvents(adapter, 4);
      yield* adapter.sendTurn({ threadId: asThreadId("life-turndone"), input: "hi" });
      stream.push({ ev: "turn_done", session_id: lifecycleFake.currentSessionId });
      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.ok(
        events.some(
          (event) => event.type === "turn.completed" && event.payload.state === "completed",
        ),
      );
    }),
  ));

const interruptFake = new FakeJcodeClient();

it("JcodeAdapterLive interrupt + stop: interruptTurn cancels and emits turn.aborted", () =>
  withAdapter(interruptFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("int-turn"));
      const eventsFiber = yield* collectEvents(adapter, 4);
      yield* adapter.sendTurn({ threadId: asThreadId("int-turn"), input: "hi" });
      yield* adapter.interruptTurn(asThreadId("int-turn"));

      const events = yield* Fiber.join(eventsFiber);
      const aborted = events.find((event) => event.type === "turn.aborted") as Extract<
        ProviderRuntimeEvent,
        { type: "turn.aborted" }
      >;
      NodeAssert.deepStrictEqual(aborted.payload, { reason: "Interrupted by user." });
      NodeAssert.deepStrictEqual(interruptFake.cancelledSessions, ["jcode-session-1"]);
    }),
  ));

it("JcodeAdapterLive interrupt + stop: stopSession emits session.exited and removes it", () =>
  withAdapter(interruptFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("int-stop"));
      const eventsFiber = yield* collectEvents(adapter, 3);
      yield* adapter.stopSession(asThreadId("int-stop"));

      const events = yield* Fiber.join(eventsFiber);
      const exited = events.at(-1) as Extract<ProviderRuntimeEvent, { type: "session.exited" }>;
      NodeAssert.deepStrictEqual(exited.payload, {
        reason: "Session stopped.",
        recoverable: false,
        exitKind: "graceful",
      });
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("int-stop")), false);
    }),
  ));

it("JcodeAdapterLive interrupt + stop: unexpected stream end emits error + exited", () =>
  withAdapter(interruptFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("int-end"));
      const stream = interruptFake.eventStream(interruptFake.currentSessionId);
      const eventsFiber = yield* collectEvents(adapter, 4);
      stream.end();

      const events = yield* Fiber.join(eventsFiber);
      const runtimeError = events.find((event) => event.type === "runtime.error") as Extract<
        ProviderRuntimeEvent,
        { type: "runtime.error" }
      >;
      NodeAssert.equal(runtimeError.payload.class, "transport_error");
      const exited = events.find((event) => event.type === "session.exited") as Extract<
        ProviderRuntimeEvent,
        { type: "session.exited" }
      >;
      NodeAssert.deepStrictEqual(exited.payload, {
        reason: "jcode harness connection closed.",
        recoverable: false,
        exitKind: "error",
      });
      NodeAssert.equal(yield* adapter.hasSession(asThreadId("int-end")), false);
    }),
  ));

const permissionFake = new FakeJcodeClient();

it("JcodeAdapterLive permissions: request.opened then respondToRequest replies allow", () =>
  withAdapter(permissionFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("perm-allow"));
      const stream = permissionFake.eventStream(permissionFake.currentSessionId);
      const eventsFiber = yield* collectEvents(adapter, 4);
      yield* adapter.sendTurn({ threadId: asThreadId("perm-allow"), input: "run tests" });
      stream.push({
        ev: "permission_request",
        session_id: permissionFake.currentSessionId,
        request_id: "perm-1",
        tool_name: "bash",
        description: "Run `npm test`",
      });

      const events = yield* Fiber.join(eventsFiber);
      const opened = events.find((event) => event.type === "request.opened") as Extract<
        ProviderRuntimeEvent,
        { type: "request.opened" }
      >;
      NodeAssert.deepStrictEqual(opened.payload, {
        requestType: "command_execution_approval",
        detail: "Run `npm test`",
        args: { tool: "bash" },
      });

      const resolvedFiber = yield* collectEvents(adapter, 1);
      yield* adapter.respondToRequest(
        asThreadId("perm-allow"),
        asApprovalRequestId("perm-1"),
        "accept",
      );
      const resolved = yield* Fiber.join(resolvedFiber);
      NodeAssert.deepStrictEqual(permissionFake.permissionReplies, [
        { sessionId: "jcode-session-1", requestId: "perm-1", decision: "allow" },
      ]);
      NodeAssert.equal(
        (resolved[0] as Extract<ProviderRuntimeEvent, { type: "request.resolved" }>).payload
          .decision,
        "accept",
      );
    }),
  ));

it("JcodeAdapterLive permissions: decline maps to deny; unknown request errors", () =>
  withAdapter(permissionFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("perm-decline"));
      yield* adapter.sendTurn({ threadId: asThreadId("perm-decline"), input: "run tests" });
      permissionFake.eventStream(permissionFake.currentSessionId).push({
        ev: "permission_request",
        session_id: permissionFake.currentSessionId,
        request_id: "perm-2",
        tool_name: "edit",
        description: "Write file",
      });
      const openedFiber = yield* collectEvents(adapter, 4);
      const openedEvents = yield* Fiber.join(openedFiber);
      NodeAssert.ok(openedEvents.some((event) => event.type === "request.opened"));
      yield* adapter.respondToRequest(
        asThreadId("perm-decline"),
        asApprovalRequestId("perm-2"),
        "decline",
      );
      NodeAssert.deepStrictEqual(permissionFake.permissionReplies.at(-1), {
        sessionId: permissionFake.currentSessionId,
        requestId: "perm-2",
        decision: "deny",
      });

      const result = yield* adapter
        .respondToRequest(asThreadId("perm-decline"), asApprovalRequestId("perm-nope"), "decline")
        .pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(
        Schema.is(ProviderAdapterRequestError)(result.failure) &&
          result.failure.detail.includes("Unknown pending permission request"),
        true,
      );
    }),
  ));

const usageFake = new FakeJcodeClient();

it("JcodeAdapterLive token usage: token_usage maps to thread.token-usage.updated", () =>
  withAdapter(usageFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("usage-tokens"));
      const stream = usageFake.eventStream(usageFake.currentSessionId);
      const eventsFiber = yield* collectEvents(adapter, 4);
      yield* adapter.sendTurn({ threadId: asThreadId("usage-tokens"), input: "hi" });
      stream.push({
        ev: "token_usage",
        session_id: usageFake.currentSessionId,
        input: 100,
        output: 50,
        cache_read_input: 20,
      });
      const events = yield* Fiber.join(eventsFiber);
      const usageEvent = events.find(
        (event) => event.type === "thread.token-usage.updated",
      ) as Extract<ProviderRuntimeEvent, { type: "thread.token-usage.updated" }>;
      NodeAssert.deepStrictEqual(usageEvent.payload.usage, {
        usedTokens: 150,
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
      });
    }),
  ));

const resumeFake = new FakeJcodeClient();

it("JcodeAdapterLive resume + read: resume cursor attaches the existing session", () =>
  withAdapter(resumeFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(
        startSessionInput("resume-attach", {
          resumeCursor: { schemaVersion: 1, sessionId: "jcode-session-persisted" },
        }),
      );
      NodeAssert.deepStrictEqual(resumeFake.attachedSessions, ["jcode-session-persisted"]);
      NodeAssert.equal(resumeFake.createdSessions.length, 0);
    }),
  ));

it("JcodeAdapterLive resume + read: unknown resume session creates a fresh one", () =>
  withAdapter(resumeFake, (adapter) =>
    Effect.gen(function* () {
      resumeFake.unknownAttachSessions.add("jcode-session-gone");
      yield* adapter.startSession(
        startSessionInput("resume-gone", {
          resumeCursor: { schemaVersion: 1, sessionId: "jcode-session-gone" },
        }),
      );
      NodeAssert.equal(resumeFake.createdSessions.length, 1);
    }),
  ));

it("JcodeAdapterLive resume + read: readThread returns assistant history messages", () =>
  withAdapter(resumeFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("resume-read"));
      resumeFake.historyMessages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello!" },
      ];
      const snapshot = yield* adapter.readThread(asThreadId("resume-read"));
      NodeAssert.equal(snapshot.threadId, asThreadId("resume-read"));
      NodeAssert.equal(snapshot.turns.length, 1);
    }),
  ));

it("JcodeAdapterLive resume + read: rollbackThread rewinds before the target index", () =>
  withAdapter(resumeFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("resume-rewind"));
      resumeFake.historyMessages = [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
        { role: "assistant", content: "d" },
      ];
      yield* adapter.rollbackThread(asThreadId("resume-rewind"), 1);
      NodeAssert.deepStrictEqual(resumeFake.rewound, [
        { sessionId: resumeFake.currentSessionId, messageIndex: 2 },
      ]);
    }),
  ));

const validationFake = new FakeJcodeClient();

it("JcodeAdapterLive validation: sendTurn rejects empty text input", () =>
  withAdapter(validationFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("val-empty"));
      const result = yield* adapter
        .sendTurn({ threadId: asThreadId("val-empty"), input: "   " })
        .pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.ok(Schema.is(ProviderAdapterValidationError)(result.failure));
    }),
  ));

it("JcodeAdapterLive validation: sendTurn rejects a model bound to another instance", () =>
  withAdapter(validationFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("val-model"));
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("val-model"),
          input: "hi",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex"),
        })
        .pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterValidationError");
    }),
  ));

it("JcodeAdapterLive validation: sendTurn on an unknown thread fails session-not-found", () =>
  withAdapter(validationFake, (adapter) =>
    Effect.gen(function* () {
      const result = yield* adapter
        .sendTurn({ threadId: asThreadId("val-missing"), input: "hi" })
        .pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.ok(Schema.is(ProviderAdapterSessionNotFoundError)(result.failure));
    }),
  ));

it("JcodeAdapterLive validation: startSession without a clientSource fails", () =>
  Effect.gen(function* () {
    const noSourceLayer = Layer.effect(
      JcodeAdapter,
      Effect.gen(function* () {
        const jcodeConfig = decodeJcodeSettings({});
        return yield* makeJcodeAdapter(jcodeConfig, {});
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/jcode-adapter-test", "/tmp")),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );
    const adapter = yield* JcodeAdapter.pipe(Effect.provide(noSourceLayer));
    const result = yield* adapter
      .startSession(startSessionInput("val-nosource"))
      .pipe(Effect.result);
    NodeAssert.equal(result._tag, "Failure");
    NodeAssert.ok(Schema.is(ProviderAdapterProcessError)(result.failure));
  }));

it("JcodeAdapterLive validation: respondToUserInput reports unsupported", () =>
  withAdapter(validationFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("val-userinput"));
      const result = yield* adapter
        .respondToUserInput(asThreadId("val-userinput"), asApprovalRequestId("req-1"), {})
        .pipe(Effect.result);
      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.ok(Schema.is(ProviderAdapterRequestError)(result.failure));
    }),
  ));

const toolFake = new FakeJcodeClient();

it("JcodeAdapterLive tool events: tool lifecycle maps to item.started/updated/completed", () =>
  withAdapter(toolFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(startSessionInput("tool-life"));
      const stream = toolFake.eventStream(toolFake.currentSessionId);
      const eventsFiber = yield* collectEvents(adapter, 8);
      yield* adapter.sendTurn({ threadId: asThreadId("tool-life"), input: "fix it" });
      const sessionId = toolFake.currentSessionId;
      stream.push({ ev: "tool_start", session_id: sessionId, call_id: "call-1", name: "bash" });
      stream.push({
        ev: "tool_input_delta",
        session_id: sessionId,
        call_id: "call-1",
        delta: '{"cmd":',
      });
      stream.push({
        ev: "tool_input_delta",
        session_id: sessionId,
        call_id: "call-1",
        delta: '"npm test"}',
      });
      stream.push({ ev: "tool_exec", session_id: sessionId, call_id: "call-1", name: "bash" });
      stream.push({
        ev: "tool_done",
        session_id: sessionId,
        call_id: "call-1",
        name: "bash",
        output: "ok",
      });

      const events = yield* Fiber.join(eventsFiber);
      NodeAssert.equal(
        events.length,
        8,
        `tool events: ${events.map((event) => event.type).join(", ")}`,
      );
      const started = events.find((event) => event.type === "item.started") as Extract<
        ProviderRuntimeEvent,
        { type: "item.started" }
      >;
      NodeAssert.equal(started.payload.itemType, "dynamic_tool_call");
      NodeAssert.equal(started.payload.title, "bash");
      const updates = events.filter((event) => event.type === "item.updated");
      NodeAssert.ok(updates.length >= 2);
      const completed = events.find((event) => event.type === "item.completed") as Extract<
        ProviderRuntimeEvent,
        { type: "item.completed" }
      >;
      NodeAssert.equal(completed.payload.status, "completed");
      NodeAssert.equal(completed.payload.detail, "ok");
      // call_id surfaces as the provider ref so UIs can correlate
      NodeAssert.equal(completed.providerRefs?.providerItemId, "call-1");
    }),
  ));

const modelFake = new FakeJcodeClient();

it("JcodeAdapterLive model selection: startSession with a model calls setModel", () =>
  withAdapter(modelFake, (adapter) =>
    Effect.gen(function* () {
      yield* adapter.startSession(
        startSessionInput("model-set", {
          modelSelection: createModelSelection(ProviderInstanceId.make("jcode"), "opus-5"),
        }),
      );
      NodeAssert.deepStrictEqual(modelFake.setModels, [
        { sessionId: "jcode-session-1", model: "opus-5" },
      ]);
    }),
  ));
