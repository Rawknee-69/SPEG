/**
 * CACM panel — cross-agent context timeline (task 1.11).
 *
 * Queries the local cacm-daemon over WebSocket via `@cacm/sdk` and renders a
 * timeline of *all* agent sessions (Claude Code, Codex, OpenCode, Cursor,
 * Cursor, SPEG), color-coded by agent. Each session expands to the context
 * extracted from it (decisions, errors, patterns) and offers an "Inject
 * context" action that hands the daemon's formatted reminder to the caller
 * (ChatView inserts it into the composer draft). Auto-refreshes when the
 * daemon pushes `cacm.session_activity` notifications.
 *
 * Kept dependency-light on purpose: the daemon is loopback-only and
 * unauthenticated, so the panel treats an unreachable daemon as a friendly
 * error state instead of failing the thread.
 */
import {
  CacmClient,
  DEFAULT_DAEMON_URL,
  type AgentSession,
  type AgentType,
  type ContextType,
  type CrossAgentContext,
} from "@cacm/sdk";
import {
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Network,
  RefreshCw,
  RotateCw,
  Send,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Badge } from "~/components/ui/badge";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Spinner } from "~/components/ui/spinner";

export interface CacmPanelProps {
  /** cacm-daemon address; defaults to `ws://localhost:9786`. */
  daemonUrl?: string;
  /** Active project root; when set, sessions/context are filtered to it. */
  project?: string | null;
  /** Receives the formatted cross-agent context when the user injects. */
  onInjectContext?: (formatted: string) => void;
  /**
   * The agent currently driving the chat (e.g. "opencode"). When it changes
   * to a different agent, the panel suggests sending the collected context
   * to the new agent first.
   */
  activeAgent?: AgentType | null;
  /**
   * Auto-send path: insert the formatted context into the composer AND send
   * it, so the new agent starts with the full cross-agent picture.
   */
  onSendContext?: (formatted: string) => void;
}

type LoadStatus = "loading" | "ready" | "error";

// ---------------------------------------------------------------------------
// Pure presentation helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Display metadata per agent: a stable label and a color dot class. */
export const AGENT_META: Record<AgentType, { label: string; dotClass: string }> = {
  "claude-code": { label: "Claude Code", dotClass: "bg-orange-500" },
  codex: { label: "Codex", dotClass: "bg-emerald-500" },
  opencode: { label: "OpenCode", dotClass: "bg-cyan-500" },
  cursor: { label: "Cursor", dotClass: "bg-sky-500" },
  grok: { label: "Grok", dotClass: "bg-purple-500" },
  speg: { label: "SPEG", dotClass: "bg-fuchsia-500" },
};

export function agentLabel(agent: AgentType): string {
  return AGENT_META[agent]?.label ?? agent;
}

export function agentDotClass(agent: AgentType): string {
  return AGENT_META[agent]?.dotClass ?? "bg-muted-foreground";
}

/** Human label for a context type. */
export function contextTypeLabel(type: ContextType): string {
  switch (type) {
    case "task":
      return "Task";
    case "decision":
      return "Decision";
    case "file-change":
      return "File change";
    case "error":
      return "Error";
    case "pattern":
      return "Pattern";
  }
}

/** Context entries belonging to a session, newest first (query order). */
export function getSessionContexts(
  contexts: readonly CrossAgentContext[],
  sessionId: string,
): CrossAgentContext[] {
  return contexts.filter((context) => context.session_id === sessionId);
}

/** Decisions recorded across a session's contexts, deduplicated. */
export function getSessionDecisionNotes(contexts: readonly CrossAgentContext[]): string[] {
  return [...new Set(contexts.flatMap((context) => context.decisions))];
}

/** Errors recorded across a session's contexts, deduplicated. */
export function getSessionErrorNotes(contexts: readonly CrossAgentContext[]): string[] {
  return [...new Set(contexts.flatMap((context) => context.errors))];
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * One-line task summary for a session row: the newest extracted context's
 * content, truncated; falls back to the session's last path segment.
 */
export function summarizeSession(
  session: AgentSession,
  contexts: readonly CrossAgentContext[],
): string {
  const first = getSessionContexts(contexts, session.session_id)[0];
  const raw = first ? collapseWhitespace(first.content) : "";
  if (raw.length > 0) {
    return raw.length > 96 ? `${raw.slice(0, 96).trimEnd()}…` : raw;
  }
  const segments = session.path.split(/[\\/]/).filter(Boolean);
  const tail = segments.at(-1) ?? session.session_id;
  return tail.length > 0 ? tail : session.session_id;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CacmPanel(props: CacmPanelProps) {
  const client = useMemo(
    () => new CacmClient(props.daemonUrl ?? DEFAULT_DAEMON_URL),
    [props.daemonUrl],
  );
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [contexts, setContexts] = useState<CrossAgentContext[]>([]);
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [injectingSessionId, setInjectingSessionId] = useState<string | null>(null);
  const [injectError, setInjectError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  // Agent-switch suggestion: `{ from, to }` when the active agent changed.
  const [switchNotice, setSwitchNotice] = useState<{
    from: AgentType;
    to: AgentType;
  } | null>(null);
  const [sendingSwitchContext, setSendingSwitchContext] = useState(false);
  const [switchSendError, setSwitchSendError] = useState<string | null>(null);
  const previousAgentRef = useRef<AgentType | null | undefined>(undefined);
  // Latest workspace the panel was asked to load. A load started for an
  // earlier workspace must not apply its results after a switch, so each
  // load captures the project it queried and drops stale resolutions.
  const requestedProjectRef = useRef<string | null | undefined>(props.project);
  // Consecutive failed loads. The first failures (e.g. the brief reconnect
  // blip on a workspace switch) show a loading state with an automatic retry
  // instead of the error card; only after several consecutive failures —
  // a genuinely unreachable daemon — does the error card (with Retry /
  // Restart) appear.
  const failCountRef = useRef(0);
  // Self-heal retry scheduled after a transient failure (cleared on unmount).
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const MAX_TRANSIENT_FAILURES = 3;

  const load = useCallback(async () => {
    const project = props.project?.trim();
    requestedProjectRef.current = project;
    try {
      await client.connect();
      const [sessionResult, queryResult] = await Promise.all([
        client.sessions(project ? { project } : {}),
        project ? client.query({ project, limit: 100 }) : Promise.resolve({ entries: [] }),
      ]);
      // The workspace may have switched while the query was in flight; only
      // apply results that still belong to the active workspace.
      if (requestedProjectRef.current !== project) return;
      failCountRef.current = 0;
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      setSessions(sessionResult.sessions);
      setContexts(queryResult.entries);
      setLoadError(null);
      setStatus("ready");
    } catch (err) {
      if (requestedProjectRef.current !== project) return;
      setLoadError(errorMessage(err));
      failCountRef.current += 1;
      if (failCountRef.current < MAX_TRANSIENT_FAILURES) {
        // Likely a transient blip (e.g. a workspace switch racing a
        // reconnect): show a loading state and retry automatically instead
        // of flashing the "Could not reach cacm-daemon" error card.
        setStatus("loading");
        if (retryTimerRef.current === null) {
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null;
            void loadRef.current();
          }, 1500);
        }
      } else {
        setStatus("error");
      }
    }
  }, [client, props.project]);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    void load();
    const unsubscribe = client.onActivity(() => {
      // The daemon pushes an activity notification per filesystem event;
      // reload the timeline so new sessions/context appear without a manual
      // refresh. A stale (cancelled) effect must not schedule another load.
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
      // Deliberately do NOT close the socket here. `load` changes identity
      // when the workspace (`project`) changes, which re-runs this effect —
      // closing the daemon connection on every workspace switch and racing
      // the immediate reconnect flashes a spurious "cannot reach cacm-daemon"
      // error for ~500 ms. The connection is torn down on unmount below.
    };
  }, [client, load]);

  // Detect a change of the active agent (e.g. opencode → claude/grok/codex)
  // and surface the "send the collected context first" suggestion. Registered
  // after the load effect so callers that run `effects[0]` keep the load
  // behavior.
  useEffect(() => {
    const previous = previousAgentRef.current;
    const next = props.activeAgent ?? null;
    previousAgentRef.current = next;
    if (previous !== undefined && previous !== null && next !== null && previous !== next) {
      setSwitchNotice({ from: previous, to: next });
      setSwitchSendError(null);
    }
  }, [props.activeAgent]);

  // Tear down the daemon connection only when the panel unmounts or the
  // daemon URL changes — never on a workspace switch.
  useEffect(() => {
    return () => {
      if (retryTimerRef.current !== null) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      client.close();
    };
  }, [client]);

  const handleInject = useCallback(
    async (session: AgentSession) => {
      if (injectingSessionId !== null) return;
      setInjectError(null);
      setInjectingSessionId(session.session_id);
      try {
        const { formatted } = await client.inject({
          sessionId: session.session_id,
          agent: session.agent_type,
        });
        props.onInjectContext?.(formatted);
      } catch (err) {
        setInjectError(`Failed to inject context from ${session.session_id}: ${errorMessage(err)}`);
      } finally {
        setInjectingSessionId(null);
      }
    },
    [client, injectingSessionId, props.onInjectContext],
  );

  /**
   * "Send context first" — gather the full cross-agent context for the new
   * agent (`sessionId: "*"` = project-wide, matching the daemon's wildcard)
   * and hand it to the composer's auto-send path, so the agent the user just
   * switched to starts with the complete picture.
   */
  const handleSendContextToNewAgent = useCallback(async () => {
    if (!switchNotice || sendingSwitchContext) return;
    setSwitchSendError(null);
    setSendingSwitchContext(true);
    try {
      const { formatted } = await client.inject({
        sessionId: "*",
        agent: switchNotice.to,
      });
      props.onSendContext?.(formatted);
      setSwitchNotice(null);
    } catch (err) {
      setSwitchSendError(
        `Failed to send context to ${agentLabel(switchNotice.to)}: ${errorMessage(err)}`,
      );
    } finally {
      setSendingSwitchContext(false);
    }
  }, [client, props.onSendContext, sendingSwitchContext, switchNotice]);

  const toggleExpanded = useCallback((sessionId: string) => {
    setExpandedSessionId((current) => (current === sessionId ? null : sessionId));
  }, []);

  const retry = useCallback(() => {
    setStatus("loading");
    void load();
  }, [load]);

  /**
   * Restart the local cacm-daemon sidecar. The daemon cannot restart itself,
   * so this asks the T3 server (which owns the daemon lifecycle) to stop the
   * current instance — including a stale one from an earlier run — and spawn
   * a fresh one with the current origins. Then reload the timeline.
   */
  const restartDaemon = useCallback(async () => {
    setRestartError(null);
    setRestarting(true);
    try {
      const response = await fetch("/api/speg/cacm/restart", { method: "POST" });
      const body = (await response.json().catch(() => null)) as {
        status?: string;
        reason?: string;
      } | null;
      if (!response.ok || body?.status === "failed") {
        throw new Error(body?.reason ?? `Server returned ${response.status}`);
      }
      // The daemon restarts asynchronously (kill → port free → spawn); poll
      // its healthz until it answers again, then reload.
      const daemonHealthUrl = `${(props.daemonUrl ?? DEFAULT_DAEMON_URL).replace(/^ws/, "http").replace(/\/ws$/, "")}/healthz`;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const health = await fetch(daemonHealthUrl, { method: "GET" }).catch(() => null);
        if (health?.ok) break;
      }
      setStatus("loading");
      await load();
    } catch (err) {
      setRestartError(`Failed to restart cacm-daemon: ${errorMessage(err)}`);
    } finally {
      setRestarting(false);
    }
  }, [client, load]);

  return (
    <ScrollArea className="size-full" data-cacm-panel>
      <div className="flex min-h-full flex-col gap-3 p-3">
        <header className="flex items-center gap-2">
          <Network className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h2 className="text-sm font-semibold text-foreground">Cross-Agent Context</h2>
          <span
            className={cn(
              "ml-auto size-1.5 rounded-full",
              status === "ready"
                ? "bg-emerald-500"
                : status === "error"
                  ? "bg-destructive"
                  : "bg-muted-foreground/50",
            )}
            aria-label={
              status === "ready"
                ? "CACM daemon connected"
                : status === "error"
                  ? "CACM daemon unreachable"
                  : "Connecting to CACM daemon"
            }
          />
        </header>

        {switchNotice ? (
          <div
            role="status"
            data-agent-switch-notice
            className="flex flex-col gap-2 rounded-md border border-primary/30 bg-primary/5 p-3 text-sm"
          >
            <p className="text-foreground">
              You switched from{" "}
              <span className="font-semibold">{agentLabel(switchNotice.from)}</span> to{" "}
              <span className="font-semibold">{agentLabel(switchNotice.to)}</span>. Send the
              collected cross-agent context first so the new agent has the full picture.
            </p>
            {switchSendError ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {switchSendError}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void handleSendContextToNewAgent()}
                disabled={sendingSwitchContext}
                aria-label={`Send cross-agent context to ${agentLabel(switchNotice.to)}`}
                className="inline-flex items-center gap-1.5 self-start rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
              >
                {sendingSwitchContext ? (
                  <Spinner className="size-3.5" />
                ) : (
                  <Send className="size-3.5" aria-hidden />
                )}
                {sendingSwitchContext ? "Sending…" : "Send context first"}
              </button>
              <button
                type="button"
                onClick={() => setSwitchNotice(null)}
                disabled={sendingSwitchContext}
                aria-label="Dismiss"
                className="inline-flex items-center gap-1 self-start rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        ) : null}

        {status === "loading" ? (
          <div className="flex items-center gap-2 px-1 py-4 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Connecting to cacm-daemon…
          </div>
        ) : null}

        {status === "error" ? (
          <div
            role="alert"
            className="flex flex-col gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <p className="text-destructive-foreground">
              Could not reach cacm-daemon{props.project ? ` for ${props.project}` : ""}: {loadError}
            </p>
            {restartError ? (
              <p role="alert" className="text-xs text-destructive-foreground">
                {restartError}
              </p>
            ) : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={retry}
                aria-label="Retry connecting to CACM daemon"
                className="inline-flex items-center gap-1.5 self-start rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-accent"
              >
                <RefreshCw className="size-3.5" />
                Retry
              </button>
              <button
                type="button"
                onClick={() => void restartDaemon()}
                disabled={restarting}
                aria-label="Restart CACM daemon"
                className="inline-flex items-center gap-1.5 self-start rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
              >
                <RotateCw className={cn("size-3.5", restarting && "animate-spin")} aria-hidden />
                {restarting ? "Restarting…" : "Restart daemon"}
              </button>
            </div>
          </div>
        ) : null}

        {status === "ready" && sessions.length === 0 ? (
          <p className="px-1 py-4 text-sm text-muted-foreground">
            No agent sessions found yet. Start an agent (Claude Code, Codex, …) and its sessions
            will appear here.
          </p>
        ) : null}

        {injectError ? (
          <p role="alert" className="px-1 text-xs text-destructive-foreground">
            {injectError}
          </p>
        ) : null}

        {status === "ready" && sessions.length > 0 ? (
          <ul className="flex flex-col gap-1.5">
            {sessions.map((session) => {
              const sessionContexts = getSessionContexts(contexts, session.session_id);
              const decisions = getSessionDecisionNotes(sessionContexts);
              const errors = getSessionErrorNotes(sessionContexts);
              const expanded = expandedSessionId === session.session_id;
              const injecting = injectingSessionId === session.session_id;
              const summary = summarizeSession(session, contexts);
              return (
                <li
                  key={session.session_id}
                  data-session-row={session.session_id}
                  className="rounded-md border border-border/80 bg-card dark:inset-ring-1 dark:inset-ring-white/5"
                >
                  <div className="flex items-center gap-2 p-2">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(session.session_id)}
                      aria-label={`Session ${session.session_id}`}
                      aria-expanded={expanded}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-accent/60"
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          agentDotClass(session.agent_type),
                        )}
                        aria-hidden
                      />
                      <span className="shrink-0 text-xs font-semibold text-foreground">
                        {agentLabel(session.agent_type)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {summary}
                      </span>
                      <time className="shrink-0 text-[10px] text-muted-foreground/70">
                        {formatRelativeTimeLabel(session.created_at)}
                      </time>
                      {expanded ? (
                        <ChevronDown
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      ) : (
                        <ChevronRight
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden
                        />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleInject(session)}
                      disabled={injecting || injectingSessionId !== null}
                      aria-label={`Inject context from ${session.session_id}`}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[10px] font-medium text-foreground hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                    >
                      {injecting ? (
                        <Spinner className="size-3" />
                      ) : (
                        <ClipboardPaste className="size-3" aria-hidden />
                      )}
                      {injecting ? "Injecting…" : "Inject"}
                    </button>
                  </div>
                  {expanded ? (
                    <div className="flex flex-col gap-2 border-t border-border/70 px-3 py-2">
                      {sessionContexts.length === 0 ? (
                        <p className="text-xs text-muted-foreground">
                          No extracted context for this session yet.
                        </p>
                      ) : (
                        sessionContexts.map((context) => (
                          <div key={context.id} className="flex flex-col gap-1">
                            <div className="flex items-center gap-1.5">
                              <Badge variant="secondary" size="sm">
                                {contextTypeLabel(context.context_type)}
                              </Badge>
                              <time className="text-[10px] text-muted-foreground/70">
                                {formatRelativeTimeLabel(context.timestamp)}
                              </time>
                            </div>
                            <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-foreground/90">
                              {context.content}
                            </p>
                            {decisions.length > 0 ? (
                              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                                {decisions.map((decision) => (
                                  <li key={decision} className="break-words">
                                    <span className="font-medium text-emerald-600 dark:text-emerald-400">
                                      Decision:
                                    </span>{" "}
                                    {decision}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {errors.length > 0 ? (
                              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                                {errors.map((error) => (
                                  <li key={error} className="break-words">
                                    <span className="font-medium text-destructive-foreground">
                                      Error:
                                    </span>{" "}
                                    {error}
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                            {context.file_paths.length > 0 ? (
                              <p className="truncate text-[10px] text-muted-foreground/70">
                                {context.file_paths.join(" · ")}
                              </p>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </ScrollArea>
  );
}
