# SPEG — Implementation Checklist

> **Tracking**: All tasks, their status, dependencies, and assigned agents
> **Status key**: ⬜ pending | 🔵 in_progress | ✅ complete | ❌ blocked | ⚠️ needs_review
> **Multi-agent**: Tasks with non-overlapping files can run in parallel
> **Commit rule**: Mark ✅ ONLY after git commit succeeds (all tests pass, typecheck clean)

---

## Legend

```
⬜ pending      — Ready. Copy prompt from research/promptref.md
🔵 in_progress  — Being worked on (ONE at a time per agent)
✅ complete     — Done, tested, verified, committed, reported
❌ blocked      — Waiting on dependency or decision
⚠️ needs_review — Done but needs human verification
```

---

## Phase 1: Foundation — Target: Working Windows Desktop Build

| ID | Task | Status | Files | Depends | Agent | Report |
|----|------|--------|-------|---------|-------|--------|
| 1.1 | Package scaffolding | ✅ | `speg/package.json`, `speg/tsconfig.json`, `pnpm-workspace.yaml` | — | — | [1.1-scaffolding.md](../research/report/1.1-scaffolding.md) |
| 1.2 | SPEG contracts (schemas) | ✅ | `packages/contracts/src/speg/` (7 files) | 1.1 | — | [1.2-contracts.md](../research/report/1.2-contracts.md) |
| 1.3 | Jcode harness API client (from source) | ⬜ | `speg/src/jcode/` (10 files: protocol, framing, sockets, client, launch, errors, service, layer) | 1.1, 1.2 | — | — |
| 1.4 | CACM session watcher | ⬜ | `speg/src/cacm/` (7 files) | 1.3 | — | — |
| 1.5 | CACM context extractor | ⬜ | `speg/src/cacm/` (4 files) | 1.4 | — | — |
| 1.6 | CACM context injector | ⬜ | `speg/src/cacm/` (4 files) | 1.5 | — | — |
| 1.7 | SPEG server integration | ⬜ | `apps/server/src/speg/` (4 files), `ws.ts`, `server.ts` | 1.3, 1.6 | — | — |
| 1.8 | Desktop build + Windows packaging | ⬜ | `apps/desktop/src/speg/`, `electron-builder.yml`, `scripts/` | 1.7 | — | — |
| 1.9 | Phase 1 integration test + cleanup | ⬜ | None (verification only) | 1.1–1.8 | — | — |

### Phase 1 Verification Gates

- [ ] `vp run --filter @speg/core typecheck` passes
- [ ] `vp run --filter @t3tools/contracts typecheck` passes
- [ ] `vp run --filter @t3tools/server typecheck` passes
- [ ] `vp run --filter @t3tools/web typecheck` passes
- [ ] `vp run --filter @t3tools/desktop typecheck` passes
- [ ] All SPEG tests pass: `vp run test speg/test/`
- [ ] All contract tests pass: `vp run test packages/contracts/test/speg/`
- [ ] All integration tests pass: `vp run test apps/server/test/speg/`
- [ ] `vp lint` clean (0 errors on SPEG files)
- [ ] `vp run dev` starts with SPEG services active
- [ ] Jcode daemon launches and responds to health check
- [ ] WebSocket accepts `speg.chat.sendMessage` RPC
- [ ] WebSocket streams via `speg.chat.subscribe`
- [ ] CACM RPC methods respond: `speg.cacm.queryContext`, `speg.cacm.listSessions`
- [ ] Windows `.exe` builds: `powershell -File scripts/build-speg-desktop.ps1`
- [ ] Desktop app launches and displays SPEG UI
- [ ] Git tag `speg-v0.1.0-phase1` created
- [ ] Existing T3 Code functionality unaffected (regression check)

---

## Phase 2: Cross-Agent CACM

| ID | Task | Status | Files | Depends | Agent | Report |
|----|------|--------|-------|---------|-------|--------|
| 2.1 | Claude Code session parser | ⬜ | `speg/src/cacm/parsers/ClaudeCodeParser.ts` | 1.4 | — | — |
| 2.2 | Codex session parser | ⬜ | `speg/src/cacm/parsers/CodexParser.ts` | 1.4 | — | — |
| 2.3 | OpenCode session parser | ⬜ | `speg/src/cacm/parsers/OpenCodeParser.ts` | 1.4 | — | — |
| 2.4 | Cursor session parser | ⬜ | `speg/src/cacm/parsers/CursorParser.ts` | 1.4 | — | — |
| 2.5 | Multi-agent watcher (all parsers registered) | ⬜ | `speg/src/cacm/Layers/SessionWatcherLive.ts` (update) | 2.1-2.4 | — | — |
| 2.6 | Cross-agent context injection | ⬜ | `speg/src/cacm/CrossAgentInjector.ts` | 2.5, 1.6 | — | — |
| 2.7 | Memory browser UI (web) | ⬜ | `apps/web/src/routes/speg/`, `apps/web/src/components/speg/` | 1.7, 2.5 | — | — |
| 2.8 | Phase 2 integration test | ⬜ | None (verification) | 2.1-2.7 | — | — |

---

## Phase 3: Providers + Skills

| ID | Task | Status | Files | Depends | Agent | Report |
|----|------|--------|-------|---------|-------|--------|
| 3.1 | Provider catalog service | ⬜ | `speg/src/providers/` | 1.3 | — | — |
| 3.2 | Provider picker UI | ⬜ | `apps/web/src/components/speg/` | 1.7, 3.1 | — | — |
| 3.3 | Model selection persistence | ⬜ | `speg/src/providers/` | 3.1 | — | — |
| 3.4 | API key management UI | ⬜ | `apps/web/src/components/speg/` | 3.2 | — | — |
| 3.5 | Skill: Graphify (Mermaid) | ⬜ | `speg/skills/graphify/SKILL.md` | 1.3 | — | — |
| 3.6 | Skill: Ponytail (formatting) | ⬜ | `speg/skills/ponytail/SKILL.md` | 1.3 | — | — |
| 3.7 | Skill: Best Practices | ⬜ | `speg/skills/best-practices/SKILL.md` | 1.3 | — | — |
| 3.8 | Skill: Security Audit | ⬜ | `speg/skills/security-audit/SKILL.md` | 1.3 | — | — |
| 3.9 | Skill: Doc Generator | ⬜ | `speg/skills/doc-generator/SKILL.md` | 1.3 | — | — |
| 3.10 | Skill: Test Generator | ⬜ | `speg/skills/test-generator/SKILL.md` | 1.3 | — | — |
| 3.11 | Skill manager UI | ⬜ | `apps/web/src/components/speg/SkillManager.tsx` | 3.5-3.10 | — | — |
| 3.12 | Phase 3 integration test | ⬜ | None (verification) | 3.1-3.11 | — | — |

---

## Phase 4: Memory Visualizer + Swarm UI

| ID | Task | Status | Files | Depends | Agent | Report |
|----|------|--------|-------|---------|-------|--------|
| 4.1 | Memory graph query service | ⬜ | `speg/src/memory/` | 1.3 | — | — |
| 4.2 | Memory graph visualizer (D3/Canvas) | ⬜ | `apps/web/src/components/speg/MemoryGraph.tsx` | 4.1 | — | — |
| 4.3 | Memory search UI | ⬜ | `apps/web/src/components/speg/MemorySearch.tsx` | 4.2 | — | — |
| 4.4 | Memory CRUD UI | ⬜ | `apps/web/src/components/speg/MemoryEditor.tsx` | 4.2 | — | — |
| 4.5 | Compactor service | ⬜ | `speg/src/cacm/Compactor.ts` | 1.5 | — | — |
| 4.6 | Compactor UI | ⬜ | `apps/web/src/components/speg/Compactor.tsx` | 4.5 | — | — |
| 4.7 | Swarm creation UI | ⬜ | `apps/web/src/components/speg/SwarmCreate.tsx` | 1.3 | — | — |
| 4.8 | Swarm dashboard (DAG view) | ⬜ | `apps/web/src/components/speg/SwarmDashboard.tsx` | 4.7 | — | — |
| 4.9 | Swarm agent controls | ⬜ | `apps/web/src/components/speg/SwarmControls.tsx` | 4.8 | — | — |
| 4.10 | Phase 4 integration test | ⬜ | None (verification) | 4.1-4.9 | — | — |

---

## Phase 5: Terminal + VCS + Browser + Auth

| ID | Task | Status | Files | Depends | Agent | Report |
|----|------|--------|-------|---------|-------|--------|
| 5.1 | Terminal PTY service | ⬜ | `speg/src/terminal/` | 1.7 | — | — |
| 5.2 | Terminal UI (xterm.js) | ⬜ | `apps/web/src/components/speg/Terminal.tsx` | 5.1 | — | — |
| 5.3 | VCS diff viewer | ⬜ | `apps/web/src/components/speg/DiffViewer.tsx` | 1.7 | — | — |
| 5.4 | Branch picker UI | ⬜ | `apps/web/src/components/speg/BranchPicker.tsx` | 5.3 | — | — |
| 5.5 | Browser automation UI | ⬜ | `apps/web/src/components/speg/BrowserPreview.tsx` | 1.3 | — | — |
| 5.6 | Auth service (JWT + OAuth) | ⬜ | `speg/src/auth/` | 1.7 | — | — |
| 5.7 | Auth UI (login/register) | ⬜ | `apps/web/src/routes/speg/auth/` | 5.6 | — | — |
| 5.8 | Remote WebSocket (WSS) | ⬜ | `apps/server/src/speg/` | 5.6 | — | — |
| 5.9 | Phase 5 integration test | ⬜ | None (verification) | 5.1-5.8 | — | — |

---

## Phase 6: Desktop + Mobile + Polish

| ID | Task | Status | Files | Depends | Agent | Report |
|----|------|--------|-------|---------|-------|--------|
| 6.1 | Desktop Electron shell | ⬜ | `apps/desktop/src/speg/` | 1.8 | — | — |
| 6.2 | Desktop native features | ⬜ | `apps/desktop/src/speg/` | 6.1 | — | — |
| 6.3 | Desktop auto-update | ⬜ | `apps/desktop/src/speg/` | 6.1 | — | — |
| 6.4 | Mobile React Native app | ⬜ | `apps/mobile/src/speg/` | 1.7 | — | — |
| 6.5 | Mobile push notifications | ⬜ | `apps/mobile/src/speg/` | 6.4 | — | — |
| 6.6 | Error boundaries + recovery | ⬜ | `apps/web/src/components/speg/` | 1.7 | — | — |
| 6.7 | Loading states + skeletons | ⬜ | `apps/web/src/components/speg/` | 1.7 | — | — |
| 6.8 | Keyboard shortcuts | ⬜ | `apps/web/src/` | 1.7 | — | — |
| 6.9 | Dark/light themes | ⬜ | `apps/web/src/` | 1.7 | — | — |
| 6.10 | Accessibility (ARIA) | ⬜ | `apps/web/src/components/speg/` | 1.7 | — | — |
| 6.11 | Phase 6 integration test | ⬜ | None (verification) | 6.1-6.10 | — | — |

---

## Parallel Work Matrix

| Group | Tasks | Files |
|-------|-------|-------|
| **A: Core Setup** | 1.1, 1.2 | `speg/`, `packages/contracts/src/speg/` |
| **B: Jcode SDK** | 1.3 | `speg/src/jcode/` |
| **C: CACM Engine** | 1.4, 1.5, 1.6 | `speg/src/cacm/` (sequential — each depends on previous) |
| **D: Server + Desktop** | 1.7, 1.8 | `apps/server/`, `apps/desktop/` |
| **E: Parsers** (Phase 2) | 2.1, 2.2, 2.3, 2.4 | `speg/src/cacm/parsers/` (different files each) |
| **F: Skills** (Phase 3) | 3.5-3.10 | `speg/skills/` (different files each) |
| **G: Memory UI** (Phase 4) | 4.2, 4.3, 4.4 | `apps/web/src/components/speg/` (different files) |

---

## Agent Assignment

| Agent | Current Task | Status | Started | Last Activity |
|-------|-------------|--------|---------|---------------|
| — | — | — | — | — |

---

## Blockers & Decisions Needed

| ID | Issue | Raised | Resolution |
|----|-------|--------|------------|
| — | — | — | — |

---

## Overall Progress

```
Phase 1: █░░░░░░░░░░░░░░░░░░░  1/9   (11%)
Phase 2: ░░░░░░░░░░░░░░░░░░░░  0/8   (0%)
Phase 3: ░░░░░░░░░░░░░░░░░░░░  0/12  (0%)
Phase 4: ░░░░░░░░░░░░░░░░░░░░  0/10  (0%)
Phase 5: ░░░░░░░░░░░░░░░░░░░░  0/9   (0%)
Phase 6: ░░░░░░░░░░░░░░░░░░░░  0/11  (0%)
─────────────────────────────────────
TOTAL:   █░░░░░░░░░░░░░░░░░░░  1/59  (2%)
```

---

## Last Updated

2026-08-04 | Plan v3 | 59 tasks across 6 phases | Windows build target
