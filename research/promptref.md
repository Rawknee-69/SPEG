# SPEG — Prompt Reference

> **Copy-paste prompts** for every task. Each prompt is self-contained — an agent can read it and start working immediately.
> After completing a task: run all tests → git commit → mark checklist ✅

---

## Task 1.1: Package Scaffolding

````
TASK: Create the @speg/core package scaffold inside the T3 Code monorepo.

CONTEXT:
- You are working in the T3 Code monorepo at the current workspace root
- The repo uses pnpm workspaces with catalog versioning
- Package naming: @speg/core (NOT @t3tools — this is a new project)
- Subpath-only exports (no barrel index.ts — follow @t3tools/shared pattern)

FILES TO CREATE:
1. speg/package.json — new package manifest:
   - name: "@speg/core"
   - version: "0.1.0"
   - type: "module"
   - exports: { "./jcode": "./src/jcode/index.ts", "./cacm": "./src/cacm/index.ts", ... }
   - dependencies: "effect": "catalog:", "@1jehuang/jcode-sdk": "^0.67.0", "@t3tools/contracts": "workspace:*", "@t3tools/shared": "workspace:*"
   - devDependencies: "@effect/vitest": "catalog:", "vite-plus": "catalog:", "typescript": "catalog:"

2. speg/tsconfig.json:
   - extends: "../../tsconfig.base.json"
   - compilerOptions: { outDir: "./dist", rootDir: "./src" }
   - include: ["src/**/*.ts"]

3. speg/src/index.ts — empty entry (add exports as we build)

4. speg/src/jcode/index.ts — placeholder: export {}

5. speg/src/cacm/index.ts — placeholder: export {}

6. Update pnpm-workspace.yaml: add "speg" to packages array

STYLE REQUIREMENTS (from research/08-style-guide.md and AGENTS.md):
- ALL imports use .ts extension on relative paths
- import type for type-only imports
- NEVER use any — determine true types
- Minimal code: if 5 lines do what 20 do, use 5

VERIFICATION:
```bash
vp i                                    # Install dependencies
vp run --filter @speg/core typecheck   # Must pass
````

GIT COMMIT (only after verification passes):

```bash
git add -A
git commit -m "feat(speg): scaffold @speg/core package

- Create speg/ package with workspace config
- Add dependencies: effect, jcode-sdk, contracts, shared
- Configure TypeScript with strict mode"
```

AFTER COMMIT: Mark task 1.1 as ✅ in .plans/SPEG-CHECKLIST.md
WRITE REPORT to research/report/1.1-scaffolding.md

```

---

## Task 1.2: SPEG Contracts

```

TASK: Define all SPEG wire types using Effect/Schema in packages/contracts/src/speg/.

CONTEXT:

- Follow EXACT patterns from packages/contracts/src/baseSchemas.ts (branded IDs)
- Follow EXACT patterns from packages/contracts/src/rpc.ts (RPC definitions)
- All types must have encode/decode roundtrip tests
- Use Schema.Struct, Schema.Union, Schema.Literal — never hand-written types
- Existing T3 Code contracts MUST NOT be modified — only new files added

FILES TO CREATE:

1. packages/contracts/src/speg/spegBaseSchemas.ts:
   - Branded IDs: SpegSessionId, SpegMemoryId, SpegContextId
   - Follow makeEntityId pattern from baseSchemas.ts
   - Export both Schema and Type

2. packages/contracts/src/speg/spegSession.ts:
   - AgentSessionDescriptor: { sessionId, agentType, status, path, metadata }
   - SessionStatus: "active" | "idle" | "completed" | "failed"
   - AgentType: "jcode" | "claude-code" | "codex" | "opencode" | "cursor" | "speg"

3. packages/contracts/src/speg/spegContext.ts:
   - CrossAgentContext: { id, sessionId, agentType, contentType, content, filePaths, decisions, errors, timestamp }
   - ContextType: "task" | "decision" | "file-change" | "error" | "pattern"
   - ContextQuery: { projectPath, limit, recencyHours, agentTypes }

4. packages/contracts/src/speg/spegMemory.ts:
   - MemoryQueryParams: { query, limit, threshold, tags, scope }
   - MemorySearchResult: { entries, totalCount, searchTimeMs }
   - MemoryEntrySummary: { id, content, memoryType, confidence, tags, source }

5. packages/contracts/src/speg/spegChat.ts:
   - SpegChatMessage: { role, content, timestamp, metadata }
   - SpegTurnRequest: { sessionId, message, modelSelection, skills }
   - SpegTurnResponse: { turnId, messages, toolCalls, usage }

6. packages/contracts/src/speg/spegRpc.ts:
   - RPC methods using Rpc.make() pattern:
     - speg.chat.sendMessage: SpegTurnRequest → SpegTurnResponse
     - speg.chat.subscribe: () → Stream<SpegChatEvent>
     - speg.cacm.queryContext: ContextQuery → MemorySearchResult
     - speg.cacm.listSessions: () → AgentSessionDescriptor[]
     - speg.cacm.injectContext: { sessionId, targetAgent } → void
   - Add to WsRpcGroup (or create SpegRpcGroup — research if separate group is cleaner)

7. packages/contracts/src/speg/index.ts — re-export all

8. packages/contracts/test/speg/contracts.test.ts:
   - Roundtrip tests for EVERY schema
   - Test encode → decode for each type
   - Test invalid input rejection

RESEARCH BEFORE IMPLEMENTING:

- Read packages/contracts/src/baseSchemas.ts to understand branded ID pattern
- Read packages/contracts/src/rpc.ts to understand RPC registration pattern
- Search: "Effect Schema branded types best practices"

VERIFICATION:

```bash
vp run --filter @t3tools/contracts typecheck
vp run test packages/contracts/test/speg/contracts.test.ts
```

GIT COMMIT:

```bash
git add -A
git commit -m "feat(speg): define wire contracts for cross-agent platform

- Branded IDs: SpegSessionId, SpegMemoryId, SpegContextId
- Agent session, context, memory, chat schemas
- RPC method definitions for SPEG chat and CACM
- Full encode/decode roundtrip tests"
```

AFTER: Mark ✅ in checklist. Write report to research/report/1.2-contracts.md

```

---

## Task 1.3: Jcode Harness API Client (Build from Source)

```

TASK: Build our own TypeScript client that speaks the Jcode harness API protocol.
NO external SDK dependency. We write the client from scratch against the protocol spec.

CONTEXT:

- Jcode uses a simple NDJSON protocol over a local socket
- Protocol is defined in jcode/crates/jcode-harness-api/src/ (Rust types)
- 31 request types, 30 event types — we implement the ones we need
- Transport: Unix socket (Linux/macOS) or Windows named pipe
- We build Jcode from source: jcode/ directory is already in the repo
- Run Jcode: spawn `jcode serve` (daemon) + `jcode api-bridge` (API access)

REFERENCE FILES (read these first):

- jcode/crates/jcode-harness-api/src/lib.rs — protocol types, version constants
- jcode/crates/jcode-harness-api/src/requests.rs — all 31 request types
- jcode/crates/jcode-harness-api/src/events.rs — all 30 event types
- jcode/crates/jcode-harness-api/src/sockets.rs — socket path resolution
- jcode/crates/jcode-transport/src/unix.rs — Unix socket implementation
- jcode/crates/jcode-transport/src/windows.rs — Windows named pipe implementation

PROTOCOL SPEC:

- Framing: NDJSON — one JSON object per line, '\n' delimited, blank lines skipped
- Every frame: {"v": 1, ...} (protocol version)
- Client → Server: {"v":1, "id":<monotonic>, "req":"<kind>", ...params}\n
- Server → Client (reply): {"v":1, "reply_to":<id>, "ev":"<kind>", ...data}\n
- Server → Client (streaming): {"v":1, "ev":"<kind>", "session_id":"...", ...data}\n
- Max frame size: 16 MiB

SOCKET PATH:

- Env override: $JCODE_API_SOCKET
- Default: $JCODE_RUNTIME_DIR/jcode-api.sock or $XDG_RUNTIME_DIR/jcode-api.sock
- Fallback: $TMPDIR/jcode-<user>/jcode-api.sock
- Windows: named pipe derived via SHA256 of path stem

HANDSHAKE:
Client: {"v":1,"id":1,"req":"hello","min_version":1,"max_version":1,"client":"speg/0.1"}
Server: {"v":1,"reply_to":1,"ev":"hello_ok","version":1,"server":"...","capabilities":[...]}

FILES TO CREATE:

1. speg/src/jcode/protocol.ts:
   - TypeScript types matching jcode-harness-api exactly
   - ApiRequest union: all 31 request kinds
   - ApiEvent union: all 30 event kinds
   - Frame types: ClientFrame, ServerFrame
   - Version constants: API_VERSION = 1
   - Helper: isKnownEvent(), isKnownRequest()
   - Reference every field from the Rust source — no guessing

2. speg/src/jcode/framing.ts:
   - NdjsonEncoder: serialize frame → JSON line
   - NdjsonDecoder: incremental line-by-line decoder
   - Handle partial lines (buffer remainder)
   - Skip blank lines
   - Enforce 16 MiB max frame size
   - Pure functions, no dependencies

3. speg/src/jcode/sockets.ts:
   - resolveApiSocketPath(): platform-specific path resolution
   - Unix: read $JCODE_API_SOCKET or compute default path
   - Windows: compute named pipe path from socket path stem
   - Reference jcode-transport for exact logic

4. speg/src/jcode/client.ts:
   - JcodeClient class:
     - constructor(socketPath): connect to api-bridge
     - connect(): open socket, send hello, await hello_ok
     - request(req): send request, await correlated reply
     - events(sessionId?): async iterator over streaming events
     - close(): close socket
   - Request/reply correlation via pending Map<id, Deferred>
   - Event routing: events with reply_to → resolve pending; without → streaming iterator
   - Auto-reconnect with exponential backoff (1s → 16s cap)
   - High-level methods mirroring protocol:
     - createSession(workingDir) → session info
     - sendMessage(id, content, opts?) → void
     - run(id, content, opts?) → collected turn
     - cancel(id) / softInterrupt(id, msg) → void
     - listModels(id) / setModel(id, model) → models
     - getHistory(id) / peekSession(id, limit?) → messages
     - listSessions() → session list
     - ping() → boolean

5. speg/src/jcode/launch.ts:
   - launchJcodeDaemon(opts): spawn `jcode serve` as child process
   - Build Jcode first: run `cargo build --release` in jcode/ dir
   - Find binary: jcode/target/release/jcode
   - Wait for daemon socket to appear (poll with timeout)
   - launchApiBridge(): spawn `jcode api-bridge` after daemon ready
   - Health check: ping the bridge
   - Shutdown: kill processes gracefully (SIGTERM → SIGKILL after timeout)
   - Platform: Unix uses setsid() to detach, Windows uses CREATE_NEW_PROCESS_GROUP

6. speg/src/jcode/Errors.ts:
   - JcodeNotFoundError: { searchedPaths: string[] }
   - JcodeBuildError: { reason: string, stderr: string }
   - JcodeLaunchError: { reason: string }
   - ProtocolError: { code: string, message: string }
   - ConnectionError: { socketPath: string, reason: string }
   - All extend Schema.TaggedErrorClass

7. speg/src/jcode/Services/JcodeService.ts:
   - Effect service wrapping JcodeClient lifecycle
   - Shape: launch, healthCheck, shutdown, createSession, sendMessage, streamEvents
   - Service tag: "speg/jcode/JcodeService"

8. speg/src/jcode/Layers/JcodeServiceLive.ts:
   - Layer.effect(JcodeService, ...)
   - Launch Jcode daemon + api-bridge on startup
   - Health check periodically (every 30s)
   - Graceful shutdown on server stop
   - Fork-parked behind ServerActivation

9. speg/test/jcode/protocol.test.ts:
   - Test frame encode/decode roundtrip
   - Test all request types serialize correctly
   - Test all event types deserialize correctly
   - Test NDJSON decoder handles partial lines
   - Test unknown event kinds don't crash

10. speg/test/jcode/client.test.ts:
    - Mock Unix socket for unit tests
    - Test handshake flow
    - Test request/reply correlation
    - Test streaming events
    - Test reconnect behavior
    - Test error handling (connection refused, timeout)

RESEARCH:

- Read ALL files in jcode/crates/jcode-harness-api/src/
- Read jcode/crates/jcode-transport/src/unix.rs for socket details
- Read jcode/crates/jcode-transport/src/windows.rs for named pipe details
- Search: "Node.js Unix domain socket client"
- Search: "Windows named pipe Node.js"
- Search: "NDJSON streaming parser TypeScript"

VERIFICATION:

```bash
vp run --filter @speg/core typecheck
vp run test speg/test/jcode/protocol.test.ts
vp run test speg/test/jcode/client.test.ts

# Integration test (requires Jcode built):
cd jcode && cargo build --release
cd .. && node -e "
  const { JcodeClient } = require('./speg/dist/jcode/client.js');
  // ... test full flow
"
```

GIT COMMIT:

```bash
git add -A
git commit -m "feat(speg): build Jcode harness API client from protocol spec

- TypeScript types matching jcode-harness-api Rust crate exactly
- NDJSON encoder/decoder with incremental parsing
- Platform socket resolution (Unix + Windows named pipe)
- JcodeClient: connect, request/reply, streaming events, reconnect
- Jcode daemon + api-bridge lifecycle management
- Effect service wrapper with health checks and graceful shutdown
- Zero external SDK dependencies — pure protocol implementation
- Unit tests with mock socket; integration test with real Jcode"
```

AFTER: Mark ✅ in checklist. Write report to research/report/1.3-jcode-client.md

```

---

## Task 1.4: CACM Session Watcher

```

TASK: Build a cross-platform filesystem watcher that monitors agent session directories.

CONTEXT:

- CACM = Cross-Agent Context Manager
- Watch multiple agent session directories for new activity
- Parse each agent's session format into canonical AgentTurn
- Emit SessionActivity events via PubSub
- Use chokidar (NOT fs.watch — buggy on Windows)
- Pluggable parser interface for different agent types

FILES TO CREATE:

1. speg/src/cacm/Errors.ts:
   - SessionWatchError: { path: string, reason: string }
   - SessionParseError: { sessionPath: string, agentType: string, reason: string }
   - ParserNotFoundError: { agentType: string }

2. speg/src/cacm/AgentSessionParser.ts:
   - Interface: { readonly agentType: AgentType; readonly parseSessionManifest: (path) => SessionManifest; readonly parseTurn: (raw) => AgentTurn; readonly detectActivity: (path) => boolean }
   - SessionManifest: { sessionId, agentType, createdAt, turns: number, status }

3. speg/src/cacm/parsers/JcodeSessionParser.ts:
   - Implements AgentSessionParser for agentType: "jcode"
   - Parse ~/.jcode/sessions/<id>/transcript.jsonl (NDJSON)
   - Each line = one JSON object (Message type from jcode-message-types)
   - Extract: user messages, assistant responses, tool calls
   - Canonical AgentTurn: { turnIndex, timestamp, userMessage, assistantResponse, toolCalls, fileModifications }

4. speg/src/cacm/parsers/ClaudeCodeParser.ts (STUB):
   - Implement AgentSessionParser interface
   - Throw ParserNotFoundError with message "Claude Code parser — Phase 2"

5. speg/src/cacm/parsers/CodexParser.ts (STUB): same pattern

6. speg/src/cacm/parsers/OpenCodeParser.ts (STUB): same pattern

7. speg/src/cacm/parsers/CursorParser.ts (STUB): same pattern

8. speg/src/cacm/Services/SessionWatcher.ts:
   - Shape: { readonly watch: (projectPath) => Effect<void>; readonly streamActivity: Stream<SessionActivity>; readonly registerParser: (parser) => Effect<void> }
   - SessionActivity: { sessionId, agentType, eventType: "started"|"turn"|"ended", turn?, timestamp }
   - Service tag: "speg/cacm/SessionWatcher"

9. speg/src/cacm/Layers/SessionWatcherLive.ts:
   - Use chokidar.watch() for each agent directory
   - Platform-specific paths:
     - Windows: %LOCALAPPDATA%\jcode\sessions\, %USERPROFILE%\.claude\projects\
     - Unix: ~/.jcode/sessions/, ~/.claude/projects/
   - On file change → detect new activity → parse → publish to PubSub
   - Debounce: 500ms (don't emit on every write)
   - Register default parsers on init (Jcode parser + stubs)

10. speg/test/cacm/SessionWatcher.test.ts:
    - Create mock session directories with sample JSONL
    - Test watch detects new files
    - Test Jcode parser extracts correct turns
    - Test PubSub subscribers receive events
    - Test stub parsers throw ParserNotFoundError
    - Test debounce behavior

11. speg/src/cacm/index.ts — export all

RESEARCH:

- Search: "chokidar vs fs.watch Windows reliability"
- Search: "best way to watch multiple directories Node.js"
- Read Jcode transcript.jsonl format (sample in ~/.jcode/sessions/ if available)
- Search: "NDJSON parsing streaming Node.js"

VERIFICATION:

```bash
vp run --filter @speg/core typecheck
vp run test speg/test/cacm/SessionWatcher.test.ts
```

GIT COMMIT:

```bash
git add -A
git commit -m "feat(speg): add CACM session watcher with Jcode parser

- Cross-platform fs watcher using chokidar
- Pluggable agent session parser interface
- Jcode JSONL parser: extracts turns from transcript
- Stub parsers for Claude Code, Codex, OpenCode, Cursor
- PubSub-based activity streaming
- Platform-specific watch paths (Windows/Unix)
- Unit tests with mock filesystem"
```

AFTER: Mark ✅ in checklist. Write report to research/report/1.4-session-watcher.md

```

---

## Task 1.5: CACM Context Extractor

```

TASK: Extract context from agent turns and store in Jcode memory graph.

CONTEXT:

- Subscribe to SessionWatcher's activity stream
- For each new turn, extract key context
- Batch turns within a session (every 5 turns or at session end)
- MVP: template-based heuristics (no LLM dependency yet)
- Store extracted context in Jcode memory graph via JcodeMemoryAccess
- Use KeyedCoalescingWorker from @t3tools/shared for per-session batching

FILES TO CREATE:

1. speg/src/cacm/ExtractionHeuristics.ts:
   - extractTaskDescription(turn): string | null
     - First user message in session = task description
     - Look for: "I want to", "I need to", "Help me", "Build", "Create", "Fix"
   - extractDecisions(turn): string[]
     - Messages containing: "decided", "chose", "going with", "will use", "using"
     - Assistant response that states a choice or approach
   - extractFileChanges(turn): string[]
     - Parse tool call output for file paths
     - Common patterns: "Modified:", "Created:", "Wrote to:", file extensions
   - extractErrors(turn): string[]
     - Messages containing: "error", "failed", "broke", "exception", "cannot"
     - Tool call errors
   - extractPatterns(turn): string[]
     - Repeated file patterns
     - Convention mentions: "always", "never", "convention", "best practice"
   - ALL functions are PURE (no side effects) — return extracted data, don't store

2. speg/src/cacm/Services/ContextExtractor.ts:
   - Shape: { readonly start: () => Effect<void>; readonly extractFromTurn: (turn) => Effect<ContextExtractResult> }
   - ContextExtractResult: { contexts: CrossAgentContext[] }
   - Service tag: "speg/cacm/ContextExtractor"

3. speg/src/cacm/Layers/ContextExtractorLive.ts:
   - Subscribe to SessionWatcher.streamActivity via Stream.runForEach
   - On each turn: call ExtractionHeuristics → produce CrossAgentContext entries
   - Batch: accumulate turns per session, extract at threshold (5 turns) or session end
   - Use KeyedCoalescingWorker keyed by sessionId for batching
   - Store entries via JcodeMemoryAccess.store()
   - Each entry gets: provenance: "Observed", source: { agent, sessionId, turnIndex }
   - Handle errors gracefully: log warning, continue (don't crash on one bad parse)

4. speg/test/cacm/ContextExtractor.test.ts:
   - Test each extraction heuristic with sample turns
   - Test batching behavior (extracts at threshold)
   - Test storage via mock JcodeMemoryAccess
   - Test error resilience (bad turn data doesn't crash)

RESEARCH:

- Search: "NLP keyword extraction JavaScript without ML"
- Search: "extract file paths from text regex"
- Read @t3tools/shared KeyedCoalescingWorker pattern
- Read Jcode MemoryEntry schema from research/06-jcode-internals.md

VERIFICATION:

```bash
vp run --filter @speg/core typecheck
vp run test speg/test/cacm/ContextExtractor.test.ts
```

GIT COMMIT:

```bash
git add -A
git commit -m "feat(speg): add CACM context extractor with heuristics

- Template-based extraction: tasks, decisions, files, errors, patterns
- Batched extraction per session (every 5 turns or session end)
- KeyedCoalescingWorker for per-session batching
- Stores in Jcode memory graph with Observed provenance
- Pure extraction functions — testable independently
- Error-resilient: bad turns logged, processing continues"
```

AFTER: Mark ✅ in checklist. Write report to research/report/1.5-context-extractor.md

```

---

## Task 1.6: CACM Context Injector

```

TASK: Query memory graph, format context, inject into new agent sessions.

CONTEXT:

- When user starts a new session with any agent, inject relevant context
- Query Jcode memory graph for recent activity in the project
- Rank by recency × relevance × confidence
- Format per target agent type
- Inject via appropriate mechanism per agent

FILES TO CREATE:

1. speg/src/cacm/InjectionFormatters.ts:
   - formatForSpeg(contexts: CrossAgentContext[]): string
     - Format: bullet list with agent name + time ago
     - Template: "[Cross-Agent Context]\n• Task: {content} ({agent}, {timeAgo})\n..."
     - Max 2000 chars (~500 tokens)
   - formatForClaudeCode(contexts): string
     - Append format for CLAUDE.md: "\n\n[SPEG Context — recent cross-agent activity]\n..."
   - formatForCodex(contexts): string
     - Prepend to first user message: "Context from recent sessions:\n..."
   - formatForOpenCode(contexts): string
     - Append format for OPENCODE.md
   - formatForCursor(contexts): string
     - Append format for .cursorrules
   - Truncate if over budget: drop lowest-ranked entries

2. speg/src/cacm/Services/ContextInjector.ts:
   - Shape: { readonly injectContext: (target: InjectionTarget) => Effect<void>; readonly queryContext: (project) => Effect<CrossAgentContext[]> }
   - InjectionTarget: { projectPath, targetAgent, sessionId? }
   - Service tag: "speg/cacm/ContextInjector"

3. speg/src/cacm/Layers/ContextInjectorLive.ts:
   - queryContext: calls JcodeMemoryAccess.search() with project context
   - Ranking algorithm:
     - recencyScore = e^(-hoursAgo / 24) — exponential decay over 24h
     - relevanceScore = from Jcode's cosine similarity
     - confidenceScore = from MemoryEntry.confidence
     - finalScore = recencyScore × 0.5 + relevanceScore × 0.3 + confidenceScore × 0.2
   - injectContext: format + inject per target agent
     - SPEG: sendMessage({ noReply: true }) with formatted context
     - Claude Code: append to CLAUDE.md file
     - Codex: prepend to first user message (handled by caller)
     - OpenCode: append to OPENCODE.md file
     - Cursor: append to .cursorrules file
   - Context window budget: 2000 chars max (truncate if over)
   - Deduplicate: merge entries about same file/decision

4. speg/test/cacm/ContextInjector.test.ts:
   - Test ranking algorithm with known scores
   - Test formatting for each agent type
   - Test truncation when over budget
   - Test injection via mock (verify correct method called)
   - Test deduplication

RESEARCH:

- Search: "exponential decay scoring algorithm"
- Search: "LLM context injection best practices"
- Read Jcode memory search from research/06-jcode-internals.md
- Search: "ranking algorithm recency relevance confidence"

VERIFICATION:

```bash
vp run --filter @speg/core typecheck
vp run test speg/test/cacm/ContextInjector.test.ts
```

GIT COMMIT:

```bash
git add -A
git commit -m "feat(speg): add CACM context injector with cross-agent formatting

- Memory graph query with weighted ranking (recency×0.5 + relevance×0.3 + confidence×0.2)
- Per-agent context formatters: SPEG, Claude Code, Codex, OpenCode, Cursor
- 2000-char context budget with truncation
- Deduplication of overlapping context entries
- Unit tests for ranking, formatting, truncation, injection"
```

AFTER: Mark ✅ in checklist. Write report to research/report/1.6-context-injector.md

```

---

## Task 1.7: SPEG Server Integration

```

TASK: Wire SPEG services into the T3 Code server. Add WebSocket RPC routes.

CRITICAL RULES:

- DO NOT modify existing T3 Code RPC methods or behavior
- Add new SPEG routes following EXISTING ws.ts patterns exactly
- Use authorizeEffect + observeRpcEffect for all new handlers
- SPEG services fork-parked behind ServerActivation Deferred
- SPEG Layer composition follows existing server.ts patterns

FILES TO CREATE:

1. apps/server/src/speg/SpegLayer.ts:
   - Compose all SPEG services into one Layer
   - SpegLayer = Layer.mergeAll(
     JcodeInstanceManagerLive,
     SessionWatcherLive.pipe(Layer.provide(JcodeInstanceManagerLive)),
     ContextExtractorLive.pipe(Layer.provide(SessionWatcherLive)),
     ContextInjectorLive.pipe(Layer.provide(ContextExtractorLive)),
     )
   - Export as SpegLayer

2. apps/server/src/speg/SpegRpcHandlers.ts:
   - Implement all SPEG RPC methods:
     - handleSpegChatSendMessage(wsRpcGroup, currentSession)
     - handleSpegChatSubscribe(wsRpcGroup, currentSession)
     - handleSpegCacmQueryContext(wsRpcGroup, currentSession)
     - handleSpegCacmListSessions(wsRpcGroup, currentSession)
     - handleSpegCacmInjectContext(wsRpcGroup, currentSession)
   - Each handler: authorizeEffect(currentSession.scopes, requiredScope) → call service → return result
   - Follow pattern from existing handlers in ws.ts

3. apps/server/src/speg/SpegWsRoutes.ts:
   - Function: registerSpegRoutes(wsRpcGroup, currentSession)
   - Register all SPEG RPC methods
   - Follow pattern from ws.ts route registration

4. apps/server/src/ws.ts (MINIMAL addition):
   - Import and call registerSpegRoutes() where other routes are registered
   - Add SpegLayer to the server Layer composition
   - This should be a 5-line diff maximum

5. apps/server/src/server.ts (MINIMAL addition):
   - Import SpegLayer
   - Add to makeServerLayer composition
   - 2-line diff maximum

6. apps/server/test/speg/SpegIntegration.test.ts:
   - Test: server starts with SPEG layer active
   - Test: WebSocket accepts speg.chat.sendMessage RPC
   - Test: WebSocket streaming for speg.chat.subscribe
   - Test: CACM RPC methods respond correctly
   - Test: existing T3 Code RPC still works (regression check)

RESEARCH:

- Read apps/server/src/ws.ts to understand EXACT route registration pattern
- Read apps/server/src/server.ts to understand EXACT layer composition
- Search: "Effect RPC server route registration pattern"

VERIFICATION:

```bash
vp run --filter @speg/core typecheck
vp run --filter @t3tools/server typecheck
vp run test apps/server/test/speg/SpegIntegration.test.ts
# Start server to verify SPEG endpoints respond
```

GIT COMMIT:

```bash
git add -A
git commit -m "feat(speg): integrate SPEG services into T3 Code server

- SpegLayer: composes all SPEG Effect services
- SpegRpcHandlers: chat, CACM query/list/inject
- WebSocket routes registered alongside existing RPC
- Minimal diff: 5 lines in ws.ts, 2 in server.ts
- Integration tests: all SPEG RPC methods respond
- Existing T3 Code routes unaffected"
```

AFTER: Mark ✅ in checklist. Write report to research/report/1.7-server-integration.md

```

---

## Task 1.8: Desktop Build & Windows Packaging

```

TASK: Package SPEG into a working Windows Electron desktop application.

CONTEXT:

- Existing T3 Code desktop app wraps web in Electron
- SPEG adds new routes + components to web → desktop inherits them
- Windows build: NSIS installer + portable .exe
- Jcode binary: bundled or downloaded on first launch
- Target: Windows x64, macOS ARM64/x64, Linux x64

FILES TO CREATE/MODIFY:

1. apps/desktop/src/speg/SpegDesktopBridge.ts:
   - Desktop IPC handlers for SPEG-specific operations
   - SpegJcodeStatus: check Jcode binary installation
   - SpegInstallJcode: trigger Jcode download/install
   - SpegOpenSessionDir: open session directory in file explorer
   - Follow existing DesktopIpc pattern exactly

2. apps/desktop/src/main.ts (MINIMAL addition):
   - Import and register SPEG desktop bridge handlers
   - 3-5 line diff maximum

3. apps/desktop/electron-builder.yml (UPDATE):
   - Add SPEG-specific build config
   - Windows: NSIS + portable targets
   - Include Jcode binary in extraResources (or download on first launch)
   - App ID: com.speg.desktop
   - Product name: SPEG

4. apps/desktop/package.json (UPDATE):
   - Add @speg/core to dependencies
   - Add build:win script

5. scripts/build-speg-desktop.ps1 (Windows build script):
   - Build server: vp run --filter @t3tools/server build
   - Build web: vp run --filter @t3tools/web build
   - Build desktop: vp run --filter @t3tools/desktop build
   - Package: electron-builder --win --x64
   - Verify: check .exe exists and has expected size

6. scripts/build-speg-desktop.sh (Unix build script):
   - Same as above but for macOS/Linux targets

RESEARCH:

- Read apps/desktop/src/main.ts to understand EXACT initialization
- Read existing electron-builder.yml for config patterns
- Search: "electron-builder Windows NSIS configuration"
- Search: "bundle external binary with Electron app"

VERIFICATION:

```bash
# On Windows:
powershell -File scripts/build-speg-desktop.ps1
# Verify .exe produced at dist/speg-setup-*.exe

# Type check:
vp run --filter @t3tools/desktop typecheck
```

GIT COMMIT:

```bash
git add -A
git commit -m "feat(speg): add desktop packaging with Windows build

- SPEG desktop bridge: Jcode status, install, session dir IPC
- electron-builder config: NSIS + portable for Windows
- Build scripts for Windows (PowerShell) and Unix (bash)
- Jcode binary bundling strategy
- Desktop inherits SPEG web routes automatically"
```

AFTER: Mark ✅ in checklist. Write report to research/report/1.8-desktop-build.md

```

---

## Task 1.9: Phase 1 Integration Test & Cleanup

```

TASK: End-to-end verification that Phase 1 is complete and production-ready.

WHAT TO DO:

1. Run full typecheck on all SPEG files:

   ```bash
   vp run --filter @speg/core typecheck
   vp run --filter @t3tools/contracts typecheck
   vp run --filter @t3tools/server typecheck
   vp run --filter @t3tools/web typecheck
   vp run --filter @t3tools/desktop typecheck
   ```

2. Run all SPEG tests:

   ```bash
   vp run test speg/test/
   vp run test packages/contracts/test/speg/
   vp run test apps/server/test/speg/
   ```

3. Run lint on changed files:

   ```bash
   vp lint
   ```

4. Start dev server to verify SPEG endpoints:

   ```bash
   vp run dev
   # Verify in another terminal:
   # - WebSocket accepts speg.* RPC methods
   # - Jcode daemon launches and responds to ping
   ```

5. Build desktop for Windows:

   ```bash
   powershell -File scripts/build-speg-desktop.ps1
   # Verify .exe exists and can launch
   ```

6. Git tag the phase:
   ```bash
   git tag -a speg-v0.1.0-phase1 -m "SPEG Phase 1: Foundation complete"
   ```

FILES CHANGED: None (verification only)

EXIT CRITERIA:

- [ ] All typecheck passes
- [ ] All tests pass (0 failures)
- [ ] Lint clean (0 errors)
- [ ] Dev server starts with SPEG active
- [ ] Windows .exe builds successfully
- [ ] Git tag created

GIT COMMIT:

```bash
# Only if there are lint/type fixes needed
git add -A
git commit -m "chore(speg): phase 1 integration fixes"
git push origin --tags
```

AFTER: Write final Phase 1 report to research/report/1.9-phase1-complete.md
Mark Phase 1 header as ✅ in SPEG-CHECKLIST.md

PHASE 1 COMPLETE. Ready for Phase 2.

```

---

## Notes for Future Phases

Phases 2-6 follow the same pattern. Each task gets:
1. Self-contained prompt in this file
2. Files to create with exact paths
3. Research directions
4. Verification commands
5. Git commit template
6. Report instructions

Copy the pattern above for each new task.
```
