# SPEG Agent Guide — How to Work on This Project

> **For**: Any coding agent (Claude, Codex, Cursor, SPEG, etc.)
> **Read this FIRST** before touching any code. Then read the master plan and checklist.

---

## Quick Start

1. **Read** `.plans/21-speg-master-plan.md` — the architecture and task overview
2. **Read** `.plans/SPEG-CHECKLIST.md` — find next ⬜ task
3. **Copy the prompt** from `research/promptref.md` — each task has a complete self-contained prompt
4. **Read** `research/08-style-guide.md` — code conventions (or the summary below)
5. **Pick a ⬜ task**, mark it 🔵, set your name in the Agent Assignment table
6. **Research** if needed (search web for algorithms, patterns, APIs)
7. **Implement** following ALL rules
8. **Test**: `vp run typecheck` + `vp run test <your-files>`
9. **Git commit** with conventional commit message after all tests pass
10. **Report**: Write `research/report/<task-id>.md`
11. **Mark** ✅ in checklist, pick next task

---

## Critical Rules (Violating Any = Rejected)

### Code Quality
- ❌ **NO `any` types.** Ever. Determine the true type.
- ❌ **NO suppressed errors/warnings.** Fix the root cause, don't silence.
- ❌ **NO duplicated code.** If copied >2 times → helper function.
- ✅ **MINIMAL code.** Fewer lines = better. If 5 lines do what 20 lines do, use 5.
- ✅ **PRODUCTION quality.** Handle all error states. Clean up resources. Add finalizers.

### TypeScript
- `import type { X }` for type-only imports
- `.ts` extension on ALL relative imports
- Namespace imports for Node builtins: `import * as NodeFS from "node:fs"`
- Derive types from Schema, never hand-write when Schema exists

### Effect
- `Effect.fn("functionName")` for named Effect functions — not bare `Effect.gen`
- `Schema.TaggedErrorClass` for ALL errors — with structured fields
- `Layer.effect(ServiceTag, makeFn)` for service implementations
- `PubSub` for event broadcasting between services
- `Queue` + `Deferred` for command processing

### Tests
- `@effect/vitest` with `it.effect` — not `Effect.runPromise`
- Wait on receipts, never timeouts — "A test that needs a timeout is wrong"
- Test files: `ModuleName.test.ts` adjacent to source
- Run ONLY your changed files: `vp run test speg/src/cacm/SessionWatcher.test.ts`

### Verification (After Every Task)
```bash
vp run --filter speg typecheck     # Type check SPEG package
vp run test <your-test-files>      # Run your tests
vp lint                            # Lint changed files (auto-runs on staged)
```
**NEVER run repo-wide**: `vp check`, `vp run -r test`, `vp run -r typecheck`

### Research
- Before implementing ANY algorithm: search web for best approach
- "Is there a better way?" — check npm, GitHub, papers, blog posts
- If unsure: ASK the human. Don't guess. Don't make up answers.

---

## Task Workflow (Every Task, Every Time)

```
1. READ      → Task spec in master plan + any dependency task reports
2. RESEARCH  → Search web for best approach. Check prior art.
3. PLAN      → Decide on implementation approach (minimal, correct)
4. IMPLEMENT → Write code following style guide
5. TEST      → Write unit tests. Run them.
6. VERIFY    → typecheck + lint + test all pass
7. REPORT    → Write concise report in research/report/<task-id>.md
8. CHECKLIST → Mark ✅ in SPEG-CHECKLIST.md
9. NEXT      → Pick next task. Continue until ALL done or human halts.
```

---

## Report Template

```markdown
# Task <ID>: <Title>

**Agent**: <your-name>
**Status**: ✅ complete
**Time**: <duration>

## What Was Done
<brief description of implementation>

## Files Changed
- `path/to/file.ts` — <what changed>

## Key Decisions
- <decision 1> — <why>
- <decision 2> — <why>

## Research
- <any web research done, URLs consulted>

## Verification
```
vp run --filter speg typecheck  → PASS
vp run test <files>              → 7 passed, 0 failed
```

## Issues / Notes
<anything the next agent needs to know>
```

---

## Multi-Agent Rules

- **One file, one agent.** If two tasks touch the same file, they CANNOT run in parallel. Check the Parallel Work Matrix.
- **Don't cross branches.** Don't look at or merge other agents' branches.
- **Update the checklist.** Mark task 🔵 when you start, ✅ when done.
- **Write clear reports.** The next agent needs to understand your decisions.
- **If blocked, mark it.** Update the Blockers table and explain why.

---

## Report Directory

All reports go in `speg/research/report/`:
```
research/report/
├── 1.1-scaffolding.md
├── 1.2-contracts.md
├── 1.3-harness-sdk.md
├── ...
```

Read previous reports before starting dependent tasks.

---

## Questions?

If ANYTHING is unclear — task specification, architecture decision, edge case — **ask the human**. Do not proceed with ambiguity.
