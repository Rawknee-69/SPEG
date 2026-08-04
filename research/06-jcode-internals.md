# Jcode Internals — Architecture Deep-Dive

> Generated: 2026-08-04 | Source: Repository exploration at `E:\SPEG\jcode`
> This documents Jcode's internal architecture for SPEG integration planning.

---

## Repository Structure

Jcode is a Rust workspace with **~92 crates** organized in 5 tiers.

### Tier 1: Foundation — Shared Types (no app logic deps)

| Crate | Responsibility |
|---|---|
| `jcode-build-meta` | Build-time metadata (version, git hash) — leaf dependency |
| `jcode-message-types` | Core message types: `Message`, `ContentBlock`, `ToolCall`, `Role` |
| `jcode-session-types` | Session types: `RenderedMessage`, `ResumeTarget` (jcode/ClaudeCode/Codex/Pi/OpenCode/Cursor), compaction info |
| `jcode-memory-types` | **Memory system types**: `MemoryEntry`, `MemoryGraph`, `EdgeKind`, `ClusterEntry`, `TagEntry`, `PipelineState` |
| `jcode-tool-types` | Tool output: `ToolOutput`, `ToolImage` |
| `jcode-protocol` | Internal protocol messages |
| `jcode-harness-api` | **Public stable API v1**: `ClientFrame`, `ServerFrame`, `ApiRequest`, `ApiEvent`, `HarnessClient` — NDJSON over Unix socket |
| `jcode-transport` | Platform IPC: `UnixListener`/`UnixStream` (Unix) or named pipe (Windows) |
| `jcode-config-types` | Configuration data types |
| `jcode-auth-types` | Authentication types |
| `jcode-ambient-types` | Ambient mode types |
| `jcode-background-types` | Background task types |
| `jcode-batch-types` | Batch operation types |
| `jcode-gateway-types` | Gateway/provider routing types |
| `jcode-task-types` | Task/delegation types (swarm task graph) |
| `jcode-usage-types` | Usage/token tracking |
| `jcode-side-panel-types` | Side panel content |
| `jcode-selfdev-types` | Self-development types |
| `jcode-fuzzy` | Char-level DP fuzzy matcher |
| `jcode-math` | Numeric/math kernels (pure) |
| `jcode-command-risk` | Command risk assessment |
| `jcode-storage` | Low-level file persistence types |

### Tier 2: Core Engine

| Crate | Responsibility |
|---|---|
| `jcode-base` | Foundation: embeddings (ONNX/tract MiniLM), env detection, file ops, auth, logging, config, memory store persistence |
| `jcode-core` | Core business logic |
| `jcode-app-core` | **THE ENGINE**: turn execution, tools (30+), server lifecycle, client sessions, swarm comms, ambient mode, memory pipeline, session I/O, self-dev, compaction, streaming, prompts, permissions, file activity |
| `jcode-agent-runtime` | Agent primitives: `SoftInterruptQueue`, `InterruptSignal`, `BackgroundToolSignal`, `GracefulShutdownSignal` |
| `jcode-swarm-core` | Swarm coordination: message routing, TLDR validation, plan items, worker assignment |
| `jcode-compaction-core` | Context window compaction |
| `jcode-embedding` | Local embedding inference (all-MiniLM-L6-v2 via tract-onnx) |
| `jcode-render-core` | Cross-platform rendering abstractions |
| `jcode-import-core` | **Session import** from other agents (Claude Code, Codex, Pi, OpenCode, Cursor) |
| `jcode-productivity-core` | Productivity features |
| `jcode-overnight-core` | Overnight/background task execution |
| `jcode-plan` | Plan/task planning |
| `jcode-telemetry-core` | Telemetry collection |

### Tier 3: Providers (one pair per backend)

| Type Crate | Runtime Crate | Backend |
|---|---|---|
| `jcode-provider-core` | (shared traits) | Provider abstractions |
| `jcode-provider-anthropic` | `jcode-provider-anthropic-runtime` | Claude API |
| `jcode-provider-openai` | `jcode-provider-openai-runtime` | OpenAI API |
| `jcode-provider-gemini` | `jcode-provider-gemini-runtime` | Google Gemini |
| `jcode-provider-copilot` | `jcode-provider-copilot-runtime` | GitHub Copilot |
| `jcode-provider-antigravity` | `jcode-provider-antigravity-runtime` | Antigravity |
| `jcode-provider-openrouter` | `jcode-provider-openrouter-runtime` | OpenRouter |
| `jcode-provider-bedrock` | (self-contained) | AWS Bedrock |
| `jcode-provider-cursor-runtime` | — | Cursor agent |
| `jcode-provider-claude-cli-runtime` | — | Claude CLI |
| `jcode-provider-doctor` | — | Provider diagnostics |
| `jcode-provider-env` | — | Environment-based config |
| `jcode-provider-metadata` | — | Provider metadata |

### Tier 4: Presentation & UI

| Crate | Responsibility |
|---|---|
| `jcode-tui` | Full TUI — app state, input, rendering, session picker, all screens |
| `jcode-tui-core` | Shared TUI core abstractions |
| `jcode-tui-render` | Terminal rendering (ratatui) |
| `jcode-tui-markdown` | Markdown rendering |
| `jcode-tui-messages` | Message display |
| `jcode-tui-mermaid` | Mermaid rendering (custom Rust, 1800× faster than browser) |
| `jcode-tui-style` | Styling/color system |
| `jcode-tui-anim` | 3D idle animation (trig-heavy, opt-level=3) |
| `jcode-tui-session-picker` | Session picker component |
| `jcode-tui-account-picker` | Account picker |
| `jcode-tui-permissions` | Permission prompt UI |
| `jcode-tui-tool-display` | Tool call rendering |
| `jcode-tui-usage-overlay` | Usage overlay |
| `jcode-tui-workspace` | Multi-session workspace UI |
| `jcode-tui-visual-debug` | Visual debug overlays |
| `jcode-desktop2` | Desktop GUI (winit + wgpu + Vello + Parley — GPU vector rendering) |

### Tier 5: Infrastructure

| Crate | Responsibility |
|---|---|
| `jcode-sdk` | Rust SDK for harness API |
| `jcode-harness-api-server` | API bridge server (Unix socket → internal protocol) |
| `jcode-logging` | Structured logging |
| `jcode-terminal-launch` | Terminal launch helpers |
| `jcode-terminal-image` | Inline image display (Kitty, iTerm2) |
| `jcode-pdf` | PDF extraction |
| `jcode-azure-auth` | Azure OpenAI auth |
| `jcode-notify-email` | Email notifications |
| `jcode-setup-hints` | Platform setup hints |
| `jcode-update-core` | Self-update logic |
| `jcode-build-support` | Build-time helpers |

### Dependency Spine

```
jcode-build-meta (leaf)
  ↓
jcode-base (embeddings, env, config, files)
  ↓
jcode-app-core (agent engine, server, tools, sessions)
  ↓
jcode-tui (terminal UI, re-exports)
  ↓
jcode (root: CLI binary + lib)
```

---

## Memory System (Critically Important for CACM)

### Graph Structure (HashMap-based, not petgraph for serialization)

```rust
pub struct MemoryGraph {
    graph: DiGraph<MemoryNode, EdgeKind>,
    memory_index: HashMap<String, NodeIndex>,
    tag_index: HashMap<String, NodeIndex>,
    cluster_index: HashMap<String, NodeIndex>,
}
```

### Node Types
- **Memory** — Core entry (fact, preference, procedure, correction, negative)
- **Tag** — Explicit label (user-defined or inferred)
- **Cluster** — Automatic grouping via embedding similarity (HDBSCAN)

### Edge Types
- **HasTag**: Memory → Tag
- **InCluster**: Memory → Cluster
- **RelatesTo** { weight }: Memory → Memory (semantic connection)
- **Supersedes**: Memory → Memory (newer replaces older)
- **Contradicts**: Memory → Memory (conflicting info)
- **DerivedFrom**: Memory → Memory (procedural from factual)

### MemoryEntry Schema

```rust
pub struct MemoryEntry {
    // Identity
    pub id: String,
    pub content: String,
    pub category: MemoryCategory,
    
    // Classification
    pub memory_type: MemoryType,  // Fact|Preference|Procedure|Correction|Negative
    pub scope: Scope,             // Global|Project|Session
    pub tags: Vec<String>,
    
    // Source (KEY for CACM)
    pub source: Option<MemorySource>,  // { agent: "claude-code", session_id: "..." }
    pub message_range: Option<(u32, u32)>,
    pub file_paths: Vec<String>,
    pub provenance: Provenance,    // UserStated|Observed|Inferred|Extracted
    
    // Lifecycle
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub last_accessed: DateTime<Utc>,
    pub access_count: u32,
    pub strength: u32,
    
    // Trust
    pub confidence: f32,           // 0.0-1.0, decays over time
    pub active: bool,
    pub superseded_by: Option<String>,
    
    // Embedding
    pub embedding: Option<Vec<f32>>,
}
```

### Provenance (Perfect for CACM)

- `UserStated` — User explicitly said it
- `UserCorrected` — User corrected agent
- `Observed` — Agent observed from behavior ← **CACM uses this**
- `Inferred` — Agent inferred from context
- `Extracted` — Extracted from session summary ← **CACM uses this too**

### Confidence Decay

| Memory Type | Half-life | Rationale |
|---|---|---|
| Correction | 365 days | High value, rarely stale |
| Preference | 90 days | May evolve |
| Fact | 30 days | Codebase facts can stale |
| Procedure | 60 days | Changes less often |
| Inferred | 7 days | Low-confidence inferences |

### Cascade Retrieval Algorithm

1. Embed context with all-MiniLM-L6-v2
2. Cosine similarity search → top-10 initial hits
3. BFS traversal (depth=2) following edges with decay:
   - HasTag: 0.8 weight
   - InCluster: 0.6 weight
   - RelatesTo: variable weight
   - Supersedes: 0.9 weight
4. Sidecar verification (GPT-5.3 Codex Spark) filters relevance
5. Results available one turn later

### Post-Retrieval Maintenance (Opportunistic)

After serving memories, the memory agent can:
- Discover and strengthen links between co-relevant memories
- Boost confidence for verified memories
- Decay confidence for rejected memories
- Detect gaps (context had no relevant memories → log for future extraction)
- Infer tags from context

---

## Session Management

### Server-Client Model

- Single server daemon (`jcode serve`) owns all sessions
- TUI clients connect over Unix socket (`/run/user/$UID/jcode.sock`)
- Windows: named pipe equivalent
- Client reconnection with exponential backoff (1s → 30s)
- `/reload`: server `exec()`s new binary, clients auto-reconnect

### Session Resume

Jcode can resume sessions from:
- Jcode (native)
- Claude Code
- Codex
- Pi
- OpenCode
- Cursor

Via `ResumeTarget` enum in `jcode-session-types`. Implementation in `jcode-import-core`.

### Session Storage

```
~/.jcode/
├── sessions/
│   └── <session-id>/
│       ├── transcript.jsonl
│       └── state.json
├── memory/
│   ├── graph.json
│   ├── projects/<hash>.json
│   ├── global.json
│   ├── embeddings/<id>.vec
│   ├── clusters/metadata.json
│   └── tags/tag_index.json
├── builds/
│   ├── current/jcode
│   ├── stable/jcode
│   └── versions/<ver>/jcode
└── servers.json
```

---

## Harness API v1 (SDK Protocol)

### Transport
- NDJSON framing (one JSON object per line, `\n` delimited)
- Unix socket (Linux/macOS) or named pipe (Windows)
- Version: `v: 1` in every frame

### Request Types (Client → Server)
`hello`, `list_sessions`, `archive_session`, `restore_session`, `set_retention_policy`, `create_session`, `attach_session`, `detach_session`, `send_message`, `cancel`, `soft_interrupt`, `get_history`, `peek_session`, `clear`, `rewind`, `permission_response`, `list_models`, `get_runtime_info`, `set_api_key`, `clear_api_key`, `read_file`, `find_files`, `search_text`, `file_status`, `set_model`, `set_reasoning_effort`, `compact`, `rename_session`, `rewind_undo`, `cancel_soft_interrupts`, `ping`

### Event Types (Server → Client)
**Replies**: `hello_ok`, `ok`, `error`, `sessions`, `attached`, `history`, `pong`
**Streaming**: `text_delta`, `reasoning_delta`, `reasoning_done`, `tool_start`, `tool_input_delta`, `tool_exec`, `tool_done`, `token_usage`, `turn_done`
**Control**: `permission_request`, `session_status`, `message_accepted`, `background_progress`
**Info**: `model_info`, `models`, `runtime_info`, `credential_updated`, `file_content`, `files`, `text_matches`, `file_status`, `compacted`, `session_renamed`

### TypeScript SDK (`@1jehuang/jcode-sdk`)

| File | Purpose |
|---|---|
| `protocol.ts` | Wire types: `ApiRequest`, `ApiEvent`, `SessionInfo`, known event/request kinds |
| `client.ts` | `JcodeClient` class: connect, request/reply via `pending` map, streaming via async iterator, structured output |
| `launch.ts` | `launchInstance()`: spawn private Jcode daemon with own `JCODE_HOME` |
| `framing.ts` | `NdjsonDecoder`: incremental newline-delimited JSON decoder |
| `sockets.ts` | Socket path resolution |
| `structured.ts` | JSON Schema → Ajv validation with retry |

---

## Skills System

### Format
Skills are Markdown files with YAML frontmatter at `.jcode/skills/<name>/SKILL.md`:

```yaml
---
name: optimization
description: Use when improving performance of Rust/TypeScript code
allowed-tools: bash, read, write, grep, agentgrep, batch, todo
---
# Skill body — Markdown instructions for the agent
```

### Activation
- Skills are NOT pre-loaded
- Conversation is embedded, skill descriptions are embedded
- Cosine similarity match → automatic injection
- Agent can manually activate via `skill` tool
- Users can invoke via slash commands
- `allowed-tools` restricts tool access while skill is active

### Built-in Skills
Currently only `optimization` is in the repo. SPEG will add many more.

---

## Extension Points for SPEG

### For CACM Integration
- **Memory graph** (`jcode-memory-types`): add `source: MemorySource` with `agent` field
- **Provenance** (`Provenance::Observed`, `Provenance::Extracted`): already supports cross-agent tracking
- **Session import** (`jcode-import-core`): existing `ResumeTarget` variants — add new as needed
- **Harness API** (`jcode-harness-api`): stable protocol v1 — use existing methods, propose additions

### For Custom UI
- **Harness API** is the official path — `JcodeClient.launch()` for isolated instances
- **Events stream** provides everything: text deltas, tool calls, permissions, usage
- **Session management**: list, create, attach, resume, import — all through SDK
- **Memory tools**: `memory { remember, recall, search, list, forget, link, tag }` — available to agents

### For Adding Skills
- Drop SKILL.md in `.jcode/skills/<name>/`
- YAML frontmatter with name, description, allowed-tools
- Auto-discovered by embedding-based skill loader
