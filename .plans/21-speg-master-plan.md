# SPEG — The Universal Cross-Agent AI Platform

> **Plan 21** | Status: Planning | Built inside `t3code/` as sibling project
> **Model**: Any capable coding agent | **Mode**: Goal-oriented — work until complete or halted
> **Multi-agent**: Yes — parallel tasks on non-overlapping file paths
> **Windows target**: Yes — Phase 1 must produce a working Windows desktop build

---

## Instructions (Read First)

This is a **goal-oriented plan**. An agent reading this should:

1. Pick the next **pending** task from `SPEG-CHECKLIST.md`
2. Copy the task's **full prompt** from `research/promptref.md`
3. Research best approaches (search web if unsure — never guess)
4. Implement following ALL rules in `research/08-style-guide.md` and `AGENTS.md`
5. Write tests
6. Verify: `vp run typecheck` + `vp run test <files>` on changed files only
7. **Git commit** with conventional commit message after all tests pass
8. Write report in `research/report/<task-id>.md`
9. Mark task ✅ in `SPEG-CHECKLIST.md` — **only after git commit succeeds**
10. Pick next task — **do not stop until all tasks done or human halts**

If you encounter blockers, dead-ends, or unclear requirements: **ask the human**. Do not invent answers.

---

## Naming Convention

**Everything new is SPEG**. No T3/T3 Code branding in new code:

| Context | Naming |
|---------|--------|
| Package name | `@speg/core` |
| Service tags | `speg/cacm/SessionWatcher`, `speg/jcode/InstanceManager` |
| RPC methods | `speg.chat.sendMessage`, `speg.cacm.queryContext` |
| Config paths | `~/.speg/`, `%APPDATA%/speg/` |
| Web routes | `/speg/chat`, `/speg/memory` |
| File paths | `speg/src/`, `apps/web/src/components/speg/` |
| Existing T3 Code | **UNTOCUHED** — no renaming of existing `@t3tools/*` packages |

---

## Style Guide Reference

Every agent MUST follow `AGENTS.md` and `research/08-style-guide.md`. Critical rules:

| Rule | Requirement |
|------|-------------|
| **Minimal code** | Same logic >2 times → helper. Fewer lines = better. |
| **Production quality** | Never suppress errors. Fix root cause. |
| **Types** | NEVER `any`. Derive from Schema. |
| **Imports** | `import type` for types. `.ts` extension. Namespace Node builtins. |
| **Effect** | `Effect.fn("name")`. `Schema.TaggedErrorClass`. `Layer.effect`. |
| **Tests** | `@effect/vitest` with `it.effect`. Wait on receipts. |
| **Verification** | `vp run typecheck` + `vp run test <files>` on changed files ONLY. |
| **Research** | Search web for best approach before implementing. |
| **Commits** | Conventional commits after ALL tests pass. |
| **Reports** | Write to `research/report/<task-id>.md` |

---

## Architecture

```
t3code/                                    ← All work happens here
├── apps/
│   ├── server/src/speg/     ← SPEG server services (Effect layers)
│   ├── web/src/
│   │   ├── components/speg/ ← SPEG React components
│   │   └── routes/speg/     ← SPEG routes
│   ├── desktop/src/speg/    ← SPEG Electron integration
│   └── mobile/src/speg/     ← SPEG React Native
├── packages/
│   └── contracts/src/speg/  ← SPEG wire schemas
├── speg/                    ← NEW: Core SPEG package
│   ├── src/
│   │   ├── jcode/           ← Jcode SDK wrappers
│   │   ├── cacm/            ← Cross-Agent Context Manager
│   │   │   └── parsers/     ← Agent session parsers
│   │   ├── memory/          ← Memory graph services
│   │   ├── providers/       ← Provider catalog
│   │   ├── terminal/        ← Terminal services
│   │   └── auth/            ← Auth services
│   ├── skills/              ← Preconfigured skills
│   └── test/                ← Tests
├── .plans/                  ← Plans
└── research/                ← Analysis, reports, promptref
```

### Core Innovation: CACM (Cross-Agent Context Manager)

```
Claude Code ──┐
Codex ────────┤
Cursor ───────┼── SessionWatcher ──→ ContextExtractor ──→ Jcode Memory Graph
OpenCode ─────┤                                              │
SPEG/Jcode ───┘                                              │
       ▲                                                     │
       └──────── ContextInjector ◀─── MemoryQuery ◀─────────┘
```

---

## Phase 1: Foundation — Target: Working Windows Desktop Build

### Task 1.1: Package Scaffolding

**Goal**: Create the `@speg/core` package, configure workspace, ensure it compiles.

**Files**:
- `speg/package.json` — new package manifest
- `speg/tsconfig.json` — TypeScript config
- `speg/src/index.ts` — entry point
- `pnpm-workspace.yaml` — add `speg` to workspace

**Key decisions**:
- Package name: `@speg/core`
- Dependencies: `effect`, `@1jehuang/jcode-sdk`, `@t3tools/contracts`, `@t3tools/shared`
- Exports: subpath-only exports (matching `@t3tools/shared` pattern)
- Target: ESNext, NodeNext module resolution, strict mode

**Dependencies**: None

**Exit criteria**:
- `vp i` installs without errors
- `vp run --filter @speg/core typecheck` passes
- Import `@speg/core` from another package resolves

---

### Task 1.2: SPEG Contracts

**Goal**: Define all cross-agent wire types in Effect/Schema.

**Files**:
- `packages/contracts/src/speg/spegBaseSchemas.ts` — branded IDs
- `packages/contracts/src/speg/spegSession.ts` — agent session descriptors
- `packages/contracts/src/speg/spegContext.ts` — cross-agent context types
- `packages/contracts/src/speg/spegMemory.ts` — memory query/result types
- `packages/contracts/src/speg/spegRpc.ts` — RPC method definitions
- `packages/contracts/src/speg/spegChat.ts` — chat message types
- `packages/contracts/src/speg/index.ts` — re-exports
- `packages/contracts/test/speg/` — contract tests

**Key decisions**:
- Branded IDs: `SpegSessionId`, `SpegMemoryId`, `SpegContextId`
- Use `Schema.Struct`, `Schema.Union`, `Schema.Literal` — no hand-written types
- RPC follows `WsRpcGroup` pattern from existing `rpc.ts`
- All schemas must have encode/decode roundtrip tests
- Include `protocolVersion: 1` in ServerConfig extension

**Dependencies**: 1.1

**Exit criteria**:
- All schemas pass encode/decode roundtrip tests
- `vp run --filter @t3tools/contracts typecheck` passes
- `vp run test packages/contracts/test/speg/` all pass

---

### Task 1.3: Jcode SDK Effect Wrapper

**Goal**: Effect-native service wrappers around `@1jehuang/jcode-sdk`.

**Files**:
- `speg/src/jcode/Services/JcodeInstanceManager.ts` — service tag + shape
- `speg/src/jcode/Services/JcodeSessionBridge.ts` — session mapping
- `speg/src/jcode/Services/JcodeMemoryAccess.ts` — memory graph access
- `speg/src/jcode/Layers/JcodeInstanceManagerLive.ts` — implementation
- `speg/src/jcode/Layers/JcodeSessionBridgeLive.ts`
- `speg/src/jcode/Layers/JcodeMemoryAccessLive.ts`
- `speg/src/jcode/Errors.ts` — tagged errors
- `speg/test/jcode/` — unit tests with mock Jcode SDK

**Key decisions**:
- `JcodeClient.launch()` mode — private instance per project
- Windows: detect Jcode binary path (`%LOCALAPPDATA%\jcode\bin\jcode.exe`)
- Linux/macOS: `~/.local/bin/jcode` or PATH
- Health check: `ping()` via harness API
- Session bridge: map `SpegSessionId` ↔ Jcode `session_id`
- Memory access: read/write Jcode memory graph via SDK calls
- Service tags use `speg/jcode/` prefix

**Dependencies**: 1.1, 1.2

**Exit criteria**:
- Services defined with proper Effect Layer pattern
- Mock Jcode SDK tests pass
- Real Jcode integration test (requires Jcode installed): launch → create session → ping

---

### Task 1.4: CACM Session Watcher

**Goal**: Filesystem watcher that monitors agent session dirs, parses activity.

**Files**:
- `speg/src/cacm/Services/SessionWatcher.ts` — service tag + shape
- `speg/src/cacm/Layers/SessionWatcherLive.ts` — implementation
- `speg/src/cacm/AgentSessionParser.ts` — parser interface
- `speg/src/cacm/parsers/JcodeSessionParser.ts` — Jcode JSONL parser
- `speg/src/cacm/Errors.ts` — parse errors, watch errors
- `speg/test/cacm/SessionWatcher.test.ts` — tests with mock filesystem

**Key decisions**:
- Use `chokidar` (cross-platform fs watcher) — NOT `fs.watch` (buggy on Windows)
- Watch paths per platform:
  - Windows: `%LOCALAPPDATA%\jcode\sessions\`, `%USERPROFILE%\.claude\projects\`
  - Linux/macOS: `~/.jcode/sessions/`, `~/.claude/projects/`
- Parse Jcode `transcript.jsonl` — NDJSON format with `Message` type
- Emit `SessionActivity` via `PubSub` for downstream consumers
- Parser interface: `AgentSessionParser` with `parseTurn(raw) -> AgentTurn`
- Stub parsers for Claude Code, Codex, Cursor, OpenCode (throw "not implemented" — Phase 2)

**Dependencies**: 1.3

**Exit criteria**:
- Watcher detects file changes in mock Jcode session directory
- Parser extracts turns from sample JSONL
- `PubSub` subscribers receive `SessionActivity` events
- All unit tests pass

---

### Task 1.5: CACM Context Extractor

**Goal**: Extract context from agent turns, store in Jcode memory graph.

**Files**:
- `speg/src/cacm/Services/ContextExtractor.ts` — service tag + shape
- `speg/src/cacm/Layers/ContextExtractorLive.ts` — implementation
- `speg/src/cacm/ExtractionHeuristics.ts` — MVP extraction logic
- `speg/test/cacm/ContextExtractor.test.ts` — tests

**Key decisions**:
- Subscribe to `SessionWatcher.streamActivity`
- Batch turns within session: extract every 5 turns OR at session end
- MVP extraction: template-based heuristics (no LLM yet):
  - Task: first user message → task description
  - Decisions: messages containing "decided", "chose", "going with", "will use"
  - File changes: parse tool call output for file paths
  - Errors: messages containing "error", "failed", "broke", "exception"
- Store via `JcodeMemoryAccess` with `provenance: "Observed"`, `source: { agent, sessionId }`
- Use `KeyedCoalescingWorker` (from shared) for per-session batching

**Dependencies**: 1.4

**Exit criteria**:
- Subscribes to watcher, receives turns
- Extracts task, decisions, file changes, errors from sample turns
- Stores entries in Jcode memory graph (verified via mock)
- Unit tests for each extraction heuristic

---

### Task 1.6: CACM Context Injector

**Goal**: Query memory graph, format context, inject into new sessions.

**Files**:
- `speg/src/cacm/Services/ContextInjector.ts` — service tag + shape
- `speg/src/cacm/Layers/ContextInjectorLive.ts` — implementation
- `speg/src/cacm/InjectionFormatters.ts` — per-agent formatting
- `speg/test/cacm/ContextInjector.test.ts` — tests

**Key decisions**:
- Query: `JcodeMemoryAccess.search(projectContext, { limit: 10, recency: "24h" })`
- Rank: `recency_score × relevance_score × confidence`
- Format per target agent:
  - **SPEG**: system context message via `sendMessage({ noReply: true })`
  - **Claude Code**: append to project's `CLAUDE.md` with `[SPEG Context]` section
  - **Codex**: prepend to first user message
  - **OpenCode**: append to `OPENCODE.md`
  - **Cursor**: append to `.cursorrules`
- Context window budget: max 2000 tokens for injected context
- Truncate: drop lowest-ranked entries if over budget

**Dependencies**: 1.5

**Exit criteria**:
- Queries memory graph with project context
- Ranks results correctly (recency × relevance)
- Formats context for each agent type
- Injects into SPEG session (verified via mock)
- Unit tests for ranking, formatting, truncation

---

### Task 1.7: SPEG Server Integration

**Goal**: Wire SPEG services into the existing server. Add WebSocket RPC routes.

**Files**:
- `apps/server/src/speg/SpegLayer.ts` — compose all SPEG services
- `apps/server/src/speg/SpegRpcHandlers.ts` — RPC handler implementations
- `apps/server/src/speg/SpegWsRoutes.ts` — WebSocket route registration
- `apps/server/src/ws.ts` — add SPEG routes (minimal diff — use existing pattern)
- `apps/server/src/server.ts` — add SPEG layer to server composition
- `apps/server/test/speg/` — integration tests

**Key decisions**:
- `SpegLayer` composes: `JcodeInstanceManagerLive` + `SessionWatcherLive` + `ContextExtractorLive` + `ContextInjectorLive`
- RPC handlers follow existing `ws.ts` patterns: `authorizeEffect` + `observeRpcEffect`
- Server activation: SPEG services fork-parked until server activation (use existing `ServerActivation` Deferred)
- Jcode daemon: launched on server startup, health-checked periodically
- Windows: ensure Unix socket paths are replaced with named pipes where needed
- Do NOT break existing T3 Code RPC methods — only add new ones

**Dependencies**: 1.3, 1.6

**Exit criteria**:
- `vp run dev` starts with SPEG services active
- WebSocket accepts SPEG RPC calls
- Jcode daemon launches and is health-checked
- All integration tests pass
- Existing T3 Code functionality unaffected

---

### Task 1.8: Desktop Build & Windows Packaging

**Goal**: Produce a working Windows desktop application that bundles SPEG.

**Files**:
- `apps/desktop/src/speg/SpegDesktopBridge.ts` — SPEG desktop IPC handlers
- `apps/desktop/src/main.ts` — add SPEG to app initialization
- `apps/desktop/package.json` — add SPEG deps, build config
- `apps/desktop/electron-builder.yml` — Windows NSIS/MSI config
- `speg/scripts/build-desktop.sh` — build script
- `speg/scripts/build-desktop.ps1` — Windows build script

**Key decisions**:
- Electron wraps the web app (existing pattern)
- SPEG UI routes: `/speg/chat`, `/speg/memory`, `/speg/settings`
- Desktop IPC: expose SPEG-specific operations via `desktopBridge`
- Windows packaging: NSIS installer + portable .exe
- Jcode binary: bundled with the app OR downloaded on first launch
- Auto-update: `electron-updater` with SPEG update channel
- Build target: Windows x64, macOS ARM64/x64, Linux x64

**Dependencies**: 1.7

**Exit criteria**:
- `vp run dev:desktop` starts desktop app with SPEG UI
- Windows build produces working `.exe`
- Desktop app: launch → see SPEG chat → send message → receive response
- Smoke test on Windows passes

---

### Task 1.9: Phase 1 Integration Test & Cleanup

**Goal**: End-to-end verification that Phase 1 is complete and production-ready.

**What**:
1. Full build: `vp run build` (all packages + apps)
2. Lint check: `vp lint` (all SPEG files)
3. Type check: `vp run typecheck` (all SPEG files)
4. Test suite: `vp run test speg/` + `vp run test apps/server/test/speg/`
5. Start server: `vp run dev` — verify SPEG endpoints respond
6. Desktop launch: verify SPEG UI visible
7. Windows build: verify `.exe` produced
8. Git tag: `speg-v0.1.0-phase1`

**Files**: None (verification only)

**Dependencies**: 1.1–1.8

**Exit criteria**:
- All checks pass
- Windows `.exe` launches and works
- Git tag created
- Phase 1 marked COMPLETE in checklist

---

## Done Criteria (Full Plan)

- [ ] CACM watches all major agent types and extracts context
- [ ] Context seamlessly transfers between any agent
- [ ] Jcode's 40+ providers accessible through SPEG UI
- [ ] 6 preconfigured skills (Graphify, Ponytail, Best Practices, Security, Docs, Tests)
- [ ] Memory graph visualizer with BFS cascade view
- [ ] Swarm dashboard with DAG task view
- [ ] Terminal, VCS diff viewer, browser automation UI
- [ ] Multi-user auth with remote access
- [ ] Desktop (Electron) — Windows, macOS, Linux
- [ ] Mobile (React Native) — iOS, Android
- [ ] Every task has unit tests, all pass
- [ ] All typecheck + lint pass
- [ ] Agent reports in `research/report/`
- [ ] Git tags at each phase completion
