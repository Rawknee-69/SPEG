# SPEG — Complete Architecture Reference

> Generated: 2026-08-04 | Source: Full repository analysis
> This document is the single-source-of-truth architecture reference for the SPEG monorepo.
> Every module, file role, and architectural decision is documented here.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [Architecture Principles](#3-architecture-principles)
4. [Server Architecture (apps/server)](#4-server-architecture)
5. [Web Client (apps/web)](#5-web-client)
6. [Desktop App (apps/desktop)](#6-desktop-app)
7. [Mobile App (apps/mobile)](#7-mobile-app)
8. [Packages](#8-packages)
9. [Wire Protocol & Contracts](#9-wire-protocol--contracts)
10. [Provider Adapter System](#10-provider-adapter-system)
11. [Event Sourcing Pipeline](#11-event-sourcing-pipeline)
12. [State Management](#12-state-management)
13. [Auth & Security](#13-auth--security)
14. [VCS & Checkpointing](#14-vcs--checkpointing)
15. [Performance Characteristics](#15-performance-characteristics)
16. [Development Workflow](#16-development-workflow)
17. [Architectural Roadmap](#17-architectural-roadmap)

---

## 1. Project Overview

**SPEG** is an open-source "bring-your-own-subscription" agent harness control surface. It wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode) behind a typed WebSocket server and serves web, desktop, and mobile clients.

- **100K+ users** across all surfaces
- **Monorepo**: pnpm workspace with catalog versioning
- **Stack**: TypeScript 6 + Effect 4.0.0-beta.103 + React 19 + Electron 41 + React Native (Expo 56)
- **Runtime**: Bun (primary) or Node.js 24+
- **License**: MIT (SPEG Tools Inc.)

---

## 2. Repository Structure

```
speg/
├── apps/
│   ├── server/          # Bun/Node WebSocket server (the `speg` CLI)
│   ├── web/             # React/Vite web UI
│   ├── desktop/         # Electron shell wrapping web + bundling server
│   ├── mobile/          # React Native (Expo) for iOS/Android
│   └── marketing/       # Astro-based marketing site (t3.codes)
├── packages/
│   ├── contracts/       # Effect/Schema wire types (root dependency)
│   ├── shared/          # ~50 shared utility modules
│   ├── client-runtime/  # Shared client logic (connection, state, RPC)
│   ├── effect-acp/      # OpenAI ACP protocol client (Effect)
│   ├── effect-codex-app-server/ # Codex App Server protocol client
│   ├── ssh/             # SSH auth, commands, tunneling
│   └── tailscale/       # Tailscale integration
├── infra/
│   └── relay/           # SPEG Connect relay server
├── native/
│   ├── libghostty-vt/   # Ghostty VT library (Rust → WASM)
│   └── resource-monitor/ # Native resource monitor (Rust)
├── docs/
│   ├── architecture/    # Terminal renderers design
│   ├── internals/       # Glossary, architecture, providers, remote, CI
│   ├── operations/      # Release, observability runbooks
│   └── user/            # Install, keybindings, permissions, remote
├── .plans/              # 30+ architectural plans (numbered 01–20 + named)
├── .repos/              # Vendored reference repos (alchemy-effect, effect-smol)
├── .agents/             # Agent skills (ios-debugger, ios-simulator, test-speg-*)
├── oxlint-plugin-speg/ # Custom oxlint ESLint plugin (3 rules)
├── scripts/             # Dev runner, build, release tooling
├── patches/             # 13 pnpm patches
├── experiments/         # Experiment files
└── assets/              # App icons (dev, nightly, prod)
```

---

## 3. Architecture Principles

### 3.1 Three-Tier Client-Server Model

```
Clients (web/desktop/mobile)
    │  shared: @speg/client-runtime
    │  (connection supervisor, RPC session, Atom state)
    ▼
Effect RPC over WebSocket (/ws)
    │  contract: @speg/contracts
    ▼
apps/server (execution boundary)
    │  orchestration engine (event-sourced)
    │  provider driver registry
    │  checkpointing, VCS, terminals, filesystem
    ▼
Agent CLIs: Codex, Claude, Cursor, Grok, OpenCode
```

### 3.2 Key Design Decisions

1. **Server is the execution boundary** — provider processes, terminals, git, filesystem all live on the server. Clients are "dumb terminals" that render state.

2. **Event-sourced orchestration** — Command → Decider → Events → Projector → Read Model. One SQL transaction per command.

3. **Effect RPC, not hand-rolled push** — Typed `WsRpcGroup` with ~70 methods. Streaming members replace broadcast bus.

4. **Shared client runtime** — Web and mobile compose `@speg/client-runtime` identically; they differ only in the platform layer.

5. **Provider-neutral architecture** — `ProviderService` routes operations without knowing which agent is behind them. Provider-specific divergence uses `getCapabilities()`.

6. **Complexity at adapter boundary** — Orchestration stays pure, UI stays dumb, adapters handle provider-specific translation.

7. **Drainable workers** — Async follow-up work runs in queue-backed workers (`DrainableWorker`) with deterministic `drain()` for tests.

---

## 4. Server Architecture (apps/server)

### 4.1 Entry Point & CLI

**File**: `apps/server/src/bin.ts`
- Defines CLI via `Command.make("speg")` with subcommands: `start`, `serve`, `pair`, `auth`, `project`, `service`, `connect`
- Default handler calls `runServerCommand(flags)` from `cli/server.ts`

### 4.2 Server Startup Sequence

**File**: `apps/server/src/server.ts` (28KB)

`makeServerLayer` uses a **deferred activation barrier** pattern:

1. **Pre-activation**: Builds dependency stack bottom-up:
   - **SqlitePersistenceLayerLive** — opens DB, enables WAL + foreign keys, runs migrations
   - **OrchestrationLayerLive** — event store, projection pipeline, snapshot queries, engine
   - **Persistence projections** — Thread, project, message, activity, session, turn, checkpoint, approval repos (all SQLite-backed)
   - **Provider layers** — `ProviderInstanceRegistryHydrationLive`, `ProviderServiceLive`, `ProviderAdapterRegistryLive`, `ProviderSessionDirectoryLive`
   - **VCS** — Git driver, VCS driver registry, worktree, provisioning, status broadcasting
   - **Reactor layer** — `OrchestrationReactor`, `ProviderRuntimeIngestion`, `ProviderCommandReactor`, `CheckpointReactor`, `ThreadDeletionReactor`, `AgentAwarenessRelay`
   - **Auth** — `EnvironmentAuth`, `ServerSecretStore`, session/pairing stores
   - **Workspace, terminal, preview, telemetry, analytics**

2. **Deferred activation**: A `Deferred<void>` (`ServerActivation`) gates everything. Subsystems park behind it via `forkParked()` — they fork their fiber but block on `await(activation)` before real work.

3. **HTTP server binding**: `HttpServer` starts listening.

4. **Activation**: `activation` is resolved → all subsystem fibers unpark.

5. **Post-activation**: Persists runtime state (port, PID), sets up Tailscale Serve, reconciles cloud tunnel links.

6. **Launch**: `Layer.launch(makeServerLayer)` — runs the entire layered Effect application.

### 4.3 WebSocket Layer

**File**: `apps/server/src/ws.ts` (90KB, ~2000 lines) — largest single file

- Uses Effect's `RpcServer` + `WsRpcGroup` over a single WebSocket endpoint
- Each authenticated connection creates a scoped `WsRpcGroup`
- **Authorization**: Every RPC method wrapped with `authorizeEffect`/`authorizeStream` checking `currentSession.scopes` against `requiredScopeForRpcMethod`
- **Observability**: All RPC methods instrumented with `observeRpcEffect`/`observeRpcStream`

**RPC Method Categories** (~70 total):

| Category | Examples |
|---|---|
| Orchestration | `dispatchCommand`, `getTurnDiff`, `getFullThreadDiff`, `searchThreads`, `subscribeShell`, `subscribeThread` |
| Server | `serverProbe`, `serverGetConfig`, `serverRefreshProviders`, `serverUpdateProvider`, `serverGetSettings`, `serverUpdateSettings`, keybinding CRUD, diagnostics |
| Workspace | `projectListEntries`, `projectReadFile`, `projectWriteFile`, `projectSearchFiles`, `projectSearchContents`, `filesystemBrowse`, `launchEditor`, `assetsCreateUrl` |
| Terminal | `terminalCreate`, `terminalClose`, `terminalResize`, `terminalWrite`, `terminalSubscribe` |
| Preview | `previewCreate`, `previewClose`, `portDiscover`, `portStartScan` |
| VCS | `subscribeVcsStatus`, `vcsRefreshStatus`, `vcsPull`, `gitRunStackedAction`, source control |

### 4.4 Key Subsystems

#### Orchestration Engine

| File | Role | Size |
|---|---|---|
| `orchestration/orchestrationLayer.ts` | Composes all orchestration services | — |
| `orchestration/OrchestrationEngine.ts` | Serial command processor, in-memory read model, event publishing | — |
| `orchestration/decider.ts` | Pure function: (command + readModel) → events | 41KB |
| `orchestration/commandInvariants.ts` | Pre-condition checks before event generation | — |
| `orchestration/projector.ts` | Pure function: (model + event) → new model | 26KB |
| `orchestration/ProjectionPipeline.ts` | 9 SQLite-backed projectors for denormalized reads | 63KB |
| `orchestration/commandReceiptRepository.ts` | Idempotency via command receipts | — |
| `orchestration/orchestrationProjectionRepo.ts` | Read-model snapshot queries | — |

#### Provider System

| File | Role |
|---|---|
| `provider/ProviderAdapter.ts` | Interface: launch, connect, sendTurn, interrupt, streamEvents |
| `provider/ProviderService.ts` | Cross-provider orchestration, validates inputs |
| `provider/ProviderSessionDirectory.ts` | Tracks active provider sessions |
| `provider/ProviderAdapterRegistry.ts` | Maps `ProviderInstanceId` → adapter |
| `provider/ProviderRuntimeIngestion.ts` | Translates runtime events → orchestration commands |
| `provider/ProviderCommandReactor.ts` | Domain intent → `ProviderService` calls |
| `provider/ProviderRegistry.ts` | Enumerates available providers for UI |
| `provider/ProviderSessionReaper.ts` | Cleans up stale sessions on startup |
| `provider/drivers/claude/ClaudeAdapter.ts` | Claude SDK adapter |
| `provider/drivers/codex/` | Codex adapter (ACP protocol) |
| `provider/drivers/cursor/` | Cursor adapter |
| `provider/drivers/grok/` | Grok adapter |
| `provider/drivers/opencode/` | OpenCode adapter |

#### Checkpointing

| File | Role |
|---|---|
| `checkpointing/CheckpointStore.ts` | Git-based workspace checkpoint capture/restore/diff |
| `checkpointing/CheckpointDiffQuery.ts` | Serves diff requests to WebSocket API |
| `checkpointing/CheckpointReactor.ts` | Reacts to turn completion, captures checkpoints |

#### Persistence

| File | Role |
|---|---|
| `persistence/sqlite/SqlitePersistenceLayer.ts` | SQLite setup (WAL, FK, migrations) |
| `persistence/orchestrationEventStore.ts` | Append-only event log |
| `persistence/projection/` | 9 denormalized projection tables |

#### VCS/Git

| File | Role |
|---|---|
| `git/GitVcsDriver.ts` | VCS driver implementation for Git |
| `git/GitWorktreeManager.ts` | Worktree creation, switch, cleanup |
| `vcs/VcsDriverRegistry.ts` | VCS driver registry |
| `vcs/VcsStatusBroadcaster.ts` | Broadcasts VCS status to clients |
| `sourceControl/` | Source control provider (GitHub, etc.) |

---

## 5. Web Client (apps/web)

### 5.1 Tech Stack
- **React 19.2.6** + **TanStack Router** + **Vite**
- **Tailwind CSS** for styling
- **Lexical** for rich text editor
- **@legendapp/list** for virtualized lists
- **@dnd-kit** for drag-and-drop
- **Zustand** for client-local UI state
- **Effect Atoms** for server-synced state
- **Ghostty WASM** for terminal emulation

### 5.2 Boot Sequence

1. `main.tsx` → `createRoot` → chooses `HashHistory` (Electron) or `BrowserHistory`
2. Wraps in `ClerkProvider` + `ManagedRelayAuthProvider`
3. `AppRoot` → `AppAtomRegistryProvider` (single global `AtomRegistry`)
4. `<RouterProvider>` — TanStack Router
5. Connection runtime establishes WebSocket → loads shell/thread snapshots from IndexedDB cache → seeds atoms → subscribes to live streams

### 5.3 Component Architecture

```
AppRoot
└── AppAtomRegistryProvider
    └── RouterProvider
        └── __root.tsx (RootRouteView)
            ├── CommandPalette
            ├── AppSidebarLayout
            │   └── <Outlet />
            │       ├── _chat.tsx (ChatRouteLayout)
            │       │   ├── _chat.index.tsx → IndexDraftLanding
            │       │   ├── _chat.$environmentId.$threadId.tsx → ChatView
            │       │   └── _chat.draft.$draftId.tsx → ChatView
            │       ├── /settings.tsx → SettingsPanels
            │       ├── /pair.tsx → PairingRouteSurface
            │       └── /connect.tsx → ConnectCliAuthSurface
            ├── ToastProvider
            └── PreviewAutomationHosts / ElectronBrowserHost
```

### 5.4 ChatView (6189 lines, 232KB)

Core rendering structure:
```
ChatView → DiffWorkerPoolProvider → ChatViewContent
├── ChatHeader (project title, scripts, branch info)
├── ThreadErrorBanner
├── Main flex row:
│   ├── Chat Column:
│   │   ├── ProviderStatusBanner
│   │   ├── MessagesTimeline (LegendList virtualized)
│   │   └── Composer overlay:
│   │       ├── DraftHeroHeadline
│   │       ├── ComposerBannerStack
│   │       ├── ChatComposer (glass shell, max-w-3xl)
│   │       └── BranchToolbar
│   └── Right Panel:
│       └── RightPanelTabs (plan, diff, files, file, preview, terminal)
```

### 5.5 Composer System

**composerDraftStore.ts** (141KB): Zustand + localStorage persistence. Stores prompt text, images, terminal contexts, element contexts, preview annotations, model selections, runtime mode.

**ChatComposer.tsx** (126KB): Main composer UI with ~80 props. Sub-components:
- `ComposerPromptEditor` (Lexical-based, 56KB) — plaintext with decorator nodes for @mentions, @skills, terminal contexts
- `ProviderModelPicker` — model/instance selection
- `ComposerCommandMenu` — slash commands (model/plan/default)
- `ComposerFooterModeControls` — interaction mode + runtime mode toggles
- `ComposerPrimaryActions` — send/interrupt buttons
- `ContextWindowMeter` — token usage visualization

**Send flow**: gather prompt → assemble with contexts → create/update thread → dispatch `thread.turn.start` → stream activities → derive timeline entries

### 5.6 Terminal

**Ghostty WASM** (`src/terminal/ghostty/`):
- `ghostty-vt.wasm` (631KB) — Rust-compiled terminal emulator
- `GhosttyTerminal` class — wraps WASM surface, manages rows/cols, selection, scrollback (10K rows)
- `GhosttySurface` React component — canvas-based cell rendering with WebGL font atlas
- Font: JetBrains Mono + Nerd Font Symbols (WOFF2)

---

## 6. Desktop App (apps/desktop)

### 6.1 Architecture
- **Electron 41.5.0** shell wrapping the web app
- Embeds and manages its own `speg` server process
- `DesktopBackendManager` spawns server, resolves port (default 3773), provides auto-restart with exponential backoff
- `DesktopBackendPool` supports concurrent backends (Windows primary + optional WSL)
- Custom `speg://` protocol for loading the renderer

### 6.2 IPC Bridge
- Typed Effect-based IPC (`DesktopIpc` + `preload.ts`)
- `desktopBridge` exposed on `window` via `contextBridge`
- **80+ IPC channels**: folder picking, native dialogs, theme, context menus, external URLs, window state, auto-updates, branding, client settings, connection catalog, SSH, server exposure, WSL control, in-app browser preview

### 6.3 Platform-Exclusive Features
- **SSH-managed remote environments** — `@speg/ssh` + `DesktopSshEnvironment`
- **WSL backend** — second server instance inside WSL2
- **In-app browser preview** — Chromium `WebContents` with Playwright automation
- **Auto-updates** — `electron-updater` with channel selection
- **Tailscale serve** — network exposure
- **Native dialogs** — folder picker, SSH password prompts
- **Safe storage** — OS keychain via `electron-safeStorage`

---

## 7. Mobile App (apps/mobile)

### 7.1 Tech Stack
- **React Native 0.85.3** + **Expo SDK 56**
- Navigation: `@react-navigation/native-stack`
- Native modules: `speg-composer-editor`, `speg-markdown-text`, `speg-review-diff`, `speg-terminal`
- SQLite: `expo-sqlite` for cached snapshots
- Push: `expo-notifications` + `expo-widgets` (Live Activities on iOS)

### 7.2 Platform Differences from Web

| Feature | Implementation |
|---|---|
| Connectivity | `expo-network` instead of `navigator.onLine` |
| Wakeups | React Native `AppState` lifecycle events |
| Auth | `@clerk/expo` |
| SSH | Rejected (desktop-only) |
| Terminal | Native view module |
| Review diffs | Native diff rendering with Shiki |
| Markdown | `react-native-nitro-markdown` |
| Push | Live Activities + remote push via SPEG Connect |
| Offline | `thread-outbox-manager.ts` queues operations offline |
| UI | Liquid-glass effects, haptics, font scaling |
| Background | Reports client activity on 25s interval |

### 7.3 Shared with Web
Both use `@speg/client-runtime` identically for:
- Connection supervisor (retry with exponential backoff)
- RPC sessions
- Atom-based domain state
- Environment registry

---

## 8. Packages

### 8.1 @speg/contracts (Root Dependency)

**Role**: Effect/Schema wire types + small derived helpers. No heavy runtime logic.

**Exports**: `.` (index), `./settings`, `./relay`

**Key contents**:
- `baseSchemas.ts` — branded identifiers (ThreadId, ProjectId, EnvironmentId, etc.)
- `rpc.ts` — ~70 typed RPC method definitions in `WsRpcGroup`
- `ServerConfig` — initial sync payload (environment, providers, settings, keybindings)
- `OrchestrationThread` / `OrchestrationShellSnapshot` — main data contracts
- `ProviderRuntime` contracts (38KB) — all runtime event shapes
- `ForwardCompatibleArray` — silently drops unknown union members for version-skew survival
- `Relay` contracts — device registration, environment linking, DPoP, push notifications

### 8.2 @speg/shared (~50 subpath exports)

**Key modules**:
- **Workers**: `DrainableWorker` (transactional queue), `KeyedCoalescingWorker` (keyed atomic merge)
- **Networking**: `Net` (port availability, ephemeral reservation), `advertisedEndpoint`, `httpReadiness`
- **Relay**: `relayClient` (cloudflared download/verify/install), `relayJwt`, `relayAuth`, `relaySigning`, `dpop`
- **Observability**: `observability` (trace records, rotating file sink), `logging`, `httpObservability`
- **Schema**: `schemaJson` (safe diagnostics formatting), `schemaYaml`, `Struct` (deepMerge)
- **Model**: `model` (selection helpers, default resolution, slug aliases)
- **Other**: `semver`, `shell`, `git`, `sourceControl`, `serverSettings`, `keybindings`, `searchRanking`, `qrCode` (42KB), `preview`, `hostProcess`, `cliArgs`, `connectAuth`, `path`, `devHome`, `devProxy`

### 8.3 @speg/client-runtime (Subpath-only exports)

**Role**: Shared client behavior for web and mobile. No root export.

**Subsystems**:
- `connection/` — `ConnectionDriver`, `ConnectionResolver`, `EnvironmentSupervisor` (reconnect loop), `EnvironmentRegistry`
- `rpc/` — `RpcSession`, `RpcClient.make(WsRpcGroup)`, subscription auto-reconnect
- `authorization/` — `RemoteEnvironmentAuthorization` (bearer + DPoP paths), token caching
- `state/` — **35+ modules** using Effect's `Atom` system:
  - `threads.ts` — per-thread `SubscriptionRef` with cached+live+persist pattern
  - `shell.ts` — environment overview
  - `server.ts` — server config, update state machine
  - `runtime.ts` — core atom infrastructure (query, subscription, command atoms)
  - `terminal.ts`, `preview.ts`, `vcs.ts`, `git.ts`, `projects.ts`, `filesystem.ts`, `auth.ts`
  - `threadReducer.ts` (21KB) — applies stream events to build full thread state
  - `shellReducer.ts` — shell stream event reducer

**Connection targets**:
- `PrimaryConnectionTarget` — local loopback (same-origin cookie auth)
- `BearerConnectionTarget` — remote with bearer token
- `RelayConnectionTarget` — cloudflared tunnel
- `SshConnectionTarget` — SSH tunnel (desktop-only)

### 8.4 Other Packages

| Package | Role |
|---|---|
| `effect-acp` | Effect-idiomatic OpenAI ACP client for Codex |
| `effect-codex-app-server` | Effect-idiomatic Codex App Server protocol client |
| `@speg/ssh` | SSH auth, commands, config, errors, tunneling |
| `@speg/tailscale` | Tailscale integration |

---

## 9. Wire Protocol & Contracts

### 9.1 RPC Method Map (~70 methods)

All methods are declared in `packages/contracts/src/rpc.ts` using `Rpc.make()` and assembled into `WsRpcGroup`.

Every RPC is typed as `payload → success | error`, with streaming methods having `stream: true`.

### 9.2 Version-Skew Mechanism

**`ForwardCompatibleArray<Element>`**: Silently drops unknown union members during decode so older clients survive servers sending newer variants. This is the critical decoupling mechanism — permissive on decode, strict on encode.

**`ServerConfig.capabilities`**: Optional boolean flags that gate client behavior (`connectionProbe`, `threadSettlement`, `threadSnooze`, `serverSelfUpdate`). Absent = unsupported on that server.

**No explicit protocol version field**: Schema compatibility via `ForwardCompatibleArray` + capability flags is the sole version-skew mechanism.

### 9.3 Key Contracts

- **`ModelSelection`** — legacy decode absorbs `{provider, model}` objects and promotes to `{instanceId, model}`
- **`ExecutionEnvironmentDescriptor`** — `{environmentId, label, platform, serverVersion, capabilities}`
- **`ServerAuthPolicy`** — literal union: `"desktop-managed-local" | "loopback-browser" | "remote-reachable" | "unsafe-no-auth"`
- **`OrchestrationThread`** — full thread data contract
- **`OrchestrationShellSnapshot`** — environment overview data contract
- **`ProviderRuntime`** (38KB) — all runtime event shapes from all provider drivers

---

## 10. Provider Adapter System

### 10.1 Layer Stack

| Layer | Role |
|---|---|
| `ProviderDriver` | Interface: launch, connect, sendTurn, interrupt, streamEvents |
| `ProviderAdapter` (per-provider) | Implements `ProviderDriver`, translates provider-specific events → `ProviderRuntimeEvent` |
| `ProviderService` | Cross-provider orchestration, routes turns, emits unified event stream |
| `ProviderSessionDirectory` | Tracks active sessions (thread→session mapping) |
| `ProviderAdapterRegistry` | Maps `ProviderInstanceId` → adapter |
| `ProviderRegistry` | Enumerates available providers for UI |
| `ProviderSessionReaper` | Cleans up stale sessions on startup |

### 10.2 Provider Event Flow

1. Client sends `dispatchCommand({ type: "thread.turn.start" })` via WebSocket
2. OrchestrationEngine validates → writes domain event
3. `ProviderCommandReactor` listens → calls `ProviderService.sendTurn()`
4. `ProviderService` looks up adapter → calls `adapter.sendTurn()`
5. Adapter sends messages to agent CLI → emits `ProviderRuntimeEvent`s
6. `ProviderRuntimeIngestion` translates runtime events → orchestration commands
7. Commands flow back through orchestration engine → domain events → projectors → SQLite → WebSocket push

### 10.3 Built-in Adapters

- **ClaudeAdapter**: Wraps `@anthropic-ai/claude-agent-sdk`'s `query()` sessions
- **CodexAdapter**: OpenAI ACP protocol via `effect-acp`
- **CursorAdapter**: Cursor CLI integration
- **GrokAdapter**: Grok Build integration
- **OpenCodeAdapter**: OpenCode SDK integration

### 10.4 Provider-Neutral Guardrails

- No generic runtime API may depend on provider-native event names
- Provider-specific divergence uses `ProviderService.getCapabilities()`, not `if provider === "codex"` branches
- All provider events flow through canonical `ProviderRuntimeEvent` stream

---

## 11. Event Sourcing Pipeline

### 11.1 Full Cycle: Command → Read Model

```
Client dispatchCommand()
    │
    ▼
[Command Queue — unbounded, serial worker]
    │
    ▼
decider.ts — pure function: (command + readModel) → PlannedOrchestrationEvent[]
    │  checks commandInvariants first
    │
    ▼
[SQLite Transaction — atomic]
    ├── eventStore.append(event) — INSERT into orchestration_events
    ├── projectEvent(readModel, event) — update in-memory read model
    ├── projectionPipeline.projectEvent(event) — update 9 SQLite projection tables
    └── commandReceiptRepository.upsert() — idempotency
    │
    ▼
[Publish to PubSub]
    ├── subscribeShell streams
    ├── subscribeThread streams
    ├── ProviderRuntimeIngestion
    ├── CheckpointReactor
    └── AgentAwarenessRelay
```

### 11.2 Event Store Schema

- `orchestration_events`: `sequence` (global auto-increment), `stream_id`, `stream_version` (per-aggregate), `event_type`, `payload_json`, `metadata_json`, `actor_kind`
- `orchestration_command_receipts`: `(commandId, status, resultSequence, error)` — idempotency

### 11.3 Projection Tables (9 tables)

- `projection_projects`
- `projection_threads` (with derived columns: pendingApprovalCount, pendingUserInputCount, shellSummary)
- `projection_thread_messages` (with attachments_json)
- `projection_thread_activities` (with sequence for ordering)
- `projection_thread_sessions`
- `projection_thread_turns` (with checkpointRef, diffSummary)
- `projection_thread_proposed_plans`
- `projection_checkpoints`
- `projection_pending_approvals`

### 11.4 Bounds

- `MAX_THREAD_MESSAGES = 2_000`
- `MAX_THREAD_CHECKPOINTS = 500`
- `SHELL_RESUME_MAX_GAP = 1000` events
- `THREAD_RESUME_MAX_GAP = 1000` events

### 11.5 Reactors (6 services)

1. **OrchestrationEngine** — Command authority, serial worker, in-memory read model
2. **ProviderCommandReactor** — Domain intent → ProviderService calls (DrainableWorker)
3. **ProviderRuntimeIngestion** — Runtime events → orchestration commands (10K caches, 2hr TTL)
4. **CheckpointReactor** — Captures Git checkpoints on turn completion
5. **ThreadDeletionReactor** — Cleans up worktrees, terminals, provider sessions
6. **AgentAwarenessRelay** — Relays agent presence to clients

---

## 12. State Management

### 12.1 Server-Side: Event-Sourced

- In-memory `OrchestrationReadModel` maintained by serial worker
- SQLite-backed projections for queries
- PubSub for live push to clients

### 12.2 Client-Side: Dual Approach

**Effect Atoms** (server-synced, via `@effect/atom-react`):
- `state/server.ts` — server config, providers, settings, keybindings
- `state/shell.ts` — environment shell
- `state/threads.ts` — per-thread `SubscriptionRef` with cached+live+persist
- `state/terminal.ts`, `state/vcs.ts`, `state/preview.ts`, `state/projects.ts`
- Sync pattern: load cached → seed SubscriptionRef → subscribe live → debounce-persist (500ms)

**Zustand Stores** (client-local UI, all with localStorage persistence):
- `composerDraftStore.ts` (141KB) — composer content
- `terminalUiStateStore.ts` — terminal open/height/active
- `rightPanelStore.ts` — right panel surfaces
- `uiStateStore.ts` — project expansion, visit timestamps
- `diffPanelStore.ts`, `previewStateStore.ts`, `previewMiniPlayerStore.ts`
- `promptStashStore.ts`, `threadSelectionStore.ts`

### 12.3 Atom Command Concurrency Modes

- `parallel` — every invocation runs independently
- `serial` — FIFO queue per key
- `singleFlight` — deduplicate concurrent calls
- `latest` — coalesce queued calls, keep newest

---

## 13. Auth & Security

### 13.1 Auth Model (Plan 18)

**Policy modes**:
- `DesktopManagedLocalPolicy` — auto-pair for local desktop
- `LoopbackBrowserPolicy` — auto-pair for loopback browser
- `RemoteReachablePolicy` — auth required
- `UnsafeNoAuthPolicy` — no auth (development)

**Service model** (Effect-native):
- `ServerAuth` — main facade
- `BootstrapCredentialService` — bootstrap grants
- `SessionCredentialService` — cookies + bearer tokens
- `ServerSecretStore` — signing keys
- `AuthRouteGuards` — HTTP middleware

### 13.2 WebSocket Authorization

Every RPC method is wrapped with scope-checking:
```typescript
authorizeEffect(currentSession.scopes, requiredScopeForRpcMethod[method])
```

### 13.3 Remote Access

- **Bearer tokens**: Manually paired direct HTTP/WS
- **DPoP tokens**: Relay-based with bootstrap credential exchange
- **SSH tunnels**: Desktop-only, provisioned via `@speg/ssh`
- **Tailscale**: Endpoint provider for bearer path

---

## 14. VCS & Checkpointing

### 14.1 VCS Driver Abstraction (Plan 19)

Provider-neutral VCS layer:
- `VcsDriver` — local repository mechanics
- `VcsRepositoryResolver` — detect VCS kind + root
- `VcsProcess` — Effect-native process execution
- Provider-neutral nouns: `WorkingCopyStatus`, `ChangeSet`, `RefName`
- Driver capabilities: `kind`, `supportsWorktrees`, `supportsBookmarks`
- Freshness: `live-local`, `cached-local`, `cached-remote`, `explicit-remote`

### 14.2 Checkpointing Flow

1. Turn starts → session recorded
2. Agent produces output → `ProviderRuntimeIngestion` emits `turn.completed`
3. `CheckpointReactor` captures Git checkpoint (hidden ref)
4. Diff computed between start/end refs
5. `thread.turn-diff-completed` event dispatched
6. Client can query diffs via `getTurnDiff`

### 14.3 Source Control Provider (Plan 20)

Pluggable hosting layer:
- `SourceControlProvider` — GitHub/GitLab/Azure DevOps
- `ChangeRequest` — PR/MR abstraction
- Rate-limit awareness with retry/reset metadata

---

## 15. Performance Characteristics

### 15.1 Identified Bottlenecks

| Concern | Severity | Detail |
|---|---|---|
| Serial command worker | High | ONE fiber processes all orchestration commands. Slow commands block everything. |
| In-memory read model | Medium | Holds all active projects/threads/messages. Rebuilt from SQLite on startup. |
| Synchronous projection pipeline | High | All 9 projectors run inside the SQL transaction per event. |
| Shell event DB re-reads | Medium | Coalesced but re-reads full projections after each burst. |
| No WebSocket message batching | Low | Events emitted individually through PubSub. |
| Monolithic ChatView | High | 6189-line component, 80+ props, cascading re-renders. |
| composerDraftStore localStorage | Medium | Every keystroke triggers debounced localStorage write. |
| Ghostty WASM terminal | Medium | 631KB WASM, per-thread instances mounted but hidden. |
| Multiple Zustand persist stores | Medium | Each has own persist middleware, many serializations. |
| Effect Schema overhead | Low | O(n) validation per ForwardCompatibleArray payload. |
| ProviderRuntimeIngestion caches | Low | 10K capacity, 2hr TTL, no eager eviction. |
| No code splitting | Medium | Single bundle, no React.lazy for routes. |
| Attachment file I/O in projection | Low | File operations inside event processing path. |

### 15.2 Optimizations Already in Place

- Shell event coalescing: 50ms windows, concurrency 8
- WebSocket per-message-deflate with context takeover
- Resume gap bounds (1000 events) preventing OOM
- LegendList virtualization for message timeline
- `KeyedCoalescingWorker` for state synchronization
- Subscription auto-reconnect with backoff (1s→16s capped)
- IndexedDB/SQLite caching for offline resilience
- WAL mode + foreign keys in SQLite

---

## 16. Development Workflow

### 16.1 Tooling
- **Package manager**: pnpm 11.10.0
- **Build toolchain**: `vite-plus` (vp)
- **Linter**: oxlint with custom `oxlint-plugin-speg` (3 rules)
- **Formatter**: vite-plus formatter
- **Type checker**: TypeScript 6 + Effect language service (20+ diagnostic rules)
- **Tests**: vitest (node environment, 60s timeouts)
- **CI**: GitHub Actions (lint, typecheck, test, optional smoke-test)

### 16.2 Dev Servers
- `vp i` — install dependencies
- `vp run dev` — start server + web
- `vp test run <files>` — run targeted tests
- Worktree-isolated `.speg` state directory
- Stable ports derived from worktree path

### 16.3 Custom Lint Rules
- `no-global-process-runtime` (error)
- `no-inline-schema-compile` (warn)
- `no-manual-effect-runtime-in-tests` (error)
- `namespace-node-imports` (error)

### 16.4 Key Commands

| Command | Purpose |
|---|---|
| `vp i` | Install dependencies |
| `vp run dev` | Start dev server (server + web) |
| `vp run dev:share` | Start with Tailscale sharing |
| `vp run dev:server` | Server only |
| `vp run dev:web` | Web only |
| `vp run dev:desktop` | Desktop app |
| `vp test run <files>` | Run specific tests |
| `vp run typecheck` | Type check |
| `vp run lint` | Lint |
| `vp run fmt` | Format |

---

## 17. Architectural Roadmap

### Phase A: Stabilization — MOSTLY DONE
- Normalize shared code, decompose monoliths
- Replace timing-sensitive WS with deterministic primitives
- Hardened runtime: `DrainableWorker`, `ServerPushBus`, `RuntimeReceiptBus`

### Phase B: Effect Migration + Event Sourcing — IN PROGRESS
- Rewrite backend into Effect-TS services
- Full event envelope, DB-backed projections, idempotent command receipts
- Wire ProviderService into wsServer (PR 1 of plan 12)
- Spec 1:1 cutover (disruptive persistence layer reset)

### Phase C: Feature Expansion — DESIGNED, EARLY IMPLEMENTATION
- Claude Code integration (first new provider, template pattern)
- VCS driver/provider abstraction (Git, Jujutsu, GitHub, GitLab, Azure DevOps)
- Auth model for remote access
- `AdvertisedEndpoint` contract for connection discovery

---

## Appendix: File Size Reference

| File | Size | Role |
|---|---|---|
| `apps/server/src/ws.ts` | 90KB | WebSocket RPC layer |
| `apps/server/src/orchestration/ProjectionPipeline.ts` | 63KB | 9 SQLite projectors |
| `apps/server/src/orchestration/decider.ts` | 41KB | Command → events |
| `apps/server/src/orchestration/projector.ts` | 26KB | Event → read model |
| `apps/server/src/server.ts` | 28KB | Server construction |
| `apps/server/src/provider/ProviderRuntimeIngestion.ts` | ~30KB | Runtime → orchestration |
| `apps/web/src/composerDraftStore.ts` | 141KB | Composer state |
| `apps/web/src/components/chat/ChatComposer.tsx` | 126KB | Composer UI |
| `apps/web/src/components/chat/ChatView.tsx` | ~232KB (6189 lines) | Chat view |
| `apps/web/src/components/ComposerPromptEditor.tsx` | 56KB | Lexical editor |
| `apps/web/src/session-logic.ts` | 41KB | Session derivation |
| `apps/web/src/terminal/ghostty/surface.ts` | 53KB | Canvas terminal |
| `apps/web/src/terminal/ghostty/core.ts` | 43KB | Terminal core |
| `packages/contracts/src/providerRuntime.ts` | 38KB | Provider runtime types |
| `packages/shared/src/shell.ts` | 22KB | Shell helpers |
| `packages/shared/src/qrCode.ts` | 42KB | QR code generation |
| `apps/server/test/server.test.ts` | 279KB | Server tests |
| `apps/server/test/ProjectionPipeline.test.ts` | 98KB | Projector tests |
| `apps/server/test/ProviderRuntimeIngestion.test.ts` | 118KB | Ingestion tests |
