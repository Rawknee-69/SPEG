# SPEG — Prompt Reference v5

> **Copy-paste prompts** for every task. Each prompt is self-contained.
> After completing: run all tests → git commit → mark checklist ✅ → write report
> **Architecture**: CACM = standalone daemon (Rust). SPEG web imports `@cacm/sdk` (TS).
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
- Add to root Cargo.toml as workspace member
- Reference: jcode/crates/jcode-memory-types/src/ for MemoryEntry patterns
- Reference: jcode/crates/jcode-import-core/src/ for session parsing patterns

FILES TO CREATE:

1. cacm/cacm-core/Cargo.toml:
   - name: "cacm-core", version: "0.1.0", edition: "2021"
   - dependencies: serde, serde_json, chrono, tokio, notify (fs watcher)

2. cacm/cacm-core/src/lib.rs — crate root, re-export modules

3. cacm/cacm-core/src/types.rs:
   - AgentType enum: Jcode, ClaudeCode, Codex, OpenCode, Cursor, Speg
   - AgentSession { session_id, agent_type, path, created_at, status }
   - AgentTurn { turn_index, timestamp, user_message, assistant_response, tool_calls, file_modifications }
   - CrossAgentContext { id, session_id, agent_type, context_type, content, file_paths, decisions, errors, timestamp }
   - ContextType enum: Task, Decision, FileChange, Error, Pattern
   - All types derive Serialize, Deserialize, Debug, Clone

4. cacm/cacm-core/src/watcher.rs:
   - SessionWatcher struct: watch paths, detect changes, emit events
   - Uses notify crate (cross-platform: inotify/FSEvents/ReadDirectoryChangesW)
   - Event type: SessionActivity { session_id, agent_type, event_type, turn, timestamp }
   - tokio::mpsc channel for event emission
   - Platform path resolution: ~/.jcode/sessions/, ~/.claude/projects/, etc.

5. cacm/cacm-core/src/parsers/mod.rs:
   - AgentSessionParser trait:
     fn agent_type() -> AgentType;
     fn parse_session_manifest(path: &Path) -> Result<AgentSession>;
     fn parse_turn(raw: &str) -> Result<AgentTurn>;
     fn detect_activity(path: &Path) -> bool;
   - ParserRegistry: HashMap<AgentType, Box<dyn AgentSessionParser>>
   - register() and get() methods

6. cacm/Cargo.toml (workspace root for cacm):
   - [workspace] members: ["cacm-core", "cacm-daemon", "cacm-sdk-rs"]

RESEARCH:

- Read jcode/crates/jcode-memory-types/src/lib.rs for MemoryEntry.source pattern
- Read jcode/crates/jcode-import-core/src/lib.rs for Claude Code parsing patterns
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
git commit -m "feat(cacm): add cacm-core crate with types, watcher, parser trait

- Core types: AgentSession, AgentTurn, CrossAgentContext
- SessionWatcher using notify crate (cross-platform fs events)
- AgentSessionParser trait + ParserRegistry
- Workspace member in cacm/Cargo.toml"
```

AFTER: Mark ✅, write report to research/report/1.1-cacm-core.md

```

---

## Task 1.4: cacm-daemon (HTTP + WebSocket Server)

```

TASK: Build the CACM daemon — a standalone Rust binary exposing CACM over WebSocket.

CONTEXT:

- The daemon is the RUNNING PROCESS that watches agent sessions and serves queries
- Depends on cacm-core for all logic
- Uses axum or warp for HTTP + WebSocket (research which is lighter)
- JSON-RPC style API over WebSocket
- One daemon serves all clients (Jcode, SPEG web, any tool)

FILES TO CREATE:

1. cacm/cacm-daemon/Cargo.toml:
   - depends on: cacm-core (path), tokio, axum (or warp), serde_json, tower-http (cors)
   - [[bin]] name: "cacm-daemon", path: "src/main.rs"

2. cacm/cacm-daemon/src/main.rs:
   - Parse CLI args: --port (default 9786), --jcode-home, --db-path
   - Initialize: start SessionWatcher, register parsers
   - Start HTTP server with WebSocket upgrade
   - Graceful shutdown on SIGTERM/SIGINT

3. cacm/cacm-daemon/src/server.rs:
   - WebSocket handler: upgrade, parse JSON frames, route to handlers
   - Request format: {"id": 1, "method": "cacm.query", "params": {...}}
   - Response format: {"id": 1, "result": {...}} or {"id": 1, "error": {...}}
   - Notification format: {"event": "cacm.session_activity", "data": {...}}
   - Request/reply correlation via pending HashMap

4. cacm/cacm-daemon/src/handlers.rs:
   - handle_query(params) → Vec<CrossAgentContext>
   - handle_sessions(params) → Vec<AgentSession>
   - handle_inject(params) → String (formatted context)
   - handle_ping() → "pong"

5. cacm/cacm-daemon/src/storage.rs:
   - Storage trait: store_context(), query_context(), list_sessions()
   - JcodeBackend: connects to Jcode daemon via harness API, stores in memory graph
   - SqliteBackend: fallback local storage if Jcode unavailable
   - Auto-select: try Jcode first, fall back to SQLite

API SPEC:

```
→ {"id":1,"method":"cacm.query","params":{"project":"/path/to/repo","limit":10}}
← {"id":1,"result":{"entries":[...]}}

→ {"id":2,"method":"cacm.sessions","params":{"project":"/path/to/repo"}}
← {"id":2,"result":{"sessions":[...]}}

→ {"id":3,"method":"cacm.inject","params":{"sessionId":"abc","agent":"claude-code"}}
← {"id":3,"result":{"formatted":"[Cross-Agent Context]\n• ..."}}

← {"event":"cacm.session_activity","data":{"agent":"jcode","session":"fox","turn":{...}}}
```

RESEARCH:

- Search: "axum websocket example Rust"
- Search: "warp vs axum Rust websocket performance"
- Search: "Rust JSON-RPC over websocket pattern"

VERIFICATION:

```bash
cd cacm && cargo build -p cacm-daemon
cargo test -p cacm-daemon
./target/debug/cacm-daemon --port 9787 &
# Test with websocat or node script
```

GIT COMMIT:

```bash
git add cacm/cacm-daemon/
git commit -m "feat(cacm): add cacm-daemon with WebSocket JSON-RPC API

- HTTP + WebSocket server using axum
- JSON-RPC style API: cacm.query, cacm.sessions, cacm.inject
- Jcode memory graph backend + SQLite fallback
- Session activity push notifications
- Graceful shutdown"
```

AFTER: Mark ✅, write report to research/report/1.2-cacm-daemon.md

```

---

## Task 1.5: Jcode Session Parser

```

TASK: Implement the Jcode session parser for cacm-core.

CONTEXT:

- Implements AgentSessionParser trait for AgentType::Jcode
- Parses Jcode session directories: ~/.jcode/sessions/<id>/
- Reads transcript JSONL files
- Reference: jcode/crates/jcode-session-types/src/ for message format
- Reference: jcode/crates/jcode-import-core/src/ for parsing patterns

FILES TO CREATE:

1. cacm/cacm-core/src/parsers/jcode.rs:
   - JcodeSessionParser struct implementing AgentSessionParser
   - agent_type() → AgentType::Jcode
   - parse_session_manifest(path) → reads session metadata, returns AgentSession
   - parse_turn(raw) → parses one JSONL line into AgentTurn
     - Extract: user message (role="user"), assistant response (role="assistant")
     - Extract: tool calls from message content blocks
     - Extract: file modifications from tool call results
   - detect_activity(path) → checks for new/modified transcript files

2. Register in parsers/mod.rs:
   - Add JcodeSessionParser to default ParserRegistry

3. cacm/cacm-core/tests/jcode_parser_test.rs:
   - Test with sample Jcode transcript JSONL
   - Test parsing user messages, assistant responses, tool calls
   - Test session manifest extraction
   - Test activity detection

4. Stub parsers (placeholder — Phase 2):
   - parsers/claude.rs — returns NotImplemented error
   - parsers/codex.rs — returns NotImplemented error
   - parsers/opencode.rs — returns NotImplemented error
   - parsers/cursor.rs — returns NotImplemented error

RESEARCH:

- Read jcode/crates/jcode-session-types/src/lib.rs for session format
- Read jcode/crates/jcode-message-types/src/lib.rs for Message type
- Search: "Rust serde JSONL streaming parser"

VERIFICATION:

```bash
cd cacm && cargo test -p cacm-core
```

GIT COMMIT:

```bash
git add cacm/cacm-core/src/parsers/
git commit -m "feat(cacm): add Jcode session parser with stub parsers

- JcodeSessionParser: parses transcript JSONL → AgentTurn
- Extracts user messages, assistant responses, tool calls
- Stub parsers for Claude Code, Codex, OpenCode, Cursor
- Registered in default ParserRegistry"
```

AFTER: Mark ✅, write report to research/report/1.3-jcode-parser.md

```

---

## Task 1.6: Context Extractor

```

TASK: Implement heuristic context extraction from AgentTurn data.

CONTEXT:

- Pure functions — receive AgentTurn, return extracted context
- MVP: template-based heuristics (no LLM dependency)
- Later: integrate with Jcode's sidecar model for LLM-based extraction
- Stores context in cacm-daemon's storage backend

FILES TO CREATE:

1. cacm/cacm-core/src/extractor.rs:
   - ContextExtractor struct
   - extract_context(turns: Vec<AgentTurn>) → Vec<CrossAgentContext>
   - Heuristic functions (pure, testable):
     - extract_task(turns): first user message = task description
       - Keywords: "I want to", "build", "create", "fix", "implement", "refactor"
     - extract_decisions(turns): messages containing decision keywords
       - Keywords: "decided", "chose", "going with", "will use", "using"
     - extract_file_changes(turns): parse tool calls for file paths
       - Patterns: "Modified:", "Created:", "Wrote to:", file extensions
     - extract_errors(turns): messages containing error keywords
       - Keywords: "error", "failed", "broke", "exception", "cannot"
     - extract_patterns(turns): repeated file patterns, convention mentions
       - Keywords: "always", "never", "convention", "best practice", "pattern"
   - Batching: accumulate turns, extract every 5 turns or at session end

2. cacm/cacm-core/tests/extractor_test.rs:
   - Test each heuristic with sample turns
   - Test batching behavior
   - Test edge cases (empty turns, single turn, malformed data)

RESEARCH:

- Search: "keyword extraction algorithm Rust"
- Search: "regex file path extraction"
- Read jcode/crates/jcode-base/src/sidecar.rs for LLM integration pattern (future)

VERIFICATION:

```bash
cd cacm && cargo test -p cacm-core
```

GIT COMMIT:

```bash
git add cacm/cacm-core/src/extractor.rs cacm/cacm-core/tests/
git commit -m "feat(cacm): add heuristic context extractor

- Pure extraction functions: tasks, decisions, files, errors, patterns
- Keyword-based heuristics (MVP — LLM upgrade path defined)
- Batched extraction (every 5 turns or session end)
- Unit tests for each heuristic and edge cases"
```

AFTER: Mark ✅, write report to research/report/1.4-extractor.md

```

---

## Task 1.7: Context Injector

```

TASK: Implement context injection — query memory, rank, format for target agent.

CONTEXT:

- Query cacm-daemon storage for recent cross-agent context
- Rank by recency × relevance × confidence
- Format per target agent type
- Return formatted string for injection

FILES TO CREATE:

1. cacm/cacm-core/src/injector.rs:
   - ContextInjector struct
   - inject(project: &str, target_agent: AgentType, session_id: Option<&str>) → String
   - query_context(project: &str, limit: usize) → Vec<CrossAgentContext>
   - rank_context(entries: Vec<CrossAgentContext>) → Vec<CrossAgentContext>:
     - recency_score = e^(-hours_ago / 24.0)
     - final_score = recency_score × 0.5 + relevance × 0.3 + confidence × 0.2
     - Sort descending, take top N
   - format_context(entries: Vec<CrossAgentContext>, target: AgentType) → String:
     - Speg/Jcode: "[Cross-Agent Context]\n• Task: ... (agent, time_ago)\n..."
     - ClaudeCode: append format for CLAUDE.md
     - Codex: prepend format for first user message
     - OpenCode: append format for OPENCODE.md
     - Cursor: append format for .cursorrules
   - Budget: max 2000 chars, truncate lowest-ranked if over

2. cacm/cacm-core/tests/injector_test.rs:
   - Test ranking algorithm with known scores
   - Test formatting for each agent type
   - Test truncation when over budget
   - Test empty context (no entries found)

RESEARCH:

- Search: "exponential decay ranking algorithm"
- Read how Jcode formats system reminders in jcode-app-core/src/agent/prompting.rs

VERIFICATION:

```bash
cd cacm && cargo test -p cacm-core
```

GIT COMMIT:

```bash
git add cacm/cacm-core/src/injector.rs cacm/cacm-core/tests/
git commit -m "feat(cacm): add context injector with cross-agent formatting

- Weighted ranking: recency×0.5 + relevance×0.3 + confidence×0.2
- Per-agent formatters: Speg, Claude Code, Codex, OpenCode, Cursor
- 2000-char budget with truncation
- Unit tests for ranking, formatting, edge cases"
```

AFTER: Mark ✅, write report to research/report/1.5-injector.md

```

---

## Task 1.8: cacm-sdk-rs + jcode-cacm-bridge

```

TASK: Build the Rust SDK for CACM and the thin Jcode bridge crate.

CONTEXT:

- cacm-sdk-rs: Rust client library that talks to cacm-daemon via WebSocket
- jcode-cacm-bridge: thin Jcode crate that imports cacm-sdk-rs and registers CACM tools
- Jcode stays VANILLA — only the bridge crate is added to Jcode workspace
- Zero modifications to jcode-app-core, jcode-harness-api, or any existing Jcode crate

FILES TO CREATE:

1. cacm/cacm-sdk-rs/Cargo.toml:
   - name: "cacm-sdk-rs", depends on: tokio, tokio-tungstenite, serde_json, cacm-core

2. cacm/cacm-sdk-rs/src/lib.rs:
   - CacmClient struct: connect(addr), query(project, limit), sessions(project), inject(project, agent, session)
   - WebSocket connection to cacm-daemon
   - Request/reply correlation
   - Reconnect with exponential backoff
   - Public API: async fn query(...), async fn sessions(...), async fn inject(...)

3. jcode/crates/jcode-cacm-bridge/Cargo.toml:
   - depends on: cacm-sdk-rs (path), jcode-app-core, jcode-base, jcode-tool-core
   - description: "Thin bridge registering CACM as Jcode tools"

4. jcode/crates/jcode-cacm-bridge/src/lib.rs:
   - register_cacm_tools(registry: &mut Registry):
     - CacmQueryTool: implements Tool trait, calls cacm-sdk-rs query()
     - CacmInjectTool: implements Tool trait, calls cacm-sdk-rs inject()
   - init_cacm_hook(): registers turn_start hook via jcode-base::hooks
     - Before each turn: call cacm-sdk-rs inject() → set system_reminder
   - ~200 lines total

5. jcode/Cargo.toml: add "crates/jcode-cacm-bridge" to workspace members

6. jcode/src/cli/startup.rs or equivalent: call register_cacm_tools() + init_cacm_hook()
   - Find the right init point — research Jcode's startup sequence

RESEARCH:

- Read jcode-app-core/src/tool/mod.rs to understand Registry::base_tools() pattern
- Read jcode-base/src/hooks.rs for turn_start hook registration
- Read jcode/src/main.rs or cli/startup.rs for initialization sequence
- Search: "Rust tungstenite websocket client example"

VERIFICATION:

```bash
# Build cacm-sdk-rs
cd cacm && cargo build -p cacm-sdk-rs

# Build Jcode with bridge
cd jcode && cargo build --workspace
cargo test -p jcode-cacm-bridge

# Verify CACM tools appear in Jcode
./target/debug/jcode --list-tools | grep cacm
```

GIT COMMIT:

```bash
git add cacm/cacm-sdk-rs/ jcode/crates/jcode-cacm-bridge/ jcode/Cargo.toml
git commit -m "feat(cacm): add cacm-sdk-rs and jcode-cacm-bridge

- cacm-sdk-rs: Rust client for cacm-daemon (WebSocket)
- jcode-cacm-bridge: thin crate registering CACM tools in Jcode
- CacmQueryTool + CacmInjectTool registered in Jcode tool registry
- turn_start hook for automatic context injection
- Zero modifications to existing Jcode crates"
```

AFTER: Mark ✅, write report to research/report/1.6-sdk-bridge.md

```

---

## Task 1.9: cacm-sdk-ts (@cacm/sdk)

```

TASK: Build the TypeScript SDK for CACM — npm package @cacm/sdk.

CONTEXT:

- TypeScript client that talks to cacm-daemon via WebSocket
- Used by speg-web and any Node.js tool
- Published as npm package (or workspace package for now)
- Zero dependencies beyond the platform (use native WebSocket)

FILES TO CREATE:

1. cacm/cacm-sdk-ts/package.json:
   - name: "@cacm/sdk", version: "0.1.0", type: "module"
   - main: "./dist/index.js", types: "./dist/index.d.ts"
   - scripts: { build, typecheck, test }

2. cacm/cacm-sdk-ts/tsconfig.json

3. cacm/cacm-sdk-ts/src/index.ts — public API exports

4. cacm/cacm-sdk-ts/src/types.ts:
   - TypeScript types matching cacm-core Rust types
   - AgentType, AgentSession, AgentTurn, CrossAgentContext, ContextType
   - CacmQueryParams, CacmQueryResult, CacmSessionResult, CacmInjectResult

5. cacm/cacm-sdk-ts/src/client.ts:
   - CacmClient class:
     - constructor(url: string = "ws://localhost:9786")
     - connect(): Promise<void> — open WebSocket, await ready
     - query(params): Promise<CacmQueryResult>
     - sessions(params): Promise<CacmSessionResult>
     - inject(params): Promise<CacmInjectResult>
     - onActivity(callback): void — listen for push notifications
     - close(): void
   - Request/reply correlation via pending Map
   - Auto-reconnect with exponential backoff

6. cacm/cacm-sdk-ts/test/client.test.ts:
   - Mock WebSocket for unit tests
   - Test query, sessions, inject
   - Test reconnect behavior

RESEARCH:

- Search: "TypeScript WebSocket client class pattern"
- Read existing Jcode harness API client pattern for inspiration

VERIFICATION:

```bash
cd cacm/cacm-sdk-ts
npm install
npm run typecheck
npm test
```

GIT COMMIT:

```bash
git add cacm/cacm-sdk-ts/
git commit -m "feat(cacm): add cacm-sdk-ts TypeScript client

- @cacm/sdk npm package
- CacmClient: connect, query, sessions, inject, activity events
- TypeScript types matching cacm-core Rust types
- Auto-reconnect with exponential backoff
- Unit tests with mock WebSocket"
```

AFTER: Mark ✅, write report to research/report/1.7-cacm-sdk-ts.md

```

---

## Task 1.10: SPEG Web UI

```

TASK: Build the SPEG web UI — React app that imports @cacm/sdk.

CONTEXT:

- React + Vite + Tailwind (follow T3 Code web patterns where applicable)
- Connects to cacm-daemon via @cacm/sdk
- Connects to Jcode daemon via harness API for chat
- Minimal components — keep it simple, production quality

FILES TO CREATE:

1. speg-web/package.json:
   - React 19, Vite, Tailwind, @cacm/sdk (workspace:\*)
   - react-router for routing

2. speg-web/src/client.ts:
   - Jcode harness API client (talk to Jcode daemon for chat)
   - Reuse or adapt speg/src/jcode/client.ts patterns if already built
   - OR use @1jehuang/jcode-sdk directly (already installed in speg/)

3. speg-web/src/components/ChatView.tsx:
   - Message timeline (virtualized list)
   - Composer bar (text input + send)
   - Agent status indicator
   - Provider/model selector

4. speg-web/src/components/CacmTimeline.tsx:
   - Cross-agent session timeline
   - Shows recent sessions from all agents (via @cacm/sdk)
   - Color-coded by agent type
   - Click to view session details

5. speg-web/src/components/ProviderPicker.tsx:
   - Model/provider selector (uses Jcode's listModels API)

6. speg-web/src/routes/ — React Router routes
   - /chat — main chat view
   - /cacm — cross-agent timeline
   - /settings — settings

7. speg-web/src/App.tsx — root component, router setup

RESEARCH:

- Search: "React virtualized message list"
- Read T3 Code apps/web/src for component patterns (ChatView, composer)
- Keep components SIMPLE — no 6189-line monsters

VERIFICATION:

```bash
cd speg-web
npm install
npm run typecheck
npm run build
npm run dev  # verify UI renders
```

GIT COMMIT:

```bash
git add speg-web/
git commit -m "feat(speg): add SPEG web UI with chat and CACM timeline

- React + Vite + Tailwind web app
- ChatView with message timeline and composer
- CacmTimeline showing cross-agent sessions via @cacm/sdk
- Provider/model picker
- Minimal components, production quality"
```

AFTER: Mark ✅, write report to research/report/1.8-speg-web.md

```

---

## Task 1.11: Compactor

```

TASK: Implement cross-session context compaction.

CONTEXT:

- Runs during cacm-daemon's ambient cycles (or on-demand)
- Deduplicates similar entries from different agents
- Summarizes multi-turn sessions into milestone entries
- Links related entries in the memory graph

FILES TO CREATE:

1. cacm/cacm-core/src/compactor.rs:
   - Compactor struct
   - compact(entries: Vec<CrossAgentContext>) → Vec<CrossAgentContext>
   - Deduplication:
     - Group entries by file_path or decision content
     - Keep highest-confidence entry, merge metadata
     - Mark superseded entries
   - Summarization:
     - Group entries by session
     - Generate milestone summary (task + outcome)
     - Replace detailed entries with summary
   - Linking:
     - Find entries about same topic across agents
     - Add related_to metadata
   - Staleness:
     - Apply confidence decay to entries older than threshold
     - Prune entries below confidence threshold

2. cacm/cacm-core/tests/compactor_test.rs:
   - Test deduplication: 3 entries about same file → 1 merged entry
   - Test summarization: 10 turn-level entries → 1 milestone entry
   - Test staleness pruning
   - Test empty input

RESEARCH:

- Search: "text deduplication algorithm Rust"
- Search: "confidence decay formula"
- Read jcode-base/src/memory/ for consolidation patterns

VERIFICATION:

```bash
cd cacm && cargo test -p cacm-core
```

GIT COMMIT:

```bash
git add cacm/cacm-core/src/compactor.rs cacm/cacm-core/tests/
git commit -m "feat(cacm): add cross-session context compactor

- Deduplicates entries from different agents
- Summarizes multi-turn sessions into milestones
- Links related entries across agents
- Confidence decay and staleness pruning
- Unit tests for all operations"
```

AFTER: Mark ✅, write report to research/report/1.9-compactor.md

```

---

## Task 1.12: Phase 1 Integration Gate

```

TASK: End-to-end verification. All builds pass, all tests pass, Windows .exe produced.

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

4. TypeScript build:
   cd cacm/cacm-sdk-ts && npm run typecheck && npm test
   cd speg-web && npm run typecheck && npm run build

5. Integration test:
   - Start cacm-daemon
   - Start Jcode daemon (jcode serve + jcode api-bridge)
   - Start speg-web dev server
   - Verify: chat works, CACM timeline populated

6. Windows build:
   - Build speg-desktop Electron app
   - Bundle cacm-daemon + jcode binaries
   - Produce Windows .exe

7. Git tag:
   git tag -a speg-v0.1.0-phase1 -m "SPEG Phase 1 complete"

EXIT CRITERIA:

- [ ] cargo build --workspace (both cacm + jcode) → PASS
- [ ] cargo test --workspace → all pass
- [ ] cargo clippy → no warnings
- [ ] cargo fmt --check → clean
- [ ] cacm-sdk-ts: typecheck + tests → PASS
- [ ] speg-web: typecheck + build → PASS
- [ ] cacm-daemon starts and responds to WebSocket queries
- [ ] Jcode builds with cacm-bridge, CACM tools visible
- [ ] Windows .exe produced
- [ ] Git tag created

AFTER: Write report to research/report/1.12-phase1-complete.md
Mark Phase 1 as complete. Ready for Phase 2.

```

---

## Task 1.13: CACM Daemon WebSocket Protocol Types

```

TASK: Define TypeScript types for the CACM daemon WebSocket protocol.

CONTEXT:

- CACM daemon (1.4) uses a simple JSON WebSocket protocol, NOT Effect RPC
- These types are for cacm-sdk-ts to use when talking to cacm-daemon
- Must mirror the Rust types in cacm-core/src/types.rs exactly
- Separate from the Effect/Schema contracts in 1.2 (for SPEG web ↔ T3 Code server)

FILES TO CREATE:

1. cacm/cacm-sdk-ts/src/types.ts:
   - AgentType: "jcode" | "claude-code" | "codex" | "opencode" | "cursor" | "speg"
   - AgentSession, AgentTurn, CrossAgentContext, ContextType
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

AFTER: Mark ✅, write report to research/report/1.13-protocol-types.md

```

---

## Task 1.14: Wire Contracts Barrel Export

```

TASK: Wire the SPEG contracts barrel into the @t3tools/contracts package entry.

CONTEXT:

- Task 1.2 created SPEG contracts but intentionally did NOT export them from the package
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

AFTER: Mark ✅, write report to research/report/1.14-barrel-export.md

```

```
