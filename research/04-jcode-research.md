# Jcode — Architecture Research Notes

> Generated: 2026-08-04 | Sources: jcode.sh, GitHub README, SDK docs, SERVER_ARCHITECTURE.md, SWARM_ARCHITECTURE.md

---

## Key Discovery: Jcode is Production-Ready

Jcode (v0.67.1, 15.8K stars, 6,672 commits) is NOT a raw harness to wrap. It is a **complete, production-grade coding agent platform** with:

- **GA TypeScript SDK** (`@1jehuang/jcode-sdk` on npm) — semver stable, protocol v1
- **Server mode** — `jcode serve` with multi-client Unix socket architecture
- **Desktop app** — shipped in v0.67.0
- **iOS app** — coming soon with Tailscale remote access
- **40+ built-in providers** — Claude, OpenAI, Gemini, Copilot, OpenRouter, and many more
- **Swarm system** — multi-agent coordination with coordinator/worker architecture
- **Semantic memory** — vector embeddings, automatic extraction, cosine similarity retrieval
- **Skills system** — on-demand semantic activation, slash commands
- **MCP support** — shared across sessions, instant startup via schema cache
- **Browser automation** — Firefox Agent Bridge (Chrome planned)
- **Self-dev mode** — agent modifies own source, rebuilds, reloads binary
- **Session resume** — resume from Claude Code, Codex, OpenCode, Pi sessions

---

## Jcode Architecture

### Server Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    JCODE SERVER (Rust)                    │
│                                                          │
│  jcode serve                                             │
│  ├── Unix socket: /run/user/$UID/jcode.sock              │
│  ├── API socket:  /run/user/$UID/jcode-api.sock          │
│  ├── Registry:    ~/.jcode/servers.json                  │
│  ├── Provider backend (40+ providers)                    │
│  ├── MCP pool (shared across sessions)                   │
│  └── Sessions (fox, bear, owl...)                        │
└──────────┬───────────────────────────────────────────────┘
           │ Unix socket
    ┌──────┼──────┬──────────┐
    ▼      ▼      ▼          ▼
  TUI    TUI    TUI     API Bridge
Client  Client  Client  (TypeScript SDK)
```

### Performance (Real Benchmarks)

| Metric | Jcode | Claude Code | Codex CLI |
|---|---|---|---|
| Time to first frame | **14ms** | 3,437ms (245× slower) | 883ms (63× slower) |
| Time to first input | **48.7ms** | 3,513ms (72× slower) | 906ms (18.6× slower) |
| RAM (1 session) | **27.8MB** (no embeddings) | 386.6MB (14× more) | 140MB (5× more) |
| RAM (10 sessions) | **117MB** (no embeddings) | 2,300MB (20× more) | 335MB (3× more) |
| Extra RAM per session | **~10MB** | ~213MB (21× more) | ~22MB (2× more) |

### TypeScript SDK API Surface

The SDK is GA-quality with protocol v1 (semver stable). Key methods:

```
JcodeClient.launch(options)     → start private instance
JcodeClient.connect(options)    → attach to user's jcode
createSession(workingDir?)      → new conversation
attachSession(id)               → subscribe to session
sendMessage(id, content)        → send turn
run(id, content, options?)      → send + collect full turn
runStructured(id, content, opts)→ validated JSON output
events(sessionId?)              → async iterator over stream
globalEvents(options?)          → fan all sessions into one iterator
cancel(id) / softInterrupt(id)  → interrupt turn
getHistory(id) / peekSession()  → read transcripts
listModels(id) / setModel(id)   → model catalog + selection
getRuntimeInfo(id)              → server version, capabilities, routes
respondToPermission(...)        → answer permission prompts
setApiKey(provider, key)        → manage provider credentials
archiveSession / restoreSession → reversible session hiding
compact(id)                     → transcript compaction
```

**Event kinds**: `text_delta`, `reasoning_delta`, `tool_start`, `tool_input_delta`, `tool_exec`, `tool_done`, `token_usage`, `background_progress`, `permission_request`, `message_accepted`, `session_status`, `model_info`, `turn_done`

### Swarm Architecture

- **Coordinator** — owns shared plan, assigns scopes, approves updates
- **Worktree Manager** — owns worktree scope, handles integration
- **Agents** — execute tasks in parallel, propose plan updates, DM each other
- **Modes**: ad-hoc (fan-out, 1 level), light-swarm (1 level), swarm-deep (recursive spawning)
- Communication: DMs, subtree broadcasts, topic channels, shared context keys

### Memory Architecture

- Semantic vector embeddings per turn/response
- Cosine similarity retrieval from memory graph
- Automatic extraction (semantic drift, K turns, session end)
- Memory sideagent for verification (optional)
- Explicit memory tools: search, store, session search
- Ambient mode: automatic consolidation, staleness detection, conflict resolution

---

## Implications for SPEG Architecture

### What Jcode Already Does (DON'T rebuild)

- ✅ Agent lifecycle management
- ✅ Provider integration (40+ providers)
- ✅ Session management + resume
- ✅ Swarm coordination
- ✅ Semantic memory system
- ✅ MCP server management
- ✅ Browser automation
- ✅ Skills activation
- ✅ Self-dev mode
- ✅ Permission/approval system
- ✅ Transcript persistence
- ✅ Model catalog
- ✅ API key management
- ✅ Structured JSON output

### What SPEG SHOULD Build

- **🔴 Custom Web/Mobile UI** — Jcode has TUI + desktop app, no web or mobile UI yet
- **🔴 Multi-Project Orchestration** — Jcode is session-scoped; SPEG adds project management
- **🔴 Multi-User Access** — Jcode is single-user; SPEG adds auth/authz for teams
- **🔴 Remote Web Access** — Jcode uses Unix sockets; SPEG adds WebSocket gateway
- **🟡 Skill Marketplace** — Extended skill catalog beyond Jcode's built-in skills
- **🟡 Enhanced Swarm UI** — Visual swarm dashboard with DAG views
- **🟡 Memory Browser** — Visual memory graph exploration
- **🟡 Configuration Profiles** — Per-project provider, model, skill defaults
- **🟢 Cross-Session Analytics** — Usage, cost, performance tracking
- **🟢 Plugin System** — Third-party UI extensions

### Corrected Architecture

```
┌─────────────────────────────────────────────────────────┐
│  SPEG CLIENTS (Web / Desktop / Mobile)                   │
│  ┌──────────────────────────────────────────────────┐   │
│  │ @speg/client-runtime                             │   │
│  │  Connection supervisor, RPC, Atom state          │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────┘
                       │ WebSocket (Effect RPC)
┌──────────────────────┴──────────────────────────────────┐
│  SPEG SERVER (Bun + TypeScript + Effect)                │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Project Manager (multi-project orchestration)    │   │
│  │ Auth Service (multi-user, sessions)              │   │
│  │ WebSocket Gateway (Effect RPC)                   │   │
│  │ UI State Coordinator (composer, panels, views)   │   │
│  │ Skill Registry (extended skill catalog)          │   │
│  │ Analytics & Telemetry                            │   │
│  └──────────────────────────────────────────────────┘   │
└──────────────────────┬──────────────────────────────────┘
                       │ @1jehuang/jcode-sdk (TypeScript)
┌──────────────────────┴──────────────────────────────────┐
│  JCODE DAEMON (Rust binary)                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Agents · Swarms · Memory · Skills · MCP          │   │
│  │ Providers (40+) · Browser · Self-Dev             │   │
│  │ Session persistence · Transcripts                │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

The SPEG server is now a **thin orchestration layer** — it manages projects, users, and multi-surface access. All agent intelligence lives in Jcode, accessed through its SDK.

---

## SDK Integration Modes

### Mode 1: Private Instance (launch)
```typescript
import { JcodeClient } from "@1jehuang/jcode-sdk";

// SPEG server spawns a private Jcode instance per user/project
const client = await JcodeClient.launch({
  workingDir: projectPath,
  jcodeHome: `/data/speg/projects/${projectId}/.jcode`,
  inheritLogins: true,
});

const session = await client.createSession();
const turn = await client.run(session.session_id, "summarize this repo");
```

### Mode 2: Connect to Existing (connect)
```typescript
// SPEG server connects to the user's already-running Jcode
const client = await JcodeClient.connect({
  socketPath: "/run/user/1000/jcode-api.sock",
  clientName: "speg-server/1.0",
});
```

---

## What This Means for the Plan

The plan needs significant restructuring:

1. **Phase 1-2 merge**: Foundation + Jcode integration becomes trivial — just `npm install @1jehuang/jcode-sdk`
2. **Phase 4 (Skills)**: Jcode already has skills. SPEG adds an extended skill marketplace.
3. **Phase 5 (Swarms)**: Jcode already has swarms. SPEG adds enhanced visualization.
4. **Phase 6 (Memory)**: Jcode already has memory. SPEG adds memory browser UI.
5. **Phase 7 (Browser)**: Jcode already has browser automation. SPEG surfaces it in UI.
6. **Phase 8 (Self-Dev)**: Jcode already has self-dev. SPEG adds UI controls.
7. **Provider adapters (Phase 3)**: Jcode handles 40+ providers natively. SPEG doesn't need adapters.

**The plan shrinks dramatically** — from building everything to building a UI orchestration layer on top of a mature platform.
