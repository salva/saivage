# F34 r2 — Implementation plan (Proposal B)

## Changes from r1

- Re-baselined ordering: this plan now runs **after** F22, consistent with [SPEC/v2/review-2026-05/F22/APPROVED.md](SPEC/v2/review-2026-05/F22/APPROVED.md) and [SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md#L11-L13).
- Edit steps re-targeted at the post-F22 shape: all `PlanService` methods are already `async`, `documents.ts` exports are `async`, `PlanService.init()` already exists. F34's edits become cache wiring inside the existing async bodies.
- Cache-load now happens inside the existing `async init()` method (added by F22 step 11), not in the constructor.
- `plan_complete_stage` step rewritten as a single, executable sequence: build → `await writeDoc(plan)` → `await writeDoc(history)` → commit both to cache → `archiveStage`. Write-failure semantics stated once and matching [02-design-r2.md](02-design-r2.md).
- "Cross-issue ordering" section flipped: F34 now must wait for F22.

## Ordered edits

All edits are in [src/mcp/plan-server.ts](src/mcp/plan-server.ts) unless noted. Line references are to the **current** (pre-F22, pre-F34) source for traceability; the edit applies to the corresponding location after F22 has landed and turned the methods async.

### Step 0 — Precondition

F22 has merged. The repo state has:
- All `documents.ts` exports are `async`.
- `PlanService` constructor no longer calls `ensureDir`.
- `PlanService.init()` exists and currently has the body `await ensureDir(dirname(this.planPath));` (per [F22/03-plan-r2.md](../F22/03-plan-r2.md#L153-L162)).
- Every public method on `PlanService` is `async` (per F22 plan step 11).
- `bootstrap.ts` calls `await planService.init()` after construction.

If F22 has not landed, **stop**: this plan is not applicable.

### Step 1 — Add cache fields and load them in `init()`

In the `PlanService` class body (around [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L51-L68)):

- Rename `private mutationQueue: Promise<unknown> = Promise.resolve();` to `private opQueue: Promise<unknown> = Promise.resolve();`.
- Add:
  - `private plan: Plan | null = null;`
  - `private history: PlanHistory = { stages: [] };`

Extend the existing post-F22 `async init()` method:

```ts
async init(): Promise<void> {
  await ensureDir(dirname(this.planPath));
  this.plan = await readDocOrNull(this.planPath, PlanSchema);
  this.history = (await readDocOrNull(this.historyPath, PlanHistorySchema)) ?? { stages: [] };
}
```

The constructor body is unchanged from the F22 baseline (path assignments only).

### Step 2 — Replace every `await readDocOrNull` inside tool methods with cache access

Each method body is already `async` (post-F22). F34 swaps the read source and adds the write-then-commit-cache step on mutators.

- `plan_get` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L81-L85): return `structuredClone(this.plan)` or the `PLAN_NOT_FOUND` error.
- `plan_get_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L88-L105): use `this.plan` then `this.history` from the same snapshot; deep-clone the matched record before return.
- `plan_get_current_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L108-L113): use `this.plan`.
- `plan_set_stages` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L116-L139): construct the new `Plan`; `await writeDoc(this.planPath, nextPlan, PlanSchema)`; on success `this.plan = nextPlan;`; return `structuredClone(nextPlan)`.
- `plan_add_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L141-L160): start from `structuredClone(this.plan)`, mutate the clone, `await writeDoc(...)`, then commit to cache. Return a clone.
- `plan_remove_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L161-L178): same pattern.
- `plan_set_current` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L179-L192): same pattern.
- `plan_complete_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L194-L255):
  1. Validate the `CompletedStage` (existing logic).
  2. `const nextPlan = structuredClone(this.plan)`; remove the completed stage; clear `current_stage_id` if it matched; update `updated_at`.
  3. `const nextHistory = structuredClone(this.history)`; push the new `CompletedStage`.
  4. `await writeDoc(this.planPath, nextPlan, PlanSchema)`.
  5. `await writeDoc(this.historyPath, nextHistory, PlanHistorySchema)`.
  6. `this.plan = nextPlan; this.history = nextHistory;`
  7. `archiveStage(this.projectRoot, stage.id)` (existing out-of-scope side effect, kept after the cache commit).
  - **Write-failure handling** is identical to the single-document mutators: any rejected `await writeDoc(...)` propagates out of the op; the cache stays at the prior value. A failure of the second `writeDoc` (history) leaves disk with an updated `plan.json` but stale `plan-history.json`. This is the same residual cross-document disk inconsistency that exists today and is explicitly out of scope for F34 (no rollback `writeDoc` introduced).
- `plan_get_history` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L257-L266): return a clone of `this.history` (or its sliced tail).
- `plan_init` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L268-L290): replace `existsSync(this.planPath)` with `this.plan !== null`; on success `await writeDoc(...)` then `this.plan = plan;`.

Rule of thumb for every mutator: build a new value, `await writeDoc(...)` first, and only then assign to `this.plan` / `this.history`. If any `writeDoc` rejects, the cache stays at the prior value and the error propagates to the queued op.

### Step 3 — Make `handleToolCall` queue every call (not just mutators)

In [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L298-L309), replace the body of `handleToolCall` with:

```ts
async handleToolCall(toolName, args) {
  return this.serializeOp(() => this.handleToolCallInner(toolName, args));
}
```

Rename `serializeMutation` to `serializeOp` and have it operate on `this.opQueue`:

```ts
private async serializeOp<T>(fn: () => Promise<T>): Promise<T> {
  const run = this.opQueue.catch(() => undefined).then(fn);
  this.opQueue = run.catch(() => undefined);
  return run;
}
```

Delete the `isMutatingPlanTool` helper at [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L522-L530) (no longer used).

### Step 4 — Direct method call in `recovery.ts`

[src/runtime/recovery.ts](src/runtime/recovery.ts#L206) calls `planService.plan_get()` directly (outside `handleToolCall`). Post-F22 this is already `await planService.plan_get()`. The method still returns the same shape; after F34 it returns from cache instead of disk. No edit needed in `recovery.ts`; the direct call bypasses `opQueue`, which is acceptable because `recovery.ts` runs during boot before MCP clients are active.

### Step 5 — Deep-clone helper

No separate helper file. Use `structuredClone(...)` inline at the four read sites (`plan_get`, `plan_get_stage`, `plan_get_current_stage`, `plan_get_history`) and inside each mutator that needs a working copy. `structuredClone` is a Node built-in (≥ 17); the `saivage` repo targets Node ≥ 20.

### Step 6 — Tests

Inspect existing tests:

```
src/mcp/plan-server.test.ts
```

Required updates:
- Tests that call a tool method and then read `plan.json` from disk keep working unchanged (writes still hit disk on every mutator).
- Tests that mutate `plan.json` on disk between two service calls and expect the second call to see the new state must be removed or rewritten. Per constraint 5 in the analysis this is no longer supported. Grep for `writeFileSync` / `await writeFile` against `plan.json` inside the test file to enumerate them.
- Any test that constructed `new PlanService(...)` without `await service.init()` (and relied on the constructor-time `ensureDir`) was already updated by F22; F34 inherits that.

New tests to add:
1. **Read-after-write consistency**: call `plan_set_stages(...)` then `plan_get()` and assert the returned plan matches.
2. **Reads return clones**: call `plan_get()`, mutate the returned object, call `plan_get()` again, assert the second result is unaffected.
3. **Concurrent reads/writes serialised through `handleToolCall`**: fire `plan_add_stage` and `plan_get` against `handleToolCall` without awaiting individually; assert ordering matches issue order (the read after the write sees the new stage).
4. **`plan_init` rejects when cache is populated**: assert the existing `STAGE_EXISTS` error path still fires after a successful prior `plan_init`, without needing the file to exist on disk first.
5. **`plan_complete_stage` write-failure leaves cache and primary cache intact**: mock `writeDoc` to reject on the first call; assert `plan_get()` still returns the pre-completion plan, and `plan_get_history()` does not contain the completed stage.
6. **`plan_complete_stage` second-write-failure leaves cache at prior value**: mock `writeDoc` to resolve once then reject; assert `plan_get()` still returns the pre-completion plan (cache unchanged) even though `plan.json` on disk now reflects the post-completion state. Document in the test comment that the cross-document disk drift is the known residual gap out of scope for F34.
7. **Cross-document atomic view in `plan_get_stage`**: covered indirectly by tests 1 and 3.

### Step 7 — Validation commands

Run from `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/mcp/plan-server.test.ts
npx vitest run src/runtime/runtime.test.ts
npx vitest run
```

The first targeted run is for the affected module; the second is for the recovery callsite; the final full-suite run catches surprises in agents that talk to the planner.

### Step 8 — Rollback

One commit, scoped to `src/mcp/plan-server.ts` plus its tests. `git revert` restores the pre-cache behaviour (still on top of F22's async baseline).

## Cross-issue ordering

- Must happen **after** F22 (async fs). F34 targets the post-F22 async `documents.ts` and `PlanService.init()` shape.
- Independent of **F08** (legacy mirror in `recovery.ts`).
- Independent of **F12** (MCP magic constants).
- Touches the same file as no other current F (F-numbers F23, F28 mention MCP but in different files / concerns).
