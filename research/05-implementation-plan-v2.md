# SPEG — Custom AI Agent System: Implementation Plan v2

> **Updated**: 2026-08-04 | **Based on**: Full SPEG analysis + Jcode SDK research
> This plan reflects the discovery that Jcode is a **complete, production-grade platform**
> with a GA TypeScript SDK — SPEG is a UI orchestration layer on top, not a from-scratch agent system.

---

## Corrected Vision

**SPEG** is a **multi-surface orchestration UI** for Jcode. Jcode provides the agent intelligence (agents, swarms, memory, skills, MCP, browser, 40+ providers). SPEG adds what Jcode doesn't have:

- 🌐 **Web UI** — Jcode has TUI + desktop app, no web client
- 📱 **Mobile UI** — Jcode's iOS app is still in development
- 📁 **Multi-project management** — Jcode is session-scoped; SPEG adds project orchestration
- 👥 **Multi-user access** — Jcode is single-user; SPEG adds team auth
- 🌍 **Remote web access** — Jcode uses Unix sockets; SPEG adds WebSocket gateway
- 🎨 **Rich visualizations** — Swarm DAG graphs, memory browsers, analytics dashboards
- 🧩 **Skill marketplace** — Extended catalog beyond Jcode's built-in skills

---

## Corrected Architecture

```
┌─────────────────────────────────────────────────────────┐
│  SPEG CLIENTS                                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Web (React + TanStack Router + Tailwind)          │  │
│  │ Desktop (Electron wrapping web)                   │  │
│  │ Mobile (React Native + Expo)                      │  │
│  │                                                   │  │
│  │ @speg/client-runtime                              │  │
│  │  Connection supervisor, RPC, Atom state           │  │
│  │  Composer, terminal, diff viewer, panels          │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │ Effect RPC over WebSocket
                       │ (@speg/contracts)
┌──────────────────────┴──────────────────────────────────┐
│  SPEG SERVER (Bun + TypeScript + Effect)                │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Project Service (CRUD, workspace management)      │  │
│  │ Auth Service (multi-user, sessions, scopes)       │  │
│  │ WebSocket Gateway (RPC, subscriptions, push)      │  │
│  │ Jcode Instance Manager (launch/connect/health)    │  │
│  │ Skill Registry (extended marketplace)             │  │
│  │ Terminal Proxy (PTY → WebSocket)                  │  │
│  │ VCS Service (Git worktrees, diffs, PRs)           │  │
│  │ Analytics & Usage Tracking                        │  │
│  │ Persistence (SQLite: projects, users, settings)   │  │
│  └───────────────────────────────────────────────────┘  │
└──────────────────────┬──────────────────────────────────┘
                       │ @1jehuang/jcode-sdk (TypeScript)
                       │ JcodeClient.launch() or .connect()
┌──────────────────────┴──────────────────────────────────┐
│  JCODE DAEMON (Rust binary — v0.67.1+)                  │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Agents        · Session lifecycle                │  │
│  │ Swarms        · Coordinator/worker, DAG tasks     │  │
│  │ Memory        · Vector embeddings, auto-recall    │  │
│  │ Skills        · Semantic activation, slash cmds   │  │
│  │ MCP           · Shared pool, schema cache         │  │
│  │ Browser       · Firefox Agent Bridge              │  │
│  │ Providers     · 40+ (Claude, OpenAI, Gemini...)   │  │
│  │ Self-Dev      · Edit→build→test→reload            │  │
│  │ Session I/O   · Resume, import, transcript        │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### What Changed from v1

| v1 Assumption | v2 Reality |
|---|---|
| Build JSON-RPC bridge to Jcode | Use `@1jehuang/jcode-sdk` (GA, protocol v1) |
| Build agent lifecycle management | Jcode SDK handles all agent/session lifecycle |
| Build provider adapters (Claude, OpenAI...) | Jcode has 40+ built-in providers |
| Build swarm coordination engine | Jcode has full swarm system with coordinator/worker |
| Build memory system from scratch | Jcode has semantic memory with auto-extraction |
| Build MCP integration | Jcode has shared MCP pool with schema cache |
| Build browser automation | Jcode has Firefox Agent Bridge |
| Build event-sourced orchestration | SPEG server is a thin proxy, not an event store |
| 10 phases, 23-34 weeks | **6 phases, 12-18 weeks** |

---

## Implementation Phases (Revised)

---

### PHASE 1: Foundation & Jcode Integration (2-3 weeks)

**Goal**: Monorepo scaffolded, Jcode SDK integrated, basic chat working.

#### 1.1 Project Scaffolding
- Initialize pnpm monorepo: `apps/` (server, web, desktop, mobile), `packages/` (contracts, shared, client-runtime)
- TypeScript 6 + Effect 4.0 + strict mode
- Vite+ build toolchain (lint, format, test, typecheck)
- CI/CD (GitHub Actions: lint → typecheck → test)
- **Unit test**: Monorepo builds cleanly

#### 1.2 Contracts Package (`@speg/contracts`)
- Define base branded identifiers (ProjectId, ThreadId, SessionId, EnvironmentId)
- Define `WsRpcGroup` with initial RPC methods:
  - `project.list` / `project.create` / `project.delete`
  - `thread.list` / `thread.create` / `thread.sendMessage` (streaming)
  - `thread.subscribe` (streaming)
  - `server.getConfig` / `server.getSettings`
  - `terminal.create` / `terminal.write` / `terminal.subscribe`
- Include `protocolVersion` field from day one
- **Unit test**: Schema encode/decode roundtrip

#### 1.3 Jcode SDK Integration
- Install `@1jehuang/jcode-sdk` in server
- Implement `JcodeInstanceManager`:
  - `launch()` — spawn private Jcode instance per project with `JcodeClient.launch()`
  - `connect()` — attach to existing Jcode daemon with `JcodeClient.connect()`
  - Health monitoring: ping, restart on crash, version check
  - Instance pooling: one Jcode daemon handles multiple sessions
- Implement `JcodeSessionBridge`:
  - Map SPEG thread → Jcode session (`createSession`, `attachSession`)
  - Stream Jcode events → SPEG WebSocket push (`events()` iterator)
  - Route SPEG messages → Jcode `sendMessage()`
  - Handle interrupts: `cancel()`, `softInterrupt()`
  - Handle permissions: `respondToPermission()`
- **Integration test**: Start Jcode instance, create session, send message, receive streaming response

#### 1.4 Server Scaffolding
- HTTP server with WebSocket upgrade (Bun)
- SQLite persistence (WAL mode, migrations) for SPEG-specific data
- Wire `WsRpcGroup` handlers delegating to Jcode SDK
- Basic auth (token-based for MVP)
- Dev server workflow
- **Integration test**: WebSocket connects, RPC roundtrip through to Jcode

#### 1.5 Basic Web UI
- `ChatView` as composed micro-components:
  - `ChatHeader` — project name, session indicator
  - `MessageTimeline` — virtualized (LegendList)
  - `ComposerBar` — text input with send
  - `AgentStatusIndicator` — Jcode session status
- `ConnectionDriver` + `EnvironmentSupervisor` (adapted from SPEG)
- Client-side state with Effect Atoms
- **Integration test**: Open web UI, send message, see Jcode agent response stream

---

### PHASE 2: Multi-Provider & Skills UI (2-3 weeks)

**Goal**: Users can select from Jcode's 40+ providers, and SPEG's extended skills are accessible.

#### 2.1 Provider Picker
- Jcode SDK's `listModels()` + `setModel()` exposed through SPEG server
- Provider catalog UI: model list, capability badges, context windows
- Model selection persistence per thread
- Quick provider switching without losing context
- API key management: `setApiKey()` / `clearApiKey()` via SDK
- **Integration test**: Switch from Claude to OpenAI mid-conversation

#### 2.2 Extended Skill Registry
- SPEG skill marketplace on top of Jcode's built-in skill system
- Skill definitions: name, description, semantic triggers, configuration schema
- Pre-packaged skills:
  - **Graphify** — Mermaid diagram generation
  - **Ponytail** — Code formatting & style enforcement
  - **Best Practices** — Per-language best practice checking
  - **Security Audit** — Vulnerability scanning for agent output
  - **Doc Generator** — Auto-documentation from code
  - **Test Generator** — Unit test generation
- Skill UI:
  - Active skills status bar
  - Per-skill toggle (on/off)
  - Skill configuration panel
  - Slash command menu integration
- **Integration test**: Skill activated, affects agent behavior

#### 2.3 Skill ↔ Jcode Bridge
- SPEG skills registered as Jcode-compatible skill definitions
- Skill activation triggers Jcode's skill injection
- Skill results surfaced in SPEG UI (diagrams rendered inline, etc.)
- **Integration test**: Graphify skill generates Mermaid diagram visible in chat

---

### PHASE 3: Swarm & Memory UI (3-4 weeks)

**Goal**: Rich visual interfaces for Jcode's swarm and memory systems.

#### 3.1 Swarm Dashboard
- Jcode swarm sessions exposed through SDK
- Swarm creation UI:
  - Number of agents
  - Agent type selection (specialist roles)
  - Task description → automatic decomposition
- Swarm visualization:
  - Agent graph (coordinator, workers, worktree managers)
  - Agent status (idle, running, blocked, done)
  - Communication paths (DMs, broadcasts, channels)
  - Task DAG with dependencies, owner, status
- Swarm controls:
  - Spawn/stop individual agents
  - Assign/reassign tasks
  - Force stop entire swarm
- **Integration test**: 3-agent swarm solving a multi-file task

#### 3.2 Memory Browser
- Jcode memory system exposed through SDK
- Memory visualization:
  - Memory graph with cosine similarity edges
  - Search interface (semantic + keyword)
  - Memory cards with source context
  - Relevance scores
- Memory management:
  - Manual store/delete
  - Session search (RAG over past sessions)
  - Memory consolidation status
  - Staleness indicators
- **Integration test**: Search memory, find relevant past context, inject into conversation

#### 3.3 Session Management UI
- Session browser: list, search, preview
- Session resume: click to continue past conversation
- Session import: resume from Claude Code, Codex, OpenCode sessions
- Transcript viewer: full history with search
- **Integration test**: Stop server, restart, resume conversation from session list

---

### PHASE 4: Terminal, VCS & Browser (2-3 weeks)

**Goal**: Terminal access, Git integration, and browser automation surfaced in UI.

#### 4.1 Terminal Integration
- Server-side PTY management (Bun's `node-pty` or Bun.pty)
- WebSocket terminal streaming
- Simpler ANSI/xterm.js renderer (avoid Ghostty WASM for MVP)
- Multiple terminals per thread
- Terminal context injection into composer
- **Integration test**: Open terminal, run command, capture output, inject into prompt

#### 4.2 VCS Integration
- Git driver: worktree management, branch switching
- Turn checkpointing: hidden Git refs per turn
- Diff viewer: before/after per turn
- Branch picker in UI
- PR/MR integration (future: GitHub, GitLab)
- **Integration test**: Multi-turn session with diff between turns

#### 4.3 Browser Automation UI
- Jcode's built-in browser tool surfaced:
  - Browser status indicator
  - Screenshot display inline in chat
  - Page content shown as expandable blocks
  - Browser action log in timeline
- Browser setup helper: `jcode browser setup` integration
- **Integration test**: Agent uses browser to test a web page

---

### PHASE 5: Multi-User, Auth & Remote Access (2-3 weeks)

**Goal**: Team access, authentication, and remote web connectivity.

#### 5.1 Authentication
- User registration/login (email/password + OAuth)
- Session tokens with JWT
- Role-based access: admin, member, viewer
- Per-project permissions
- API key generation for CI/CD
- **Integration test**: Two users, different projects, correct access control

#### 5.2 Remote Access
- WebSocket gateway accessible over internet
- HTTPS + WSS with TLS
- Cloudflare Tunnel or Tailscale for private access
- Mobile connectivity support
- **Integration test**: Connect from mobile to remote server

#### 5.3 Multi-User Collaboration
- Shared project access
- Real-time presence (who's viewing what)
- Activity feed (who did what)
- Thread ownership and visibility
- **Integration test**: Two users in same project, see each other's activity

---

### PHASE 6: Desktop, Mobile & Polish (3-4 weeks)

**Goal**: Full multi-surface experience with production quality.

#### 6.1 Desktop App
- Electron shell wrapping web app
- Jcode binary bundling (per-platform)
- Native features: file dialogs, notifications, auto-updates
- System tray with quick actions
- Deep link handling (`speg://` protocol)
- **Integration test**: Desktop app installs, launches, connects to server

#### 6.2 Mobile App
- React Native (Expo) app
- Shared `@speg/client-runtime` with web
- Push notifications (agent completion, swarm status)
- Offline message outbox
- Native terminal rendering
- App shortcuts and widgets
- **Integration test**: Mobile connects, sends message, receives push

#### 6.3 Production Polish
- Error boundaries and recovery
- Loading states and skeletons
- Keyboard shortcuts
- Accessibility (ARIA labels, screen reader)
- Dark/light themes
- i18n infrastructure
- Analytics and usage tracking
- **Integration test**: Full user journey across all surfaces

---

## Performance Design (SPEG-Specific)

Since Jcode handles all agent computation (and does it at 14ms to first frame, ~10MB per session), SPEG's performance concerns are purely about the UI layer:

| Concern | Approach |
|---|---|
| WebSocket throughput | Effect RPC with per-message-deflate |
| UI bundle size | Route-level code splitting, lazy-loaded terminal |
| State persistence | IndexedDB with batched writes (not localStorage) |
| Chat re-renders | Composed micro-components with memo boundaries |
| Terminal rendering | xterm.js (lighter than Ghostty WASM for MVP) |
| Multi-session memory | SQLite projections, not in-memory read model |
| Jcode instance count | One daemon per server, session multiplexing |

### Resource Budgets

| Component | Target |
|---|---|
| SPEG server (Bun) | <100MB idle |
| Jcode daemon (per server) | <50MB idle (without embeddings) |
| Per Jcode session | ~10MB additional |
| Web client | <2MB initial bundle, <20MB runtime |
| SQLite | <50MB typical |

---

## Testing Strategy

### Per-Phase Requirements
Every phase closes with:
1. **Unit tests** — pure logic (schema validation, state transitions)
2. **Integration tests** — service boundaries (Jcode SDK ↔ SPEG server, server ↔ WebSocket)
3. **Contract tests** — wire protocol roundtrip
4. **E2E tests** — critical user flows

### Test Infrastructure
- Vitest for unit + integration
- Effect `TestContext` for service-level tests
- Mock Jcode SDK responses for deterministic tests
- SQLite in-memory for persistence tests
- Playwright for web UI E2E (Phase 4+)

---

## Delivery Timeline (Revised)

| Phase | Duration | Key Deliverable |
|---|---|---|
| **1. Foundation + Jcode** | 2-3 weeks | Working chat with Jcode agent via web UI |
| **2. Providers + Skills** | 2-3 weeks | Provider picker, skill marketplace, preconfigured skills |
| **3. Swarm + Memory** | 3-4 weeks | Swarm dashboard, memory browser, session management |
| **4. Terminal + VCS + Browser** | 2-3 weeks | Terminal, git integration, browser automation UI |
| **5. Auth + Remote** | 2-3 weeks | Multi-user auth, remote web access |
| **6. Desktop + Mobile + Polish** | 3-4 weeks | Desktop app, mobile app, production polish |

**Total**: 14-20 weeks (down from 23-34 weeks in v1)

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Desktop framework | **Electron** | Mature ecosystem, browser preview, SSH |
| Server runtime | **Bun** | Fast startup, good SQLite, SPEG-aligned |
| Jcode integration | **`@1jehuang/jcode-sdk`** | GA quality, protocol v1, semver stable |
| Jcode mode | **`JcodeClient.launch()`** per project | Isolation, clean lifecycle, ephemeral state |
| Contracts | Effect/Schema + `protocolVersion` | Type safety, version negotiation |
| UI state | Effect Atoms + IndexedDB | Not localStorage, batched writes |
| Terminal | xterm.js (MVP) → native (later) | Lighter than Ghostty WASM |
| Auth | JWT + OAuth (Clerk or custom) | Multi-user from Phase 5 |

---

## Documents Index

| File | Content |
|---|---|
| `research/01-architecture.md` | Complete SPEG architecture reference |
| `research/02-performance-analysis.md` | SPEG bottleneck analysis + fixes |
| `research/03-implementation-plan.md` | **v1 plan (SUPERSEDED)** — based on incorrect Jcode assumptions |
| `research/04-jcode-research.md` | Jcode architecture research — SDK, server, swarm, memory |
| `research/05-implementation-plan-v2.md` | **This document** — corrected v2 plan |
