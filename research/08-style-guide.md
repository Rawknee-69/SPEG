# T3 Code / SPEG — Comprehensive Style Guide

> Extracted from: AGENTS.md, tsconfig.base.json, vite.config.ts, oxlint rules, LLMS.md, actual source code
> **Every agent MUST follow these rules. Violations = rejected code.**

---

## 1. File Naming

| Type | Convention | Example |
|------|-----------|---------|
| Services | `PascalCase.ts` | `SessionWatcher.ts`, `OrchestrationEngine.ts` |
| Layers (implementations) | `PascalCaseLive.ts` | `SessionWatcherLive.ts` |
| Utilities/logic | `camelCase.ts` | `sessionWatcher.ts`, `composerDraftStore.ts` |
| Errors | `Errors.ts` (one per domain) | `speg/src/cacm/Errors.ts` |
| Contracts | `domainName.ts` | `spegSession.ts`, `spegContext.ts` |
| Tests | `ModuleName.test.ts` | `SessionWatcher.test.ts` |
| Plans | `NN-short-description.md` | `21-speg-master-plan.md` |

---

## 2. Import Ordering (Strict)

```typescript
// 1. Type-only imports from contracts
import type { ThreadId, SessionId } from "@t3tools/contracts";

// 2. Runtime value imports from contracts
import { OrchestrationCommand } from "@t3tools/contracts";

// 3. Effect namespace imports (alphabetical)
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

// 4. Effect sub-packages
import * as NodeContext from "@effect/platform-node/NodeContext";

// 5. Node builtins (MUST use canonical PascalCase aliases)
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
// NOT: import * as fs from "node:fs"  ← WRONG

// 6. Internal domain imports (relative with .ts extension)
import { SessionWatcher } from "./Services/SessionWatcher.ts";
import { toParseError } from "./Errors.ts";

// 7. Test imports
import { describe, expect, it } from "vite-plus/test";
```

**Forbidden**: `import * as os from "node:os"` — must be `NodeOS`. Namespace aliases enforced by `t3code/namespace-node-imports` rule.

---

## 3. Type Declaration Patterns

### Branded IDs

```typescript
import * as Schema from "effect/Schema";

const makeId = <Brand extends string>(brand: Brand) =>
  Schema.NonEmptyString.pipe(Schema.brand(brand));

export const AgentSessionId = makeId("AgentSessionId");
export type AgentSessionId = typeof AgentSessionId.Type;

// Usage: AgentSessionId.make("some-id")
```

### Schema-First (ALL validation)

```typescript
// Literals
export const SessionStatus = Schema.Literals("active", "idle", "completed", "failed");
export type SessionStatus = typeof SessionStatus.Type;

// Structs
export const AgentSessionDescriptor = Schema.Struct({
  sessionId: AgentSessionId,
  agentType: Schema.String,
  status: SessionStatus,
  path: Schema.String,
  metadata: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});
export type AgentSessionDescriptor = typeof AgentSessionDescriptor.Type;

// Union
export const CrossAgentEvent = Schema.Union(
  Schema.Struct({ _tag: Schema.Literal("session-started"), session: AgentSessionDescriptor }),
  Schema.Struct({ _tag: Schema.Literal("turn-detected"), turn: AgentTurn }),
  Schema.Struct({ _tag: Schema.Literal("session-ended"), sessionId: AgentSessionId }),
);
```

### Inferred over Annotated

```typescript
// GOOD: derive from schema
export type AgentSessionDescriptor = typeof AgentSessionDescriptor.Type;

// BAD: hand-write when schema exists
export interface AgentSessionDescriptor { ... }
```

### NO `any`

```typescript
// NEVER
function process(data: any): any { ... }

// ALWAYS: determine the true type
function process(data: AgentSessionDescriptor): Effect.Effect<void, ParseError> { ... }
```

---

## 4. Effect Patterns

### Service + Layer

```typescript
// Services/SessionWatcher.ts
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export interface SessionWatcherShape {
  readonly watch: () => Effect.Effect<void, SessionWatcherError>;
  readonly streamActivity: Stream.Stream<SessionActivity>;
}

export class SessionWatcher extends Context.Service<SessionWatcher, SessionWatcherShape>()(
  "speg/cacm/SessionWatcher"
) {}

// Layers/SessionWatcherLive.ts
import * as Layer from "effect/Layer";

export const SessionWatcherLive = Layer.effect(
  SessionWatcher,
  Effect.gen(function* () {
    const activityPubSub = yield* PubSub.unbounded<SessionActivity>();
    
    const watch = Effect.fn("SessionWatcher.watch")(function* () {
      // ... implementation
    });
    
    return SessionWatcher.of({
      watch,
      streamActivity: Stream.fromPubSub(activityPubSub),
    });
  }),
);
```

### Effect.fn (NOT bare Effect.gen)

```typescript
// GOOD
const processTurn = Effect.fn("processTurn")(function* (turn: AgentTurn) {
  const extractor = yield* ContextExtractor;
  return yield* extractor.extract(turn);
});

// BAD
const processTurn = (turn: AgentTurn) =>
  Effect.gen(function* () {
    const extractor = yield* ContextExtractor;
    return yield* extractor.extract(turn);
  });
```

### Error Handling

```typescript
// Define errors as TaggedErrorClass
export class SessionParseError extends Schema.TaggedErrorClass<SessionParseError>()(
  "SessionParseError",
  {
    sessionId: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to parse session ${this.sessionId}: ${this.reason}`;
  }
}

// Union type
export type SessionWatcherError = SessionParseError | SessionNotFoundError;

// Catching
effect.pipe(
  Effect.catchTag("SessionParseError", (e) =>
    Effect.logWarning(`Parse failed: ${e.reason}`),
  ),
);
```

### Layer Composition

```typescript
export const SpegLayer = Layer.mergeAll(
  JcodeInstanceManagerLive,
  SessionWatcherLive.pipe(Layer.provide(JcodeInstanceManagerLive)),
  ContextExtractorLive.pipe(Layer.provide(SessionWatcherLive)),
);
```

---

## 5. Function Patterns

### Minimal code — DRY aggressively

```typescript
// BAD: duplicated error handling
function readFileA(path: string) {
  try { return fs.readFileSync(path, "utf-8"); }
  catch (e) { throw new FileReadError({ path, cause: e }); }
}
function readFileB(path: string) {
  try { return fs.readFileSync(path, "utf-8"); }
  catch (e) { throw new FileReadError({ path, cause: e }); }
}

// GOOD: helper (ONLY if used ≥3 times)
function safeReadFile(path: string): string {
  try { return NodeFS.readFileSync(path, "utf-8"); }
  catch (e) { throw new FileReadError({ path, cause: e }); }
}
```

### Early returns over nested ifs

```typescript
// BAD
function validate(input: Input): Result {
  if (input.name) {
    if (input.email) {
      if (input.age > 0) {
        return { valid: true, data: input };
      }
    }
  }
  return { valid: false };
}

// GOOD
function validate(input: Input): Result {
  if (!input.name) return { valid: false };
  if (!input.email) return { valid: false };
  if (input.age <= 0) return { valid: false };
  return { valid: true, data: input };
}
```

---

## 6. Testing Patterns

### Test framework: @effect/vitest

```typescript
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// Use it.effect (NOT Effect.runPromise)
describe("SessionWatcher", () => {
  it.effect("detects new session activity", () =>
    Effect.gen(function* () {
      const watcher = yield* SessionWatcher;
      yield* watcher.watch();
      const events: SessionActivity[] = [];
      // ... collect events
      expect(events.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
```

### Test data factories

```typescript
function makeAgentSession(overrides: Partial<AgentSessionDescriptor> = {}): AgentSessionDescriptor {
  return {
    sessionId: AgentSessionId.make("test-session"),
    agentType: "jcode",
    status: "active",
    path: "/tmp/test/.jcode/sessions/test-session",
    metadata: {},
    ...overrides,
  };
}
```

### NO timeouts in tests

```typescript
// BAD
await new Promise(r => setTimeout(r, 1000));

// GOOD: wait on receipts or drains
yield* DrainableWorker.drain(worker);
```

---

## 7. Verification (After Every Task)

```bash
# Type check SPEG package only
vp run --filter speg typecheck

# Run YOUR tests only
vp run test speg/src/cacm/SessionWatcher.test.ts

# Lint (auto-runs on staged files via vite-plus)
vp lint
```

**NEVER run**: `vp check`, `vp run -r test`, `vp run -r typecheck` — CI owns these.

---

## 8. Forbidden Patterns (Enforced)

| Pattern | Why Forbidden |
|---------|---------------|
| `process.platform` / `process.arch` | Not Effect-injectable. Use `HostProcess` from shared. |
| `Effect.runPromise` in new tests | Use `@effect/vitest` with `it.effect` |
| `Schema.decodeSync(...)` in function body | Recompiles on every call. Hoist to module scope. |
| `import * as fs from "node:fs"` | Must use `NodeFS`. Enforced by namespace lint rule. |
| Barrel imports from `@t3tools/client-runtime` | Use explicit subpath imports |
| `any` type anywhere | Type safety violation |
| `Date.now()`, `Math.random()`, `console.log`, `fetch` in Effect | Use Effect services |
| `pkill -f` / PID-by-name | May kill developer's agent |
| Timeout-based waiting in tests | Use receipts and drains |

---

## 9. Research Before Implementing

For ANY non-trivial logic:
1. Search web: "best way to [X] in TypeScript"
2. Check npm for existing packages
3. Check GitHub for prior art
4. Check papers/blogs for algorithms
5. If multiple approaches: pick the simplest correct one
6. If unsure: ASK

---

## 10. Report Template

After every task, write to `research/report/<task-id>.md`:

```markdown
# Task <ID>: <Title>
**Agent**: <name> | **Status**: ✅ | **Time**: <duration>

## What Was Done
<brief>

## Files Changed
- `path` — <what>

## Verification
```
vp run --filter speg typecheck  → PASS
vp run test <files>              → N passed, 0 failed
```

## Notes
<anything next agent needs>
```
