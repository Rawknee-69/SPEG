/**
 * Mock WebSocket for unit tests.
 *
 * Swapped in via `globalThis.WebSocket` so `CacmClient` exercises its real
 * code paths (connect/close listeners, send, frame correlation) without a
 * network. A test "daemon" is simulated with the static hooks below:
 *
 * - `MockWebSocket.onRequest` — receives every request frame the client sends.
 * - `MockWebSocket.autoOpen` — fresh sockets auto-open (microtask) like a real daemon accepting.
 * - `MockWebSocket.failOnConstruct` — fresh sockets immediately error + close (daemon unreachable).
 * - instance helpers `open()` / `fail()` / `receive()` / `close()` drive a specific socket.
 */

import type { WebSocketLike, WebSocketLikeEvent } from "../dist/index.js";

type Listener = (event: WebSocketLikeEvent) => void;

/** A client request frame, as parsed by the mock. */
export interface RequestFrame {
  id: number;
  method: string;
  params: unknown;
}

export class MockWebSocket implements WebSocketLike {
  /** All sockets created, in order (used to observe reconnects). */
  static instances: MockWebSocket[] = [];
  /** When true, a fresh socket auto-opens shortly after construction. */
  static autoOpen = false;
  /** When true, a fresh socket immediately errors + closes after construction. */
  static failOnConstruct = false;
  /** Receives every request frame sent across all instances. */
  static onRequest: ((ws: MockWebSocket, frame: RequestFrame) => void) | null = null;

  readonly url: string;
  readonly createdAt = Date.now();
  readyState = 0; // CONNECTING
  sent: string[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    if (MockWebSocket.failOnConstruct) {
      queueMicrotask(() => this.fail());
    } else if (MockWebSocket.autoOpen) {
      queueMicrotask(() => this.open());
    }
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
    const frame = JSON.parse(data) as RequestFrame;
    MockWebSocket.onRequest?.(this, frame);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.emit("close", { code, reason });
  }

  // ---- test helpers ----

  /** Simulate the daemon accepting the connection. */
  open(): void {
    this.readyState = 1; // OPEN
    this.emit("open", {});
  }

  /** Simulate the connection failing before/without opening. */
  fail(): void {
    this.readyState = 3; // CLOSED
    this.emit("error", {});
    this.emit("close", { code: 1006 });
  }

  /** Simulate the daemon sending a frame to the client. */
  receive(payload: string): void {
    this.emit("message", { data: payload });
  }

  private emit(type: string, event: WebSocketLikeEvent): void {
    const set = this.listeners.get(type);
    if (!set) return;
    for (const listener of [...set]) listener(event);
  }
}

/** The most recently created socket. */
export function lastWs(): MockWebSocket {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!ws) throw new Error("no MockWebSocket was created");
  return ws;
}

/** Send a JSON-RPC-style success reply for `frame` back to the client. */
export function reply(ws: MockWebSocket, frame: { id: number }, result: unknown): void {
  ws.receive(JSON.stringify({ id: frame.id, result }));
}
