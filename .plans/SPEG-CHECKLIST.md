# SPEG — Implementation Checklist v6

> **Strategy**: CACM daemon + right panel tab + settings. Harness = **already-supported providers only**.
> **Revision v6**: jcode is **DROPPED** — provider adapter, session parser, and harness-API storage removed from t3code. **No self-built harness for now**: support is limited to the harnesses T3 Code already supports (Claude Code, Codex, OpenCode, Cursor, Grok). Historical jcode rows below are marked superseded.
> **No separate web UI** — T3 Code IS the UI. Observability dashboard deferred to Phase 6.

---

## Phase 1: Foundation — CACM + harness slot (16 tasks — 8 done)

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 1.1 | @speg/core TypeScript package scaffold | ✅ | TS | `speg/package.json`, `speg/tsconfig.json`, `pnpm-workspace.yaml` | — |
| 1.2 | SPEG wire contracts (Effect/Schema) | ✅ | TS | `packages/contracts/src/speg/` (7 files), 64 tests | 1.1 |
| 1.3 | cacm-core Rust crate (types, watcher, parser trait) | ⬜ | Rust | `cacm/cacm-core/` | — |
| 1.4 | cacm-daemon (HTTP+WS server, JSON-RPC API) | ⬜ | Rust | `cacm/cacm-daemon/` | 1.3 |
| 1.5 | ~~Jcode~~ session parser 🔄 superseded | ⬜ | Rust | ~~`cacm/cacm-core/src/parsers/jcode.rs`~~ (removed) | 1.3 |
| 1.6 | Context extractor (heuristics) | ⬜ | Rust | `cacm/cacm-core/src/extractor.rs` | 1.5 |
| 1.7 | Context injector (query + rank + format) | ⬜ | Rust | `cacm/cacm-core/src/injector.rs` | 1.6 |
| 1.8 | cacm-sdk-rs (harness adapter slot) 🔄 superseded | ⬜ | Rust | `cacm/cacm-sdk-rs/` (bridge crate removed) | 1.4, 1.7 |
| 1.9 | cacm-sdk-ts (@cacm/sdk npm package) | ✅ | TS | `cacm/cacm-sdk-ts/` | 1.4 |
| 1.10 | ~~Jcode Provider Adapter~~ 🔄 superseded (removed) | ✅→❌ | TS | ~~`JcodeDriver.ts`, `JcodeAdapter.ts`, `JcodeProcessManager.ts`~~ | 1.8 |
| 1.11 | **CACM Right Panel Tab** (T3 Code web) | ✅ | TS | `apps/web/src/components/speg/CacmPanel.tsx` | 1.9 |
| 1.12 | **SPEG Settings Panel** (T3 Code web) | ✅ | TS | `apps/web/src/components/speg/SpegSettings.tsx` | — |
| 1.13 | Compactor (dedup + summarize + link) | ✅ | Rust | `cacm/cacm-core/src/compactor.rs` | 1.6 |
| 1.14 | CACM daemon WebSocket protocol types | ✅ | TS | `cacm/cacm-sdk-ts/src/types.ts` | 1.2, 1.4 |
| 1.15 | Wire contracts barrel export | ⬜ | TS | `packages/contracts/src/index.ts` (1 line) | 1.2 |
| 1.16 | Phase 1 integration gate (already-supported harnesses) | ⬜ | Both | None | 1.1–1.15 |

---

## Phase 2: Cross-Agent Parsers

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 2.1 | Claude Code parser | ⬜ | Rust | `cacm/cacm-core/src/parsers/claude.rs` | 1.5 |
| 2.2 | Codex parser | ⬜ | Rust | `cacm/cacm-core/src/parsers/codex.rs` | 1.5 |
| 2.3 | OpenCode parser | ⬜ | Rust | `cacm/cacm-core/src/parsers/opencode.rs` | 1.5 |
| 2.4 | Cursor parser | ⬜ | Rust | `cacm/cacm-core/src/parsers/cursor.rs` | 1.5 |
| 2.5 | Cross-agent injection (all agents) | ⬜ | Rust | `cacm/cacm-core/src/injector.rs` (update) | 2.1-2.4 |
| 2.6 | Phase 2 gate | ⬜ | Both | None | 2.1-2.5 |

---

## Phase 3: Skills + Provider UI

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 3.1 | Skill: Graphify | ⬜ | MD | `jcode/.jcode/skills/graphify/SKILL.md` | 1.8 |
| 3.2 | Skill: Ponytail | ⬜ | MD | `jcode/.jcode/skills/ponytail/SKILL.md` | 1.8 |
| 3.3 | Skill: Best Practices | ⬜ | MD | `jcode/.jcode/skills/best-practices/SKILL.md` | 1.8 |
| 3.4 | Skill: Security Audit | ⬜ | MD | `jcode/.jcode/skills/security-audit/SKILL.md` | 1.8 |
| 3.5 | Skill: Doc Generator | ⬜ | MD | `jcode/.jcode/skills/doc-generator/SKILL.md` | 1.8 |
| 3.6 | Skill: Test Generator | ⬜ | MD | `jcode/.jcode/skills/test-generator/SKILL.md` | 1.8 |
| 3.7 | Skill manager in settings | ⬜ | TS | `apps/web/src/components/speg/SpegSettings.tsx` (update) | 3.1-3.6 |
| 3.8 | Phase 3 gate | ⬜ | Both | None | 3.1-3.7 |

---

## Phase 4: Memory + Swarm Panels

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 4.1 | Memory graph query (cacm-daemon endpoint) | ⬜ | Rust | `cacm/cacm-daemon/src/` | 1.4 |
| 4.2 | Memory graph right panel tab | ⬜ | TS | `apps/web/src/components/speg/MemoryGraph.tsx` | 4.1 |
| 4.3 | Swarm dashboard right panel tab | ⬜ | TS | `apps/web/src/components/speg/SwarmDashboard.tsx` | 1.10 |
| 4.4 | Phase 4 gate | ⬜ | Both | None | 4.1-4.3 |

---

## Phase 5: Auth + Remote Access

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 5.1 | Auth service (cacm-daemon) | ⬜ | Rust | `cacm/cacm-daemon/src/auth.rs` | 1.4 |
| 5.2 | Remote WebSocket gateway | ⬜ | Rust | `cacm/cacm-daemon/src/` | 5.1 |
| 5.3 | Phase 5 gate | ⬜ | Both | None | 5.1-5.2 |

---

## Phase 6: Observability + Polish (Deferred)

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 6.1 | Observability web dashboard (deep analytics) | ⬜ | TS | `speg-web/` (new, minimal) | 1.12 |
| 6.2 | Mobile React Native CACM widget | ⬜ | TS | `apps/mobile/src/speg/` | 1.12 |
| 6.3 | Error boundaries + polish | ⬜ | TS | `apps/web/src/components/speg/` | 1.12 |
| 6.4 | Accessibility + themes + shortcuts | ⬜ | TS | `apps/web/src/` | 1.12 |
| 6.5 | Phase 6 gate | ⬜ | Both | None | 6.1-6.4 |

---

## What Changed from v5

| v5 | v6 | Why |
|----|-----|-----|
| speg-web/ (React app) | **T3 Code right panel tabs** | T3 Code IS the UI. No redundant app. |
| speg-desktop/ (Electron) | **T3 Code desktop** | Already exists. The already-supported harnesses bundle into it. |
| Standalone SPEG web UI | **Existing provider adapters** | Claude Code, Codex, OpenCode, Cursor, Grok — T3 Code's existing adapter system |
| CACM timeline component | **CACM right panel tab** | Same data, rendered in T3 Code's side panel |
| Provider picker component | **T3 Code model picker** | Already exists in T3 Code's composer |

### T3 Code Surfaces We Extend

```
T3 Code Web/Desktop UI
├── Chat View
│   └── Composer
│       └── Provider Picker ← Jcode appears here (existing: Codex, Claude, Cursor...)
├── Right Panel Tabs
│   ├── Plan tab           (existing)
│   ├── Diff tab           (existing)
│   ├── Files tab          (existing)
│   ├── Preview tab        (existing)
│   ├── Terminal tab       (existing)
│   ├── CACM tab           ← NEW: cross-agent context timeline
│   ├── Memory tab         ← NEW: memory graph visualizer
│   └── Swarm tab          ← NEW: swarm DAG dashboard
└── Settings
    └── SPEG section       ← NEW: Jcode + CACM configuration
```

### What Users See

1. Open T3 Code → composer shows the already-supported providers (Claude, Codex, OpenCode, Cursor, Grok)
2. Select harness → pick model → start chatting
3. Right panel → **CACM tab** shows timeline of ALL agent sessions (Claude Code, Codex, etc.)
4. Right panel → **Memory tab** shows memory graph with cross-agent links
5. Right panel → **Swarm tab** shows live swarm status when using harness swarms
6. Settings → **SPEG** section configures the CACM daemon, watch paths, skills

### Observability Web UI (Phase 6 — deferred)

A minimal standalone dashboard for:
- Deep agent performance analytics (tokens, latency, success rate)
- Context quality scoring (how well CACM context matches agent output)
- Cross-agent workflow visualization (time spent per agent, context transfer accuracy)
- Export/share analysis reports

This is Phase 6. Not needed for MVP.

---

## Language Split

| Language | Components |
|----------|-----------|
| **Rust** | cacm-core, cacm-daemon, cacm-sdk-rs, parsers, compactor (~~jcode-cacm-bridge~~ removed) |
| **TypeScript** | @speg/core, contracts, cacm-sdk-ts, existing provider adapters, right panel tabs, settings panel |

---

## Overall Progress

```
Phase 1: ██████░░░░░░░░░░░░░░  8/16  (50%)
Phase 2: ░░░░░░░░░░░░░░░░░░░░  0/6   (0%)
Phase 3: ░░░░░░░░░░░░░░░░░░░░  0/8   (0%)
Phase 4: ░░░░░░░░░░░░░░░░░░░░  0/4   (0%)
Phase 5: ░░░░░░░░░░░░░░░░░░░░  0/3   (0%)
Phase 6: ░░░░░░░░░░░░░░░░░░░░  0/5   (0%)
─────────────────────────────────────
TOTAL:   ████░░░░░░░░░░░░░░░░  8/42  (19%)
```

## Last Updated

2026-08-05 | v9 — CACM daemon WebSocket protocol types | 42 tasks · 1.1, 1.2, 1.8, 1.9, 1.10, 1.11, 1.12, 1.13, 1.14 done
