# SPEG — Implementation Plan v3 (Final)

> **Updated**: 2026-08-04
> **Based on**: Full T3 Code analysis + Jcode internal architecture + Memory Architecture docs
> **Core innovation**: Universal Cross-Agent Context Continuity (CACM)

---

## What Changed from v2

After exploring Jcode's actual internals (92 crates, HashMap-based memory graph, all-MiniLM-L6-v2 embeddings, cascade BFS retrieval, provenance tracking), and understanding the user's need for seamless cross-agent context, the plan now centers on:

1. **Not using Jcode's TUI at all** — we build our own custom UI (web + desktop + mobile)
2. **Jcode's memory graph as universal context store** — we extend it for cross-agent data
3. **Cross-Agent Context Manager (CACM)** — the core innovation: seamless context continuity across Claude Code, Codex, Cursor, OpenCode, and our SPEG agent
4. **Lightweight design** — SPEG server is a thin proxy; Jcode does the heavy lifting

---

## The Core Innovation: Cross-Agent Context Manager (CACM)

### The Problem

A developer switches between coding agents:
1. Starts in **Claude Code** → makes decisions, changes files, discovers patterns
2. Switches to **Codex** → has no idea what Claude Code was doing
3. Switches to **Cursor** → again, context lost
4. Opens **SPEG** → finally, everything is remembered

Each switch loses context. Work is repeated. Decisions are forgotten.

### The Solution: CACM

CACM is a **universal context bus** that sits between the user's workspace and any agent:

```
┌─────────────────────────────────────────────────────────┐
│                 CACM (Cross-Agent Context Manager)       │
│                                                         │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  SESSION    │  │   CONTEXT    │  │   CONTEXT     │  │
│  │  WATCHER    │→│  EXTRACTOR   │→│   INJECTOR    │  │
│  │             │  │              │  │               │  │
│  │ Watches:    │  │ Extracts:    │  │ Injects into: │  │
│  │ • Claude CC │  │ • Tasks      │  │ • Claude CC   │  │
│  │ • Codex     │  │ • Decisions  │  │ • Codex       │  │
│  │ • Cursor    │  │ • FileΔ      │  │ • Cursor      │  │
│  │ • OpenCode  │  │ • Patterns   │  │ • OpenCode    │  │
│  │ • SPEG      │  │ • Errors     │  │ • SPEG        │  │
│  └─────────────┘  └──────┬───────┘  └───────────────┘  │
│                          │                              │
│                 ┌────────┴────────┐                     │
│                 │  JCODE MEMORY   │                     │
│                 │     GRAPH       │                     │
│                 │                 │                     │
│                 │ • MemoryEntry   │                     │
│                 │ • Provenance    │                     │
│                 │ • Embeddings    │                     │
│                 │ • Cascade BFS   │                     │
│                 └────────┬────────┘                     │
│                          │                              │
│                 ┌────────┴────────┐                     │
│                 │   COMPACTOR     │                     │
│                 │                 │                     │
│                 │ • Summarizes    │                     │
│                 │ • Deduplicates  │                     │
│                 │ • Consolidates  │                     │
│                 └─────────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

### How It Works

#### 1. Session Watcher

Monitors agent session directories using filesystem watchers:

| Agent | Watch Path | Session Format |
|---|---|---|
| Claude Code | `~/.claude/projects/<hash>/` | JSONL conversation logs |
| Codex | `~/.codex/sessions/` | JSONL with message format |
| Cursor | Workspace `~/.cursor/` | Session state files |
| OpenCode | `~/.local/share/opencode/sessions/` | JSONL logs |
| SPEG/Jcode | `~/.jcode/sessions/` | Jcode native session format |

When a session becomes active (new messages appear), the watcher triggers extraction.

#### 2. Context Extractor

For each new message/turn in any agent session, the extractor:

1. **Parses** the agent-specific conversation format into a canonical `AgentTurn`:
   ```
   AgentTurn { agent, sessionId, timestamp, userMessage, assistantResponse, toolCalls, fileChanges }
   ```

2. **Extracts** key context using a lightweight LLM (Jcode's sidecar model):
   - **Task description**: what the user is trying to accomplish
   - **Decisions made**: architectural choices, approach selections
   - **Files modified**: what was changed and why
   - **Patterns discovered**: codebase conventions, gotchas
   - **Errors encountered**: what broke and how it was fixed
   - **Progress state**: what's done, what's remaining

3. **Stores** as `MemoryEntry` in Jcode's memory graph:
   ```
   MemoryEntry {
     content: "Refactored auth module to use JWT instead of sessions...",
     category: Fact,
     memory_type: Procedure,
     scope: Project,
     provenance: Observed,          // ← Key: it was observed, not user-stated
     source: {
       agent: "claude-code",
       session_id: "abc123",
       timestamp: "2026-08-04T12:00:00Z"
     },
     embedding: [0.1, 0.2, ...],   // Auto-generated by Jcode
     confidence: 0.85,
     tags: ["auth", "refactor", "jwt"],
   }
   ```

#### 3. Context Injector

When the user starts a NEW session with ANY agent:

1. **Queries** Jcode's memory graph for recent, relevant context
2. **Ranks** by recency, relevance, and confidence
3. **Formats** context per agent:
   - Claude Code: injected as system reminder or initial user message
   - Codex: injected as context preamble
   - SPEG: injected via Jcode's `sendMessage({ noReply: true })` or system prompt
   - Others: via AGENTS.md append or initial message
4. **Injects** at session start — the agent immediately knows:
   - What was being worked on
   - What decisions were made
   - What files were changed
   - What problems were encountered
   - What remains to be done

#### 4. Compactor

Runs periodically (ambient mode, session end, on-demand):

1. **Deduplicates** similar memories across agents (same file change from different agents)
2. **Summarizes** multi-turn sessions into concise progress entries
3. **Links** related memories (RelatesTo edges)
4. **Detects conflicts** — if Claude Code decided X and Codex decided Y, flag it
5. **Prunes** stale context (confidence decay)
6. **Consolidates** into higher-level "milestone" memories

### Why Jcode's Memory Graph Is Perfect for This

Jcode's memory system already has everything we need:

| Feature | How CACM Uses It |
|---|---|
| `Provenance::Observed` | Tracks that context came from watching another agent |
| `scope: Project` | Context is scoped to the project, not user-wide |
| `embedding: Vec<f32>` | Semantic search across all agent contexts |
| Cascade BFS retrieval | Finding ALL related context, not just direct hits |
| `RelatesTo` edges | Linking contexts from different agents |
| `Supersedes` edges | When newer context replaces older |
| `Contradicts` edges | When agents disagree |
| `confidence` decay | Auto-staling old context |
| `tags` | Organizing by topic across agents |
| `source.session_id` | Tracking which agent produced which context |
| Sidecar verification | Ensuring only relevant context is injected |
| Post-retrieval maintenance | Auto-strengthening useful links |

### CACM Data Flow

```
USER starts Claude Code session
    │
    ▼
[Session Watcher] detects new messages in ~/.claude/projects/
    │
    ▼
[Context Extractor] parses Claude conversation, extracts:
    "User is building a REST API for user management"
    "Decided to use JWT over sessions"
    "Modified src/auth/handler.ts, src/auth/middleware.ts"
    "Encountered CORS error, fixed by adding middleware"
    │
    ▼
[Memory Graph] stores 4 new MemoryEntries with:
    provenance: Observed
    source.agent: "claude-code"
    embeddings for semantic search
    │
    ▼
USER switches to SPEG agent
    │
    ▼
[Context Injector] queries memory graph:
    "What was happening in this project recently?"
    │
    ▼
Returns ranked context:
    1. "Building REST API for user management" (recency: high)
    2. "Using JWT, not sessions" (decision)
    3. "Modified auth handler and middleware" (file changes)
    4. "CORS error fixed with middleware" (lesson learned)
    │
    ▼
Injects into SPEG agent's initial context:
    "Before you start, here's what was happening:
     The user is building a REST API for user management.
     They decided to use JWT over sessions.
     Recent files modified: src/auth/handler.ts, src/auth/middleware.ts
     A CORS error was encountered and fixed by adding middleware.
     Pick up from here."
    │
    ▼
SPEG agent continues seamlessly from where Claude Code left off
```

---

## Revised Architecture

```
┌─────────────────────────────────────────────────────────┐
│  SPEG CLIENTS (Web · Desktop · Mobile)                   │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Custom UI (not Jcode TUI)                         │  │
│  │ • Cross-agent session browser                     │  │
│  │ • Memory graph visualizer                         │  │
│  │ • Context continuity timeline                     │  │
│  │ • Agent-agnostic chat + composer                  │  │
│  │ • Swarm dashboard (DAG view)                      │  │
│  │ • Terminal, diff viewer, browser preview          │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │ Effect RPC over WebSocket
┌──────────────────────┴──────────────────────────────────┐
│  SPEG SERVER (Bun + TypeScript + Effect)                │
│  ┌───────────────────────────────────────────────────┐  │
│  │  ⭐ CACM (Cross-Agent Context Manager)            │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │ SessionWatcher    → watches agent dirs      │  │  │
│  │  │ ContextExtractor  → parses + summarizes     │  │  │
│  │  │ ContextInjector   → queries + formats       │  │  │
│  │  │ Compactor         → deduplicates + merges   │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │                                                   │  │
│  │  Project Service · Auth Service                   │  │
│  │  WebSocket Gateway · Terminal Proxy               │  │
│  │  VCS Service · Analytics                          │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │ @1jehuang/jcode-sdk
┌──────────────────────┴──────────────────────────────────┐
│  JCODE DAEMON (Rust binary)                             │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Memory Graph (HashMap DiGraph)                    │  │
│  │  • MemoryEntry + MemoryType + Provenance          │  │
│  │  • Embeddings (all-MiniLM-L6-v2, ONNX/tract)     │  │
│  │  • Cascade BFS retrieval (depth=2)                │  │
│  │  • Sidecar verification (GPT-5.3 Spark)           │  │
│  │  • Post-retrieval maintenance                    │  │
│  │  • Confidence decay, negative memories            │  │
│  │                                                   │  │
│  │ Agents · Swarms · Skills · MCP · Browser          │  │
│  │ 40+ Providers · Self-Dev · Session I/O            │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘

External agents (Claude Code, Codex, Cursor, OpenCode)
    ↑
    └── CACM watches their session directories
        Extracts context → stores in Jcode memory graph
        Injects context when switching agents
```

---

## Implementation Phases (Final)

---

### PHASE 1: Foundation + CACM Core (3-4 weeks)

**Goal**: Monorepo, contracts, Jcode SDK integrated, CACM working for Jcode sessions.

#### 1.1 Project Scaffolding
- pnpm monorepo: `apps/server`, `apps/web`, `apps/desktop`, `apps/mobile`, `packages/contracts`, `packages/shared`, `packages/client-runtime`
- TypeScript 6 + Effect 4.0 + strict mode
- Vite+ build toolchain
- CI/CD pipeline
- **Test**: Monorepo builds, lints, typechecks

#### 1.2 Contracts (`@speg/contracts`)
- Base identifiers: ProjectId, AgentSessionId, ContextEntryId, MemoryId
- `WsRpcGroup` with RPC methods for CACM, chat, projects
- `CrossAgentContext` schema: universal context entry format
- `AgentSessionDescriptor`: agent type, session path, status
- `MemoryQuery` / `MemoryResult`: search across Jcode memory graph
- `protocolVersion` field from day one
- **Test**: Schema encode/decode roundtrip

#### 1.3 Jcode SDK Integration
- Install `@1jehuang/jcode-sdk`
- `JcodeInstanceManager`: launch private instances per project
- `JcodeSessionBridge`: map SPEG threads → Jcode sessions
- Stream Jcode events → SPEG WebSocket push
- **Test**: Full send→receive cycle through Jcode SDK

#### 1.4 CACM Core — Session Watcher
- `SessionWatcher` service:
  - Watches `~/.jcode/sessions/` for Jcode sessions
  - Detects new messages/turns via file watcher (chokidar or fs.watch)
  - Parses Jcode session format into canonical `AgentTurn`
  - Emits `SessionActivity` events when new turns detected
- Agent session format parsers (pluggable):
  - `JcodeSessionParser`: reads Jcode's JSONL session files
  - Stubs for Claude Code, Codex, Cursor, OpenCode (Phase 3)
- **Test**: Detect new Jcode session, parse turns, emit events

#### 1.5 CACM Core — Context Extractor
- `ContextExtractor` service:
  - Receives `AgentTurn` events from watcher
  - Extracts context using lightweight LLM (Jcode sidecar or local model)
  - Produces `CrossAgentContext` entries
  - Stores in Jcode memory graph via `JcodeSessionBridge`
- Extraction prompts per agent type
- Batching: accumulate turns within a session, extract periodically
- **Test**: Extract context from Jcode session, verify stored in memory graph

#### 1.6 CACM Core — Context Injector
- `ContextInjector` service:
  - Queries Jcode memory graph for recent project context
  - Ranks by recency × relevance × confidence
  - Formats context for target agent
  - Injects at session start via appropriate mechanism
- Injection format per agent:
  - SPEG/Jcode: `sendMessage({ noReply: true })` or system prompt prefix
  - External agents: AGENTS.md append or initial user message
- **Test**: Create context in memory, start new SPEG session, verify context injected

#### 1.7 Basic Web UI
- `ChatView` composed micro-components (learned from T3 Code's mistake)
- Agent session browser (list recent sessions across agents)
- Context continuity indicator (shows injected context at session start)
- Basic composer with send
- **Test**: Open web UI, see context from previous session, start new session

---

### PHASE 2: CACM External Agents (2-3 weeks)

**Goal**: CACM works across Claude Code, Codex, Cursor, and OpenCode.

#### 2.1 External Agent Parsers
- `ClaudeCodeSessionParser`: parse `~/.claude/projects/<hash>/*.jsonl`
- `CodexSessionParser`: parse `~/.codex/sessions/` conversation logs
- `OpenCodeSessionParser`: parse `~/.local/share/opencode/sessions/`
- `CursorSessionParser`: parse Cursor session state (best effort)
- Each parser implements `AgentSessionParser` interface:
  ```
  parseSession(sessionPath) → AgentSession
  parseTurn(rawMessage) → AgentTurn
  detectActivity(sessionPath) → boolean
  ```
- **Test**: Parse real Claude Code session, extract turns

#### 2.2 Multi-Agent Watcher
- Extend `SessionWatcher` to watch all agent directories
- Agent auto-discovery: detect which agents are installed/active
- Agent session registry: track all active sessions across agents
- Cross-agent session timeline: ordered list of all sessions
- **Test**: Start Claude Code session, see it appear in SPEG, start Codex, see both

#### 2.3 Cross-Agent Context Injection
- When user starts a session with ANY agent:
  1. Detect agent type
  2. Query memory graph for recent context from ALL agents
  3. Format per agent's conventions
  4. Inject appropriately
- For external agents, injection via:
  - Claude Code: append to project's CLAUDE.md or `/context` command
  - Codex: prepend to initial message
  - OpenCode: append to OPENCODE.md
  - Cursor: append to .cursorrules
- **Test**: Claude Code → SPEG switch preserves full context

#### 2.4 Cross-Agent Memory Browser UI
- Timeline view: all sessions across agents, color-coded by agent
- Context cards: extracted decisions, file changes, patterns
- Agent switcher: jump between sessions
- "What did I do?" — semantic search across all agent history
- **Test**: Search for "auth module", see results from all agents

---

### PHASE 3: Provider Picker + Skills (2-3 weeks)

**Goal**: Jcode's 40+ providers accessible through SPEG UI. Preconfigured skills.

#### 3.1 Provider Picker
- Expose Jcode's `listModels()` / `setModel()` through SPEG
- Provider catalog UI with model details, capabilities, pricing
- Per-thread model persistence
- API key management via `setApiKey()` / `clearApiKey()`
- Quick provider switching
- **Test**: Switch Claude → OpenAI → Gemini mid-conversation

#### 3.2 Preconfigured Skills
- Skill definitions in `.jcode/skills/<name>/SKILL.md` format
- Initial skill set:
  - **Graphify**: Mermaid diagram generation (auto-detects diagram requests)
  - **Ponytail**: Code formatting enforcement per language
  - **Best Practices**: TypeScript, Rust, Python, Go conventions
  - **Security Audit**: SQL injection, XSS, secret detection
  - **Doc Generator**: Auto-documentation from code
  - **Test Generator**: Unit test scaffolding
- Skill UI: toggle, config, activity indicator
- Skills work across all agents (not just SPEG)
- **Test**: Enable Graphify, agent generates Mermaid diagram

---

### PHASE 4: Memory Visualizer + Swarm UI (3-4 weeks)

**Goal**: Rich visual interfaces for memory graph and swarm system.

#### 4.1 Memory Graph Visualizer
- D3.js/Canvas-based graph visualization
- Nodes: Memory (blue), Tag (orange), Cluster (purple)
- Edges: HasTag, InCluster, RelatesTo, Supersedes, Contradicts
- Interactive: hover for details, click to expand, drag to rearrange
- Filters: by agent source, by tag, by time range, by confidence
- Cascade retrieval visualization: show how BFS finds related memories
- **Test**: Load memory graph, explore connections

#### 4.2 Memory Management UI
- Manual memory CRUD: create, edit, delete, link, tag
- Memory search: semantic + keyword
- Session memory: RAG over past sessions
- Confidence decay visualization
- Contradiction highlighting
- **Test**: Search, edit, link memories

#### 4.3 Swarm Dashboard
- Expose Jcode's swarm system through SPEG UI
- Swarm creation: agent count, roles, task description
- Agent graph: coordinator + workers + worktree managers
- Task DAG: dependency graph with status (queued/running/done/blocked/failed)
- Communication log: DMs, broadcasts, channels
- Swarm controls: spawn, stop, reassign
- **Test**: Create 3-agent swarm, watch task distribution

#### 4.4 Compactor UI
- Manual compaction triggers
- Before/after view of consolidated memories
- Deduplication preview
- Milestone creation from multiple sessions
- **Test**: Compact 10 sessions into 3 milestones

---

### PHASE 5: Terminal, VCS, Browser, Auth (3-4 weeks)

**Goal**: Terminal access, Git integration, browser preview, multi-user auth.

#### 5.1 Terminal Integration
- PTY management (node-pty)
- xterm.js rendering (NOT Ghostty WASM — keep it light)
- WebSocket terminal streaming
- Multiple terminals per thread
- Terminal context injection into composer
- **Test**: Open terminal, run build, inject output

#### 5.2 VCS Integration
- Git driver: worktree, branch, status
- Turn diff viewer (checkpoint-based)
- Branch picker
- PR/MR integration stub
- **Test**: Multi-turn session with diffs

#### 5.3 Browser Automation UI
- Jcode's built-in browser tool surfaced
- Screenshot display inline
- Browser action log in timeline
- **Test**: Agent navigates, clicks, returns screenshot

#### 5.4 Auth & Multi-User
- User registration (email/password + OAuth)
- JWT session tokens
- Per-project permissions
- Remote WebSocket access (WSS)
- **Test**: Two users, different permissions

---

### PHASE 6: Desktop, Mobile, Polish (3-4 weeks)

**Goal**: Full multi-surface experience.

#### 6.1 Desktop (Electron)
- Electron shell wrapping web app
- Native features: file dialogs, notifications, tray
- Jcode binary bundling
- Auto-updates
- **Test**: Desktop install → connect → chat

#### 6.2 Mobile (React Native + Expo)
- Shared `@speg/client-runtime`
- Push notifications
- Offline outbox
- Native terminal
- **Test**: Mobile → remote server → send message

#### 6.3 Polish
- Error boundaries
- Loading states
- Keyboard shortcuts
- Dark/light themes
- Accessibility

---

## Performance Design

SPEG is designed to be **lightweight** — the SPEG server is a thin proxy with ~100MB idle memory. Jcode handles all agent computation at ~10MB per session.

| Component | Target Memory | Approach |
|---|---|---|
| SPEG server (Bun) | <100MB idle | Thin proxy, no heavy processing |
| Jcode daemon | <50MB (no embeddings) | Jcode's native efficiency |
| Per Jcode session | ~10MB | Session multiplexing |
| Web client | <2MB initial bundle | Route-level code splitting |
| CACM watcher | <20MB | Incremental parsing, not full reloads |
| Memory graph | ~50MB (50K entries) | Stored on disk, cached in Jcode |

### What Keeps SPEG Light

- **No event-sourcing engine** — Jcode handles all that
- **No provider adapters** — Jcode has 40+ built-in
- **No WASM terminal** — xterm.js is lighter
- **No in-memory read model** — SQLite projections only
- **No synchronous projection pipeline** — async PubSub
- **Context extraction is batched** — not per-message, per-session
- **Context injection is query-time** — not precomputed

---

## Delivery Timeline

| Phase | Duration | Key Deliverable |
|---|---|---|
| **1. Foundation + CACM Core** | 3-4 weeks | CACM working for Jcode sessions, basic web chat |
| **2. CACM External Agents** | 2-3 weeks | Cross-agent context: Claude, Codex, Cursor, OpenCode |
| **3. Providers + Skills** | 2-3 weeks | Provider picker, 6 preconfigured skills |
| **4. Memory Viz + Swarm** | 3-4 weeks | Memory graph visualizer, swarm dashboard |
| **5. Terminal + VCS + Auth** | 3-4 weeks | Terminal, git, browser, multi-user |
| **6. Desktop + Mobile + Polish** | 3-4 weeks | Desktop app, mobile app, production polish |

**Total**: 16-22 weeks

---

## Research Documents

| # | File | Content |
|---|---|---|
| 1 | `01-architecture.md` | T3 Code architecture reference (35KB) |
| 2 | `02-performance-analysis.md` | T3 Code bottleneck analysis (17KB) |
| 3 | `03-implementation-plan.md` | v1 plan (superseded) |
| 4 | `04-jcode-research.md` | Jcode SDK + architecture research (11KB) |
| 5 | `05-implementation-plan-v2.md` | v2 plan (superseded) |
| 6 | `06-jcode-internals.md` | Jcode crate structure + memory internals |
| 7 | `07-implementation-plan-v3.md` | **This document** — final plan with CACM |
