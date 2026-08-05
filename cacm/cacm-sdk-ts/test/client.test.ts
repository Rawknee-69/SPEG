import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { CacmClient, CacmError, normalizeDaemonUrl } from "../dist/index.js";
import type { CacmSessionActivity } from "../dist/index.js";
import { lastWs, MockWebSocket, reply } from "./mock-websocket.ts";

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  MockWebSocket.instances = [];
  MockWebSocket.autoOpen = false;
  MockWebSocket.failOnConstruct = false;
  MockWebSocket.onRequest = null;
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  MockWebSocket.instances = [];
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleEntry(id: string): Record<string, unknown> {
  return {
    id,
    session_id: "s1",
    agent_type: "codex",
    context_type: "decision",
    content: "use the workspace resolver",
    file_paths: ["Cargo.toml"],
    decisions: ["resolver = 2"],
    errors: [],
    timestamp: "2026-01-01T00:00:00Z",
  };
}

function sampleSession(id: string): Record<string, unknown> {
  return {
    session_id: id,
    agent_type: "jcode",
    path: `/repo/${id}.jsonl`,
    created_at: "2026-01-01T00:00:00Z",
    status: "active",
  };
}

function sampleActivity(overrides: Partial<CacmSessionActivity> = {}): CacmSessionActivity {
  return {
    session_id: "s1",
    agent_type: "jcode",
    event_type: "modified",
    turn: 3,
    timestamp: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isCacmError(err: unknown, kind: CacmError["kind"]): boolean {
  return err instanceof CacmError && err.kind === kind;
}

// ---------------------------------------------------------------------------
// Address normalization
// ---------------------------------------------------------------------------

test("normalizeDaemonUrl appends the /ws route", () => {
  assert.equal(normalizeDaemonUrl(""), "ws://localhost:9786/ws");
  assert.equal(normalizeDaemonUrl("ws://localhost:9786"), "ws://localhost:9786/ws");
  assert.equal(normalizeDaemonUrl("ws://localhost:9786/"), "ws://localhost:9786/ws");
  assert.equal(normalizeDaemonUrl("localhost:9786"), "ws://localhost:9786/ws");
  assert.equal(normalizeDaemonUrl("localhost:9786/ws"), "ws://localhost:9786/ws");
  assert.equal(normalizeDaemonUrl("ws://localhost:9786/ws"), "ws://localhost:9786/ws");
  assert.equal(normalizeDaemonUrl("wss://daemon.example/ws"), "wss://daemon.example/ws");
  assert.equal(normalizeDaemonUrl("ws://localhost:9786?token=x"), "ws://localhost:9786/ws?token=x");
  assert.throws(() => normalizeDaemonUrl("http://evil"), CacmError);
  assert.throws(() => normalizeDaemonUrl("bad addr"), CacmError);
  assert.throws(() => normalizeDaemonUrl("ws://"), CacmError);
});

// ---------------------------------------------------------------------------
// connect()
// ---------------------------------------------------------------------------

test("connect opens a socket and resolves on the open event", async () => {
  const client = new CacmClient("ws://test/ws");
  const connected = client.connect();
  const ws = lastWs();
  assert.equal(ws.readyState, 0); // CONNECTING until the daemon accepts
  ws.open();
  await connected;
  assert.equal(ws.readyState, 1);
  client.close();
});

test("connect resolves immediately when already open", async () => {
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  await client.connect();
  const sockets = MockWebSocket.instances.length;
  await client.connect();
  assert.equal(MockWebSocket.instances.length, sockets, "no second socket");
  client.close();
});

test("connect rejects when the daemon refuses the connection", async () => {
  const client = new CacmClient("ws://test/ws", { maxReconnectAttempts: 0 });
  const connected = client.connect();
  lastWs().fail();
  await assert.rejects(connected, (err) => isCacmError(err, "connect"));
  client.close();
});

test("connect times out when the socket never opens", async () => {
  // The mock neither opens nor errors: the connect timeout must reject.
  const client = new CacmClient("ws://test/ws", {
    connectTimeoutMs: 20,
    maxReconnectAttempts: 0,
  });
  const connected = client.connect();
  await assert.rejects(connected, (err) => isCacmError(err, "connect"));
  client.close();
});

test("invalid constructor addresses are rejected", async () => {
  const client = new CacmClient("http://evil");
  await assert.rejects(client.connect(), (err) => isCacmError(err, "invalid-address"));
  client.close();
});

// ---------------------------------------------------------------------------
// Request/reply roundtrips
// ---------------------------------------------------------------------------

test("query sends cacm.query and parses entries", async () => {
  MockWebSocket.onRequest = (ws, frame) => {
    assert.equal(frame.method, "cacm.query");
    assert.deepEqual(frame.params, { project: "/repo", limit: 5 });
    reply(ws, frame, { entries: [sampleEntry("c1")] });
  };
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  const result = await client.query({ project: "/repo", limit: 5 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.id, "c1");
  assert.equal(result.entries[0]?.agent_type, "codex");
  assert.equal(result.entries[0]?.context_type, "decision");
  client.close();
});

test("sessions sends cacm.sessions and parses sessions", async () => {
  MockWebSocket.onRequest = (ws, frame) => {
    assert.equal(frame.method, "cacm.sessions");
    assert.deepEqual(frame.params, { project: "/repo" });
    reply(ws, frame, { sessions: [sampleSession("s9")] });
  };
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  const result = await client.sessions({ project: "/repo" });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0]?.session_id, "s9");
  assert.equal(result.sessions[0]?.agent_type, "jcode");
  assert.equal(result.sessions[0]?.status, "active");
  client.close();
});

test("sessions defaults to an empty params object", async () => {
  MockWebSocket.onRequest = (ws, frame) => {
    assert.equal(frame.method, "cacm.sessions");
    assert.deepEqual(frame.params, {});
    reply(ws, frame, { sessions: [] });
  };
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  const result = await client.sessions();
  assert.deepEqual(result.sessions, []);
  client.close();
});

test("inject sends cacm.inject and returns formatted text", async () => {
  MockWebSocket.onRequest = (ws, frame) => {
    assert.equal(frame.method, "cacm.inject");
    assert.deepEqual(frame.params, { sessionId: "ses_abc", agent: "jcode" });
    reply(ws, frame, {
      formatted: "[Cross-Agent Context]\n• Task: hi (jcode, 5m ago)",
    });
  };
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  const result = await client.inject({ sessionId: "ses_abc", agent: "jcode" });
  assert.ok(result.formatted.startsWith("[Cross-Agent Context]"));
  client.close();
});

test("ping returns pong", async () => {
  MockWebSocket.onRequest = (ws, frame) => {
    assert.equal(frame.method, "cacm.ping");
    ws.receive(JSON.stringify({ id: frame.id, result: "pong" }));
  };
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  assert.equal(await client.ping(), "pong");
  client.close();
});

test("correlates concurrent requests by id", async () => {
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  const replies: Record<number, unknown> = {
    1: { entries: [sampleEntry("a")] },
    2: { entries: [sampleEntry("b")] },
  };
  MockWebSocket.onRequest = (ws, frame) => {
    setTimeout(() => reply(ws, frame, replies[frame.id] ?? { entries: [] }), 5);
  };
  const [a, b] = await Promise.all([
    client.query({ project: "/repo" }),
    client.query({ project: "/repo2" }),
  ]);
  assert.equal(a.entries[0]?.id, "a");
  assert.equal(b.entries[0]?.id, "b");
  client.close();
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test("rpc errors reject with kind 'rpc' and are not retried", async () => {
  let calls = 0;
  MockWebSocket.onRequest = (ws, frame) => {
    calls += 1;
    ws.receive(
      JSON.stringify({
        id: frame.id,
        error: { code: -32602, message: "missing required param 'project' (string)" },
      }),
    );
  };
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  await assert.rejects(client.query({ project: "" }), (err) => {
    assert.ok(err instanceof CacmError);
    assert.equal(err.kind, "rpc");
    assert.equal(err.code, -32602);
    assert.match(err.message, /project/);
    return true;
  });
  assert.equal(calls, 1);
  client.close();
});

test("requests time out when the daemon never replies", async () => {
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws", { timeoutMs: 20 });
  await assert.rejects(client.query({ project: "/repo" }), (err) => isCacmError(err, "timeout"));
  client.close();
});

test("malformed replies reject with kind 'protocol'", async () => {
  MockWebSocket.onRequest = (ws, frame) => {
    ws.receive(JSON.stringify({ id: frame.id, unexpected: true }));
  };
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  await assert.rejects(client.query({ project: "/repo" }), (err) => isCacmError(err, "protocol"));
  client.close();
});

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

test("onActivity receives cacm.session_activity notifications and unsubscribes", async () => {
  MockWebSocket.onRequest = (ws, frame) => {
    ws.receive(JSON.stringify({ event: "cacm.session_activity", data: sampleActivity() }));
    reply(ws, frame, { entries: [] });
  };
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  const seen: CacmSessionActivity[] = [];
  const unsubscribe = client.onActivity((activity) => seen.push(activity));

  await client.query({ project: "/repo" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.session_id, "s1");
  assert.equal(seen[0]?.event_type, "modified");
  assert.equal(seen[0]?.turn, 3);

  unsubscribe();
  MockWebSocket.onRequest = (ws, frame) => reply(ws, frame, { entries: [] });
  await client.query({ project: "/repo" });
  assert.equal(seen.length, 1, "unsubscribed listener must not fire");
  client.close();
});

// ---------------------------------------------------------------------------
// Reconnect behavior
// ---------------------------------------------------------------------------

test("reconnects with backoff after the daemon drops the connection", async () => {
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws", {
    backoffBaseMs: 20,
    backoffMaxMs: 40,
    maxReconnectAttempts: 3,
  });
  let servedOnFirst = 0;
  let servedOnSecond = 0;
  MockWebSocket.onRequest = (ws, frame) => {
    if (MockWebSocket.instances[0] === ws) {
      servedOnFirst += 1;
      ws.close(); // daemon drops the connection instead of replying
      return;
    }
    servedOnSecond += 1;
    reply(ws, frame, { entries: [] });
  };

  await client.connect();
  // The first request hits the dropped socket → transport error, not retried.
  await assert.rejects(client.query({ project: "/repo" }), (err) => isCacmError(err, "transport"));
  assert.equal(servedOnFirst, 1);

  // Background reconnect opens a fresh socket after the backoff delay.
  await waitFor(() => MockWebSocket.instances.length >= 2);
  const first = MockWebSocket.instances[0]!;
  const second = MockWebSocket.instances[1]!;
  assert.ok(
    second.createdAt - first.createdAt >= 20 - 5,
    `expected >= 15 ms backoff, got ${second.createdAt - first.createdAt}`,
  );
  await waitFor(() => second.readyState === 1);

  const result = await client.query({ project: "/repo" });
  assert.deepEqual(result.entries, []);
  assert.equal(servedOnSecond, 1);
  client.close();
});

test("stops reconnecting after maxReconnectAttempts", async () => {
  MockWebSocket.failOnConstruct = true; // every new socket errors + closes
  const client = new CacmClient("ws://test/ws", {
    backoffBaseMs: 5,
    backoffMaxMs: 10,
    maxReconnectAttempts: 2,
  });
  await assert.rejects(client.connect(), (err) => isCacmError(err, "connect"));
  // 1 initial attempt + 2 scheduled reconnect attempts, then it gives up.
  await waitFor(() => MockWebSocket.instances.length >= 3);
  await sleep(40);
  assert.equal(MockWebSocket.instances.length, 3, "no further attempts after budget");
  client.close();
});

test("close rejects in-flight requests and stops reconnection", async () => {
  MockWebSocket.autoOpen = true;
  const client = new CacmClient("ws://test/ws");
  MockWebSocket.onRequest = () => {
    /* never reply */
  };
  const query = client.query({ project: "/repo" });
  await waitFor(() => MockWebSocket.instances.length >= 1 && lastWs().readyState === 1);
  client.close();
  await assert.rejects(query, (err) => isCacmError(err, "transport"));
  const count = MockWebSocket.instances.length;
  await sleep(30);
  assert.equal(MockWebSocket.instances.length, count, "no reconnection after close");
});
