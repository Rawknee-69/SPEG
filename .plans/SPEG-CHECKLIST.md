# SPEG — Implementation Checklist v5

> **CACM is standalone** — importable daemon + SDKs. Jcode vanilla. SPEG web imports cacm-sdk-ts.
> **Status key**: ⬜ pending | 🔵 in_progress | ✅ complete | ❌ blocked
> **Tasks 1.1–1.2**: v4 plan — already implemented and committed. Unchanged.

---

## Phase 1: Foundation (12 tasks — 2 done, 10 remaining)

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 1.1 | @speg/core TypeScript package scaffold | ✅ | TS | `speg/package.json`, `speg/tsconfig.json`, `pnpm-workspace.yaml` | — |
| 1.2 | SPEG wire contracts (Effect/Schema) | ✅ | TS | `packages/contracts/src/speg/` (7 files), `contracts.test.ts` | 1.1 |
| 1.3 | cacm-core Rust crate (types, watcher, parser trait) | ✅ | Rust | `cacm/cacm-core/` | — |
| 1.4 | cacm-daemon (HTTP+WS server, JSON-RPC API) | ⬜ | Rust | `cacm/cacm-daemon/` | 1.3 |
| 1.5 | Jcode session parser | ⬜ | Rust | `cacm/cacm-core/src/parsers/jcode.rs` | 1.3 |
| 1.6 | Context extractor (heuristics) | ⬜ | Rust | `cacm/cacm-core/src/extractor.rs` | 1.5 |
| 1.7 | Context injector (query + rank + format) | ⬜ | Rust | `cacm/cacm-core/src/injector.rs` | 1.6 |
| 1.8 | cacm-sdk-rs + jcode-cacm-bridge | ⬜ | Rust | `cacm/cacm-sdk-rs/`, `jcode/crates/jcode-cacm-bridge/` | 1.4, 1.7 |
| 1.9 | cacm-sdk-ts (@cacm/sdk npm package) | ⬜ | TS | `cacm/cacm-sdk-ts/` | 1.4 |
| 1.10 | SPEG web UI (React, imports @cacm/sdk) | ⬜ | TS | `speg-web/` | 1.9 |
| 1.11 | Compactor (dedup + summarize + link) | ⬜ | Rust | `cacm/cacm-core/src/compactor.rs` | 1.6 |
| 1.12 | Phase 1 integration gate | ⬜ | Both | None (verification) | 1.1–1.11 |

### v5 Append Tasks (bridge v4 implementations → v5 architecture)

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 1.13 | Add CACM daemon WebSocket protocol types | ⬜ | TS | `cacm/cacm-sdk-ts/src/types.ts` | 1.2, 1.4 |
| 1.14 | Wire contracts barrel into package entry | ⬜ | TS | `packages/contracts/src/index.ts` (1-line add) | 1.2 |

**1.13 rationale**: v4 contracts defined Effect/Schema types. v5 CACM daemon uses a simple JSON WebSocket protocol (not Effect RPC). The `cacm-sdk-ts` types.ts must mirror the Rust `cacm-core/src/types.rs` exactly — these are the protocol types, separate from the Effect RPC contracts. The existing 1.2 types (CrossAgentContext, AgentSessionDescriptor, etc.) inform these but the wire format differs.

**1.14 rationale**: 1.2 report notes the barrel is intentionally NOT exported yet (would modify existing files). This task adds one `export * from "./speg/index.ts"` line to `packages/contracts/src/index.ts` so consumers can `import { SpegSessionId } from "@t3tools/contracts"`. Safe to do now since the contracts are stable.

### Phase 1 Verification Gates

- [x] `@speg/core` package typechecks (`vp run --filter @speg/core typecheck` PASS)
- [x] SPEG contracts: 64 tests pass, 0 regressions (287 existing tests)
- [ ] `cargo build --workspace` — all Rust compiles (cacm + jcode with bridge)
- [ ] `cargo test --workspace` — all Rust tests pass
- [ ] `cargo clippy --workspace` — no warnings
- [ ] `cargo fmt --check` — all formatted
- [ ] `cacm-daemon` starts, accepts WebSocket connections
- [ ] CACM daemon detects Jcode session activity
- [ ] `@cacm/sdk` builds, connects to daemon, queries context
- [ ] Jcode builds with `jcode-cacm-bridge` — CACM tools visible
- [ ] SPEG web UI: chat works, CACM timeline populated
- [ ] Windows `.exe` builds (cacm-daemon + jcode + speg-desktop)
- [ ] `git tag speg-v0.1.0-phase1`

---

## Phase 2: External Agent Parsers + Cross-Agent Injection

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 2.1 | Claude Code parser | ⬜ | Rust | `cacm/cacm-core/src/parsers/claude.rs` | 1.5 |
| 2.2 | Codex parser | ⬜ | Rust | `cacm/cacm-core/src/parsers/codex.rs` | 1.5 |
| 2.3 | OpenCode parser | ⬜ | Rust | `cacm/cacm-core/src/parsers/opencode.rs` | 1.5 |
| 2.4 | Cursor parser | ⬜ | Rust | `cacm/cacm-core/src/parsers/cursor.rs` | 1.5 |
| 2.5 | Cross-agent injection (all agents) | ⬜ | Rust | `cacm/cacm-core/src/injector.rs` (update) | 2.1-2.4 |
| 2.6 | CACM timeline UI | ⬜ | TS | `speg-web/src/components/CacmTimeline.tsx` | 1.10, 2.5 |
| 2.7 | Phase 2 gate | ⬜ | Both | None | 2.1-2.6 |

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
| 3.7 | Provider picker UI | ⬜ | TS | `speg-web/src/components/ProviderPicker.tsx` | 1.10 |
| 3.8 | Skill manager UI | ⬜ | TS | `speg-web/src/components/SkillManager.tsx` | 3.1-3.6 |

---

## Phase 4: Memory + Swarm UI

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 4.1 | Memory graph query (cacm-daemon endpoint) | ⬜ | Rust | `cacm/cacm-daemon/src/` | 1.4 |
| 4.2 | Memory graph visualizer | ⬜ | TS | `speg-web/src/components/MemoryGraph.tsx` | 4.1 |
| 4.3 | Memory search + CRUD UI | ⬜ | TS | `speg-web/src/components/MemorySearch.tsx` | 4.2 |
| 4.4 | Swarm dashboard (DAG view) | ⬜ | TS | `speg-web/src/components/SwarmDashboard.tsx` | 1.10 |
| 4.5 | Phase 4 gate | ⬜ | Both | None | 4.1-4.4 |

---

## Phase 5: Terminal + Auth

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 5.1 | Terminal PTY (jcode existing + UI proxy) | ⬜ | Both | `speg-web/src/components/Terminal.tsx` | 1.10 |
| 5.2 | Auth service (cacm-daemon) | ⬜ | Rust | `cacm/cacm-daemon/src/auth.rs` | 1.4 |
| 5.3 | Auth UI (login/register) | ⬜ | TS | `speg-web/src/routes/auth/` | 5.2 |
| 5.4 | Remote WebSocket gateway | ⬜ | Rust | `cacm/cacm-daemon/src/` | 5.2 |
| 5.5 | Phase 5 gate | ⬜ | Both | None | 5.1-5.4 |

---

## Phase 6: Desktop + Mobile + Polish

| ID | Task | Status | Lang | Files | Depends |
|----|------|--------|------|-------|---------|
| 6.1 | Desktop Electron shell | ⬜ | TS | `speg-desktop/src/main.ts` | 1.12 |
| 6.2 | Desktop bundling (cacm-daemon + jcode) | ⬜ | TS | `speg-desktop/`, `scripts/` | 6.1 |
| 6.3 | Desktop auto-update | ⬜ | TS | `speg-desktop/src/` | 6.1 |
| 6.4 | Mobile React Native app | ⬜ | TS | `speg-mobile/` | 1.10 |
| 6.5 | Mobile push notifications | ⬜ | TS | `speg-mobile/src/` | 6.4 |
| 6.6 | Error boundaries + loading | ⬜ | TS | `speg-web/src/components/` | 1.10 |
| 6.7 | Accessibility + themes + shortcuts | ⬜ | TS | `speg-web/src/` | 1.10 |
| 6.8 | Phase 6 gate | ⬜ | Both | None | 6.1-6.7 |

---

## Language Split

| Language | Components | Phase 1 tasks |
|----------|-----------|---------------|
| **Rust** | cacm-core, cacm-daemon, cacm-sdk-rs, jcode-cacm-bridge, parsers | 1.3–1.8, 1.11 |
| **TypeScript** | @speg/core, contracts, cacm-sdk-ts, speg-web, speg-desktop, speg-mobile | 1.1–1.2, 1.9–1.10, 1.13–1.14 |
| **Markdown** | Skills, docs | 3.1–3.6 |

---

## Overall Progress

```
Phase 1: █░░░░░░░░░░░░░░░░░░░  2/14  (14%)
Phase 2: ░░░░░░░░░░░░░░░░░░░░  0/7   (0%)
Phase 3: ░░░░░░░░░░░░░░░░░░░░  0/8   (0%)
Phase 4: ░░░░░░░░░░░░░░░░░░░░  0/5   (0%)
Phase 5: ░░░░░░░░░░░░░░░░░░░░  0/5   (0%)
Phase 6: ░░░░░░░░░░░░░░░░░░░░  0/8   (0%)
─────────────────────────────────────
TOTAL:   █░░░░░░░░░░░░░░░░░░░  2/47  (4%)
```

## Last Updated

2026-08-04 | v5 — tasks 1.1–1.2 are v4 implementations (committed, unchanged) | 47 tasks
