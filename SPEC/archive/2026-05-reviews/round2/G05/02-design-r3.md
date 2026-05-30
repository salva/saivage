# G05 — Design r3

**Finding**: [../G05-worker-message-builder-duplicated-5x.md](../G05-worker-message-builder-duplicated-5x.md)
**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
**Round-2 review**: [04-review-r2.md](04-review-r2.md) — CHANGES_REQUESTED (3 items).

## Round 3 deltas vs r2

Three reviewer-mandated changes ([04-review-r2.md](04-review-r2.md)) are applied here. Everything else from [02-design-r2.md](02-design-r2.md) — Proposal B (refined) — carries forward unchanged: roster-as-single-owner via `workerInit`, exported free function `buildInitialMessage`, one `WorkerAgent` constructor signature, `WorkerAgent.createWorker<T>(...)` factory, bodyless pure-worker subclasses, reviewer-only override surface, `WORKER_CTORS` as ctor wiring only, mandatory local validation + operator-gated container restarts.

1. **Existing direct-constructor tests are migrated to the new API.** r2 incorrectly asserted the existing agent tests still pass unchanged. r3's plan ([03-plan-r3.md](03-plan-r3.md) step 5b) explicitly rewrites every `new ReviewerAgent(ctx, input)` / `new CoderAgent(ctx, input)` / `new DesignerAgent(ctx, input)` call site in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L136), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L200), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L375), and [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L550) to `await WorkerAgent.createWorker<XxxAgent>(ctx, input, "<role>")`. The plan validation gate `pnpm test -- src/agents` becomes meaningful only after this migration.

2. **Compile-time and runtime exhaustiveness are real.**
   - Compile-time: the r2 anchor `Exclude<..., null> extends WorkerInitMeta` is replaced by `[Extract<..., { worker: true; workerInit: null }>] extends [never]` (see [01-analysis-r3.md §9a](01-analysis-r3.md)). A `worker: true` entry with `workerInit: null` now fails `tsc --noEmit` at the anchor.
   - Runtime: a narrow inspector `export function hasWorkerCtor(role: WorkerRole): boolean` is exported from [src/agents/worker.ts](../../../../src/agents/worker.ts); the roster cross-check iterates `WORKER_ROLES` and asserts `hasWorkerCtor(role)` for each. An unregistered role fails that specific role's assertion (not a generic "the static method exists" boolean).

3. **One owner for `WorkerRole`.** r2 left `task-report.ts` declaring its own `WorkerRole` union next to the roster-derived `WorkerRole`. r3 deletes the duplicate: [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25) imports `WorkerRole` from [src/agents/roster.ts](../../../../src/agents/roster.ts#L213) and `ROLE_TO_TASK_TYPE` is typed `Record<WorkerRole, Task["type"]>` using that imported type. After r3, the role *set* lives in `ROSTER`; the default-task-type *mapping* still lives in `task-report.ts` (called from `normalizeTask`) but reuses the canonical type. This is consistent with the design's "ROSTER is the single source of worker-role metadata" claim — the only remaining role-keyed table outside `ROSTER` is now ctor wiring (`WORKER_CTORS`), which is plumbing, not metadata.

---

## Chosen design — Proposal B (refined; same as r2, three patches applied)

The architecture from [02-design-r2.md](02-design-r2.md) stands. Only the three items above change. The interface, ctor signature, renderer, subclass shape, bootstrap dispatch, and deletion list are unchanged from r2 except as noted below.

### Single source of truth: `ROSTER.workerInit` (unchanged from r2)

Same `WorkerInitMeta` interface, same `workerInit: WorkerInitMeta | null` field on `RosterEntry`, same `getWorkerInitMeta(role)` accessor. See [02-design-r2.md §Single source of truth](02-design-r2.md) for the literal values.

The only material change is the compile-time anchor at the bottom of [src/agents/roster.ts](../../../../src/agents/roster.ts):

```ts
// Compile-time guard: every entry with worker: true must have a non-null workerInit.
type _WorkerEntriesWithNullInit = Extract<
  (typeof ROSTER)[number],
  { worker: true; workerInit: null }
>;
type _EveryWorkerHasInit = [_WorkerEntriesWithNullInit] extends [never] ? true : never;
const _everyWorkerHasInit: _EveryWorkerHasInit = true;
void _everyWorkerHasInit;
```

The wrapped-tuple form is required to prevent distribution over the union (see [01-analysis-r3.md §9a](01-analysis-r3.md)).

### `WorkerRole` is sourced from `ROSTER` everywhere

In [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25):

```ts
// before
export type WorkerRole = "coder" | "researcher" | "data_agent" | "reviewer" | "designer";
const ROLE_TO_TASK_TYPE: Record<WorkerRole, Task["type"]> = { ... };

// after
import type { WorkerRole } from "./roster.js";
export type { WorkerRole };
const ROLE_TO_TASK_TYPE: Record<WorkerRole, Task["type"]> = { ... };
```

The `export type { WorkerRole }` line keeps existing consumers that import `WorkerRole` from `task-report.ts` (e.g. [src/agents/worker.ts](../../../../src/agents/worker.ts)) working without a sweeping import-path update. No cycle: `roster.ts` does not import from `task-report.ts`. `ROLE_TO_TASK_TYPE`'s value literal is unchanged; only its key type now resolves through the roster.

### Unified renderer and factory in `WorkerAgent` (unchanged from r2 + one export)

Same `buildInitialMessage(ctx, input, role, opts?)` exported free function, same `WorkerAgent` constructor `(ctx, input, role, eagerSkillBlock, initialMessage, config?)`, same `static async createWorker<T>(ctx, input, role, config?)`. One new export beside `registerWorkerCtor`:

```ts
export function hasWorkerCtor(role: WorkerRole): boolean {
  return WORKER_CTORS.has(role);
}
```

This is a test inspector only; the runtime path (`createWorker → getWorkerCtor`) keeps its existing throw-on-missing behaviour. `hasWorkerCtor` lets the cross-check report *which* role is unregistered instead of relying on a meta-property check that always passes.

### Subclass files become declarations (unchanged from r2)

Same four three-line files (`coder.ts`, `researcher.ts`, `designer.ts`, `data-agent.ts`) and same reviewer shape. See [02-design-r2.md §Subclass files become declarations](02-design-r2.md).

### Bootstrap changes (unchanged from r2)

Five `case` branches replace `await XxxAgent.create(ctx, workerInput, { onActivity })` with `await WorkerAgent.createWorker<XxxAgent>(ctx, workerInput, role, { onActivity })`. See [02-design-r2.md §Bootstrap changes](02-design-r2.md).

### Deletion list (extended)

Carries [02-design-r2.md §Deletion list](02-design-r2.md) verbatim, plus:

- The duplicate `export type WorkerRole = "coder" | "researcher" | ...` union declaration at [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25). After r3 the type is re-exported from `roster.ts`.
- Four old-style direct-construction call sites in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L136), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L200), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L375), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L550). The surrounding test bodies are unchanged; only the construction expression flips to `await WorkerAgent.createWorker<XxxAgent>(...)`.
- The r2 anchor `Exclude<Extract<..., { worker: true }>["workerInit"], null> extends WorkerInitMeta` — replaced by the wrapped-tuple guard above.
- The r2 roster-cross-check assertion `expect(() => WorkerAgent["createWorker"]).toBeDefined()` — replaced by `expect(hasWorkerCtor(role)).toBe(true)` inside the per-role loop.

### Test impact (amended)

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts): four lines change construction shape (one each at L136, L200, L375, L550). The test functions themselves (router stubs, MCP runtime stubs, assertions on `calls.length` and message contents, `agent.review(...)`, `agent.run()`) do not change. The Reviewer tests at L136 / L200 keep calling `agent.review(firstInput)` and `agent.review(makeReviewInput(...))`, because `ReviewerAgent.review` is still the public follow-up surface ([02-design-r2.md §Subclass files become declarations](02-design-r2.md)).
- [src/agents/worker-initial-message.test.ts](../../../../src/agents/worker-initial-message.test.ts): new, six snapshot cases. Unchanged from r2.
- [src/agents/worker-spawn.test.ts](../../../../src/agents/worker-spawn.test.ts): new, three consumer-level cases over `createChildSpawner` (normal worker + reviewer first + reviewer second-same-stage). Unchanged from r2.
- [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts): r2 cross-check, with the `hasWorkerCtor(role)` assertion replacing the bogus static-method-exists check. The subclass-module dynamic imports stay (they trigger the `registerWorkerCtor` side-effects before the inspector runs).

### Trade-offs (unchanged from r2 plus)

Same trade-offs as [02-design-r2.md §Trade-offs](02-design-r2.md), with one strengthening:

- ✅ The "one owner for worker-role metadata" claim is now also true for the *role-set* itself (`WorkerRole`), not just the per-role payload.
- ✅ Exhaustiveness is enforceable: compile fails on missing `workerInit`, test fails on missing `WORKER_CTORS` registration with a per-role error.

### Why not Proposal A in r3 (unchanged)

Same as [02-design-r2.md §Why not Proposal A in r2](02-design-r2.md). The three r2→r3 patches don't change the verdict.
