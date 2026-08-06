import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { AgentSession, CrossAgentContext } from "@cacm/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  agentDotClass,
  agentLabel,
  contextTypeLabel,
  getSessionContexts,
  getSessionDecisionNotes,
  getSessionErrorNotes,
  summarizeSession,
  type CacmPanelProps,
  CacmPanel,
} from "./CacmPanel";

const testState = vi.hoisted(() => {
  type ActivityCallback = (activity: unknown) => void;
  return {
    client: null as unknown as {
      connect: ReturnType<typeof vi.fn>;
      sessions: ReturnType<typeof vi.fn>;
      query: ReturnType<typeof vi.fn>;
      inject: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      onActivity: ReturnType<typeof vi.fn>;
    },
    activityCallback: null as ActivityCallback | null,
    CacmClient: class {
      connect = vi.fn();
      sessions = vi.fn();
      query = vi.fn();
      inject = vi.fn();
      close = vi.fn();
      onActivity = vi.fn((callback: ActivityCallback) => {
        testState.activityCallback = callback;
        return () => {};
      });
      constructor() {
        // The component constructs its own client via useMemo on first render;
        // apply sane defaults here so the panel renders before tests override.
        testState.client = this as unknown as typeof testState.client;
        this.connect.mockResolvedValue(undefined);
        this.sessions.mockResolvedValue({ sessions: [] });
        this.query.mockResolvedValue({ entries: [] });
        this.inject.mockResolvedValue({ formatted: "[Cross-Agent Context]\n• note" });
      }
    },
  };
});

vi.mock("@cacm/sdk", () => ({
  DEFAULT_DAEMON_URL: "ws://localhost:9786",
  CacmClient: testState.CacmClient,
}));

// Slot-based react hooks harness (repo pattern for compiled components).
const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const effects: Array<() => void | (() => void)> = [];

  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
      effects.length = 0;
    },
    effects,
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useEffect(callback: () => void | (() => void)): void {
      nextIndex();
      effects.push(callback);
    },
    useMemo<T>(factory: () => T): T {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = factory();
      }
      return slots[index] as T;
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, (nextValue: T | ((value: T) => T)) => void] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue = (nextValue: T | ((value: T) => T)) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const codexSession: AgentSession = {
  session_id: "ses-codex-1",
  agent_type: "codex",
  path: "/repo/.codex/sessions/ses-codex-1",
  project: "/repo",
  created_at: "2026-08-05T10:00:00Z",
  status: "active",
};

const claudeSession: AgentSession = {
  session_id: "ses-claude-1",
  agent_type: "claude-code",
  path: "/repo/.claude/projects/ses-claude-1.jsonl",
  project: "/repo",
  created_at: "2026-08-05T09:00:00Z",
  status: "completed",
};

const decisionContext: CrossAgentContext = {
  id: "ctx-decision",
  session_id: "ses-codex-1",
  agent_type: "codex",
  context_type: "decision",
  content: "Use Effect v4 idioms for the adapter layer.",
  file_paths: ["apps/server/src/provider/Drivers/CodexDriver.ts"],
  decisions: ["Use Effect v4 idioms for the adapter layer."],
  errors: [],
  project: "/repo",
  timestamp: "2026-08-05T10:05:00Z",
};

const errorContext: CrossAgentContext = {
  id: "ctx-error",
  session_id: "ses-codex-1",
  agent_type: "codex",
  context_type: "error",
  content: "Codex session terminated unexpectedly mid-turn.",
  file_paths: [],
  decisions: [],
  errors: ["Codex session terminated unexpectedly mid-turn."],
  project: "/repo",
  timestamp: "2026-08-05T10:06:00Z",
};

// ---------------------------------------------------------------------------
// Element-tree helpers (no DOM in this suite; components are invoked directly)
// ---------------------------------------------------------------------------

function walk(node: ReactNode, visit: (element: ReactElement) => void): void {
  for (const child of Children.toArray(node)) {
    if (isValidElement(child)) {
      visit(child);
      walk((child.props as { children?: ReactNode }).children, visit);
    }
  }
}

function findByAriaLabel(node: ReactNode, label: string): ReactElement | null {
  let found: ReactElement | null = null;
  walk(node, (element) => {
    if (!found && (element.props as { "aria-label"?: string })["aria-label"] === label) {
      found = element;
    }
  });
  return found;
}

function findByRole(node: ReactNode, role: string): ReactElement | null {
  let found: ReactElement | null = null;
  walk(node, (element) => {
    if (!found && (element.props as { role?: string }).role === role) {
      found = element;
    }
  });
  return found;
}

function collectText(node: ReactNode): string {
  const parts: string[] = [];
  const push = (current: ReactNode) => {
    for (const child of Children.toArray(current)) {
      if (typeof child === "string" || typeof child === "number") {
        parts.push(String(child));
      } else if (isValidElement(child)) {
        push((child.props as { children?: ReactNode }).children);
      }
    }
  };
  push(node);
  return parts.join(" ");
}

function renderPanel(props: Partial<CacmPanelProps> = {}): ReactElement {
  hooks.beginRender();
  return CacmPanel({
    daemonUrl: "ws://localhost:9786",
    project: "/repo",
    ...props,
  }) as ReactElement;
}

/** Invoke the load/subscribe effect registered by the *first* render. */
function runInitialEffect(): void {
  const effect = hooks.effects[0];
  if (!effect) throw new Error("no effect registered by the first render");
  effect();
}

/** Invoke the effect at `index` (0-based registration order per render). */
function runEffect(index: number): void {
  const effect = hooks.effects[index];
  if (!effect) throw new Error(`no effect registered at index ${index}`);
  effect();
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  hooks.reset();
  testState.activityCallback = null;
});

afterEach(() => {
  hooks.reset();
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("CacmPanel presentation helpers", () => {
  it("labels every agent type with a distinct color dot", () => {
    const agents: Array<[AgentSession["agent_type"], string]> = [
      ["claude-code", "Claude Code"],
      ["codex", "Codex"],
      ["opencode", "OpenCode"],
      ["cursor", "Cursor"],
      ["grok", "Grok"],
      ["speg", "SPEG"],
    ];
    for (const [agent, label] of agents) {
      expect(agentLabel(agent)).toBe(label);
      expect(agentDotClass(agent)).toMatch(/^bg-/);
    }
    const classes = new Set(agents.map(([agent]) => agentDotClass(agent)));
    expect(classes.size).toBe(agents.length);
  });

  it("labels context types", () => {
    expect(contextTypeLabel("task")).toBe("Task");
    expect(contextTypeLabel("decision")).toBe("Decision");
    expect(contextTypeLabel("file-change")).toBe("File change");
    expect(contextTypeLabel("error")).toBe("Error");
    expect(contextTypeLabel("pattern")).toBe("Pattern");
  });

  it("filters contexts to a session and folds decision/error notes", () => {
    const contexts = [decisionContext, errorContext, { ...errorContext, session_id: "other" }];
    expect(getSessionContexts(contexts, "ses-codex-1")).toEqual([decisionContext, errorContext]);
    expect(getSessionDecisionNotes([decisionContext, decisionContext])).toEqual([
      "Use Effect v4 idioms for the adapter layer.",
    ]);
    expect(getSessionErrorNotes([errorContext])).toEqual([
      "Codex session terminated unexpectedly mid-turn.",
    ]);
  });

  it("summarizes a session from its newest context and truncates long content", () => {
    expect(summarizeSession(codexSession, [decisionContext])).toBe(
      "Use Effect v4 idioms for the adapter layer.",
    );
    const long = {
      ...decisionContext,
      content: "word ".repeat(60),
    };
    expect(summarizeSession(codexSession, [long]).endsWith("…")).toBe(true);
  });

  it("falls back to the session path tail when no context exists", () => {
    expect(summarizeSession(codexSession, [])).toBe("ses-codex-1");
    expect(summarizeSession(claudeSession, [])).toBe("ses-claude-1.jsonl");
  });
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

describe("CacmPanel", () => {
  it("shows a loading state while connecting", () => {
    const tree = renderPanel();
    expect(collectText(tree)).toContain("Connecting to cacm-daemon");
    expect(testState.client.connect).not.toHaveBeenCalled();
  });

  it("loads sessions and context on mount and renders the timeline", async () => {
    renderPanel(); // first render constructs the client (constructor defaults)
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession, claudeSession] });
    testState.client.query.mockResolvedValue({ entries: [decisionContext, errorContext] });
    runInitialEffect();
    await flushPromises();

    const tree = renderPanel();
    expect(testState.client.connect).toHaveBeenCalledTimes(1);
    expect(testState.client.sessions).toHaveBeenCalledWith({ project: "/repo" });
    expect(testState.client.query).toHaveBeenCalledWith({ project: "/repo", limit: 100 });

    expect(findByAriaLabel(tree, "Session ses-codex-1")).not.toBeNull();
    expect(findByAriaLabel(tree, "Session ses-claude-1")).not.toBeNull();
    const text = collectText(tree);
    expect(text).toContain("Codex");
    expect(text).toContain("Claude Code");
    expect(text).toContain("Use Effect v4 idioms for the adapter layer.");
    // CACM header + one inject button per session.
    expect(findByAriaLabel(tree, "Inject context from ses-codex-1")).not.toBeNull();
    expect(findByAriaLabel(tree, "Inject context from ses-claude-1")).not.toBeNull();
    // Connected indicator.
    expect(findByAriaLabel(tree, "CACM daemon connected")).not.toBeNull();
  });

  it("loads all sessions without a project and skips context query", async () => {
    renderPanel({ project: null });
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession] });
    runInitialEffect();
    await flushPromises();

    renderPanel({ project: null });
    expect(testState.client.sessions).toHaveBeenCalledWith({});
    expect(testState.client.query).not.toHaveBeenCalled();
    expect(collectText(renderPanel({ project: null }))).toContain("Codex");
  });

  it("renders an empty state when the daemon has no sessions", async () => {
    renderPanel();
    runInitialEffect();
    await flushPromises();

    const tree = renderPanel();
    expect(collectText(tree)).toContain("No agent sessions found yet.");
  });

  it("re-queries on workspace switch without closing the daemon connection", async () => {
    // Render 1 for workspace A: effects[0]=load, effects[1]=switch, effects[2]=close.
    renderPanel({ project: "/repo-a" });
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession] });
    testState.client.query.mockResolvedValue({ entries: [decisionContext] });
    runInitialEffect();
    await flushPromises();
    expect(testState.client.connect).toHaveBeenCalledTimes(1);
    expect(testState.client.sessions).toHaveBeenCalledWith({ project: "/repo-a" });

    // Render 2 for workspace B: effects[3]=load, effects[4]=switch, effects[5]=close.
    renderPanel({ project: "/repo-b" });
    testState.client.sessions.mockResolvedValue({ sessions: [claudeSession] });
    testState.client.query.mockResolvedValue({ entries: [] });
    runEffect(3); // the new render's load effect
    await flushPromises();

    expect(testState.client.sessions).toHaveBeenCalledWith({ project: "/repo-b" });
    // The socket is reused across workspaces — closing on every switch is
    // what caused the transient "cannot reach cacm-daemon" flash.
    expect(testState.client.close).not.toHaveBeenCalled();
    expect(collectText(renderPanel({ project: "/repo-b" }))).toContain("Claude Code");
    // And unmount still tears the connection down (effects[5] = close).
    const unmount = hooks.effects[5]?.() ?? (() => {});
    unmount();
    expect(testState.client.close).toHaveBeenCalledTimes(1);
  });

  it("shows a loading state, not the error card, on transient failure after data", async () => {
    vi.useFakeTimers();
    // First workspace loads fine (effects[0]=load, effects[1]=switch, effects[2]=close).
    renderPanel({ project: "/repo-a" });
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession] });
    testState.client.query.mockResolvedValue({ entries: [decisionContext] });
    runInitialEffect();
    await flushPromises();
    expect(collectText(renderPanel({ project: "/repo-a" }))).toContain("Codex");

    // The next workspace's load fails transiently (e.g. reconnect blip).
    testState.client.connect.mockRejectedValueOnce(new Error("connection refused"));
    renderPanel({ project: "/repo-b" });
    runEffect(3); // render 2's load effect
    await flushPromises();

    const tree = renderPanel({ project: "/repo-b" });
    // No error card — the panel keeps a loading state and self-heals.
    expect(findByRole(tree, "alert")).toBeNull();
    expect(collectText(tree)).toContain("Connecting to cacm-daemon");
    // The self-heal retry is scheduled and recovers on the next connect.
    testState.client.connect.mockResolvedValue(undefined);
    testState.client.sessions.mockResolvedValue({ sessions: [claudeSession] });
    testState.client.query.mockResolvedValue({ entries: [] });
    await vi.advanceTimersByTimeAsync(1600);
    await flushPromises();
    expect(collectText(renderPanel({ project: "/repo-b" }))).toContain("Claude Code");

    // Clear the pending retry timer on unmount (effects[5] = close).
    const unmount = hooks.effects[5]?.() ?? (() => {});
    unmount();
    expect(testState.client.close).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("surfaces a retryable error only after the daemon stays unreachable", async () => {
    vi.useFakeTimers();
    renderPanel();
    // Keep failing: a single blip stays in a loading state, and only after
    // several consecutive failures does the error card appear.
    testState.client.connect.mockRejectedValue(new Error("connection refused"));
    runInitialEffect();
    await flushPromises();

    // First failure → loading state, not the error card.
    const first = renderPanel();
    expect(findByRole(first, "alert")).toBeNull();
    expect(collectText(first)).toContain("Connecting to cacm-daemon");

    // Run the self-heal retries: the daemon is still down, so after the
    // transient window the error card appears.
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    const tree = renderPanel();
    const alert = findByRole(tree, "alert");
    expect(alert).not.toBeNull();
    expect(collectText(alert)).toContain("connection refused");
    expect(findByAriaLabel(tree, "CACM daemon unreachable")).not.toBeNull();

    // Retry: the daemon comes back, so the timeline loads.
    testState.client.connect.mockResolvedValue(undefined);
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession] });
    const retry = findByAriaLabel(tree, "Retry connecting to CACM daemon");
    expect(retry).not.toBeNull();
    (retry!.props as { onClick: () => void }).onClick();
    await flushPromises();

    const recovered = renderPanel();
    expect(collectText(recovered)).toContain("Codex");
    expect(findByAriaLabel(recovered, "CACM daemon connected")).not.toBeNull();
    vi.useRealTimers();
  });

  it("expands a session to show its extracted decisions, errors, and files", async () => {
    renderPanel();
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession] });
    testState.client.query.mockResolvedValue({ entries: [decisionContext, errorContext] });
    runInitialEffect();
    await flushPromises();

    const row = findByAriaLabel(renderPanel(), "Session ses-codex-1");
    expect(row).not.toBeNull();
    (row!.props as { onClick: () => void }).onClick();

    const expanded = renderPanel();
    const text = collectText(expanded);
    expect(text).toContain("Decision");
    expect(text).toContain("Use Effect v4 idioms for the adapter layer.");
    expect(text).toContain("Codex session terminated unexpectedly mid-turn.");
    expect(text).toContain("apps/server/src/provider/Drivers/CodexDriver.ts");

    // Collapse again.
    const rowAgain = findByAriaLabel(expanded, "Session ses-codex-1");
    (rowAgain!.props as { onClick: () => void }).onClick();
    expect(collectText(renderPanel())).not.toContain("Decision");
  });

  it("injects a session's formatted context into the composer callback", async () => {
    const onInjectContext = vi.fn();
    renderPanel({ onInjectContext });
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession] });
    testState.client.query.mockResolvedValue({ entries: [decisionContext] });
    runInitialEffect();
    await flushPromises();

    const inject = findByAriaLabel(
      renderPanel({ onInjectContext }),
      "Inject context from ses-codex-1",
    );
    expect(inject).not.toBeNull();
    (inject!.props as { onClick: () => void }).onClick();
    await flushPromises();

    expect(testState.client.inject).toHaveBeenCalledWith({
      sessionId: "ses-codex-1",
      agent: "codex",
    });
    expect(onInjectContext).toHaveBeenCalledWith("[Cross-Agent Context]\n• note");
    expect(collectText(renderPanel({ onInjectContext }))).not.toContain("Injecting…");
  });

  it("disables other inject buttons and reports injection failures", async () => {
    const onInjectContext = vi.fn();
    renderPanel({ onInjectContext });
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession, claudeSession] });
    let resolveInject!: (value: { formatted: string }) => void;
    testState.client.inject.mockImplementation(
      () =>
        new Promise<{ formatted: string }>((resolve) => {
          resolveInject = resolve;
        }),
    );
    runInitialEffect();
    await flushPromises();

    const inject = findByAriaLabel(
      renderPanel({ onInjectContext }),
      "Inject context from ses-codex-1",
    );
    (inject!.props as { onClick: () => void }).onClick();

    const pending = renderPanel({ onInjectContext });
    expect(collectText(pending)).toContain("Injecting…");
    const otherInject = findByAriaLabel(pending, "Inject context from ses-claude-1");
    expect((otherInject!.props as { disabled?: boolean }).disabled).toBe(true);

    resolveInject({ formatted: "ok" });
    await flushPromises();
    expect(onInjectContext).toHaveBeenCalledWith("ok");
    expect(collectText(renderPanel({ onInjectContext }))).not.toContain("Injecting…");
  });

  it("auto-refreshes when the daemon pushes session activity", async () => {
    renderPanel();
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession] });
    testState.client.query.mockResolvedValue({ entries: [] });
    runInitialEffect();
    await flushPromises();
    expect(collectText(renderPanel())).toContain("Codex");

    // The daemon announces a new session; the activity handler reloads.
    testState.client.sessions.mockResolvedValue({ sessions: [codexSession, claudeSession] });
    expect(testState.activityCallback).not.toBeNull();
    testState.activityCallback!({ session_id: "ses-claude-1", event_type: "created" });
    await flushPromises();

    expect(testState.client.sessions).toHaveBeenCalledTimes(2);
    expect(findByAriaLabel(renderPanel(), "Session ses-claude-1")).not.toBeNull();
  });

  it("suggests sending the collected context first when the agent switches", async () => {
    const onSendContext = vi.fn();
    // Render 1 with opencode active: no notice (no prior agent to switch
    // *from*). effects[0]=load, effects[1]=switch-detection.
    const first = renderPanel({ activeAgent: "opencode", onSendContext });
    expect(collectText(first)).not.toContain("Send context first");
    runEffect(1); // records previous=opencode

    // Render 2 with a different agent: effects[3]=load, effects[4]=switch.
    renderPanel({ activeAgent: "claude-code", onSendContext });
    runEffect(4); // sees opencode → claude-code, sets the notice

    const noticed = renderPanel({ activeAgent: "claude-code", onSendContext });
    const text = collectText(noticed);
    expect(text).toContain("You switched from");
    expect(text).toContain("OpenCode");
    expect(text).toContain("Claude Code");

    // The button gathers the full cross-agent context (wildcard session) and
    // hands it to the composer's auto-send path.
    testState.client.inject.mockResolvedValue({ formatted: "[Cross-Agent Context]\n• task" });
    const send = findByAriaLabel(noticed, "Send cross-agent context to Claude Code");
    expect(send).not.toBeNull();
    (send!.props as { onClick: () => void }).onClick();
    await flushPromises();

    expect(testState.client.inject).toHaveBeenCalledWith({
      sessionId: "*",
      agent: "claude-code",
    });
    expect(onSendContext).toHaveBeenCalledWith("[Cross-Agent Context]\n• task");
    // The notice clears after sending.
    expect(collectText(renderPanel({ activeAgent: "claude-code", onSendContext }))).not.toContain(
      "Send context first",
    );
  });

  it("dismisses the switch suggestion without sending", async () => {
    const onSendContext = vi.fn();
    renderPanel({ activeAgent: "opencode", onSendContext });
    runEffect(1); // record previous=opencode
    renderPanel({ activeAgent: "grok", onSendContext });
    runEffect(4); // detect the switch
    const noticed = renderPanel({ activeAgent: "grok", onSendContext });
    expect(collectText(noticed)).toContain("Send context first");

    const dismiss = findByAriaLabel(noticed, "Dismiss");
    expect(dismiss).not.toBeNull();
    (dismiss!.props as { onClick: () => void }).onClick();
    expect(onSendContext).not.toHaveBeenCalled();
    expect(collectText(renderPanel({ activeAgent: "grok", onSendContext }))).not.toContain(
      "Send context first",
    );
  });

  it("shows a restart daemon button in the error state", async () => {
    vi.useFakeTimers();
    renderPanel(); // constructs the client (constructor applies resolved defaults)
    testState.client.connect.mockRejectedValue(new Error("connect refused"));
    runInitialEffect();
    await flushPromises();
    // Transient blips stay in a loading state; the error card (with the
    // restart button) appears only after several consecutive failures.
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    const tree = renderPanel();
    expect(collectText(tree)).toContain("Could not reach cacm-daemon");
    expect(findByAriaLabel(tree, "Restart CACM daemon")).not.toBeNull();
    vi.useRealTimers();
  });

  it("restart posts to the server route and reloads the timeline", async () => {
    vi.useFakeTimers();
    renderPanel(); // constructs the client
    testState.client.connect.mockRejectedValue(new Error("connect refused"));
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ status: "started" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    runInitialEffect();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    const tree = renderPanel();
    const restartButton = findByAriaLabel(tree, "Restart CACM daemon");
    expect(restartButton).not.toBeNull();
    (restartButton!.props as { onClick: () => void }).onClick();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/api/speg/cacm/restart", { method: "POST" });
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
