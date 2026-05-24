# F34 r1 — Implementation plan (Proposal B)

## Ordered edits

All edits are in [src/mcp/plan-server.ts](src/mcp/plan-server.ts) unless noted.

### Step 1 — Add cache fields and load them in the constructor

In the `PlanService` class body (around [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L51-L68)):

- Rename `private mutationQueue: Promise<unknown> = Promise.resolve();` to `private opQueue: Promise<unknown> = Promise.resolve();`.
- Add:
  - `private plan: Plan | null;`
  - `private history: PlanHistory;`
- In the constructor, after `ensureDir(projectSaivageDir)`:
  - `this.plan = readDocOrNull(this.planPath, PlanSchema);`
  - `this.history = readDocOrNull(this.historyPath, PlanHistorySchema) ?? { stages: [] };`

### Step 2 — Replace every `readDocOrNull` inside tool methods with cache access

Affected methods and their current read sites:

- `plan_get` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L81-L85): return `structuredClone(this.plan)` or the `PLAN_NOT_FOUND` error.
- `plan_get_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L88-L105): use `this.plan` then `this.history`; deep-clone the matched record before return.
- `plan_get_current_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L108-L113): use `this.plan`.
- `plan_set_stages` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L116-L139): construct the new `Plan`, call `writeDoc(this.planPath, plan, PlanSchema)`, then `this.plan = plan;` and return a clone.
- `plan_add_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L141-L160): operate on a deep clone of `this.plan`, write to disk, then commit to cache. Return a clone.
- `plan_remove_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L161-L178): same pattern.
- `plan_set_current` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L179-L192): same pattern.
- `plan_complete_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L194-L255): clone `this.plan` and `this.history`, mutate both, call `writeDoc(planPath)` then `writeDoc(historyPath)`, then commit both to cache. The `archiveStage` side-effect call ([src/mcp/plan-server.ts](src/mcp/plan-server.ts#L249-L253)) stays after both commits.
- `plan_get_history` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L257-L266): return a clone of `this.history` (or its sliced tail).
- `plan_init` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L268-L290): replace `existsSync(this.planPath)` with `this.plan !== null`; on success `writeDoc(...)` then `this.plan = plan;`.

Rule of thumb for every mutator: build a new value, validate it (the Zod schema check now lives inside `writeDoc` already), call `writeDoc` first, and only then assign to `this.plan` / `this.history`. If `writeDoc` throws, the cache stays at the prior value.

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

### Step 4 — Direct method call in `recovery.ts` stays the same

[src/runtime/recovery.ts](src/runtime/recovery.ts#L206) calls `planService.plan_get()` directly (outside `handleToolCall`). The method is still synchronous and returns the same shape. No edit needed there; the call now also bypasses `opQueue`, but `recovery.ts` runs synchronously during boot or the supervisor loop, before MCP clients are active, so the lack of queueing on this direct caller is acceptable. If we want belt-and-braces in a follow-up we can mark the direct method as private and force `recovery.ts` to go through a tiny accessor — out of scope for F34.

### Step 5 — Deep-clone helper

There is no separate helper file. Use `structuredClone(...)` inline at the four read sites (`plan_get`, `plan_get_stage`, `plan_get_current_stage`, `plan_get_history`). `structuredClone` is a Node built-in (≥ 17). The `saivage` repo already targets Node ≥ 20 per `package.json` `engines`.

### Step 6 — Tests

Inspect existing tests:

```
src/mcp/plan-server.test.ts
```

Required updates:
- Any test that calls a tool method and then reads `plan.json` from disk should keep working unchanged (writes still hit disk on every mutator).
- Any test that mutates `plan.json` on disk between two service calls and expects the second call to see the new state must be removed or rewritten. Per constraint 5 in the analysis this is no longer supported. Grep for `writeFileSync` and `readFileSync` against `plan.json` inside the test file to enumerate them.

New tests to add:
1. **Read-after-write consistency**: call `plan_set_stages(...)` then `plan_get()` and assert the returned plan matches.
2. **Reads return clones**: call `plan_get()`, mutate the returned object, call `plan_get()` again, assert the second result is unaffected.
3. **Concurrent reads/writes serialised**: fire `plan_add_stage` and `plan_get` against `handleToolCall` without awaiting; assert ordering matches issue order (the read after the write sees the new stage).
4. **`plan_init` rejects when cache is populated**: assert the existing `STAGE_EXISTS` error path still fires after a successful prior `plan_init`, without needing the file to exist on disk first.
5. **Cross-document atomic view in `plan_get_stage`**: not directly testable without async-write injection; covered indirectly by tests 1 and 3.

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

One commit, scoped to `src/mcp/plan-server.ts` plus its tests. `git revert` restores the pre-cache behaviour.

## Cross-issue ordering

- Must happen **before** F22 (async fs) — F22's safety story relies on F34's read-gating / cache.
- Independent of **F08** (legacy mirror in `recovery.ts`).
- Independent of **F12** (MCP magic constants).
- Touches the same file as no other current F (F-numbers F23, F28 mention MCP but in different files / concerns).
