# G05 — Analysis r3

**Finding**: [../G05-worker-message-builder-duplicated-5x.md](../G05-worker-message-builder-duplicated-5x.md)
**Round-2 review**: [04-review-r2.md](04-review-r2.md) — CHANGES_REQUESTED (3 items).
**Round-2 analysis carried forward**: [01-analysis-r2.md](01-analysis-r2.md) §§1–8 are unchanged; §9 is amended below.

## What r3 changes vs r2

The r2 analysis remains correct on the source facts (the five duplicated `build*Message` bodies, the five `static create` factories, the five subclass constructors, the commit-clause drift, the missing consumer-level test coverage on `createChildSpawner`). r3 only updates the parts r2 review showed were wrong:

1. r2 §7 said "no test imports the builders by name" and concluded the old constructors are not exercised. That is true for `build*Message`, but the existing test file [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) does directly instantiate three of the subclasses with the old positional `(ctx, input)` shape at [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L136), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L200), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L375), and [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L550). These four call sites must migrate to the new construction API, otherwise the validation gate in the plan is a fiction.

2. r2 §9 still listed `ROLE_TO_TASK_TYPE` in [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25-L35) as untouched. r3 folds it into the same single-source pattern: `task-report.ts` imports `WorkerRole` from [src/agents/roster.ts](../../../../src/agents/roster.ts#L213) and `ROLE_TO_TASK_TYPE` is keyed by that imported type — removing the duplicate `WorkerRole` union declaration. After r3 the only owner of "what tasks does a worker accept" is `roster.ts`. The default-task-type lookup itself stays in `task-report.ts` so the existing `normalizeTask` call site keeps working, but the role *set* is now sourced from one place.

3. r2 design claimed that `WORKER_CTORS` and `workerInit` are both exhaustive-checked at compile time. The actual r2 plan compile-time anchor and runtime test do not enforce either. r3 amends §9 with two enforceable mechanisms: a strict compile anchor and a runtime helper that lets the roster cross-check actually fail when a role is unregistered. See §9 below.

## 4. Common structure → contract surface (amended)

Same as [r2 §4](01-analysis-r2.md), with one clarification: the renderer's `**Type:**` line still reads from `ROLE_TO_TASK_TYPE`. That table stays in `task-report.ts` (called from `normalizeTask`) and is now keyed by the `WorkerRole` imported from `roster.ts`, so the role set itself has exactly one declaration.

## 7. Test impact today (amended)

The grep in r2 §7 (`grep -rn 'build(Coder|Researcher|Designer|DataAgent|Reviewer)Message' src/ test/`) returns only the five definitions and their five intra-file callers, and no test imports `*Agent.create`. **However**, the following tests in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) directly instantiate worker subclasses with the old `(ctx, input)` constructor shape and **must** migrate to `WorkerAgent.createWorker(...)`:

| Test (line) | Subclass | Construction shape today |
|---|---|---|
| [agents.test.ts#L136](../../../../src/agents/agents.test.ts#L136) | `ReviewerAgent` | `new ReviewerAgent(ctx, firstInput)` |
| [agents.test.ts#L200](../../../../src/agents/agents.test.ts#L200) | `ReviewerAgent` | `new ReviewerAgent(ctx, firstInput)` |
| [agents.test.ts#L375](../../../../src/agents/agents.test.ts#L375) | `CoderAgent` | `new CoderAgent(makeReviewerContext(...), makeWorkerInput(...))` |
| [agents.test.ts#L550](../../../../src/agents/agents.test.ts#L550) | `DesignerAgent` | `new DesignerAgent(makeReviewerContext(...), input)` |

After r3, every one of these is rewritten to `await WorkerAgent.createWorker<XxxAgent>(ctx, input, "<role>")`. The four call sites do not need the optional `config` parameter (they pass no `onActivity`), so the migration is mechanical. The surrounding test bodies (router stubs, MCP runtime stubs, assertions) do not change. This is the *only* user of the old subclass constructors outside the refactored subclass files themselves, so once these four lines change, `git grep "new (Coder|Reviewer|Designer|Researcher|DataAgent)Agent("` returns zero.

The new test files [src/agents/worker-initial-message.test.ts](../../../../src/agents/worker-initial-message.test.ts) and [src/agents/worker-spawn.test.ts](../../../../src/agents/worker-spawn.test.ts) carry forward unchanged from r2.

## 8. Cross-finding (unchanged)

Same as [r2 §8](01-analysis-r2.md).

## 9. Metadata ownership count (amended)

| Owner | Source | Per-role data it holds (after r3) |
|---|---|---|
| `ROSTER` | [src/agents/roster.ts](../../../../src/agents/roster.ts#L40-L210) | role, worker, dispatchTool, dispatchableBy, toolFilter, abortPriority, selfCheckFrequency, convention, defaultModelKey, displayName, summary, **workerInit** (heading, extraInstructionLines, notesDir, followUpInstruction, promptKey, invalidFinalResponseMessage) |
| `ROLE_TO_TASK_TYPE` | [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25-L35) | role → default `task.type`. Keyed by `WorkerRole` **imported from `roster.ts`** (not redeclared). |
| `WORKER_CTORS` | [src/agents/worker.ts](../../../../src/agents/worker.ts) | role → constructor (ctor wiring, not metadata). Populated by `registerWorkerCtor(role, Class)` at the bottom of each subclass file. |

The first table is the single owner of worker-role metadata. The second holds *one piece* of behaviour (default task type for `normalizeTask` back-fill) and now reuses the roster's `WorkerRole` type. The third holds class bindings only.

### 9a. Real compile-time exhaustiveness for `workerInit`

The r2 anchor

```ts
type EveryWorkerHasInit = Exclude<
  Extract<(typeof ROSTER)[number], { worker: true }>["workerInit"],
  null
> extends WorkerInitMeta ? true : never;
```

does **not** fail when a `worker: true` entry has `workerInit: null` — `Exclude<..., null>` removes the `null` arm before the `extends` check, so the residual is always `WorkerInitMeta` and the anchor type is always `true`. r3 replaces it with a guard that fails the moment any `worker: true` entry's `workerInit` includes `null` in its inferred type:

```ts
type WorkerEntriesWithNullInit = Extract<
  (typeof ROSTER)[number],
  { worker: true; workerInit: null }
>;
type _EveryWorkerHasInit = [WorkerEntriesWithNullInit] extends [never] ? true : never;
const _everyWorkerHasInit: _EveryWorkerHasInit = true;
void _everyWorkerHasInit;
```

If any future entry sets `worker: true` without populating `workerInit` (or with `workerInit: null`), `WorkerEntriesWithNullInit` is non-`never`, `_EveryWorkerHasInit` resolves to `never`, and the `const` assignment fails `tsc --noEmit`. The wrapped-tuple form `[X] extends [never]` is required because the bare `X extends never` distributes over unions and would always be `true` for non-empty unions.

### 9b. Real runtime exhaustiveness for `WORKER_CTORS`

The r2 roster cross-check at [03-plan-r2.md#L403-L417](03-plan-r2.md) wrote `expect(() => WorkerAgent["createWorker"]).toBeDefined()` — that asserts the static method exists on the class, not that any role is actually registered. r3 exports a narrow inspector from [src/agents/worker.ts](../../../../src/agents/worker.ts):

```ts
export function hasWorkerCtor(role: WorkerRole): boolean {
  return WORKER_CTORS.has(role);
}
```

and the cross-check iterates `WORKER_ROLES` and asserts `hasWorkerCtor(role)` for each. If a subclass forgets the `registerWorkerCtor(...)` trailer, the test fails for that specific role. The plan also adds a second runtime smoke: in the spawner test (step 6c), call `createWorker(ctx, input, role)` for every `WorkerRole` with stubs that make `runLoop`/`buildEagerBlock` no-op, and assert no `No worker ctor registered for role "..."` is thrown. Together those two guarantee no role can ship unregistered without one of the two tests failing.
