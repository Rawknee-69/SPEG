/**
 * CacmClient — TypeScript client for the CACM daemon's WebSocket surface.
 *
 * The daemon speaks a JSON-RPC-style protocol (see `cacm-daemon/src/server.rs`):
 *
 * ```text
 * → {"id": 1, "method": "cacm.query", "params": {"project": "/repo", "limit": 10}}
 * ← {"id": 1, "result": {"entries": [...]}}
 * ← {"id": 1, "error": {"code": -32602, "message": "..."}}
 * ← {"event": "cacm.session_activity", "data": {...}}
 * ```
 *
 * The client keeps one persistent connection, correlates replies by request
 * id (skipping server-initiated notifications), and reconnects with
 * exponential backoff when the connection drops. Zero runtime dependencies:
 * it uses the platform's native `WebSocket` (browsers and Node >= 22).
 *
 * ```ts
 * import { CacmClient } from "@cacm/sdk";
 * const client = new CacmClient();
 * await client.connect();
 * const { entries } = await client.query({ project: "/repo", limit: 10 });
 * const { formatted } = await client.inject({ sessionId: "ses_abc", agent: "codex" });
 * client.close();
 * ```
 */

import type {
  AgentSession,
  CacmInjectParams,
  CacmInjectResult,
  CacmQueryParams,
  CacmQueryResult,
  CacmSessionsParams,
  CacmSessionsResult,
  CrossAgentContext,
  CacmSessionActivity,
} from "./types.js";

/** Default daemon address — matches `cacm-daemon`'s `--port 9786` default. */
export const DEFAULT_DAEMON_URL = "ws://localhost:9786";

/** Per-request reply timeout (ms). */
const REQUEST_TIMEOUT_MS = 30_000;
/** Time to wait for the socket to reach OPEN (ms). */
const CONNECT_TIMEOUT_MS = 10_000;
/** Initial reconnect delay (doubles per failed attempt). */
const BACKOFF_BASE_MS = 100;
/** Ceiling for the reconnect delay. */
const BACKOFF_MAX_MS = 10_000;
/** Connection attempts per disconnect before giving up. */
const MAX_RECONNECT_ATTEMPTS = 8;

/** Native WebSocket readyState values. */
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

/** Categories of failure surfaced by the client. */
export type CacmErrorKind =
  | "invalid-address"
  | "connect"
  | "transport"
  | "timeout"
  | "rpc"
  | "protocol";

/** An error raised by {@link CacmClient}. */
export class CacmError extends Error {
  readonly kind: CacmErrorKind;
  /** JSON-RPC error code, present when `kind === "rpc"`. */
  readonly code?: number;

  constructor(kind: CacmErrorKind, message: string, code?: number) {
    super(message);
    this.name = "CacmError";
    this.kind = kind;
    if (code !== undefined) this.code = code;
  }
}

/** A message event delivered by a {@link WebSocketLike}. */
export interface WebSocketLikeEvent {
  /** Payload of a `message` event (string for text frames). */
  readonly data?: unknown;
  /** Close code, present on `close` events. */
  readonly code?: number;
  readonly reason?: string;
}

/**
 * The minimal structural surface of the platform WebSocket that the client
 * uses. Both the browser's `WebSocket` and Node >= 22's native `WebSocket`
 * satisfy it, and tests substitute a mock.
 */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: WebSocketLikeEvent) => void,
  ): void;
}

type WebSocketCtor = new (url: string) => WebSocketLike;

/** Tuning knobs for {@link CacmClient} (all optional; defaults match the Rust SDK). */
export interface ClientOptions {
  /** Per-request reply timeout in ms (default 30 000). */
  timeoutMs?: number;
  /** Time to wait for the socket to reach OPEN before failing the attempt (default 10 000). */
  connectTimeoutMs?: number;
  /** Initial reconnect delay in ms (default 100). */
  backoffBaseMs?: number;
  /** Ceiling for the reconnect delay in ms (default 10 000). */
  backoffMaxMs?: number;
  /** Reconnect attempts per disconnect before giving up (default 8). */
  maxReconnectAttempts?: number;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: CacmError) => void;
  timer: number;
}

/**
 * Normalize a user-supplied address into a full `ws://` URL with the daemon's
 * `/ws` route. Accepts `host:port`, `host:port/ws`, `ws://host:port`, or
 * `wss://...` (kept as-is). Throws {@link CacmError} on malformed input.
 */
export function normalizeDaemonUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "") return `${DEFAULT_DAEMON_URL}/ws`;
  if (!/^wss?:\/\//i.test(trimmed)) {
    if (trimmed.includes("://")) {
      throw new CacmError("invalid-address", `invalid daemon address: ${url}`);
    }
    return normalizeDaemonUrl(`ws://${trimmed}`);
  }
  const schemeEnd = trimmed.indexOf("://") + 3;
  const rest = trimmed.slice(schemeEnd);
  const slash = rest.indexOf("/");
  const query = rest.indexOf("?");
  const authorityEnd = Math.min(
    slash === -1 ? rest.length : slash,
    query === -1 ? rest.length : query,
  );
  const authority = rest.slice(0, authorityEnd);
  if (authority === "" || /\s/.test(authority)) {
    throw new CacmError("invalid-address", `invalid daemon address: ${url}`);
  }
  const suffix = rest.slice(authorityEnd);
  if (suffix === "" || suffix === "/" || suffix.startsWith("?")) {
    return `${trimmed.slice(0, schemeEnd)}${authority}/ws${suffix.startsWith("?") ? suffix : ""}`;
  }
  return trimmed;
}

/** Wrapper so the timer handle stays a plain `number` in every environment. */
function schedule(fn: () => void, ms: number): number {
  return setTimeout(fn, ms) as unknown as number;
}

function cancel(handle: number): void {
  clearTimeout(handle);
}

/**
 * Client for the CACM daemon's WebSocket JSON-RPC surface.
 *
 * `connect()` opens the socket and resolves once the connection is ready;
 * the socket is reused for subsequent requests. When the connection drops,
 * the client reconnects in the background with exponential backoff
 * (100 ms → 10 s, ×2, up to 8 attempts), so a later request transparently
 * uses a fresh connection. `close()` stops the client.
 */
export class CacmClient {
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxReconnectAttempts: number;

  private ws: WebSocketLike | null = null;
  private openPromise: Promise<void> | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;
  private manuallyClosed = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly activityListeners = new Set<(activity: CacmSessionActivity) => void>();

  /**
   * @param url daemon address; defaults to `ws://localhost:9786`. A bare
   * `host:port` or a `ws://` URL without a path is normalized to the daemon's
   * `/ws` route.
   * @param options tuning knobs (see {@link ClientOptions}).
   */
  constructor(url: string = DEFAULT_DAEMON_URL, options: ClientOptions = {}) {
    this.url = url;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? BACKOFF_MAX_MS;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;
  }

  /**
   * Open the WebSocket and resolve once it is ready. Resolves immediately if
   * already connected; while a connect attempt (user- or reconnect-initiated)
   * is in flight, returns that same attempt.
   */
  connect(): Promise<void> {
    if (this.isOpen()) return Promise.resolve();
    this.manuallyClosed = false;
    // A fresh user-initiated connect gets a fresh backoff budget.
    this.reconnectAttempt = 0;
    if (this.openPromise) return this.openPromise;
    const promise = this.openSocket();
    this.openPromise = promise;
    void promise.catch(() => {
      /* rejection is surfaced to awaiters; this keeps background attempts safe */
    });
    return promise;
  }

  /** `cacm.query` — stored cross-agent context for `project`, newest first. */
  async query(params: CacmQueryParams): Promise<CacmQueryResult> {
    const result = await this.request("cacm.query", params);
    const entries = readArray(result, "entries");
    return { entries: entries as unknown as CrossAgentContext[] };
  }

  /** `cacm.sessions` — live agent sessions, optionally filtered to `project`. */
  async sessions(params: CacmSessionsParams = {}): Promise<CacmSessionsResult> {
    const result = await this.request("cacm.sessions", params);
    const sessions = readArray(result, "sessions");
    return { sessions: sessions as unknown as AgentSession[] };
  }

  /** `cacm.inject` — context formatted for the target agent's next turn. */
  async inject(params: CacmInjectParams): Promise<CacmInjectResult> {
    const result = await this.request("cacm.inject", params);
    const formatted = readString(result, "formatted");
    return { formatted };
  }

  /** `cacm.ping` — liveness check, returns `"pong"`. */
  async ping(): Promise<string> {
    const result = await this.request("cacm.ping", {});
    if (typeof result !== "string") {
      throw new CacmError("protocol", "cacm.ping reply is not a string");
    }
    return result;
  }

  /**
   * Register a listener for server-pushed `cacm.session_activity`
   * notifications. Returns an unsubscribe function.
   */
  onActivity(callback: (activity: CacmSessionActivity) => void): () => void {
    this.activityListeners.add(callback);
    return () => {
      this.activityListeners.delete(callback);
    };
  }

  /**
   * Stop the client: reject in-flight requests, close the socket, and cancel
   * any scheduled reconnection. A later `connect()` restarts it.
   */
  close(): void {
    this.manuallyClosed = true;
    if (this.reconnectTimer !== null) {
      cancel(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAllPending(new CacmError("transport", "client closed"));
    if (this.openPromise) {
      void this.openPromise.catch(() => {});
      this.openPromise = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState !== WS_CLOSED) {
      try {
        ws.close(1000, "client closed");
      } catch {
        // already closing — nothing to do
      }
    }
  }

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WS_OPEN;
  }

  /** One request: ensure a connection, then send and correlate the reply. */
  private async request(method: string, params: unknown): Promise<unknown> {
    await this.connect();
    return this.sendRequest(method, params);
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WS_OPEN) {
      return Promise.reject(new CacmError("transport", "cacm-daemon connection is not open"));
    }
    const id = ++this.nextId;
    const frame = JSON.stringify({ id, method, params });
    return new Promise<unknown>((resolve, reject) => {
      const timer = schedule(() => {
        this.pending.delete(id);
        reject(
          new CacmError(
            "timeout",
            `cacm-daemon did not reply to ${method} within ${this.timeoutMs} ms`,
          ),
        );
      }, this.timeoutMs);
      this.pending.set(id, {
        method,
        resolve,
        reject: reject as (error: CacmError) => void,
        timer,
      });
      try {
        ws.send(frame);
      } catch (err) {
        this.pending.delete(id);
        cancel(timer);
        reject(
          new CacmError(
            "transport",
            `failed to send ${method}: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
    });
  }

  /** Open one socket. The caller owns the backoff/retry policy. */
  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let connectTimer: number | null = null;
      const finish = (fn: () => void) => {
        if (!settled) {
          settled = true;
          if (connectTimer !== null) cancel(connectTimer);
          fn();
        }
      };
      let ws: WebSocketLike;
      try {
        ws = new (this.webSocketCtor())(normalizeDaemonUrl(this.url));
      } catch (err) {
        finish(() => {
          this.openPromise = null;
          reject(
            err instanceof CacmError
              ? err
              : new CacmError("invalid-address", err instanceof Error ? err.message : String(err)),
          );
        });
        return;
      }
      this.ws = ws;
      connectTimer = schedule(() => {
        finish(() => {
          this.openPromise = null;
          try {
            ws.close(1006, "connect timeout");
          } catch {
            // socket already gone — nothing to close
          }
          reject(
            new CacmError(
              "connect",
              `timed out connecting to cacm-daemon at ${normalizeDaemonUrl(this.url)}`,
            ),
          );
        });
      }, this.connectTimeoutMs);
      ws.addEventListener("open", () =>
        finish(() => {
          this.openPromise = null;
          this.reconnectAttempt = 0;
          resolve();
        }),
      );
      ws.addEventListener("message", (event) => this.handleMessage(event));
      ws.addEventListener("error", () =>
        finish(() => {
          this.openPromise = null;
          reject(
            new CacmError("connect", `cannot reach cacm-daemon at ${normalizeDaemonUrl(this.url)}`),
          );
        }),
      );
      ws.addEventListener("close", () => this.handleClose(ws));
    });
  }

  private webSocketCtor(): WebSocketCtor {
    const g = globalThis as unknown as { WebSocket?: WebSocketCtor };
    const ctor = g.WebSocket;
    if (typeof ctor !== "function") {
      throw new CacmError("connect", "WebSocket is not available in this environment");
    }
    return ctor;
  }

  private handleClose(closed: WebSocketLike): void {
    // Ignore close events from superseded sockets (e.g. a duplicate close
    // after a reconnect already took over).
    if (this.ws !== closed) return;
    this.failAllPending(new CacmError("transport", "cacm-daemon connection closed"));
    this.ws = null;
    if (this.manuallyClosed) return;
    this.scheduleReconnect();
  }

  /** Reconnect after a drop: exponential backoff, bounded by the budget. */
  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.openPromise !== null) return;
    if (this.reconnectAttempt >= this.maxReconnectAttempts) return;
    const delay = Math.min(this.backoffBaseMs * 2 ** this.reconnectAttempt, this.backoffMaxMs);
    this.reconnectTimer = schedule(() => {
      this.reconnectTimer = null;
      if (this.manuallyClosed || this.openPromise !== null || this.isOpen()) return;
      this.reconnectAttempt += 1;
      this.openPromise = this.openSocket();
      void this.openPromise.catch(() => {});
    }, delay);
  }

  /** Correlate an incoming frame with a pending request (or dispatch a notification). */
  private handleMessage(event: WebSocketLikeEvent): void {
    const data = event.data;
    if (typeof data !== "string") {
      this.failAllPending(new CacmError("protocol", "expected a text frame, got non-string data"));
      return;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(data);
    } catch (err) {
      this.failAllPending(
        new CacmError(
          "protocol",
          `unparseable frame: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }
    if (typeof frame !== "object" || frame === null || Array.isArray(frame)) {
      this.failAllPending(new CacmError("protocol", "frame is not a JSON object"));
      return;
    }
    const record = frame as Record<string, unknown>;

    // Server-initiated notification: {"event": ..., "data": ...}.
    if (record.event !== undefined) {
      if (record.event === "cacm.session_activity" && this.activityListeners.size > 0) {
        const activity = record.data as CacmSessionActivity;
        for (const listener of this.activityListeners) listener(activity);
      }
      return;
    }

    // Reply: {"id": ..., "result": ...} or {"id": ..., "error": {...}}.
    const id = typeof record.id === "number" ? record.id : undefined;
    if (id === undefined) return;
    const waiter = this.pending.get(id);
    if (!waiter) return; // unsolicited/unknown id — ignore
    this.pending.delete(id);
    cancel(waiter.timer);

    if (record.error !== undefined && record.error !== null) {
      const error = record.error as Record<string, unknown>;
      const code = typeof error.code === "number" ? error.code : 0;
      const message = typeof error.message === "string" ? error.message : "unknown error";
      waiter.reject(new CacmError("rpc", message, code));
      return;
    }
    if ("result" in record) {
      waiter.resolve(record.result);
      return;
    }
    waiter.reject(new CacmError("protocol", "reply missing 'result'"));
  }

  private failAllPending(error: CacmError): void {
    for (const waiter of this.pending.values()) {
      cancel(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }
}

function readArray(result: unknown, key: string): unknown[] {
  const value = asRecord(result)[key];
  if (!Array.isArray(value)) {
    throw new CacmError("protocol", `reply missing '${key}' array`);
  }
  return value;
}

function readString(result: unknown, key: string): string {
  const value = asRecord(result)[key];
  if (typeof value !== "string") {
    throw new CacmError("protocol", `reply missing '${key}' string`);
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CacmError("protocol", "reply is not a JSON object");
  }
  return value as Record<string, unknown>;
}
