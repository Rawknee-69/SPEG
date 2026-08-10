# SPEG — Performance & Resource Analysis

> Generated: 2026-08-04 | Source: Full repository analysis
> This document identifies performance bottlenecks, their root causes, and recommended fixes.

---

## Executive Summary

SPEG is architecturally sound but carries significant performance debt from its rapid evolution. The three most impactful bottlenecks are: (1) the serial orchestration command worker creating a single-point-of-contention, (2) synchronous 9-table projection pipeline inside every SQL transaction, and (3) the monolithic ChatView component causing cascading React re-renders. Fixes range from low-effort optimizations (code splitting, worker offloading) to architectural changes (parallel projection, streaming WebSocket batching).

---

## 1. Critical Bottlenecks

### 1.1 Serial Orchestration Command Worker

**Severity**: 🔴 HIGH
**Location**: `apps/server/src/orchestration/OrchestrationEngine.ts`

**The Problem**:
All orchestration commands flow through a single unbounded Queue processed by exactly ONE fiber:

```
commandQueue → forever(Queue.take → decideOrchestrationCommand → append + project + publish)
```

A slow command (e.g., `thread.revert` requiring Git checkout + checkpoint restoration, or `thread.turn.start` with large context) blocks EVERY other command — including simple reads like `subscribeShell` snapshot requests that shouldn't need serialization.

**Root Cause**:
The in-memory read model (`OrchestrationReadModel`) is not protected by locks. Serialization IS the concurrency control. The design explicitly trades throughput for correctness — any parallel command processing would require transactional memory or snapshot isolation on the read model.

**Impact**:
- Under heavy load (multiple concurrent agent turns), command latency spikes linearly
- A single expensive operation (revert, large thread creation) pauses the entire system
- Provider sessions stall waiting for their turn-start to be processed

**Recommended Fixes** (ordered by effort):

1. **Read-only command bypass** (Low effort): Route read-only commands (snapshots, queries) through a separate parallel path that reads from SQLite projections directly, bypassing the serial worker entirely. The serial worker only handles writes.

2. **Snapshot isolation for the read model** (Medium effort): Before processing a command, take a shallow copy of the relevant aggregates from the read model. Process against the copy. Only apply the result to the main read model inside the transaction. This allows multiple commands targeting DIFFERENT aggregates to process concurrently.

3. **Aggregate-level serialization** (High effort): Key the queue by aggregate ID (projectId, threadId). Commands targeting different aggregates process in parallel. Commands targeting the same aggregate serialize. Requires per-aggregate version checking in the event store (optimistic concurrency).

4. **Offload heavy operations** (Medium effort): Move Git operations (checkpoint capture, diff computation, revert) out of the command worker and into dedicated background workers. The command worker only records the intent; the worker publishes completion events.

### 1.2 Synchronous 9-Table Projection Pipeline

**Severity**: 🔴 HIGH
**Location**: `apps/server/src/orchestration/ProjectionPipeline.ts` (63KB)

**The Problem**:
Every domain event triggers ALL 9 SQLite projectors synchronously inside the SQL transaction:

```
event → threads projector → messages projector → activities projector → 
        sessions projector → turns projector → checkpoints projector → 
        proposed-plans projector → pending-approvals projector → projects projector
```

For a `thread.message-sent` event, this means 9 sequential INSERT/UPDATE statements within the transaction. Each projector does targeted work, but the cumulative latency is the sum of all 9.

**Root Cause**:
Architectural choice to keep the event log and projections atomically consistent. The alternative (eventually consistent projections) was rejected for correctness — clients expect that after a command receipt, the projection is up-to-date.

**Impact**:
- Event persistence latency = sum of all projector work
- Under high message volume (streaming agent output), each message delta event triggers the full pipeline
- SQLite write lock held longer per transaction, blocking concurrent readers

**Recommended Fixes**:

1. **Lazy projection for non-critical tables** (Low effort): Defer `checkpoints`, `proposed-plans`, and `pending-approvals` projections to post-commit via PubSub listeners. Only the critical read path tables (threads, messages, activities) stay in-transaction.

2. **Batch message projections** (Medium effort): Instead of projecting every message-delta individually, buffer message updates in-memory and flush in batches (every 100ms or 50 messages). The `ProviderRuntimeIngestion` already buffers text — extend this to the projection layer.

3. **Projection worker pool** (High effort): Post-commit, distribute projection work across a pool of workers keyed by aggregate. This doesn't reduce total work but parallelizes across different threads/projects.

4. **Materialized view pattern** (High effort): Replace individual table updates with SQLite triggers or materialized views that derive read-model columns from the event log directly. This eliminates the 9-step chain in favor of a single append.

### 1.3 Monolithic ChatView Component

**Severity**: 🔴 HIGH
**Location**: `apps/web/src/components/chat/ChatView.tsx` (6189 lines, ~232KB)

**The Problem**:
ChatView is a single component that renders the entire chat surface: header, error banner, message timeline, composer overlay, right panel, terminal drawer, diff workers, expanded images, and alert dialogs. It passes 80+ props to ChatComposer. Any state change in any sub-component triggers a full ChatView re-render cascade.

**Root Cause**:
The component grew organically without decomposition. Plan 04 (`04-split-chatview-component.md`) proposed extracting `useChatSession` hook and presentational components, but the current state suggests incomplete decomposition.

**Impact**:
- Every keystroke in the composer triggers ChatView re-render
- Terminal state changes trigger ChatView re-render
- Right panel toggle triggers ChatView re-render
- Timeline entry derivation re-processes full activity list on every change

**Recommended Fixes**:

1. **Complete the decomposition from Plan 04** (Medium effort): Extract `ChatViewHeader`, `ChatViewMessages`, `ChatViewComposer`, `ChatViewRightPanel`, `ChatViewTerminal` into independently memoized sub-components with narrow prop interfaces.

2. **Move composer to a portal** (Low effort): Render the composer overlay in a React portal outside the ChatView tree so keystrokes don't trigger ChatView reconciliation.

3. **Virtualized timeline with windowing** (Done for messages, needs extension): LegendList already virtualizes messages. Extend to activities and work-log entries.

4. **Memoize timeline derivation** (Low effort): `deriveTimelineEntries` re-processes the full activity list on every change. Use incremental derivation — only process new activities since last derivation, append to cached result.

---

## 2. Medium-Impact Issues

### 2.1 In-Memory Read Model Growth

**Severity**: 🟡 MEDIUM
**Location**: `apps/server/src/orchestration/OrchestrationEngine.ts`

The `OrchestrationReadModel` holds ALL active projects and threads with their messages (capped at 2K each), activities, checkpoints, and sessions. For large workspaces with many threads, this grows significantly. At startup, it's rebuilt from SQLite by re-reading all active projections.

**Recommended Fixes**:
- Implement LRU eviction for threads with no recent activity (e.g., 1 hour idle → offload from memory, reload on access)
- At startup, lazy-load read model: load only indexes (thread IDs, project IDs), load full data on first access
- Consider memory-mapped SQLite for the read model instead of in-memory JS objects

### 2.2 Composer Draft Store Persistence

**Severity**: 🟡 MEDIUM
**Location**: `apps/web/src/composerDraftStore.ts` (141KB)

Every keystroke in the composer triggers: Zustand state update → selector re-render → debounced (300ms) localStorage write. The draft state object is rebuilt on every mutation. Under rapid typing during agent streaming, this creates a continuous serialize-deserialize cycle.

**Recommended Fixes**:
- Increase debounce to 1000ms for prompt text (model selections and contexts can persist immediately)
- Use `requestIdleCallback` for persistence rather than debounce
- Consider IndexedDB instead of localStorage for large draft states (images, terminal contexts)
- Batch all draft mutations into a single persistence write per "composer session"

### 2.3 Ghostty WASM Terminal Instances

**Severity**: 🟡 MEDIUM
**Location**: `apps/web/src/terminal/ghostty/`

The Ghostty terminal is a 631KB WASM module + 53KB canvas renderer. Per-thread terminal instances are mounted and hidden (not destroyed) up to `MAX_HIDDEN_MOUNTED_TERMINAL_THREADS`. Each instance allocates WASM memory for scrollback (10K rows × columns cells).

**Recommended Fixes**:
- Implement terminal hibernation: serialize terminal state, destroy WASM instance, restore on re-activation
- Lower the hidden instance cap from current value to 2-3
- Use a terminal instance pool instead of per-thread instances
- Consider OffscreenCanvas for hidden terminals (transfers rendering off main thread)

### 2.4 No Code Splitting

**Severity**: 🟡 MEDIUM
**Location**: `apps/web/src/`

The entire web app appears to be a single bundle. All routes, all components, all terminal WASM — loaded upfront. No `React.lazy` for route-level splitting.

**Recommended Fixes**:
- Route-level code splitting: `React.lazy(() => import('./routes/settings'))` for Settings, Pairing, Connect
- Defer terminal WASM loading until first terminal open
- Split the Lexical editor bundle from the main chat bundle
- Use `Suspense` boundaries for async-loaded chunks

### 2.5 Multiple Zustand Persistence Stores

**Severity**: 🟡 MEDIUM
**Location**: `apps/web/src/` (7+ Zustand stores)

Each Zustand store has its own `persist` middleware with localStorage. State changes across stores trigger independent JSON serializations. A single user action (e.g., opening right panel + switching terminal) triggers 2-3 separate localStorage writes.

**Recommended Fixes**:
- Consolidate UI state stores into a single persisted store with sliced selectors
- Use a shared persistence layer with batched writes
- Consider IndexedDB with a single transaction per flush cycle

---

## 3. Low-Impact Issues

### 3.1 Effect Schema Validation Overhead

**Severity**: 🟢 LOW
**Location**: `packages/contracts/src/`

All wire types use Effect Schema with runtime validation. `ForwardCompatibleArray` iterates every element through `Schema.decodeUnknownOption` — O(n) per payload. For large arrays (e.g., thread event lists with hundreds of messages), this adds measurable decode time.

**Recommended Fix**: Cache schema decode results for immutable payloads. Use `Schema.decodeUnknownSync` for trusted server→client paths (skip validation on internal boundaries).

### 3.2 ProviderRuntimeIngestion Cache Growth

**Severity**: 🟢 LOW
**Location**: `apps/server/src/provider/ProviderRuntimeIngestion.ts`

10K-capacity caches with 2hr TTLs for turn message IDs, buffered text, proposed plans, and task descriptions. No eager eviction — entries are only cleaned on access or TTL expiry. Under high throughput from many concurrent provider sessions, cache memory could grow.

**Recommended Fix**: Add a periodic cleanup fiber that scans and evicts expired entries. Use WeakRef where possible for large cached objects.

### 3.3 Attachment File I/O in Projection

**Severity**: 🟢 LOW
**Location**: `apps/server/src/orchestration/ProjectionPipeline.ts`

`AttachmentSideEffects` computes attachment relative paths and deletes files from disk within the projection flow. File I/O inside the event processing path adds latency, especially on slow filesystems.

**Recommended Fix**: Queue file deletions to a background worker. The projection only records the intent to delete; the worker executes asynchronously.

### 3.4 Monolithic WsRpcGroup

**Severity**: 🟢 LOW
**Location**: `packages/contracts/src/rpc.ts`

All ~70 RPC methods are in one `WsRpcGroup`. `RpcClient.make()` creates a client with every method at once. A terminal-only client still gets orchestration, preview, and git RPC methods in its type bundle.

**Recommended Fix**: Split into feature-specific groups (orchestration, terminal, vcs, preview, server). Compose groups at the server. Clients import only what they need.

### 3.5 No Version Negotiation

**Severity**: 🟢 LOW
**Location**: `packages/contracts/`

The wire protocol relies on `ForwardCompatibleArray` and optional capability flags but has no explicit protocol version field. This works for forward-compatible changes but makes breaking changes harder to coordinate.

**Recommended Fix**: Add an optional `protocolVersion` to `ServerConfig`. Clients can feature-gate on version rather than individual capability flags.

---

## 4. Resource Usage Profile

### 4.1 Server Memory

| Component | Estimate | Notes |
|---|---|---|
| Effect runtime + services | ~50-80MB | Bun/Node baseline |
| In-memory read model | ~10-50MB | Depends on thread count, message count |
| ProviderRuntimeIngestion caches | ~5-20MB | 10K entries × ~1KB each |
| SQLite page cache | ~2-10MB | WAL mode, configurable |
| WebSocket connections | ~1-5MB per client | Depends on subscription count |
| Provider subprocesses | Varies | One per active session |

### 4.2 Client Memory (Web)

| Component | Estimate | Notes |
|---|---|---|
| React + Effect runtime | ~30-50MB | |
| Ghostty WASM instances | ~20-50MB each | Per hidden terminal |
| Atom state graph | ~5-15MB | Thread/shell snapshots cached |
| Lexical editor | ~5-10MB | |
| IndexedDB cache | ~5-20MB | Shell + thread snapshots |
| LegendList virtualized DOM | ~2-5MB | |

### 4.3 Startup Time

| Phase | Duration | Notes |
|---|---|---|
| Server SQLite migration | ~50-200ms | Depends on migration count |
| Read model rebuild | ~100-500ms | Re-reads all projections from SQLite |
| Provider registry scan | ~50-200ms | Checks installed providers |
| Activation barrier release | Instant | All subsystems park behind it |
| Web client bundle load | ~500-2000ms | No code splitting |
| Web client IndexedDB cache load | ~50-200ms | |

---

## 5. Recommended Optimization Priority

| Priority | Fix | Effort | Impact |
|---|---|---|---|
| 1 | Read-only command bypass in orchestration | Low | High — unblocks queries during heavy writes |
| 2 | ChatView component decomposition | Medium | High — reduces re-render cascade, improves UX |
| 3 | Lazy projection for non-critical tables | Low | Medium — reduces transaction time |
| 4 | Composer draft store IndexedDB migration | Medium | Medium — reduces main-thread serialization |
| 5 | Code splitting (routes + terminal WASM) | Medium | Medium — improves initial load |
| 6 | Aggregate-level command serialization | High | High — true concurrency in orchestration |
| 7 | Terminal instance pooling | Medium | Low-Medium — reduces WASM memory |
| 8 | Projection worker pool | High | Medium — parallelizes post-commit work |
| 9 | In-memory read model LRU eviction | Medium | Low-Medium — caps memory for large workspaces |
| 10 | Protocol version field | Low | Low — future-proofing |

---

## 6. For the New Agent System (Jcode-based)

When building the custom agent system on top of Jcode, avoid these architectural decisions that created bottlenecks in SPEG:

1. **Don't serialize all commands through one worker.** Use per-session/per-agent command queues with aggregate-level isolation.

2. **Don't project synchronously.** Use eventual consistency with change-data-capture (CDC) or PubSub-driven async projection.

3. **Don't build monolithic UI components.** Compose chat, composer, terminal, and panels as isolated micro-frontends with narrow interfaces.

4. **Don't use localStorage for state persistence.** Use IndexedDB with batched writes from the start.

5. **Don't bundle everything upfront.** Use route-level and feature-level code splitting from day one.

6. **Don't embed a full terminal emulator in WASM.** For the initial version, use a simpler ANSI renderer or delegate to the native terminal via PTY passthrough.

7. **Don't validate every wire payload.** Use schema validation at trust boundaries only (external input, cross-process). Internal server→client paths can use plain deserialization.

8. **Don't maintain a complete in-memory read model.** Use SQLite as the primary read store with targeted in-memory caches for hot data only.
