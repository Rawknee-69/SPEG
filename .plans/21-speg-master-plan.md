# SPEG — Architecture v6: CACM as Standalone Importable Package

> **Plan 21 v6** | CACM = standalone daemon + SDKs. Harness = **already-supported providers only**.
>
> **Revision (v5 → v6): jcode is DROPPED as the harness.** The jcode
> provider adapter, session parser, and harness-API storage were removed from
> speg (see commit "revert(speg): strip jcode"). **We will not build a
> self-built harness for now** — support is limited to the harnesses SPEG
> already supports (Claude Code, Codex, OpenCode, Cursor, Grok), which CACM
> also watches (claude-code/codex/opencode/cursor). The harness slot below
> shows those existing providers. Historical jcode task records are kept but
> marked **superseded**.
> **Principle**: CACM is a universal cross-agent context manager — any tool can import and use it.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     CACM DAEMON (Rust)                        │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ cacm-core        ← Session watcher, extractor, injector│  │
│  │ cacm-daemon      ← HTTP + WebSocket server             │  │
│  │ cacm-sdk-rs      ← Rust client library                 │  │
│  │ cacm-sdk-ts      ← TypeScript client library           │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  API: WebSocket (cacm.query, cacm.sessions, cacm.inject)     │
│  Watches: ~/.claude/projects/, ~/.codex/sessions/, etc.      │
│  Stores: local SQLite (in-memory graph for lightweight runs) │
└──────┬──────────────┬──────────────────┬─────────────────────┘
       │              │                  │
       ▼              ▼                  ▼
┌──────────┐  ┌────────────┐  ┌─────────────────┐
│ HARNESSES│  │  SPEG WEB  │  │  ANY OTHER TOOL │
│ (already │  │  (React)   │  │  (Claude, etc.) │
│supported:│  │            │  │                 │
│ Claude,  │  │ + cacm-    │  │ + cacm-sdk-rs   │
│ Codex,   │  │   sdk-ts   │  │   or cacm-sdk-ts│
│ OpenCode,│  │            │  │                 │
│ Cursor,  │  │ Talks to   │  │ Talks to CACM   │
│ Grok)    │  │ CACM via   │  │ daemon via      │
│          │  │ WebSocket  │  │ WebSocket       │
│          │  │            │  │                 │
└──────────┘  └────────────┘  └─────────────────┘
```

### Key Design Decisions

| Decision | Why |
|----------|-----|
| **CACM as daemon** | One process watches all agents. Any tool connects. No embedded complexity. |
| **Core in Rust** | User preference. Watcher/extractor/injector/compactor all Rust. |
| **TypeScript SDK** | SPEG web + Node.js tools import `cacm-sdk-ts` — clean npm package. |
| **Rust SDK** | Any Rust harness consumer imports `cacm-sdk-rs`. ~~jcode~~ (superseded). |
| **Harness** | **Already-supported providers only** (Claude Code, Codex, OpenCode, Cursor, Grok). No self-built harness for now. |
| **Storage** | Local SQLite; in-memory graph for lightweight runs. ~~Jcode memory graph~~ (superseded). |
| **Protocol** | WebSocket with JSON messages — simple, cross-language, debuggable. |

---

## Package Structure

```
speg/
├── cacm/                          ← STANDALONE CACM PACKAGE
│   ├── cacm-core/                 ← Rust crate: core logic
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── lib.rs
│   │       ├── watcher.rs         ← File watcher (notify crate)
│   │       ├── parsers/
│   │       │   ├── mod.rs         ← Parser trait + registry
│   │       │   ├── claude.rs      ← Claude Code parser
│   │       │   ├── codex.rs       ← Codex parser
│   │       │   ├── opencode.rs    ← OpenCode parser
│   │       │   └── cursor.rs      ← Cursor parser
│   │       ├── extractor.rs       ← Context extraction (heuristics)
│   │       ├── injector.rs        ← Context formatting + injection
│   │       ├── compactor.rs       ← Dedup + summarize + link
│   │       └── types.rs           ← AgentSession, AgentTurn, ContextEntry
│   │
│   ├── cacm-daemon/               ← Rust binary: CACM server
│   │   ├── Cargo.toml
│   │   └── src/
│   │       ├── main.rs            ← HTTP + WebSocket server
│   │       ├── server.rs          ← Request routing, session mgmt
│   │       └── storage.rs         ← SQLite (+ in-memory graph) backend
│   │
│   ├── cacm-sdk-rs/               ← Rust client library (Rust consumers)
│   │   ├── Cargo.toml
│   │   └── src/
│   │       └── lib.rs             ← CacmClient: connect, query, inject
│   │
│   └── cacm-sdk-ts/               ← TypeScript client (for SPEG + Node.js)
│       ├── package.json           ← @cacm/sdk
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts           ← Public API
│           ├── client.ts          ← CacmClient: WebSocket + request/reply
│           └── types.ts           ← TypeScript types matching Rust types
│
├── (harness)/                     ← ~~VANILLA JCODE~~ (removed in v6 —
│                                  ←   no self-built harness for now; only
│                                  ←   the already-supported providers)
│
├── speg-web/                      ← SPEG WEB UI (TypeScript, React)
│   ├── package.json               ← depends on @cacm/sdk
│   ├── src/
│   │   ├── client.ts              ← CacmClient: WebSocket + request/reply
│   │   └── components/
│   │       ├── ChatView.tsx
│   │       ├── CacmTimeline.tsx   ← Uses @cacm/sdk for cross-agent data
│   │       ├── MemoryGraph.tsx
│   │       └── SwarmDashboard.tsx
│   └── tsconfig.json
│
├── speg-desktop/                  ← Electron desktop (wraps speg-web)
│   └── src/main.ts
│
└── speg-mobile/                   ← React Native mobile
    └── src/
```

### Dependency Graph

```
cacm-core (Rust)          ← Pure logic, no I/O deps
    ↑
cacm-daemon (Rust)        ← HTTP/WS server, depends on cacm-core
    ↑
    ├── cacm-sdk-rs (Rust)      ← Client library for Rust consumers
    │
    └── cacm-sdk-ts (TypeScript) ← Client library for TS consumers
            ↑
        speg-web (React)         ← Imports @cacm/sdk
```

### ~~Jcode Integration~~ (superseded in v6)

The jcode bridge route (a `jcode-cacm-bridge` crate registering CACM tools
and a `turn_start` injection hook inside jcode) is **removed**. There is
**no self-built harness for now**: integration covers the harnesses SPEG
already supports (Claude Code, Codex, OpenCode, Cursor, Grok), which talk to
CACM through its WebSocket API, and any future harness would follow the same
shape — a thin adapter that imports `cacm-sdk-rs`/`cacm-sdk-ts`, registers
CACM tools, and injects context before each turn.

### CACM Daemon API

```
WebSocket at ws://localhost:9786 (configurable)

→ REQUEST:  {"id":1,"method":"cacm.query","params":{"project":"/path/to/repo","limit":10}}
← RESPONSE: {"id":1,"result":{"entries":[...]}}

→ REQUEST:  {"id":2,"method":"cacm.sessions","params":{"project":"/path/to/repo"}}
← RESPONSE: {"id":2,"result":{"sessions":[...]}}

→ REQUEST:  {"id":3,"method":"cacm.inject","params":{"sessionId":"abc","agent":"claude-code"}}
← RESPONSE: {"id":3,"result":{"formatted":"[Cross-Agent Context]\n• ..."}}

→ NOTIFICATION: {"event":"cacm.session_activity","data":{"agent":"codex","sessionId":"fox","turn":{...}}}
```

### Storage Backend

CACM daemon stores context in local SQLite (default `~/.cacm/cacm.db`), with
an in-memory graph for lightweight runs. ~~Jcode memory graph~~ (superseded
in v6).

---

## Phase 1: Foundation (14 tasks — 2 done, 12 remaining)

### Task 1.1: @speg/core TypeScript Package Scaffold ✅ COMPLETE

**Status**: Done (v4 plan, commit 8f6858de). Unchanged. See `research/report/1.1-scaffolding.md`.

### Task 1.2: SPEG Wire Contracts (Effect/Schema) ✅ COMPLETE

**Status**: Done (v4 plan). Unchanged. See `research/report/1.2-contracts.md`.

---

### Task 1.3: cacm-core Rust Crate ✅ COMPLETE (parsers + watch dirs)

**Files**: `cacm/cacm-core/` — types, watcher, parser trait, real parsers

**Status**: Extended beyond scaffolding: the parser trait now has
`discover_sessions` + `read_session_turns`, and the Phase-2 stubs were
replaced with **real parsers** for Claude Code (`~/.claude/projects/*/*.jsonl`),
Codex (`~/.codex/sessions/*/*.jsonl`), OpenCode (SQLite `opencode.db` via
rusqlite), Cursor (`~/.cursor/projects/*/agent-transcripts/*/*.jsonl`), and
Grok (`~/.grok/sessions/*/<id>/chat_history.jsonl`). `AgentType::Grok` added
throughout (serde, Display, FromStr, injector formatting, settings,
`@cacm/sdk`, CACM panel). Windows watch dir fixed: opencode resolves to
`~/.local/share/opencode` (modern XDG-style storage) before `%APPDATA%`.

**Verification**: `cargo test -p cacm-core` green; real-data smoke test reads
this machine's opencode.db and grok sessions.

---

### Task 1.4: cacm-daemon ✅ COMPLETE (extraction wired)

**Files**: `cacm/cacm-daemon/` — HTTP + WebSocket server, JSON-RPC API

**Status**: The daemon now registers `ParserRegistry::with_defaults()`,
seeds sessions via each parser's `discover_sessions`, and **runs the
`ContextExtractor` on startup backfill and on every watcher activity**
(opencode DB writes trigger a full session re-scan). Contexts are persisted
to storage, so `cacm.query`/`cacm.inject` return real extracted content.

**Verification**: `cargo test -p cacm-daemon` green; end-to-end: daemon on
the default port reports 6→14 sessions (opencode/cursor/grok) and 11 context
entries; `cacm.inject` with `sessionId:"*"` returns project-wide context
formatted for the target agent.

---

### Task 1.5: ~~Jcode~~ Session Parser 🔄 SUPERSEDED

**Status**: Removed in v6 — the jcode parser (`cacm/cacm-core/src/parsers/jcode.rs`) was deleted with the jcode strip. Real per-agent parsers for the already-supported harnesses (claude-code/codex/opencode/cursor/grok) replaced the Phase-2 stubs (see task 1.3).

---

### Task 1.6: Context Extractor

**Files**: `cacm/cacm-core/src/extractor.rs` — heuristic extraction from turns

**Verification**: Extract tasks, decisions, files, errors from sample turns.

---

### Task 1.7: Context Injector

**Files**: `cacm/cacm-core/src/injector.rs` — query + rank + format

**Verification**: Format cross-agent context for Claude, Codex, SPEG targets.

---

### Task 1.8: cacm-sdk-rs 🔄 SUPERSEDED

**Status**: `cacm-sdk-rs` remains (Rust client for the future harness); the `jcode-cacm-bridge` crate was removed with the jcode strip in v6.

---

### Task 1.9: cacm-sdk-ts

**Files**: `cacm/cacm-sdk-ts/` — npm package `@cacm/sdk`

**Verification**: TS client connects to CACM daemon, queries context.

---

### Task 1.10: Jcode Provider Adapter 🔄 SUPERSEDED (removed in v6)

**Status**: Was ✅ (report: `research/report/1.10-jcode-adapter.md`). The entire adapter (`JcodeDriver.ts`, `JcodeAdapter.ts`, `JcodeProcessManager.ts`, `JcodeProvider.ts`, `JcodeTextGeneration.ts`, `JcodeSettings`) was **deleted** when jcode was dropped; the provider list stays at the already-supported harnesses.

---

### Task 1.11: CACM Right Panel Tab (SPEG Web)

**Status**: ✅ (report: `research/report/1.11-cacm-panel.md`)

**Files**: `apps/web/src/components/speg/CacmPanel.tsx` — new right panel tab

**What**: Like Cursor IDE's sidebar, SPEG has a right panel with tabs (Plan, Diff, Files, Preview, Terminal). We add a CACM tab showing:
- Cross-agent session timeline (all agents, color-coded)
- Recent context extracted from each session
- "Inject context" button for current thread
- Links to related memories
- **Agent-switch handoff** (added later): when the active chat provider changes (opencode → claude/grok/codex), the panel detects it (`activeAgent` prop mapped from `ProviderDriverKind` in ChatView) and shows a "Send context first" banner whose button gathers the full project-wide context (`cacm.inject` with `sessionId:"*"`) and auto-sends it through the composer (`onSendContext` → insert + `onSend`).

Follows `rightPanelStore.ts` pattern — registers as a new surface type.

**Verification**: Right panel shows CACM tab. Timeline populated from cacm-daemon via @cacm/sdk. Agent switch surfaces the suggestion; the auto-send button posts the context to the newly selected agent.

---

### Task 1.12: SPEG Settings Panel (SPEG Web)

**Status**: ✅ (report: `research/report/1.12-speg-settings.md`)

**Files**: `apps/web/src/routes/speg/` — new settings section

**What**: A settings panel for SPEG configuration:
- CACM daemon port + connection settings
- Agent session watch paths
- Context injection preferences (auto/manual/off)
- Skill toggle switches
- Memory graph storage backend selection

Follows existing SPEG settings panel pattern.

**Verification**: Settings appear in SPEG's settings sidebar. Changes persist.

---

### Task 1.13: Compactor

**Files**: `cacm/cacm-core/src/compactor.rs`

**Verification**: 10 entries from 3 agents → 3 milestone entries.

---

### Task 1.14: CACM Daemon WebSocket Protocol Types

**Files**: `cacm/cacm-sdk-ts/src/types.ts` — TypeScript types mirroring cacm-core Rust types

**Why**: v4 contracts (1.2) defined Effect/Schema types. v6 CACM daemon uses simple JSON WebSocket protocol. These types mirror `cacm-core/src/types.rs` exactly — separate from Effect RPC contracts.

---

### Task 1.15: Wire Contracts Barrel Export

**Files**: `packages/contracts/src/index.ts` — add `export * from "./speg/index.ts"` (1 line)

**Why**: 1.2 report notes barrel is intentionally NOT exported yet. Safe to wire now.

---

### Task 1.16: Phase 1 Integration Gate

**Files**: None — verification only

**Verification**: All builds pass, all tests pass, CACM right panel populates, the already-supported providers (Claude Code, Codex, OpenCode, Cursor, Grok) drive turns, `git tag speg-v0.1.0-phase1`.

### Task 1.17: Daemon Lifecycle Management (auto-start + restart) ✅ COMPLETE

**Files**: `apps/server/src/speg/CacmDaemonProcess.ts`, `apps/server/src/http.ts`, `apps/server/src/server.ts`, `cacm/cacm-daemon/src/server.rs`, `apps/web/src/components/speg/CacmPanel.tsx`

**What**: The CACM tab needs the local `cacm-daemon` sidecar alive and healthy.

- **Auto-start**: the SPEG server probes `GET /healthz` and spawns the
  daemon binary (`cargo build -p cacm-daemon`) as a scoped child, passing
  every origin the server can serve via `--allow-origin`; killed on server
  shutdown (`SIGTERM` + `forceKillAfter` → `taskkill` on Windows).
- **Restart**: `CacmDaemonProcess.restart` stops the owned child — or a
  *stale* daemon (detected by the `pid` the daemon now reports in `/healthz`)
  — waits for the port to free, then spawns a fresh instance with the current
  origin list. Exposed to the editor as `POST /api/speg/cacm/restart`
  (auth-scoped), surfaced in the CACM panel error state as a
  "Restart daemon" button that reloads the timeline once healthy.

**Why this matters**: a daemon left running by an earlier session (e.g. with
an outdated origin list) would otherwise be silently reused and reject the
editor's WebSocket upgrades — the panel showed "Could not reach cacm-daemon"
with no way to recover.

**Verification**: `CacmDaemonProcess.test.ts` (9 tests incl. restart
kill+re-spawn), `CacmPanel.test.tsx` (18 tests incl. restart button +
POST), `cargo test --workspace` (165), `tsgo` clean. Manual: `curl
/healthz` reports `pid`; WS upgrade from the dev origin returns 101; restart
frees port 9786 and re-binds.

---

### Task 1.18: SPEG Status Bar Footer (SPEG Web) ✅ COMPLETE

**Files**: `packages/contracts/src/speg/spegSettings.ts` (`statusBar`
settings), `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
(status-bar telemetry activities), `apps/web/src/components/speg/SpegStatusBar.tsx`
+ `.logic.ts` + tests, `apps/web/src/components/ChatView.tsx` (footer mount),
`apps/web/src/components/speg/SpegSettings.tsx` + `settingsSearch.ts`
(status-bar section), `apps/web/src/session-logic.ts` (work-log skip).

**What**: A live status-bar footer at the bottom of the chat view showing
per-harness telemetry, mirroring the reference screenshots:

- **model** — resolved active model slug (async: recomputes when the thread's
  model selection changes, and follows `model.rerouted`).
- **workspace** — active workspace basename, full path in the tooltip.
- **gitBranch** — active thread branch.
- **turnHit / avgHit** — prompt-cache hit rate for the latest request / the
  session, from the latest `context-window.updated` token-usage snapshot
  (`lastCachedInputTokens` vs `lastInputTokens`, `cachedInputTokens` vs
  `inputTokens`).
- **sessionTokens / turnTokens** — cumulative processed tokens and the
  last turn's input+output+reasoning tokens.
- **turnCost / sessionCost** — harness-reported `turn.completed.totalCostUsd`
  (Claude) when present; else `null` (hidden).
- **sessions** — distinct turn count from `turn.started`/`turn.completed`
  activities.
- **ctx** — context-window share (used/max).
- **compactAt** — shown when the harness auto-compacts (`compactsAutomatically`),
  at the configured threshold (default 80%).
- **balance** — wallet balance from `account.rate-limits.updated`
  `credits.balance` (Codex) or `account.updated`.

**Server wiring**: `runtimeEventToActivities` now maps `turn.started`,
`turn.completed`, `account.updated`, `account.rate-limits.updated`, and
`model.rerouted` into thread activities so the footer (and any future
consumer) sees cost/balance/model/turn data per harness. The work-log
derivation skips these telemetry kinds so the sidebar stays clean.

**Settings**: the SPEG settings panel gains a "Status bar" section with a
master enable switch and one toggle per item; all items default on, and a
chip is hidden automatically when the active harness doesn't report that
datum. Search catalog includes `speg-status-bar`.

**Verification**: `SpegStatusBar.logic.test.ts` (20), `SpegStatusBar.test.tsx`
(6), `SpegSettings.test.tsx` (18), `session-logic.test.ts` (60),
`ProviderRuntimeIngestion.test.ts` (45) + approval (5), contracts
`settings.test.ts` (34); `tsgo` clean on changed packages.

---

## Language Split

| Component | Language | Why |
|-----------|----------|-----|
| cacm-core | **Rust** | Performance, cross-agent watcher/extractor |
| cacm-daemon | **Rust** | Same binary, no runtime overhead |
| cacm-sdk-rs | **Rust** | Native SDK for Rust harness consumers |
| cacm-sdk-ts | **TypeScript** | SPEG web + Node.js ecosystem |
| ~~jcode-cacm-bridge~~ | **Rust** | ~~Thin Jcode integration layer~~ (removed in v6) |
| speg-web | **TypeScript** | React UI |
| speg-desktop | **TypeScript** | Electron |
| speg-mobile | **TypeScript** | React Native |

## What This Enables

```
$ cacm-daemon &                    # Start CACM (one process, watches all agents)

# The already-supported harnesses pick it up:
# (Claude Code, Codex, OpenCode, Cursor, Grok — no self-built harness for now)

# SPEG web connects:
$ cd speg-web && vp run dev        # Shows cross-agent timeline from @cacm/sdk

# Any other tool:
$ npm install @cacm/sdk            # TypeScript/Node.js
# or
cacm-sdk-rs = "0.1"               # Cargo.toml for Rust tools
```

## Done Criteria (Full Plan)

- [ ] CACM daemon watches all agent types, extracts context
- [ ] The already-supported harnesses (Claude Code, Codex, OpenCode, Cursor, Grok) integrate with CACM → cross-agent context visible in SPEG
- [ ] SPEG web imports `@cacm/sdk` → cross-agent timeline visible
- [ ] Context transfers seamlessly between Claude Code → Codex → SPEG → harness
- [ ] Any tool can `npm install @cacm/sdk` or add `cacm-sdk-rs` to Cargo.toml
- [ ] Compactor deduplicates and summarizes across sessions
- [ ] Windows desktop app (Electron + cacm-daemon + already-supported harnesses)
- [ ] All Rust: `cargo build --workspace`, `cargo test --workspace`, clippy clean
- [ ] All TypeScript: typecheck, tests pass
