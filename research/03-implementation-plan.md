# SPEG — Custom AI Agent System: Implementation Plan

> Generated: 2026-08-04 | Based on: Full T3 Code analysis + Jcode feature specification
> This is the master implementation plan for building a custom AI agent system
> using Jcode (Rust harness) with a T3 Code-inspired architecture.

---

## Vision

Build a new AI coding agent platform ("SPEG") that combines:
- **Jcode** (Rust harness) for memory-safe, high-performance agent execution
- **T3 Code-inspired architecture** for multi-surface UI (web, desktop, mobile)
- **Custom agent capabilities** with preconfigured skills and multi-agent orchestration
- **Provider flexibility** — use our own agents AND external providers (Claude, OpenAI, etc.)

This is a **new project**, separate from T3 Code, leveraging its architectural patterns but avoiding its performance bottlenecks.

---

## Architectural Foundation

### Core Architecture (Inspired by T3 Code, optimized for Jcode)

```
┌─────────────────────────────────────────────────────┐
│  CLIENTS (Web / Desktop / Mobile)                    │
│  ┌───────────────────────────────────────────────┐  │
│  │ @speg/client-runtime                          │  │
│  │  Connection supervisor, RPC, Atom state       │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ Typed WebSocket RPC
                       │ (@speg/contracts)
┌──────────────────────┴──────────────────────────────┐
│  SPEG SERVER (Node.js/Bun — TypeScript + Effect)    │
│  ┌───────────────────────────────────────────────┐  │
│  │ Orchestration Engine (event-sourced)          │  │
│  │ Provider Registry (Jcode + external)          │  │
│  │ Skill Manager                                 │  │
│  │ Checkpointing, VCS, Terminal, Filesystem      │  │
│  └───────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────┘
                       │ stdin/stdout JSON-RPC
┌──────────────────────┴──────────────────────────────┐
│  JCODE HARNESS (Rust binary)                        │
│  ┌───────────────────────────────────────────────┐  │
│  │ Agent Runtime (swarm, memory, skills, MCP)    │  │
│  │ Provider Backends (Claude, OpenAI, etc.)      │  │
│  │ Browser Automation (Firefox/Chrome)           │  │
│  │ Semantic Memory (vector embeddings)           │  │
│  │ Self-Development (recompile + reload)         │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Key Architectural Differences from T3 Code

| T3 Code Pattern | SPEG Pattern | Why |
|---|---|---|
| Serial command worker (bottleneck) | Per-session parallel workers | Jcode handles agent concurrency natively |
| In-memory read model | SQLite-only read model + targeted caches | Avoids memory growth + rebuild latency |
| Synchronous 9-table projection | Async CDC projection (PubSub-driven) | Decouples event persistence from read updates |
| Provider adapters as TypeScript | Jcode native providers + external adapter | Rust handles primary agents; TS adapts external ones |
| Ghostty WASM terminal | Simpler ANSI/xterm renderer | Lower WASM overhead for MVP |
| Monolithic ChatView | Composed micro-components | Isolated re-renders, code-splittable |
| Zustand + localStorage | IndexedDB with batched writes | Better perf, async I/O |
| ForwardCompatibleArray | Protocol version negotiation | Explicit versioning over silent drops |

### Technology Stack

| Layer | Technology | Rationale |
|---|---|---|
| **Harness** | Jcode (Rust) | Performance, memory safety, native features |
| **Server** | Node.js/Bun + TypeScript + Effect | Type safety, event sourcing, ecosystem |
| **Web UI** | React 19 + TanStack Router + Tailwind | Modern, performant |
| **Desktop** | Electron / Tauri (TBD) | Cross-platform with native features |
| **Mobile** | React Native (Expo) | iOS + Android from shared codebase |
| **Contracts** | Effect/Schema | Runtime validation, type generation |
| **Persistence** | SQLite (WAL mode) | Embedded, fast, reliable |
| **IPC** | JSON-RPC over stdin/stdout (Jcode↔Server) | Simple, debuggable, cross-platform |
| **Client↔Server** | Effect RPC over WebSocket | Typed, streaming, reconnect-resilient |

---

## Implementation Phases

---

### PHASE 1: Foundation & Contracts

**Goal**: Establish the monorepo structure, wire protocol, and build toolchain.

#### 1.1 Project Scaffolding
- Initialize pnpm monorepo with catalog versioning
- Set up `apps/` (server, web, desktop, mobile, marketing)
- Set up `packages/` (contracts, shared, client-runtime)
- Configure TypeScript 6 + Effect 4.0 + strict mode
- Configure Vite+ build toolchain (lint, format, test, typecheck)
- Set up CI/CD (GitHub Actions: lint → typecheck → test)
- **Unit test**: Verify monorepo builds cleanly

#### 1.2 Contracts Package (`@speg/contracts`)
- Define base branded identifiers (AgentId, ThreadId, ProjectId, SessionId, SkillId, SwarmId)
- Define `WsRpcGroup` with initial RPC methods:
  - `orchestration.dispatchCommand` (streaming)
  - `orchestration.subscribeShell` (streaming)
  - `orchestration.subscribeThread` (streaming)
  - `server.getConfig`
  - `server.getSettings` / `server.updateSettings`
  - `agent.list` / `agent.start` / `agent.stop`
  - `swarm.create` / `swarm.spawn`
  - `skills.list` / `skills.activate` / `skills.deactivate`
  - `terminal.create` / `terminal.write` / `terminal.subscribe`
  - `memory.search` / `memory.store`
- Define `ServerConfig` with protocol version, capabilities, agent catalog
- Define `AgentRuntime` event contracts (canonical events for all agent types)
- Define `SkillDefinition` and `SkillCatalog` contracts
- Define `SwarmDefinition` and `SwarmEvent` contracts
- Define `MemoryEntry` and `MemorySearchResult` contracts
- Include `protocolVersion` field from day one (learn from T3 Code's omission)
- **Unit test**: Schema encode/decode roundtrip for all contracts

#### 1.3 Jcode JSON-RPC Protocol
- Design the stdin/stdout JSON-RPC 2.0 protocol between server and Jcode
- Define method namespace: `agent.*`, `swarm.*`, `skills.*`, `memory.*`, `browser.*`, `mcp.*`
- Define notification events: `agent.event`, `swarm.event`, `memory.recall`
- Define error codes for Jcode-specific failures
- Document the full protocol spec
- **Unit test**: Mock Jcode server, end-to-end message exchange

#### 1.4 Shared Package (`@speg/shared`)
- Port essential utilities from T3 Code's shared package (simplified):
  - `DrainableWorker` and `KeyedCoalescingWorker`
  - `Net` (port availability, ephemeral reservation)
  - `observability` and `logging` (simplified rotating file sink)
  - `Struct.deepMerge`
  - `semver`, `path`, `cliArgs`
- Add new utilities:
  - `JcodeProcess` — spawn, health-check, restart Jcode binary
  - `JsonRpcClient` — typed JSON-RPC 2.0 client for Jcode communication
- **Unit test**: Worker drain behavior, JSON-RPC client roundtrip

#### 1.5 Server Scaffolding
- Initialize `apps/server` with Effect service layer pattern
- Set up SQLite persistence layer (WAL mode, migrations)
- Set up HTTP server with WebSocket upgrade
- Implement authentication placeholder (token-based for MVP)
- Wire `WsRpcGroup` handlers (stub implementations returning mock data)
- Set up dev server workflow (`vp run dev`)
- **Unit test**: Server starts, WebSocket connects, RPC roundtrip

---

### PHASE 2: Jcode Integration & Agent Runtime

**Goal**: Integrate Jcode harness, implement agent lifecycle, and basic chat.

#### 2.1 Jcode Process Manager
- Implement `JcodeProcessManager` — Effect service for Jcode binary lifecycle:
  - Spawn Jcode as child process (stdin/stdout JSON-RPC)
  - Health-check via `agent.ping` method
  - Auto-restart on crash with exponential backoff
  - Version negotiation on startup
  - Graceful shutdown
- Implement `JcodeBinaryResolver` — find/install Jcode binary:
  - Platform-specific paths
  - Version checking
  - Auto-download (future phase)
- **Integration test**: Spawn real Jcode, exchange messages, handle restart

#### 2.2 Agent Session Management
- Implement `AgentSessionManager`:
  - Create/destroy agent sessions
  - Route user messages to agents
  - Stream agent responses as canonical `AgentRuntimeEvent`s
  - Handle agent interrupts (stop, pause, resume)
  - Track session state (idle, running, awaiting_approval, awaiting_input)
- Implement `AgentRegistry` — catalog of available agents:
  - Built-in SPEG agents (preconfigured)
  - External provider agents (Claude, OpenAI, etc.)
  - Per-agent capabilities declaration
- **Integration test**: Start agent, send message, receive streaming response

#### 2.3 Orchestration Engine (Simplified MVP)
- Implement lightweight event-sourced orchestration:
  - Command queue with per-agent parallel workers (NOT serial)
  - Decider: (command + state) → events (pure function)
  - Event store: append-only SQLite table
  - Async projection pipeline (PubSub-driven, NOT synchronous)
  - Read model: SQLite projections (no in-memory mirror)
- Implement core commands:
  - `thread.create`, `thread.send-message`, `thread.archive`
  - `agent.start`, `agent.stop`, `agent.interrupt`
  - `project.create`, `project.delete`
- **Integration test**: Full message send→receive cycle through orchestration

#### 2.4 Basic Chat UI (Web)
- Implement `ChatView` as composed micro-components:
  - `ChatHeader` — project name, agent selector, settings
  - `MessageTimeline` — virtualized message list (LegendList)
  - `ComposerBar` — text input with agent/model picker
  - `AgentStatusIndicator` — running/idle/error state
- Implement `ConnectionDriver` + `EnvironmentSupervisor`
- Implement client-side state with Effect Atoms:
  - `agentState` — current agent session
  - `threadState` — messages, activities
  - `shellState` — environment overview
- **Integration test**: Open web UI, send message, see agent response stream

#### 2.5 Unit Test Suite
Every integration point must have a test:
- Jcode JSON-RPC protocol message parsing
- Agent session lifecycle (create → run → complete → destroy)
- Orchestration command→event flow
- WebSocket RPC roundtrip with mock Jcode
- Chat UI component rendering with mock state

---

### PHASE 3: Multi-Provider & External Agent Support

**Goal**: Support using external AI providers alongside SPEG's own agents.

#### 3.1 Provider Adapter System
- Implement `ProviderAdapter` interface (adapting T3 Code's pattern):
  - `startSession`, `sendTurn`, `interruptTurn`
  - `streamEvents` — canonical event PubSub
  - `getCapabilities` — provider-specific features
- Implement adapters for external providers:
  - **Claude** — `@anthropic-ai/claude-agent-sdk`
  - **OpenAI** — OpenAI API / Codex CLI
  - **OpenCode** — `@opencode-ai/sdk`
  - **Gemini** — Google Generative AI SDK
- Implement `ProviderService` — cross-provider routing:
  - Select adapter by provider kind
  - Validate inputs with Schema
  - Emit unified event stream
  - Handle provider failures gracefully
- **Integration test**: Each adapter: start→send→stream→receive→stop

#### 3.2 Provider Registry & Configuration
- Implement `ProviderRegistry`:
  - Enumerate available providers (Jcode native + external adapters)
  - Provider installation status checking
  - Model catalog per provider
  - Custom API endpoints
  - API key management (encrypted storage)
- Implement provider settings UI:
  - Add/remove API keys
  - Configure default provider
  - Per-provider model selection
  - Context window configuration
- **Unit test**: Provider CRUD, model catalog resolution

#### 3.3 Jcode as a Provider
- Register Jcode as a "provider" in the provider system
- Jcode-specific capabilities exposed via `getCapabilities()`:
  - `swarm` — multi-agent swarms
  - `semanticMemory` — vector memory
  - `selfDev` — self-modification
  - `browserAutomation` — built-in browser
  - `mcp` — MCP server support
- Jcode adapter translates internal JSON-RPC events → canonical `AgentRuntimeEvent`s
- UI shows Jcode-specific features when Jcode agent is active
- **Integration test**: Jcode adapter produces canonical events

#### 3.4 Provider Picker UI
- Agent selector dropdown in ComposerBar
- Model selector per provider
- Provider capability badges (swarm, memory, browser)
- Provider status indicator (connected, error, installing)
- Quick provider switching without losing thread context
- **Unit test**: Provider switch preserves thread state

---

### PHASE 4: Preconfigured Skills System

**Goal**: Built-in skills that are always active unless explicitly turned off.

#### 4.1 Skill Manager
- Implement `SkillManager` in Jcode harness:
  - Skill catalog with semantic descriptions
  - Automatic embedding-based activation (semantic matching)
  - Manual activation via slash commands
  - Per-skill enable/disable toggle
  - Skill chaining (one skill can invoke others)
- Implement `SkillRegistry` in server:
  - Load built-in skills from configuration
  - Load user-installed skills
  - Skill versioning and updates
  - Conflict detection between skills
- **Integration test**: Skill activation via semantic match

#### 4.2 Built-in Default Skills

**Graphify** (Mermaid diagram generation):
- Detects "diagram", "flowchart", "visualize" in context
- Generates Mermaid.js diagrams from text descriptions
- Renders inline in chat
- Supports: flowchart, sequence, class, ER, Gantt, pie

**Ponytail** (Code formatting & style):
- Detects code blocks in agent output
- Applies language-specific formatting rules
- Ensures consistent code style across agent outputs
- Configurable per-project style guide

**Best Practices (per-language)**:
- TypeScript/JavaScript: ESLint rules, TS strict mode suggestions
- Rust: Clippy lints, ownership patterns
- Python: PEP 8, type hints
- Go: Effective Go patterns
- Configurable rule sets per project

**Security Audit**:
- Scans agent-generated code for common vulnerabilities
- SQL injection, XSS, CSRF, path traversal detection
- Secret/key detection in output
- Dependency vulnerability checking

**Documentation Generator**:
- Auto-generates docstrings/comments for agent-written code
- README generation from codebase analysis
- API documentation from type definitions

**Test Generator**:
- Generates unit tests for agent-written code
- Coverage gap detection
- Test pattern matching (given-when-then, AAA)

#### 4.3 Skill UI
- Skill status bar showing active skills
- Skill toggle switches (on/off per skill)
- Skill activity indicator (which skill is processing)
- Skill configuration panel (per-skill settings)
- Slash command menu for manual skill activation
- **Unit test**: Skill toggle, slash command menu

#### 4.4 Skill Persistence
- Per-project skill configuration
- Default skill set for new projects
- Skill state synchronized across sessions
- Skill preferences in `ServerConfig`
- **Unit test**: Skill config survives restart

---

### PHASE 5: Swarm / Multi-Agent System

**Goal**: Enable multi-agent collaboration through Jcode's swarm features.

#### 5.1 Swarm Orchestration
- Implement swarm creation and management:
  - `swarm.create` — spawn coordinator + N worker agents
  - `swarm.spawn` — add agent to existing swarm
  - `swarm.message` — send to specific agent or broadcast
  - `swarm.stop` — terminate swarm
- Implement coordinator/worker architecture:
  - Coordinator receives user task → decomposes → distributes to workers
  - Workers execute subtasks → report to coordinator
  - Coordinator aggregates results → presents to user
- Implement swarm communication channels:
  - Direct messages (agent → agent)
  - Broadcast messages (agent → all)
  - Repository-scoped communication
- **Integration test**: 3-agent swarm solving a multi-file task

#### 5.2 Swarm UI
- Swarm status dashboard:
  - Agent list with status (idle, working, blocked, done)
  - Agent communication log
  - Task distribution visualization
  - Completion tracking progress bar
- Swarm creation dialog:
  - Number of agents
  - Agent types (specialist roles)
  - Task description
- Individual agent views within swarm:
  - Per-agent message timeline
  - Per-agent file changes
  - Per-agent status

#### 5.3 Autonomous Swarms
- Agents can spawn sub-agents autonomously
- Automatic task distribution based on agent capabilities
- Conflict detection when agents modify same files
- File change notifications between agents
- Diff checking and merge assistance
- **Integration test**: Agent autonomously spawns sub-agent for subtask

#### 5.4 Headless & UI-Managed Swarms
- Headless mode: swarm runs without UI connection
- UI-managed mode: full visualization and control
- Swarm snapshots for later review
- Swarm replay: review past swarm sessions
- **Unit test**: Headless swarm completes, UI connects and reviews

---

### PHASE 6: Memory System

**Goal**: Semantic memory with automatic extraction and context injection.

#### 6.1 Memory Backend (Jcode)
- Implement vector embedding generation:
  - Use local embedding model (fastembed or similar)
  - Cosine similarity retrieval
  - Memory graph construction
- Implement automatic memory extraction:
  - Parse agent conversations for facts, decisions, patterns
  - Extract code patterns and preferences
  - Identify project-specific knowledge
- Implement memory consolidation:
  - Merge related memories
  - Detect stale/outdated memories
  - Conflict resolution
- **Integration test**: Memory extracted from conversation, retrieved later

#### 6.2 Memory Tools
- `memory.search` — semantic search across all memories
- `memory.store` — manually store a memory
- `memory.list` — list recent memories
- `memory.delete` — remove a memory
- `memory.session-search` — RAG over previous sessions
- **Unit test**: Store→search→retrieve memory cycle

#### 6.3 Memory Integration
- Automatic context injection:
  - Before agent processes a turn, inject relevant memories
  - Passive memory recall based on conversation context
  - Memory verification side-agent (confirms relevance before injection)
- Memory UI:
  - Memory browser (search, filter, delete)
  - Memory graph visualization
  - Memory relevance scores
  - Manual memory annotation
- **Integration test**: Agent uses past memory to inform current task

#### 6.4 Ambient Memory
- Background memory organization
- Periodic cleanup of irrelevant memories
- Memory consolidation across sessions
- Relevance checking and staleness detection
- **Unit test**: Stale memory auto-detected and flagged

---

### PHASE 7: Browser Automation

**Goal**: Built-in browser tool for web testing and interaction.

#### 7.1 Browser Backend (Jcode)
- Implement browser automation via Jcode's built-in browser tool:
  - Firefox Agent Bridge (initial backend)
  - Chrome DevTools Protocol (future)
  - Remote debugging backends (future)
- Implement browser actions:
  - `browser.status` — connection status
  - `browser.navigate` — open URL
  - `browser.snapshot` — page accessibility tree
  - `browser.content` — get page text content
  - `browser.click` — click element
  - `browser.type` — type into element
  - `browser.fill-form` — fill form fields
  - `browser.screenshot` — capture screenshot
  - `browser.evaluate` — execute JavaScript
  - `browser.scroll` — scroll page
  - `browser.wait` — wait for condition
- **Integration test**: Navigate to page, interact, capture screenshot

#### 7.2 Browser UI Integration
- In-app browser preview (desktop):
  - Embedded browser view in right panel
  - Element picker (hover to highlight, click to select)
  - Screenshot capture with annotations
  - Console output viewer
- Browser action log in chat:
  - Actions taken by agent shown as timeline entries
  - Screenshots displayed inline
  - Page content shown as expandable blocks
- **Integration test**: Agent uses browser to test a web page

---

### PHASE 8: Self-Development

**Goal**: Agent can modify its own source code, recompile, and reload.

#### 8.1 Self-Dev Mode (Jcode)
- Implement self-modification capability:
  - Agent edits its own Rust source files
  - Automatic `cargo build` after changes
  - Automatic testing after build
  - Binary reload without full restart
  - Session continuation after reload
- Implement safety guards:
  - Source backup before modification
  - Build failure rollback
  - Capability gating (explicit opt-in)
  - Diff review before applying changes
- **Integration test**: Agent adds new feature to itself, rebuilds, reloads

#### 8.2 Self-Dev UI
- Self-dev status panel:
  - Build status (compiling, success, failed)
  - Test results
  - Source diff viewer
  - Reload progress
- Self-dev approval flow:
  - Auto-accept: apply without review
  - Review: show diff, wait for approval
  - Manual: agent proposes, user applies manually
- **Unit test**: Self-dev approval flow states

---

### PHASE 9: Session Management

**Goal**: Resume sessions across restarts, providers, and harnesses.

#### 9.1 Session Persistence
- Implement session serialization:
  - Full conversation history
  - Provider state (session IDs, cursors)
  - Agent state (context, memory connections)
  - Workspace state (checkpoint refs)
- Implement session resume:
  - Resume SPEG agent sessions
  - Resume Claude Code sessions (import)
  - Resume Codex sessions (import)
  - Resume OpenCode sessions (import)
  - Resume across different harnesses
- **Integration test**: Stop server, restart, resume conversation

#### 9.2 Session UI
- Session browser:
  - List past sessions by project
  - Session preview (first few messages)
  - Session search (semantic + text)
  - Resume button
- Session export/import:
  - Export as JSON/markdown
  - Import from other tools
  - Share sessions between environments
- **Unit test**: Session export→import roundtrip

---

### PHASE 10: Advanced Features & Polish

**Goal**: Terminal, VCS, MCP, desktop, mobile — the full multi-surface experience.

#### 10.1 Terminal Integration
- Server-side PTY management (via Jcode or direct)
- WebSocket terminal streaming
- Terminal UI with simpler ANSI renderer (avoid Ghostty WASM overhead for MVP)
- Multiple terminal support per thread
- Terminal context injection into composer
- **Integration test**: Open terminal, run command, capture output

#### 10.2 VCS Integration
- Git driver (VcsDriver interface)
- Worktree management per thread
- Checkpoint capture per turn (hidden git refs)
- Turn diff computation and display
- Branch/worktree picker in UI
- **Integration test**: Multi-turn session with diff between turns

#### 10.3 MCP Support
- MCP server management:
  - Global MCP config
  - Project MCP config
  - stdio MCP servers
  - Environment variable configuration
- MCP tool exposure to agents
- MCP compatibility with external providers
- **Integration test**: Connect MCP server, agent uses MCP tool

#### 10.4 Desktop App
- Electron/Tauri shell wrapping web app
- Server bundling and management
- Native features (file dialogs, notifications, auto-updates)
- SSH remote environment support
- In-app browser preview
- **Integration test**: Desktop app connects to local server, sends message

#### 10.5 Mobile App
- React Native (Expo) app
- Shared client runtime with web
- Push notifications (agent completion alerts)
- Offline message outbox
- Native terminal rendering
- **Integration test**: Mobile connects to remote server, sends message

#### 10.6 Interaction Modes
- Supervised: every action requires approval
- Auto-accept: approve file changes, prompt for dangerous operations
- Auto: approve everything except destructive operations
- Full-access: no approvals required
- Live-send: streaming input (voice → text)
- Queue-send: Shift+Enter to queue, batch send

#### 10.7 Input Methods
- Keyboard (primary)
- Voice dictation (Whisper API or local)
- Queue send (multi-line, batch)
- Live send (character-by-character streaming)

---

## Performance Design (Avoiding T3 Code Bottlenecks)

### What We Do Differently

| Concern | T3 Code Approach | SPEG Approach |
|---|---|---|
| Command processing | Serial worker (bottleneck) | Per-agent parallel workers |
| Read model | In-memory mirror + projections | SQLite projections only + targeted caches |
| Projection | Synchronous 9-table in transaction | Async PubSub-driven CDC |
| Chat component | Monolithic 6189-line component | Composed micro-components |
| State persistence | localStorage + multiple Zustand stores | IndexedDB with batched writes |
| Terminal | 631KB Ghostty WASM | Simpler ANSI renderer (MVP) |
| Schema validation | Every wire payload | Trust boundaries only |
| Code splitting | None | Route + feature-level |
| Protocol versioning | ForwardCompatibleArray | Explicit protocolVersion field |

### Resource Budgets

| Component | Target Memory | Notes |
|---|---|---|
| Jcode harness | <100MB idle | Rust efficiency |
| Server (Node/Bun) | <150MB idle | With SQLite page cache |
| Web client | <50MB (no terminal) | Code-split, lazy-loaded |
| Per-agent session | <50MB additional | Jcode handles scaling |
| SQLite database | <100MB (typical) | With projections |

---

## Testing Strategy

### Per-Phase Testing Requirements

Every phase includes:
1. **Unit tests** for pure logic (deciders, projectors, schema validation)
2. **Integration tests** for service boundaries (Jcode↔Server, Server↔Client)
3. **Contract tests** for wire protocol (schema encode/decode roundtrip)
4. **E2E tests** for critical user flows (send message → get response)

### Test Infrastructure
- Vitest for unit + integration tests
- Mock Jcode server for provider tests
- Effect `TestContext` for service-level tests
- `DrainableWorker.drain()` for deterministic async
- SQLite in-memory for persistence tests
- Playwright for web UI e2e (future phase)

### Test File Convention
```
apps/server/test/
├── unit/
│   ├── decider.test.ts
│   ├── projector.test.ts
│   └── contracts.test.ts
├── integration/
│   ├── jcode-process.test.ts
│   ├── agent-lifecycle.test.ts
│   └── orchestration.test.ts
└── e2e/
    └── full-turn.test.ts
```

---

## Delivery Timeline (Estimated)

| Phase | Duration | Dependencies | Deliverable |
|---|---|---|---|
| 1: Foundation | 2-3 weeks | None | Monorepo, contracts, server scaffold, CI |
| 2: Jcode + Agent | 3-4 weeks | Phase 1 | Working agent chat (SPEG agents only) |
| 3: Multi-Provider | 2-3 weeks | Phase 2 | Claude, OpenAI, Gemini as providers |
| 4: Skills | 2-3 weeks | Phase 2 | Preconfigured skills, skill manager UI |
| 5: Swarm | 3-4 weeks | Phase 2 | Multi-agent collaboration |
| 6: Memory | 2-3 weeks | Phase 2 | Semantic memory system |
| 7: Browser | 2-3 weeks | Phase 5 | Browser automation |
| 8: Self-Dev | 2-3 weeks | Phase 6 | Agent self-modification |
| 9: Sessions | 1-2 weeks | Phase 3 | Session resume/import/export |
| 10: Polish | 4-6 weeks | All above | Desktop, mobile, terminal, VCS, MCP |

**Total estimated**: 23-34 weeks for full feature set.

---

## Research Documents Index

All research findings are stored in `t3code/research/`:

| Document | Content |
|---|---|
| `01-architecture.md` | Complete T3 Code architecture reference |
| `02-performance-analysis.md` | Bottleneck identification and fix recommendations |
| `03-implementation-plan.md` | This document — SPEG implementation plan |

These documents are interlinked — architecture informs plan, performance analysis informs design decisions.

---

## Key Design Decisions to Revisit

The following decisions should be made before Phase 1 implementation begins:

1. **Electron vs Tauri for desktop**: Tauri would align with Rust/Jcode ecosystem but Electron has more mature ecosystem for browser preview, SSH, etc.

2. **Bun vs Node.js for server**: Bun is faster and has better SQLite support but Node.js has broader compatibility.

3. **Jcode binary distribution**: How to bundle Jcode with the app? Download on first launch? Bundle per-platform binaries?

4. **Authentication model**: T3 Code's model is comprehensive but complex. MVP could use simpler API-key based auth.

5. **Open source license**: MIT (matching T3 Code) or something else?

6. **Repository location**: New GitHub org? Monorepo or separate repos for Jcode and SPEG?
