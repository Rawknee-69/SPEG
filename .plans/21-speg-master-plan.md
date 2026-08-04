# SPEG — The Universal Cross-Agent AI Platform

> **Plan 21** | Status: Planning | Built inside `t3code/` as a sibling project
> **Model**: Any capable coding agent | **Mode**: Goal-oriented — work until complete or halted
> **Multi-agent**: Yes — parallel tasks on non-overlapping file paths
> **Windows target**: Yes — Phase 1 must produce a working Windows desktop build

---

## Instructions (Read First)

1. Pick the next **pending** task from `SPEG-CHECKLIST.md`
2. Copy the task's **full prompt** from `research/promptref.md`
3. Research best approaches (search web if unsure — never guess)
4. Implement following ALL rules in `research/08-style-guide.md` and `AGENTS.md`
5. Write tests
6. Verify: `vp run typecheck` + `vp run test <files>` on changed files only
7. **Git commit** with conventional commit after all tests pass
8. Write report in `research/report/<task-id>.md`
9. Mark task ✅ — **only after git commit succeeds**
10. Pick next task — **do not stop until all tasks done or human halts**

Blockers? Dead-ends? Unclear requirements? **Ask the human.** Never invent answers.

---

## Naming Convention

| Context | Naming |
|---------|--------|
| Package name | `@speg/core` |
| Service tags | `speg/cacm/SessionWatcher`, `speg/jcode/InstanceManager` |
| RPC methods | `speg.chat.sendMessage`, `speg.cacm.queryContext` |
| Config paths | `~/.speg/`, `%APPDATA%/speg/` |
| Web routes | `/speg/chat`, `/speg/memory` |
| Existing T3 Code | **UNTOCUHED** — no renaming of existing `@t3tools/*` packages |

---

## Architecture

```
t3code/                                    ← All work happens here
├── apps/
│   ├── server/src/speg/     ← SPEG server services (Effect layers)
│   ├── web/src/components/speg/ ← SPEG React components
│   ├── web/src/routes/speg/ ← SPEG routes
│   ├── desktop/src/speg/    ← SPEG Electron integration
│   └── mobile/src/speg/     ← SPEG React Native
├── packages/
│   └── contracts/src/speg/  ← SPEG wire schemas
├── speg/                    ← Core SPEG package
│   ├── src/
│   │   ├── jcode/           ← Jcode harness API client (built from source)
│   │   ├── cacm/            ← Cross-Agent Context Manager
│   │   │   └── parsers/     ← Agent session parsers
│   │   ├── memory/          ← Memory graph services
│   │   ├── providers/       ← Provider catalog
│   │   ├── terminal/        ← Terminal services
│   │   └── auth/            ← Auth services
│   ├── skills/              ← Preconfigured skills
│   └── test/                ← Tests
├── jcode/                   ← Jcode Rust source (existing — UNTOUCHED)
├── .plans/                  ← Plans
└── research/                ← Analysis, reports, promptref
```

### Integration: Jcode Source → SPEG

```
┌──────────────────────────────────────────────────────┐
│ SPEG SERVER (Bun + TypeScript + Effect)              │
│  ┌────────────────────────────────────────────────┐  │
│  │ speg/src/jcode/JcodeClient.ts                  │  │
│  │  - Speaks Jcode harness API protocol directly  │  │
│  │  - NDJSON over Unix socket / Windows named pipe│  │
│  │  - 31 request types, 30 event types            │  │
│  │  - No external SDK dependency                  │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────┘
                       │ NDJSON over local socket
┌──────────────────────┴───────────────────────────────┐
│ JCODE API BRIDGE (jcode api-bridge)                  │
│  - Binds jcode-api.sock                              │
│  - Translates harness API ↔ internal daemon protocol │
│  - Built from jcode/ source (cargo build)            │
└──────────────────────┬───────────────────────────────┘
                       │ Internal daemon socket
┌──────────────────────┴───────────────────────────────┐
│ JCODE DAEMON (jcode serve)                           │
│  - Agents · Swarms · Memory · Skills · MCP           │
│  - 40+ Providers · Browser · Self-Dev                │
│  - Session persistence · Transcripts                 │
└──────────────────────────────────────────────────────┘
```

**Why no npm SDK**: We write our own TypeScript client against the harness API protocol. The protocol is simple (NDJSON, 31 requests, 30 events) and the Jcode source at `jcode/` defines the exact types. This gives us full control, zero external npm deps, and tight coupling with the Jcode version we build.

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

**Goal**: Create `@speg/core` package, configure workspace, ensure it compiles.

**Files**: `speg/package.json`, `speg/tsconfig.json`, `speg/src/index.ts`, `pnpm-workspace.yaml`

**Dependencies**: None

**Exit criteria**:
- `vp i` installs without errors
- `vp run --filter @speg/core typecheck` passes

---

### Task 1.2: SPEG Contracts

**Goal**: Define all wire types in Effect/Schema.

**Files**: `packages/contracts/src/speg/` (7 files: baseSchemas, session, context, memory, chat, rpc, index)

**Dependencies**: 1.1

**Exit criteria**: All schemas pass encode/decode roundtrip tests. Typecheck passes.

---

### Task 1.3: Jcode Harness API Client

**Goal**: Build our own TypeScript client that speaks the Jcode harness API protocol directly.

**Files**:
- `speg/src/jcode/protocol.ts` — wire types matching `jcode-harness-api` crate
- `speg/src/jcode/framing.ts` — NDJSON line encoder/decoder
- `speg/src/jcode/sockets.ts` — socket path resolution (Unix + Windows named pipe)
- `speg/src/jcode/client.ts` — `JcodeClient` class: connect, request/reply, event streaming
- `speg/src/jcode/launch.ts` — spawn Jcode daemon + api-bridge as child processes
- `speg/src/jcode/Errors.ts` — tagged errors (JcodeNotFound, LaunchFailed, ProtocolError)
- `speg/src/jcode/Services/JcodeService.ts` — Effect service wrapping JcodeClient
- `speg/src/jcode/Layers/JcodeServiceLive.ts` — Layer.effect implementation
- `speg/test/jcode/` — unit tests with mock socket

**Key decisions**:
- **Zero npm deps for protocol** — no `@1jehuang/jcode-sdk`. We write our own client.
- Protocol: NDJSON over Unix socket (Linux/macOS) or Windows named pipe
- Socket path: `$JCODE_API_SOCKET` or `<runtime_dir>/jcode-api.sock`
- Windows named pipe: `\\.\pipe\<stem>-<sha256[:16]>`
- Handshake: `{"v":1,"id":1,"req":"hello","min_version":1,"max_version":1,"client":"speg/0.1"}\n`
- Frames: 31 request types, 30 event types — exact parity with `jcode-harness-api` crate
- Reference: `jcode/crates/jcode-harness-api/src/` for exact types
- Jcode lifecycle: spawn `jcode serve` as daemon, then `jcode api-bridge` for API access
- Build Jcode from source: `cargo build --release` in `jcode/` directory

**Dependencies**: 1.1, 1.2

**Exit criteria**:
- JcodeClient connects to api-bridge socket
- Handshake succeeds (hello → hello_ok)
- Create session, send message, stream events until turn_done
- All unit tests pass with mock socket
- Real integration test (requires Jcode built)

---

### Task 1.4: CACM Session Watcher

**Goal**: Filesystem watcher monitoring agent session directories.

**Files**: `speg/src/cacm/` (7 files: Errors, AgentSessionParser interface, JcodeParser, stubs, SessionWatcher service, SessionWatcherLive)

**Dependencies**: 1.3

**Exit criteria**: Watcher detects Jcode session activity. Parser extracts turns from JSONL. PubSub subscribers receive events.

---

### Task 1.5: CACM Context Extractor

**Goal**: Extract context from agent turns, store in Jcode memory graph.

**Files**: `speg/src/cacm/` (4 files: ExtractionHeuristics, ContextExtractor service, ContextExtractorLive)

**Dependencies**: 1.4

**Exit criteria**: Extracts tasks, decisions, file changes, errors. Stores in memory graph via mock.

---

### Task 1.6: CACM Context Injector

**Goal**: Query memory graph, format context, inject into new sessions.

**Files**: `speg/src/cacm/` (4 files: InjectionFormatters, ContextInjector service, ContextInjectorLive)

**Dependencies**: 1.5

**Exit criteria**: Queries memory, ranks results, formats per agent, injects into SPEG session.

---

### Task 1.7: SPEG Server Integration

**Goal**: Wire SPEG services into existing server. Add WebSocket RPC routes.

**Files**: `apps/server/src/speg/` (3 files), `apps/server/src/ws.ts` (minimal diff), `apps/server/src/server.ts` (minimal diff)

**Dependencies**: 1.3, 1.6

**Exit criteria**: Server starts with SPEG layer. WebSocket accepts SPEG RPC. Existing T3 Code unaffected.

---

### Task 1.8: Desktop Build & Windows Packaging

**Goal**: Working Windows Electron desktop app bundling SPEG + Jcode.

**Files**: `apps/desktop/src/speg/`, `electron-builder.yml`, `scripts/build-speg-desktop.ps1`

**Dependencies**: 1.7

**Exit criteria**: Windows `.exe` builds and launches. SPEG UI visible. Jcode daemon starts.

---

### Task 1.9: Phase 1 Integration Test & Cleanup

**Goal**: End-to-end verification. All checks pass. Git tag.

**Files**: None (verification only)

**Dependencies**: 1.1–1.8

**Exit criteria**: All typecheck + tests + lint pass. Windows .exe builds. `git tag speg-v0.1.0-phase1`.

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
