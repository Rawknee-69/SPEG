# SPEG — Architecture v5: CACM as Standalone Importable Package

> **Plan 21 v5** | CACM = standalone daemon + SDKs. Jcode = vanilla + thin import.
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
│  Watches: ~/.jcode/sessions/, ~/.claude/projects/, etc.      │
│  Stores: → Jcode memory graph (via harness API)              │
│          → OR local SQLite if Jcode unavailable              │
└──────┬──────────────┬──────────────────┬─────────────────────┘
       │              │                  │
       ▼              ▼                  ▼
┌──────────┐  ┌────────────┐  ┌─────────────────┐
│  JCODE   │  │  SPEG WEB  │  │  ANY OTHER TOOL │
│ (vanilla)│  │  (React)   │  │  (Claude, etc.) │
│          │  │            │  │                 │
│ + cacm-  │  │ + cacm-    │  │ + cacm-sdk-rs   │
│   sdk-rs │  │   sdk-ts   │  │   or cacm-sdk-ts│
│          │  │            │  │                 │
│ Jcode    │  │ Talks to   │  │ Talks to CACM   │
│ imports  │  │ CACM via   │  │ daemon via      │
│ CACM as  │  │ WebSocket  │  │ WebSocket       │
│ a crate  │  │            │  │                 │
│ dep. No  │  │            │  │                 │
│ core mods│  │            │  │                 │
└──────────┘  └────────────┘  └─────────────────┘
```

### Key Design Decisions

| Decision | Why |
|----------|-----|
| **CACM as daemon** | One process watches all agents. Any tool connects. No embedded complexity. |
| **Core in Rust** | User preference. Watcher/extractor/injector/compactor all Rust. |
| **TypeScript SDK** | SPEG web + Node.js tools import `cacm-sdk-ts` — clean npm package. |
| **Rust SDK** | Jcode imports `cacm-sdk-rs` — thin crate, no Jcode core modifications. |
| **Jcode vanilla** | Jcode only adds a bridge crate (`jcode-cacm-bridge`) that imports `cacm-sdk-rs` and registers CACM as a Jcode tool. Zero changes to Jcode's existing crates. |
| **Storage** | Primary: Jcode memory graph (via harness API). Fallback: local SQLite. |
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
│   │       │   ├── jcode.rs       ← Jcode transcript parser
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
│   │       └── storage.rs         ← Memory graph (Jcode) or SQLite backend
│   │
│   ├── cacm-sdk-rs/               ← Rust client library (for Jcode)
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
├── jcode/                         ← VANILLA JCODE (from 1jehuang/jcode)
│   ├── crates/
│   │   └── jcode-cacm-bridge/     ← NEW: thin bridge crate
│   │       ├── Cargo.toml         ← depends on cacm-sdk-rs
│   │       └── src/
│   │           └── lib.rs         ← Register CACM tools + hooks
│   │                               ← ZERO changes to jcode-app-core
│   └── Cargo.toml                 ← add jcode-cacm-bridge to workspace
│
├── speg-web/                      ← SPEG WEB UI (TypeScript, React)
│   ├── package.json               ← depends on @cacm/sdk
│   ├── src/
│   │   ├── client.ts              ← Jcode harness API client
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
    │       ↑
    │   jcode-cacm-bridge (Rust) ← Jcode imports this. Registers tools.
    │       ↑
    │   jcode (vanilla)          ← ZERO core modifications
    │
    └── cacm-sdk-ts (TypeScript) ← Client library for TS consumers
            ↑
        speg-web (React)         ← Imports @cacm/sdk
```

### Jcode Integration (Zero Core Mods)

`jcode-cacm-bridge` is the ONLY new crate in Jcode. It:
1. Depends on `cacm-sdk-rs` and `jcode-app-core` (for tool registration)
2. Registers CACM tools in Jcode's tool registry:
   - `cacm_query` — agent can query cross-agent context
   - `cacm_inject` — agent can request context injection
   - `cacm_sessions` — agent can list recent sessions across agents
3. Adds a `turn_start` hook (via Jcode's existing hook system in `jcode-base::hooks`) that calls `cacm.inject()` before each turn
4. That's it. ~200 lines of Rust.

No changes to: `jcode-app-core`, `jcode-harness-api`, `jcode-memory-types`, `jcode-base`. Jcode stays 100% vanilla.

### CACM Daemon API

```
WebSocket at ws://localhost:9786 (configurable)

→ REQUEST:  {"id":1,"method":"cacm.query","params":{"project":"/path/to/repo","limit":10}}
← RESPONSE: {"id":1,"result":{"entries":[...]}}

→ REQUEST:  {"id":2,"method":"cacm.sessions","params":{"project":"/path/to/repo"}}
← RESPONSE: {"id":2,"result":{"sessions":[...]}}

→ REQUEST:  {"id":3,"method":"cacm.inject","params":{"sessionId":"abc","agent":"claude-code"}}
← RESPONSE: {"id":3,"result":{"formatted":"[Cross-Agent Context]\n• ..."}}

→ NOTIFICATION: {"event":"cacm.session_activity","data":{"agent":"jcode","sessionId":"fox","turn":{...}}}
```

### Storage Backend

CACM daemon stores context in:
1. **Primary**: Jcode memory graph — connects to Jcode daemon via harness API, stores entries with `category: Custom("cross_agent_context")`, `source: "cacm"`
2. **Fallback**: Local SQLite — if Jcode daemon is not running, CACM stores context locally and syncs when Jcode becomes available

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

### Task 1.5: Jcode Session Parser

**Files**: `cacm/cacm-core/src/parsers/jcode.rs` — parse Jcode transcript JSONL

**Verification**: Parser extracts turns from sample Jcode session file.

---

### Task 1.6: Context Extractor

**Files**: `cacm/cacm-core/src/extractor.rs` — heuristic extraction from turns

**Verification**: Extract tasks, decisions, files, errors from sample turns.

---

### Task 1.7: Context Injector

**Files**: `cacm/cacm-core/src/injector.rs` — query + rank + format

**Verification**: Format cross-agent context for Claude, Codex, SPEG targets.

---

### Task 1.8: cacm-sdk-rs + Jcode Bridge

**Files**: `cacm/cacm-sdk-rs/`, `jcode/crates/jcode-cacm-bridge/`

**Verification**: Jcode builds with bridge crate. CACM tools appear in agent tool list.

---

### Task 1.9: cacm-sdk-ts

**Files**: `cacm/cacm-sdk-ts/` — npm package `@cacm/sdk`

**Verification**: TS client connects to CACM daemon, queries context.

---

### Task 1.10: Jcode Provider Adapter (T3 Code Server)

**Status**: ✅ (report: `research/report/1.10-jcode-adapter.md`)

**Files**: `apps/server/src/provider/Drivers/JcodeDriver.ts`, `apps/server/src/provider/Layers/JcodeAdapter.ts`, `apps/server/src/provider/Drivers/JcodeProcessManager.ts`, `apps/server/src/provider/Layers/JcodeProvider.ts`, `apps/server/src/textGeneration/JcodeTextGeneration.ts`, `packages/contracts/src/settings.ts` (`JcodeSettings`)

**What**: T3 Code already has provider adapters for Codex, Claude, Cursor, Grok, OpenCode. We add Jcode as a new provider. The adapter implements `ProviderDriver` interface: launch Jcode daemon, connect via harness API, send turns, stream events, interrupt.

**Verification**: Jcode appears in T3 Code's provider list. Select Jcode → start a turn → agent responds.

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

**Files**: `apps/web/src/routes/speg/` — new settings section

**What**: A settings panel for SPEG/Jcode configuration:
- Jcode binary path (auto-detect or manual)
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

**Verification**: All builds pass, all tests pass, Jcode appears as provider in T3 Code, CACM right panel populates, `git tag speg-v0.1.0-phase1`.

---

## Language Split

| Component | Language | Why |
|-----------|----------|-----|
| cacm-core | **Rust** | Performance, Jcode integration |
| cacm-daemon | **Rust** | Same binary, no runtime overhead |
| cacm-sdk-rs | **Rust** | Native Jcode dependency |
| cacm-sdk-ts | **TypeScript** | SPEG web + Node.js ecosystem |
| jcode-cacm-bridge | **Rust** | Thin Jcode integration layer |
| speg-web | **TypeScript** | React UI |
| speg-desktop | **TypeScript** | Electron |
| speg-mobile | **TypeScript** | React Native |

## What This Enables

```
$ cacm-daemon &                    # Start CACM (one process, watches all agents)

# Jcode picks it up automatically:
$ jcode                            # CACM tools available, context injected

# SPEG web connects:
$ cd speg-web && vp run dev        # Shows cross-agent timeline from @cacm/sdk

# Any other tool:
$ npm install @cacm/sdk            # TypeScript/Node.js
# or
cacm-sdk-rs = "0.1"               # Cargo.toml for Rust tools
```

## Done Criteria (Full Plan)

- [ ] CACM daemon watches all agent types, extracts context
- [ ] Jcode imports CACM via bridge crate → tools + auto-injection work
- [ ] SPEG web imports `@cacm/sdk` → cross-agent timeline visible
- [ ] Context transfers seamlessly between Claude Code → Codex → SPEG → Jcode
- [ ] Any tool can `npm install @cacm/sdk` or add `cacm-sdk-rs` to Cargo.toml
- [ ] Compactor deduplicates and summarizes across sessions
- [ ] Windows desktop app (Electron + cacm-daemon + Jcode binary)
- [ ] All Rust: `cargo build --workspace`, `cargo test --workspace`, clippy clean
- [ ] All TypeScript: typecheck, tests pass
