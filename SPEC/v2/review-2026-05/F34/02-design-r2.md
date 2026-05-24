# F34 r2 — Design

## Changes from r1

- Reversed ordering: F34 lands **after** F22 (consistent with [SPEC/v2/review-2026-05/F22/APPROVED.md](SPEC/v2/review-2026-05/F22/APPROVED.md) and [SPEC/v2/review-2026-05/F22/02-design-r2.md](SPEC/v2/review-2026-05/F22/02-design-r2.md#L149)). All proposals are rewritten against the post-F22 shape: async `documents.ts`, async `PlanService` methods, `PlanService.init()` doing the `ensureDir`.
- Removed the "What it enables: compatible with F22's async migration" framing from Proposal A and the "strictly enabling for F22" framing from Proposal B. Those statements were premised on F34 preceding F22 and no longer apply.
- Fixed Proposal B's internal cache/disk commit ordering inconsistency. The single intended sequence everywhere is: **(1) build new value, (2) `await writeDoc(...)`, (3) only on success assign to cache.** Write-failure behaviour described once and consistent across design and plan.
- `plan_complete_stage` write-then-cache section restated so the design and the plan agree on a single failure model.

Two viable proposals; Proposal B is recommended.

---

## Proposal A — Gate reads through the existing queue, keep disk as source of truth

### Scope

Files touched:
- [src/mcp/plan-server.ts](src/mcp/plan-server.ts)

### What changes

1. Rename `mutationQueue` to `opQueue`; route every `handleToolCall` through it, mutators and readers alike. `isMutatingPlanTool` deleted.
2. Inside `plan_get_stage`, replace the two separate `await readDocOrNull` calls with one helper that reads both documents within the same serialized op — still two async reads but now no other operation can land between them.
3. No other behaviour change. Disk is still the source of truth; every call still re-parses both files.

### What is removed

- The `isMutatingPlanTool` predicate.
- The implicit "reads are free / parallel" assumption.

### Risk

- Read latency increases (queued behind any in-flight write).
- Disk I/O is unchanged: still N reads per N calls. This does nothing to address the per-call `await readFile` + Zod overhead, which is the larger half of the problem.
- Does not fix `plan_complete_stage`'s split write (plan.json then history.json): that split is internal to one queue slot, so readers will not see the intermediate state, which is the only guarantee Proposal A actually adds.

### What it enables

- Nothing additional. The async-fs work F34 used to "enable" is already done by F22.

### What it forbids

- N/A: it adds a constraint (serialised reads) without removing any capability the code uses today.

### Recommendation note

Smallest change that closes the read-after-write ordering gap. Leaves the performance defect (no cache) and the per-call Zod cost on the table.

---

## Proposal B — In-memory `Plan` and `PlanHistory` cache as the source of truth (RECOMMENDED)

### Scope

Files touched:
- [src/mcp/plan-server.ts](src/mcp/plan-server.ts) (constructor body unchanged; `init()` extended; all eleven tools; queue gate)
- `src/mcp/plan-server.test.ts` (existing tests that read disk directly after a call need to be updated for cache-vs-disk consistency assertions; tests that inspect disk to verify writes remain valid)

No changes to [src/store/documents.ts](src/store/documents.ts) — the cache wraps it. F22's async signatures are accepted as-is.

### What changes

1. `PlanService` gains two private fields: `private plan: Plan | null = null` and `private history: PlanHistory = { stages: [] }`. They are populated inside the existing post-F22 `async init()` method by `await readDocOrNull(...)` against `plan.json` and `plan-history.json` (history defaults to `{ stages: [] }` when missing). The constructor stays a pure path-assignment plus `ensureDir` deferral that F22 already established.
2. `mutationQueue` is renamed `opQueue`. `handleToolCall` routes every tool (mutators and readers) through `serializeOp`. Inside each tool the body:
   - reads / mutates the in-memory `this.plan` / `this.history`,
   - on mutation, calls `await writeDoc(...)` (atomic),
   - on a successful `writeDoc`, assigns the new value to `this.plan` / `this.history`,
   - returns a `structuredClone` of the relevant view so callers cannot mutate the cache.
3. `plan_get_stage`'s cross-document lookup is now atomic: both documents are read from the same in-memory snapshot inside one op slot.
4. **`plan_complete_stage` commit ordering (single, consistent sequence):**
   1. Build `nextPlan` (clone of `this.plan` with the completed stage removed and `current_stage_id` cleared if it matched) and `nextHistory` (clone of `this.history` with the new `CompletedStage` appended).
   2. `await writeDoc(planPath, nextPlan, PlanSchema)`.
   3. `await writeDoc(historyPath, nextHistory, PlanHistorySchema)`.
   4. Only after both writes resolve, assign `this.plan = nextPlan; this.history = nextHistory;`.
   5. Then call `archiveStage(...)` (out-of-scope side effect, kept after the cache commit).
   - **Write-failure behaviour (consistent across both single-document mutators and `plan_complete_stage`):** if any `await writeDoc(...)` rejects, the error propagates out of the op and the cache stays at the prior value. For `plan_complete_stage` specifically, this means: a failure of the first `writeDoc` leaves both disk and cache unchanged (correct); a failure of the second `writeDoc` leaves disk with an updated `plan.json` but stale `plan-history.json`, the cache unchanged, and the next read returns the pre-mutation cache. This residual cross-document disk inconsistency is the same gap that exists today and is owned by future work (cross-document journaling), not by F34. F34 explicitly does not introduce a rollback `writeDoc` on the failed-second-write path — that would require its own atomicity story and is outside scope.
5. `plan_get`, `plan_get_current_stage`, `plan_get_history`, `plan_get_stage` no longer touch disk.
6. The `existsSync(this.planPath)` precheck in `plan_init` ([src/mcp/plan-server.ts](src/mcp/plan-server.ts#L268-L290)) is replaced by `this.plan !== null`.
7. Direct external method usage in `recovery.ts` (`planService.plan_get()`) keeps the same return shape; the call is already `await`-ed post-F22.

### What is removed

- All `await readDocOrNull` calls inside the eleven tool methods.
- The `isMutatingPlanTool` predicate (the queue now applies to everything).
- The implicit "disk is the source of truth, in-memory is transient" model — replaced with an explicit cached owner.

### Risk

- Slightly more state to keep correct: every mutation must update both the cache and disk. Mitigation: the cache assignment happens only after `await writeDoc(...)` resolves (so a Zod parse failure inside `writeDoc` does not leave the cache ahead of disk). On disk-write failure the op rejects and the cache stays at the prior value.
- Direct file edits while the service is running will no longer be observed (today, in principle, one could edit `plan.json` by hand and the next `plan_get` would see it). Per constraint 5 in the analysis this is not a supported workflow; accepted.
- Deep cloning before return is required to keep the cache encapsulated. We use `structuredClone` (Node ≥ 17, Saivage targets Node ≥ 20 per `package.json` `engines`).

### What it enables

- **Per-call Zod + JSON.parse cost removed from the hot path.** The planner's `plan_get` / `plan_get_current_stage` loop no longer re-parses the history on every reasoning step.
- **Cross-document snapshot consistency** for `plan_get_stage` (the only tool that crosses the plan/history boundary at read time).
- Future per-stage `tasks.json` / report caching could plug into the same pattern.

### What it forbids

- External processes / scripts editing `plan.json` directly during a Saivage session — they will be silently overwritten on the next mutation. The architecture-first stance is that this is correct: the service owns the file while it runs.
- A multi-instance `PlanService` for the same project. Already implicitly forbidden (bootstrap creates one); now structurally enforced.

### Recommendation note

Proposal B fixes both halves of F34 (read-after-write correctness AND per-call parsing cost) in one structural move and is independent of any further async migration. The added discipline (deep clone on return, write-then-update-cache) is one short helper. Recommended.

---

## Proposal C — Extract a `PlanStore` persistence object behind `PlanService`

### Scope

Files touched:
- New file `src/mcp/plan-store.ts` containing the cache + queue + atomic write logic.
- [src/mcp/plan-server.ts](src/mcp/plan-server.ts) reduced to "tool dispatch on top of `PlanStore`".

### What changes

Same runtime behaviour as Proposal B, but the cache and queue live in a new class. `PlanService` becomes a thin MCP-adapter that translates tool names and arguments into `PlanStore` method calls.

### Risk / cost

- Adds a layer used by one consumer (`PlanService`). Violates the "no abstractions used only once" guideline.
- Test surface doubles (need to test the store separately and the adapter separately).

### Why not chosen

Premature abstraction. There is exactly one consumer of `PlanStore` ever. Proposal B keeps everything in `PlanService` and the file stays at roughly the same size.

---

## Recommendation

**Proposal B**. It is the minimum design that fixes both the correctness gap (reads not gated, cross-document non-atomicity) and the performance gap (per-call disk re-read + Zod). Proposal A is a partial fix; Proposal C adds an unjustified layer.

Cross-link: this design assumes F22 has already landed (so `documents.ts` is async and `PlanService.init()` exists). F08 is handled independently in `recovery.ts`. F12 is not affected.
