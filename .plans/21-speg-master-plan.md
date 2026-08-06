# SPEG — Architecture v6: CACM as Standalone Importable Package

> **Plan 21 v6** | CACM = standalone daemon + SDKs. Harness = **TBD**.
>
> **Revision (v5 → v6): jcode is DROPPED as the harness.** The jcode
> provider adapter, session parser, and harness-API storage were removed from
> t3code (see commit "revert(speg): strip jcode"). We will integrate an
> external harness or build our own; until then CACM stays agent-agnostic
> (Claude Code, Codex, OpenCode, Cursor, SPEG) and the harness slot below is
> open. Historical jcode task records are kept but marked **superseded**.
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
│ HARNESS  │  │  SPEG WEB  │  │  ANY OTHER TOOL │
│  (TBD:   │  │  (React)   │  │  (Claude, etc.) │
│ external │  │            │  │                 │
│ or self- │  │ + cacm-    │  │ + cacm-sdk-rs   │
│  built)  │  │   sdk-ts   │  │   or cacm-sdk-ts│
│          │  │            │  │                 │
│ Connects │  │ Talks to   │  │ Talks to CACM   │
│ to CACM  │  │ CACM via   │  │ daemon via      │
│ via      │  │ WebSocket  │  │ WebSocket       │
│ sdk-rs   │  │            │  │                 │
│ or sdk-ts│  │            │  │                 │
└──────────┘  └────────────┘  └─────────────────┘
```

### Key Design Decisions

| Decision | Why |
|----------|-----|
| **CACM as daemon** | One process watches all agents. Any tool connects. No embedded complexity. |
| **Core in Rust** | User preference. Watcher/extractor/injector/compactor all Rust. |
| **TypeScript SDK** | SPEG web + Node.js tools import `cacm-sdk-ts` — clean npm package. |
| **Rust SDK** | Future harness / self-built agent imports `cacm-sdk-rs`. ~~jcode~~ (superseded). |
| **Harness** | **TBD** — external harness or self-built. The jcode bridge route was removed in v6. |
| **Storage** | Local SQLite; in-memory graph for lightweight runs. ~~Jcode memory graph~~ (superseded). |
| **Protocol** | WebSocket with JSON messages — simple, cross-language, debuggable. |

---

## Package Structure

```
t3code/
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
│                                  ←   harness slot is TBD: external or self-built)
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
and a `turn_start` injection hook inside jcode) is **removed**. When a
harness is chosen (external or self-built), integration follows the same
shape: a thin adapter that imports `cacm-sdk-rs`/`cacm-sdk-ts`, registers
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

### Task 1.3: cacm-core Rust Crate

**Files**: `cacm/cacm-core/` — types, watcher, parser trait, stub parsers

**Verification**: `cargo build -p cacm-core` compiles.

---

### Task 1.4: cacm-daemon

**Files**: `cacm/cacm-daemon/` — HTTP + WebSocket server, JSON-RPC API

**Verification**: Daemon starts, WebSocket accepts connections, responds to ping.

---

### Task 1.5: ~~Jcode~~ Session Parser 🔄 SUPERSEDED

**Status**: Removed in v6 — the jcode parser (`cacm/cacm-core/src/parsers/jcode.rs`) was deleted with the jcode strip. The parser slot is open for the chosen harness.

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

**Status**: Was ✅ (report: `research/report/1.10-jcode-adapter.md`). The entire adapter (`JcodeDriver.ts`, `JcodeAdapter.ts`, `JcodeProcessManager.ts`, `JcodeProvider.ts`, `JcodeTextGeneration.ts`, `JcodeSettings`) was **deleted** when jcode was dropped; the provider slot is open for the chosen harness.

---

### Task 1.11: CACM Right Panel Tab (T3 Code Web)

**Status**: ✅ (report: `research/report/1.11-cacm-panel.md`)

**Files**: `apps/web/src/components/speg/CacmPanel.tsx` — new right panel tab

**What**: Like Cursor IDE's sidebar, T3 Code has a right panel with tabs (Plan, Diff, Files, Preview, Terminal). We add a CACM tab showing:
- Cross-agent session timeline (all agents, color-coded)
- Recent context extracted from each session
- "Inject context" button for current thread
- Links to related memories

Follows `rightPanelStore.ts` pattern — registers as a new surface type.

**Verification**: Right panel shows CACM tab. Timeline populated from cacm-daemon via @cacm/sdk.

---

### Task 1.12: SPEG Settings Panel (T3 Code Web)

**Status**: ✅ (report: `research/report/1.12-speg-settings.md`)

**Files**: `apps/web/src/routes/speg/` — new settings section

**What**: A settings panel for SPEG configuration:
- CACM daemon port + connection settings
- Agent session watch paths
- Context injection preferences (auto/manual/off)
- Skill toggle switches
- Memory graph storage backend selection

Follows existing T3 Code settings panel pattern.

**Verification**: Settings appear in T3 Code's settings sidebar. Changes persist.

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

**Verification**: All builds pass, all tests pass, CACM right panel populates, provider list shows the chosen harness (TBD), `git tag speg-v0.1.0-phase1`.

---

## Language Split

| Component | Language | Why |
|-----------|----------|-----|
| cacm-core | **Rust** | Performance, cross-agent watcher/extractor |
| cacm-daemon | **Rust** | Same binary, no runtime overhead |
| cacm-sdk-rs | **Rust** | Native SDK for the chosen harness |
| cacm-sdk-ts | **TypeScript** | SPEG web + Node.js ecosystem |
| ~~jcode-cacm-bridge~~ | **Rust** | ~~Thin Jcode integration layer~~ (removed in v6) |
| speg-web | **TypeScript** | React UI |
| speg-desktop | **TypeScript** | Electron |
| speg-mobile | **TypeScript** | React Native |

## What This Enables

```
$ cacm-daemon &                    # Start CACM (one process, watches all agents)

# The chosen harness picks it up (TBD):
# $ <harness>                       # CACM tools available, context injected

# SPEG web connects:
$ cd speg-web && vp run dev        # Shows cross-agent timeline from @cacm/sdk

# Any other tool:
$ npm install @cacm/sdk            # TypeScript/Node.js
# or
cacm-sdk-rs = "0.1"               # Cargo.toml for Rust tools
```

## Done Criteria (Full Plan)

- [ ] CACM daemon watches all agent types, extracts context
- [ ] Chosen harness imports CACM via adapter → tools + auto-injection work
- [ ] SPEG web imports `@cacm/sdk` → cross-agent timeline visible
- [ ] Context transfers seamlessly between Claude Code → Codex → SPEG → harness
- [ ] Any tool can `npm install @cacm/sdk` or add `cacm-sdk-rs` to Cargo.toml
- [ ] Compactor deduplicates and summarizes across sessions
- [ ] Windows desktop app (Electron + cacm-daemon + chosen harness)
- [ ] All Rust: `cargo build --workspace`, `cargo test --workspace`, clippy clean
- [ ] All TypeScript: typecheck, tests pass
