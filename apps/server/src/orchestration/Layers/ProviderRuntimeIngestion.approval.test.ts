import {
  EventId,
  ProviderDriverKind,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const asTurnId = (value: string): TurnId => TurnId.make(value);

describe("runtimeEventToActivities approval details", () => {
  it("preserves complete multiline command details", () => {
    const detail = `bun run release -- ${"long-argument ".repeat(20)}\nsecond line`;
    const event = {
      type: "request.opened",
      eventId: EventId.make("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      requestId: RuntimeRequestId.make("approval-1"),
      payload: {
        requestType: "command_execution_approval",
        detail,
      },
    } satisfies ProviderRuntimeEvent;

    const [activity] = runtimeEventToActivities(event);

    expect(activity?.kind).toBe("approval.requested");
    expect((activity?.payload as Record<string, unknown> | undefined)?.detail).toBe(detail);
  });

  it("maps turn.started into a status-bar activity with the model", () => {
    const [activity] = runtimeEventToActivities({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { model: "deepseek-v4-flash", effort: "high" },
    } satisfies ProviderRuntimeEvent);

    expect(activity?.kind).toBe("turn.started");
    expect(activity?.turnId).toBe("turn-1");
    expect(activity?.payload).toMatchObject({ model: "deepseek-v4-flash", effort: "high" });
  });

  it("maps turn.completed into a status-bar activity with cost", () => {
    const [activity] = runtimeEventToActivities({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "completed",
        stopReason: "end_turn",
        totalCostUsd: 0.0016,
        usage: { input_tokens: 1 },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activity?.kind).toBe("turn.completed");
    expect(activity?.payload).toMatchObject({
      state: "completed",
      stopReason: "end_turn",
      totalCostUsd: 0.0016,
    });
  });

  it("maps account.rate-limits.updated into a status-bar activity with balance data", () => {
    const [activity] = runtimeEventToActivities({
      type: "account.rate-limits.updated",
      eventId: EventId.make("evt-rate-limits"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      payload: {
        rateLimits: { credits: { balance: "$4.04", hasCredits: true, unlimited: false } },
      },
    } satisfies ProviderRuntimeEvent);

    expect(activity?.kind).toBe("account.rate-limits.updated");
    expect(activity?.payload).toMatchObject({
      rateLimits: { credits: { balance: "$4.04" } },
    });
  });

  it("maps model.rerouted into a status-bar activity", () => {
    const [activity] = runtimeEventToActivities({
      type: "model.rerouted",
      eventId: EventId.make("evt-model-rerouted"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-07-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      payload: { fromModel: "gpt-5", toModel: "deepseek-v4-flash", reason: "availability" },
    } satisfies ProviderRuntimeEvent);

    expect(activity?.kind).toBe("model.rerouted");
    expect(activity?.summary).toContain("deepseek-v4-flash");
    expect(activity?.payload).toMatchObject({ toModel: "deepseek-v4-flash" });
  });
});
