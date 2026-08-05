# SPEG — Prompt Reference v6

> **Copy-paste prompts** for every task. Each prompt is self-contained.
> After completing: run all tests → git commit → mark checklist ✅ → write report
> **Architecture**: Jcode as T3 Code provider. CACM as right panel tab + settings.
> **Jcode**: vanilla + thin `jcode-cacm-bridge` crate. Zero core modifications.

---

## [COMPLETED] Task 1.1: @speg/core TypeScript Package Scaffold

````
TASK: Create the @speg/core package scaffold inside the T3 Code monorepo.

CONTEXT:
- Working in the T3 Code monorepo at the current workspace root
- pnpm workspaces with catalog versioning
- Package naming: @speg/core (NOT @t3tools)
- Subpath-only exports (no barrel index — follow @t3tools/shared pattern)
- jcode-sdk version: ^1.1.0 (npm latest GA; v0.67.0 does not exist on npm)
- tsconfig extends: ../tsconfig.base.json (speg/ is ONE level from root, not two)

FILES:
1. speg/package.json — name @speg/core, type module, subpath exports, catalog deps
2. speg/tsconfig.json — extends ../tsconfig.base.json
3. speg/src/index.ts, speg/src/jcode/index.ts, speg/src/cacm/index.ts — placeholders
4. pnpm-workspace.yaml — add "speg" to packages

VERIFICATION:
```bash
vp i
vp run --filter @speg/core typecheck
````

STATUS: ✅ COMPLETE (commit 8f6858de) | Report: research/report/1.1-scaffolding.md

```

---

## [COMPLETED] Task 1.2: SPEG Wire Contracts (Effect/Schema)

```

TASK: Define all SPEG wire types using Effect/Schema in packages/contracts/src/speg/.

CONTEXT:

- Follow EXACT patterns from baseSchemas.ts (branded IDs) and rpc.ts (RPC definitions)
- DO NOT modify any existing T3 Code contract file
- Create SEPARATE SpegRpcGroup (cannot modify WsRpcGroup in existing rpc.ts)

FILES:

1. packages/contracts/src/speg/spegBaseSchemas.ts — SpegSessionId, SpegMemoryId, SpegContextId
2. packages/contracts/src/speg/spegSession.ts — AgentSessionDescriptor, SessionStatus, AgentType
3. packages/contracts/src/speg/spegContext.ts — CrossAgentContext, ContextQuery
4. packages/contracts/src/speg/spegMemory.ts — MemoryQueryParams, MemorySearchResult
5. packages/contracts/src/speg/spegChat.ts — SpegTurnRequest, SpegTurnResponse
6. packages/contracts/src/speg/spegRpc.ts — SpegRpcGroup with 5 RPC methods
7. packages/contracts/src/speg/index.ts — re-export barrel
8. packages/contracts/test/speg/contracts.test.ts — 64 roundtrip + rejection tests

VERIFICATION:

```bash
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/contracts test test/speg/contracts.test.ts
```

STATUS: ✅ COMPLETE | Report: research/report/1.2-contracts.md

```

---

## Task 1.3: cacm-core Rust Crate

```

TASK: Create the cacm-core Rust crate — types, watcher infrastructure, parser trait.

CONTEXT:

- CACM is a STANDALONE package at t3code/cacm/ — not inside jcode/crates/
- This crate defines the core types and traits that cacm-daemon and parsers use
- Reference: jcode/crates/jcode-memory-types/src/ for MemoryEntry patterns

FILES TO CREATE:

1. cacm/cacm-core/Cargo.toml — name: cacm-core, deps: serde, serde_json, chrono, tokio, notify
2. cacm/cacm-core/src/lib.rs — crate root
3. cacm/cacm-core/src/types.rs — AgentType, AgentSession, AgentTurn, CrossAgentContext
4. cacm/cacm-core/src/watcher.rs — SessionWatcher using notify crate
5. cacm/cacm-core/src/parsers/mod.rs — AgentSessionParser trait + ParserRegistry
6. cacm/Cargo.toml — workspace root with members

RESEARCH:

- Read jcode/crates/jcode-memory-types/src/lib.rs for MemoryEntry.source pattern
- Search: "notify crate Rust file watcher example"
- Search: "Rust trait object registry pattern"

VERIFICATION:

```bash
cd cacm && cargo build -p cacm-core
cd cacm && cargo test -p cacm-core
cd cacm && cargo clippy -p cacm-core
```

GIT COMMIT:

```bash
git add cacm/
git commit -m "feat(cacm): add cacm-core crate with types, watcher, parser trait"
```

AFTER: Mark ✅, write report to research/report/1.3-cacm-core.md

```

---

## Task 1.4: cacm-daemon (HTTP + WebSocket Server)

```

TASK: Build the CACM daemon — a standalone Rust binary exposing CACM over WebSocket.

CONTEXT:

- One daemon serves all clients (Jcode bridge, T3 Code web, any tool)
- JSON-RPC style API over WebSocket at ws://localhost:9786
- Uses Jcode memory graph (primary) or local SQLite (fallback)

FILES TO CREATE:

1. cacm/cacm-daemon/Cargo.toml — depends on cacm-core, tokio, axum, serde_json
2. cacm/cacm-daemon/src/main.rs — CLI args, init, HTTP server, graceful shutdown
3. cacm/cacm-daemon/src/server.rs — WebSocket handler, JSON-RPC routing
4. cacm/cacm-daemon/src/handlers.rs — cacm.query, cacm.sessions, cacm.inject
5. cacm/cacm-daemon/src/storage.rs — JcodeBackend + SqliteBackend

API SPEC:

```
→ {"id":1,"method":"cacm.query","params":{"project":"/path","limit":10}}
← {"id":1,"result":{"entries":[...]}}
← {"event":"cacm.session_activity","data":{"agent":"jcode","session":"fox",...}}
```

VERIFICATION:

```bash
cd cacm && cargo build -p cacm-daemon
cargo test -p cacm-daemon
./target/debug/cacm-daemon --port 9787 &
```

GIT COMMIT:

```bash
git add cacm/cacm-daemon/
git commit -m "feat(cacm): add cacm-daemon with WebSocket JSON-RPC API"
```

AFTER: Mark ✅, write report to research/report/1.4-cacm-daemon.md

```

---

## Task 1.5: Jcode Session Parser

```

TASK: Implement the Jcode session parser for cacm-core.

CONTEXT:

- Implements AgentSessionParser trait for AgentType::Jcode
- Parses Jcode session directories: ~/.jcode/sessions/<id>/
- Reads transcript JSONL files
- Reference: jcode/crates/jcode-session-types/src/

FILES TO CREATE:

1. cacm/cacm-core/src/parsers/jcode.rs — JcodeSessionParser
2. Stub parsers: claude.rs, codex.rs, opencode.rs, cursor.rs (return NotImplemented)
3. cacm/cacm-core/tests/jcode_parser_test.rs

VERIFICATION:

```bash
cd cacm && cargo test -p cacm-core
```

GIT COMMIT:

```bash
git add cacm/cacm-core/src/parsers/
git commit -m "feat(cacm): add Jcode session parser with stub parsers"
```

AFTER: Mark ✅, write report to research/report/1.5-jcode-parser.md

```

---

## Task 1.6: Context Extractor

```

TASK: Implement heuristic context extraction from AgentTurn data.

CONTEXT:

- Pure functions — receive AgentTurn, return extracted context
- MVP: template-based heuristics (no LLM dependency)
- Extracts: tasks, decisions, file changes, errors, patterns
- Batch: every 5 turns or at session end

FILES TO CREATE:

1. cacm/cacm-core/src/extractor.rs — ContextExtractor + heuristic functions
2. cacm/cacm-core/tests/extractor_test.rs

VERIFICATION:

```bash
cd cacm && cargo test -p cacm-core
```

GIT COMMIT:

```bash
git add cacm/cacm-core/src/extractor.rs cacm/cacm-core/tests/
git commit -m "feat(cacm): add heuristic context extractor"
```

AFTER: Mark ✅, write report to research/report/1.6-extractor.md

```

---

## Task 1.7: Context Injector

```

TASK: Implement context injection — query memory, rank, format for target agent.

CONTEXT:

- Query cacm-daemon storage for recent cross-agent context
- Rank by recency × relevance × confidence
- Format per target agent type (Speg, Claude Code, Codex, etc.)
- Budget: max 2000 chars, truncate lowest-ranked if over

FILES TO CREATE:

1. cacm/cacm-core/src/injector.rs — ContextInjector + ranking + formatters
2. cacm/cacm-core/tests/injector_test.rs

VERIFICATION:

```bash
cd cacm && cargo test -p cacm-core
```

GIT COMMIT:

```bash
git add cacm/cacm-core/src/injector.rs cacm/cacm-core/tests/
git commit -m "feat(cacm): add context injector with cross-agent formatting"
```

AFTER: Mark ✅, write report to research/report/1.7-injector.md

```

---

## Task 1.8: cacm-sdk-rs + jcode-cacm-bridge

```

TASK: Build the Rust SDK for CACM and the thin Jcode bridge crate.

CONTEXT:

- cacm-sdk-rs: Rust client library that talks to cacm-daemon via WebSocket
- jcode-cacm-bridge: thin Jcode crate (~200 lines) registering CACM tools + hooks
- Jcode stays VANILLA — zero modifications to existing Jcode crates

FILES TO CREATE:

1. cacm/cacm-sdk-rs/Cargo.toml + src/lib.rs — CacmClient
2. jcode/crates/jcode-cacm-bridge/Cargo.toml + src/lib.rs — CacmQueryTool, CacmInjectTool
3. jcode/Cargo.toml — add workspace member

VERIFICATION:

```bash
cd cacm && cargo build -p cacm-sdk-rs
cd jcode && cargo build --workspace
cargo test -p jcode-cacm-bridge
```

GIT COMMIT:

```bash
git add cacm/cacm-sdk-rs/ jcode/crates/jcode-cacm-bridge/ jcode/Cargo.toml
git commit -m "feat(cacm): add cacm-sdk-rs and jcode-cacm-bridge"
```

AFTER: Mark ✅, write report to research/report/1.8-sdk-bridge.md

```

---

## Task 1.9: cacm-sdk-ts (@cacm/sdk)

```

TASK: Build the TypeScript SDK for CACM — npm package @cacm/sdk.

CONTEXT:

- TypeScript client that talks to cacm-daemon via WebSocket
- Used by T3 Code web components (CACM right panel, settings)
- Zero dependencies beyond the platform (use native WebSocket)

FILES TO CREATE:

1. cacm/cacm-sdk-ts/package.json — @cacm/sdk, type module
2. cacm/cacm-sdk-ts/src/index.ts — public API
3. cacm/cacm-sdk-ts/src/types.ts — TS types mirroring Rust types
4. cacm/cacm-sdk-ts/src/client.ts — CacmClient class
5. cacm/cacm-sdk-ts/test/client.test.ts

VERIFICATION:

```bash
cd cacm/cacm-sdk-ts && npm install && npm run typecheck && npm test
```

GIT COMMIT:

```bash
git add cacm/cacm-sdk-ts/
git commit -m "feat(cacm): add cacm-sdk-ts TypeScript client"
```

AFTER: Mark ✅, write report to research/report/1.9-cacm-sdk-ts.md

```

---

## Task 1.10: Jcode Provider Adapter (T3 Code Server)

```

TASK: Add Jcode as a new provider adapter in T3 Code's server.

CONTEXT:

- T3 Code has provider adapters for Codex, Claude, Cursor, Grok, OpenCode
- Each implements ProviderDriver interface in apps/server/src/provider/drivers/
- Jcode adapter follows the EXACT same pattern
- Talks to Jcode daemon via harness API (NDJSON over Unix socket)
- Use @1jehuang/jcode-sdk (already in speg/) — or write own client from protocol spec
- Research existing adapters FIRST: read claude/ and codex/ directories

FILES TO CREATE:

1. apps/server/src/provider/drivers/jcode/JcodeAdapter.ts:
   - Implement ProviderDriver interface
   - launch(): spawn jcode serve + api-bridge
   - sendTurn(), interrupt(), streamEvents()
   - Translate Jcode API events → canonical ProviderRuntimeEvent

2. apps/server/src/provider/drivers/jcode/JcodeProcessManager.ts:
   - Spawn Jcode daemon, health check, auto-restart, shutdown
   - Build from jcode/ source: cargo build --release

3. apps/server/src/provider/builtInDrivers.ts (UPDATE):
   - Register JcodeAdapter in built-in drivers list

4. apps/server/test/provider/jcode/JcodeAdapter.test.ts:
   - Mock Jcode harness API, test full lifecycle

RESEARCH:

- Read apps/server/src/provider/ProviderDriver.ts for the interface
- Read apps/server/src/provider/drivers/claude/ClaudeAdapter.ts for the pattern
- Read apps/server/src/provider/builtInDrivers.ts for registration

VERIFICATION:

```bash
vp run --filter @t3tools/server typecheck
vp run test apps/server/test/provider/jcode/JcodeAdapter.test.ts
# Integration: vp run dev → Jcode appears in provider list
```

GIT COMMIT:

```bash
git add apps/server/src/provider/drivers/jcode/ apps/server/src/provider/builtInDrivers.ts
git commit -m "feat(speg): add Jcode provider adapter to T3 Code server"
```

AFTER: Mark ✅, write report to research/report/1.10-jcode-adapter.md

```

---

## Task 1.11: CACM Right Panel Tab (T3 Code Web)

```

TASK: Add CACM tab to T3 Code's right panel — cross-agent context timeline.

CONTEXT:

- T3 Code web right panel has tabs: Plan, Diff, Files, Preview, Terminal
- State managed by apps/web/src/rightPanelStore.ts (surface types)
- Add new "cacm" surface type, import @cacm/sdk, query cacm-daemon
- Like Cursor IDE's sidebar but for ALL agents

FILES TO CREATE:

1. apps/web/src/components/speg/CacmPanel.tsx:
   - Queries cacm-daemon via @cacm/sdk on mount
   - Session list: color-coded by agent, timestamps, task summary
   - Click to expand → extracted context (decisions, errors, patterns)
   - "Inject context" button per session
   - Auto-refresh via activity push notifications

2. apps/web/src/rightPanelStore.ts (MINIMAL update):
   - Add "cacm" surface type — follow existing pattern

3. apps/web/test/components/speg/CacmPanel.test.tsx:
   - Mock @cacm/sdk, test rendering and injection

RESEARCH:

- Read apps/web/src/rightPanelStore.ts for surface type registration
- Read apps/web/src/components/chat/RightPanelTabs.tsx for rendering pattern

VERIFICATION:

```bash
vp run --filter @t3tools/web typecheck
vp run test apps/web/test/components/speg/CacmPanel.test.tsx
# Integration: vp run dev → right panel shows CACM tab → populated with data
```

GIT COMMIT:

```bash
git add apps/web/src/components/speg/ apps/web/src/rightPanelStore.ts
git commit -m "feat(speg): add CACM cross-agent timeline to right panel"
```

AFTER: Mark ✅, write report to research/report/1.11-cacm-panel.md

```

---

## Task 1.12: SPEG Settings Panel (T3 Code Web)

```

TASK: Add SPEG settings section to T3 Code's /settings route.

CONTEXT:

- T3 Code has settings panels at /settings, registered by category
- Add "SPEG" category for Jcode + CACM configuration

FILES TO CREATE:

1. apps/web/src/components/speg/SpegSettings.tsx:
   - Jcode: binary path (auto-detect/manual), build command, args
   - CACM Daemon: host:port, auto-start, watch paths, storage backend
   - Context Injection: auto/manual/off, max context budget (tokens)
   - Agent Watching: per-agent toggles (Jcode ON, Claude OFF, etc.)
   - Skills: per-skill toggles (placeholder for Phase 3)

2. apps/web/src/routes/settings.tsx (UPDATE):
   - Register SPEG category, route to SpegSettings

3. apps/web/test/components/speg/SpegSettings.test.tsx

RESEARCH:

- Read apps/web/src/routes/settings.tsx for registration patterns

VERIFICATION:

```bash
vp run --filter @t3tools/web typecheck
vp run test apps/web/test/components/speg/SpegSettings.test.tsx
# Integration: open /settings → SPEG section visible → save persists
```

GIT COMMIT:

```bash
git add apps/web/src/components/speg/ apps/web/src/routes/
git commit -m "feat(speg): add SPEG settings panel to T3 Code"
```

AFTER: Mark ✅, write report to research/report/1.12-speg-settings.md

```

---

## Task 1.13: Compactor

```

TASK: Implement cross-session context compaction.

CONTEXT:

- Runs during cacm-daemon's ambient cycles (or on-demand)
- Deduplicates similar entries from different agents
- Summarizes multi-turn sessions into milestone entries
- Links related entries in the memory graph

FILES TO CREATE:

1. cacm/cacm-core/src/compactor.rs:
   - Deduplication: group by file_path, keep highest-confidence
   - Summarization: multi-turn → milestone
   - Linking: cross-agent related_to edges
   - Staleness: confidence decay + pruning

2. cacm/cacm-core/tests/compactor_test.rs

RESEARCH:

- Search: "text deduplication algorithm Rust"
- Read jcode-base/src/memory/ for consolidation patterns

VERIFICATION:

```bash
cd cacm && cargo test -p cacm-core
```

GIT COMMIT:

```bash
git add cacm/cacm-core/src/compactor.rs cacm/cacm-core/tests/
git commit -m "feat(cacm): add cross-session context compactor"
```

AFTER: Mark ✅, write report to research/report/1.13-compactor.md

```

---

## Task 1.14: CACM Daemon WebSocket Protocol Types

```

TASK: Define TypeScript types for the CACM daemon WebSocket protocol.

CONTEXT:

- CACM daemon (1.4) uses a simple JSON WebSocket protocol, NOT Effect RPC
- These types are for cacm-sdk-ts to use when talking to cacm-daemon
- Must mirror the Rust types in cacm-core/src/types.rs exactly
- Separate from the Effect/Schema contracts in 1.2 (for SPEG ↔ T3 Code)

FILES TO CREATE:

1. cacm/cacm-sdk-ts/src/types.ts:
   - AgentType, AgentSession, AgentTurn, CrossAgentContext, ContextType
   - CacmQueryParams/Result, CacmSessionsParams/Result, CacmInjectParams/Result
   - CacmSessionActivity push notification type
   - All plain TypeScript interfaces (not Effect/Schema)

VERIFICATION:

```bash
cd cacm/cacm-sdk-ts && npm run typecheck
```

GIT COMMIT:

```bash
git add cacm/cacm-sdk-ts/src/types.ts
git commit -m "feat(cacm): add CACM daemon WebSocket protocol types"
```

AFTER: Mark ✅, write report to research/report/1.14-protocol-types.md

```

---

## [COMPLETED] Task 1.15: Wire Contracts Barrel Export

```

TASK: Wire the SPEG contracts barrel into the @t3tools/contracts package entry.

CONTEXT:

- Task 1.2 created SPEG contracts but intentionally did NOT export them
- Now that contracts are stable, add the barrel export
- ONE-LINE change

FILES TO MODIFY:

1. packages/contracts/src/index.ts:
   - Add: export \* from "./speg/index.ts";

VERIFICATION:

```bash
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/contracts test
```

GIT COMMIT:

```bash
git add packages/contracts/src/index.ts
git commit -m "feat(speg): wire SPEG contracts barrel into package entry"
```

AFTER: Mark ✅, write report to research/report/1.15-barrel-export.md

STATUS: ✅ COMPLETE (commit 6746799b) | Report: research/report/1.15-barrel-export.md

```

---

## Task 1.16: Phase 1 Integration Gate

```

TASK: End-to-end verification. All builds pass, all tests pass.

STEPS:

1. Full Rust build:
   cd cacm && cargo build --workspace
   cd jcode && cargo build --workspace

2. All Rust tests:
   cd cacm && cargo test --workspace
   cd jcode && cargo test --workspace

3. Clippy + fmt:
   cd cacm && cargo clippy --workspace && cargo fmt --check
   cd jcode && cargo clippy --workspace && cargo fmt --check

4. TypeScript:
   cd cacm/cacm-sdk-ts && npm run typecheck && npm test
   vp run --filter @speg/core typecheck
   vp run --filter @t3tools/contracts typecheck
   vp run --filter @t3tools/server typecheck
   vp run --filter @t3tools/web typecheck

5. Integration:
   - Start cacm-daemon
   - Start Jcode daemon (jcode serve + jcode api-bridge)
   - Start T3 Code dev server (vp run dev)
   - Verify: Jcode appears in provider list
   - Verify: CACM right panel tab populated
   - Verify: SPEG settings accessible and functional
   - Verify: chat with Jcode agent works

6. Git tag:
   git tag -a speg-v0.1.0-phase1 -m "SPEG Phase 1 complete"

EXIT CRITERIA:

- [ ] cargo build --workspace (both cacm + jcode) → PASS
- [ ] cargo test --workspace → all pass
- [ ] cargo clippy + fmt → clean
- [ ] All TypeScript typecheck + tests → PASS
- [ ] cacm-daemon starts and responds to queries
- [ ] Jcode builds with cacm-bridge, CACM tools visible
- [ ] Jcode appears as provider in T3 Code
- [ ] CACM right panel tab populated
- [ ] SPEG settings accessible
- [ ] Git tag created

AFTER: Write report to research/report/1.16-phase1-complete.md
Mark Phase 1 as complete. Ready for Phase 2.

```

```
