# SPEG — The Universal Cross-Agent AI Platform

> **Plan 21** | Status: Planning | Target: Built inside `t3code/` as a sibling project
> **Model**: Any capable coding agent | **Mode**: Goal-oriented — work until complete or halted
> **Multi-agent**: Yes — parallel tasks on non-overlapping file paths

---

## Instructions (Read First)

This is a **goal-oriented plan**. An agent reading this should:

1. Pick the next **pending** task from `SPEG-CHECKLIST.md`
2. Read the task's full specification below
3. Research best approaches (search web if unsure — never guess)
4. Implement following ALL rules in [Style Guide](#style-guide-reference)
5. Write tests
6. Verify: `vp run typecheck` + `vp run test <files>` on changed files only
7. Write report in `t3code/research/report/<task-id>.md`
8. Mark task complete in `SPEG-CHECKLIST.md`
9. Pick next task — **do not stop until all tasks done or human halts**

If you encounter blockers, dead-ends, or unclear requirements: **ask the human**. Do not invent answers.

---

## Style Guide Reference

Every agent MUST follow `t3code/AGENTS.md` and the comprehensive style guide at `t3code/research/08-style-guide.md`. Key rules:

| Rule | Requirement |
|------|-------------|
| **Minimal code** | If same logic used >2 times → helper function. Fewer lines = better. |
| **Production quality** | Never suppress errors/warnings — fix root cause. |
| **Types** | NEVER use `any`. ALWAYS use proper types. Derive from Schema, not hand-written. |
| **Imports** | `import type` for types. `.ts` extension on relative imports. Namespace for Node builtins. |
| **Effect** | `Effect.fn("name")` for named functions. `Schema.TaggedErrorClass` for errors. |
| **Tests** | `@effect/vitest` with `it.effect`. Wait on receipts, never timeouts. |
| **Verification** | `vp run typecheck` + `vp run test <files>` on changed files ONLY. Never repo-wide. |
| **Research** | Search web for best algorithms/patterns before implementing. Never guess. |
| **Reports** | After each task: write report in `t3code/research/report/<task-id>.md` |

---

## Motivation

T3 Code is a multi-provider agent harness. Jcode is a 15.8K-star Rust-based coding agent with 40+ providers, swarms, semantic memory, and a GA TypeScript SDK. The opportunity: combine T3 Code's multi-surface UI architecture with Jcode's agent intelligence, and build the **first truly cross-agent context continuity system** — where switching from Claude Code → Codex → SPEG preserves all context seamlessly.

---

## Architecture

```
t3code/                              ← All work happens here
├── apps/
│   ├── server/     ← SPEG server (new files, Effect services)
│   ├── web/        ← SPEG web UI (new routes + components)
│   ├── desktop/    ← SPEG desktop (wraps web)
│   └── mobile/     ← SPEG mobile (React Native)
├── packages/
│   ├── contracts/  ← SPEG contracts (new schemas)
│   ├── shared/     ← SPEG shared utils
│   └── client-runtime/ ← SPEG client logic
├── speg/           ← NEW: SPEG-specific code (Jcode SDK wrappers, CACM engine)
├── .plans/         ← Plans (21-speg-*.md)
└── research/       ← Analysis & reports
    └── report/     ← Agent task reports
```

### Core Innovation: CACM (Cross-Agent Context Manager)

```
Claude Code ──┐
Codex ────────┤
Cursor ───────┼── Session Watcher ──→ Context Extractor ──→ Jcode Memory Graph
OpenCode ─────┤                                                    │
SPEG/Jcode ───┘                                                    │
       ▲                                                           │
       └────────── Context Injector ◀────── Memory Query ◀─────────┘
```

CACM watches ALL agent sessions → extracts context → stores in Jcode memory graph → injects relevant context when switching agents → compacts over time.

---

## Phase 1: Foundation (Tasks 1.1 – 1.7)

### Task 1.1: Project Scaffolding

**Files**: `speg/package.json`, `speg/tsconfig.json`, root workspace config update

**What**: Create `t3code/speg/` as a new workspace package. Set up TypeScript, Effect, bundling. Register in pnpm workspace.

**Steps**:
1. Create `speg/package.json` with dependencies: `effect`, `@1jehuang/jcode-sdk`, `@t3tools/contracts`, `@t3tools/shared`
2. Create `speg/tsconfig.json` extending base config
3. Update `pnpm-workspace.yaml` to include `speg`
4. Run `vp i` to install
5. Verify: `vp run --filter speg typecheck` passes

**Exit criteria**: `speg/` package exists, imports resolve, typecheck passes.

---

### Task 1.2: SPEG Contracts

**Files**: `packages/contracts/src/speg/` (new directory with multiple files)

**What**: Define all SPEG wire types using Effect/Schema. Follow existing contract patterns exactly.

**Schemas to define**:
- `spegBaseSchemas.ts` — branded IDs: `AgentSessionId`, `MemoryEntryId`, `ContextChunkId`
- `spegSession.ts` — `AgentSessionDescriptor` (agent type, path, status, metadata)
- `spegContext.ts` — `CrossAgentContext` (universal context entry), `ContextChunk`, `ContextQuery`
- `spegMemory.ts` — `MemoryQueryParams`, `MemorySearchResult`, `MemoryEntrySummary`
- `spegRpc.ts` — RPC methods: `cacm.queryContext`, `cacm.listSessions`, `cacm.injectContext`, `speg.chat.sendMessage`, `speg.chat.subscribe`

**Pattern**: Follow `packages/contracts/src/baseSchemas.ts` for branded IDs. Follow `packages/contracts/src/rpc.ts` for RPC definitions.

**Exit criteria**: All schemas defined with encode/decode tests. `vp run --filter @t3tools/contracts typecheck` passes.

---

### Task 1.3: Jcode SDK Wrapper

**Files**: `speg/src/jcode/` (new directory)

**What**: Effect-native wrapper around `@1jehuang/jcode-sdk`. Follow Layer + Service pattern from T3 Code.

**Services**:
- `JcodeInstanceManager` — launch private Jcode instances, health checks, restart
- `JcodeSessionBridge` — map SPEG threads ↔ Jcode sessions, stream events, route messages
- `JcodeMemoryAccess` — read/write Jcode memory graph, query embeddings

**Pattern**: Each service = `Context.Service` tag + `Layer.effect` implementation + `Schema.TaggedErrorClass` errors.

**Exit criteria**: Services defined with unit tests. Mock Jcode SDK for testing.

---

### Task 1.4: CACM Session Watcher

**Files**: `speg/src/cacm/SessionWatcher.ts`

**What**: Filesystem watcher that monitors agent session directories and emits `SessionActivity` events when new turns appear.

**Service**: `SessionWatcher`
- Watch paths per agent type (Jcode, Claude Code, Codex — stubs for others)
- Parse session format → canonical `AgentTurn`
- Emit via PubSub for downstream consumers
- Pluggable parser interface: `AgentSessionParser`

**Parsers**:
- `JcodeSessionParser` — parse `~/.jcode/sessions/<id>/transcript.jsonl`
- Stubs for Claude Code, Codex, Cursor, OpenCode (implemented in Phase 2)

**Exit criteria**: Watcher detects new Jcode session activity. Unit tests with mock filesystem.

---

### Task 1.5: CACM Context Extractor

**Files**: `speg/src/cacm/ContextExtractor.ts`

**What**: Receives `AgentTurn` events, extracts context, stores in Jcode memory graph.

**Service**: `ContextExtractor`
- Receive turns from SessionWatcher PubSub
- Batch turns within a session (extract every K turns or at session end)
- Use lightweight LLM for extraction (initial: template-based heuristics; later: Jcode sidecar)
- Produce `CrossAgentContext` entries
- Store via `JcodeMemoryAccess` with `provenance: Observed`, `source: { agent, sessionId }`

**Extraction heuristics (MVP)**:
- Task: first user message in session = task description
- Decisions: messages containing "decided", "chose", "going with"
- File changes: tool calls that modify files
- Errors: messages containing "error", "failed", "broke"
- Patterns: repeated file patterns, conventions mentioned

**Exit criteria**: Extract context from mock Jcode session, verify stored entries. Unit tests.

---

### Task 1.6: CACM Context Injector

**Files**: `speg/src/cacm/ContextInjector.ts`

**What**: Queries Jcode memory graph for relevant context and formats it for target agent.

**Service**: `ContextInjector`
- Query: `JcodeMemoryAccess.search()` with current project context
- Rank: recency × relevance × confidence
- Format per agent type (SPEG: system context message; external: AGENTS.md snippet)
- Inject at session start

**Injection format for SPEG**:
```
[Cross-Agent Context — from recent sessions]
• Task: Building REST API for user management (Claude Code, 10 min ago)
• Decision: Using JWT instead of sessions (Claude Code)
• Files modified: src/auth/handler.ts, src/auth/middleware.ts
• Issue resolved: CORS error fixed with middleware (Codex, 5 min ago)
• Pick up from here.
```

**Exit criteria**: Query memory, format context, inject into SPEG session. Unit tests.

---

### Task 1.7: SPEG Server Integration

**Files**: `apps/server/src/speg/` (new directory, minimal additions)

**What**: Wire SPEG services into the existing T3 Code server. Add SPEG WebSocket routes.

**Steps**:
1. Create `SpegLayer` composing all SPEG services
2. Add SPEG RPC handlers to `ws.ts` (minimal additions — use existing patterns)
3. Register SPEG routes
4. Verify: `vp run dev` starts with SPEG services

**Exit criteria**: Server starts with SPEG layer. WebSocket accepts SPEG RPC calls.

---

## Phase 2: External Agent CACM (Tasks 2.1 – 2.4)

### Task 2.1: Claude Code Parser

**Files**: `speg/src/cacm/parsers/ClaudeCodeParser.ts`

**What**: Parse Claude Code session files at `~/.claude/projects/<hash>/`.

**Key challenge**: Claude Code session format. Research the actual file structure first.

**Exit criteria**: Parse real Claude Code session, extract turns. Unit tests.

---

### Task 2.2: Codex Parser

**Files**: `speg/src/cacm/parsers/CodexParser.ts`

**What**: Parse Codex session files at `~/.codex/sessions/`.

**Exit criteria**: Parse real Codex session. Unit tests.

---

### Task 2.3: OpenCode & Cursor Parsers

**Files**: `speg/src/cacm/parsers/OpenCodeParser.ts`, `speg/src/cacm/parsers/CursorParser.ts`

**What**: Parse OpenCode (`~/.local/share/opencode/sessions/`) and Cursor sessions.

**Exit criteria**: Parse real sessions. Unit tests.

---

### Task 2.4: Cross-Agent Context Injection

**Files**: `speg/src/cacm/CrossAgentInjector.ts`

**What**: When user switches agents, inject context formatted for the target agent.

**Mechanisms per agent**:
- SPEG: system context message
- Claude Code: append to CLAUDE.md or initial message
- Codex: prepend to first user message
- OpenCode: append to OPENCODE.md
- Cursor: append to .cursorrules

**Exit criteria**: Claude → SPEG switch preserves context. Integration test.

---

## Phase 3-6: See `SPEG-CHECKLIST.md` for full task list

(Each phase expands into 4-6 tasks following the same pattern)

## Done Criteria (Full Plan)

- [ ] CACM watches all major agent types and extracts context
- [ ] Context seamlessly transfers between any agent
- [ ] Jcode's 40+ providers accessible through SPEG UI
- [ ] 6 preconfigured skills (Graphify, Ponytail, Best Practices, Security, Docs, Tests)
- [ ] Memory graph visualizer with BFS cascade view
- [ ] Swarm dashboard with DAG task view
- [ ] Terminal, VCS diff viewer, browser automation UI
- [ ] Multi-user auth with remote access
- [ ] Desktop (Electron) and Mobile (React Native) apps
- [ ] Every task has unit tests
- [ ] All typecheck + lint pass
- [ ] Agent reports in `t3code/research/report/`
