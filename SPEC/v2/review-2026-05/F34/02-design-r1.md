# F34 r1 — Design

Two viable proposals; Proposal B is recommended.

---

## Proposal A — Gate reads through the existing queue, keep disk as source of truth

### Scope

Files touched:
- [src/mcp/plan-server.ts](src/mcp/plan-server.ts)

### What changes

1. Rename `mutationQueue` to `opQueue`; route every `handleToolCall` through it, mutators and readers alike. `isMutatingPlanTool` deleted.
2. Inside `plan_get_stage`, replace the two separate `readDocOrNull` calls with one helper that reads both documents within the same serialized op — still two `readFileSync` syscalls but now no other operation can land between them.
3. No other behaviour change. Disk is still the source of truth; every call still parses both files.

### What is removed

- The `isMutatingPlanTool` predicate.
- The implicit "reads are free / parallel" assumption.

### Risk

- Read latency increases (queued behind any in-flight write).
- Disk I/O is unchanged: still N reads per N calls. This does nothing to address the per-call `readFileSync` + Zod overhead, which is the larger half of the problem.
- Does not fix `plan_complete_stage`'s split write (plan.json then history.json): that split is internal to one queue slot, so readers will not see the intermediate state, which is the only guarantee Proposal A actually adds.

### What it enables

- Compatible with F22's async migration: once reads are queued, switching writes to `fs/promises` is safe because no concurrent read can land between the async chunks of a write.

### What it forbids

- N/A: it adds a constraint (serialised reads) without removing any capability the code uses today.

### Recommendation note

Smallest change that closes the correctness gap. Leaves the performance defect (no cache) on the table.

---

## Proposal B — In-memory `Plan` and `PlanHistory` cache as the source of truth (RECOMMENDED)

### Scope

Files touched:
- [src/mcp/plan-server.ts](src/mcp/plan-server.ts) (constructor, all eleven tools, queue gate)
- `src/mcp/plan-server.test.ts` (existing tests that read disk directly after a call need to be updated — they already exist for cache-vs-disk consistency assertions; tests that inspect disk to verify writes remain valid)

No changes to [src/store/documents.ts](src/store/documents.ts) — the cache wraps it.

### What changes

1. `PlanService` gains two private fields: `private plan: Plan | null` and `private history: PlanHistory`. Both are initialised in the constructor by reading from disk once (using `readDocOrNull` / `readDocOrNull` returning `{ stages: [] }` when missing).
2. `mutationQueue` is renamed `opQueue`. Every public method (including readers) becomes a coroutine that:
   - awaits the queue,
   - reads/mutates the in-memory `this.plan` / `this.history`,
   - on mutation, writes the new state to disk via `writeDoc` (atomic),
   - returns a deep clone of the relevant view so callers cannot mutate the cache.
3. `plan_get_stage`'s cross-document lookup is now atomic: both documents are read from the same in-memory snapshot inside one op slot.
4. `plan_complete_stage` keeps two `writeDoc` calls (one per file: durability is out of scope for F34), but the cache mutation for both documents is committed atomically before either disk write begins. Readers always see a consistent in-memory view; a crash between the two disk writes is the same risk as today and is owned by F22-adjacent work, not F34.
5. `plan_get`, `plan_get_current_stage`, `plan_get_history`, `plan_get_stage` no longer touch disk.
6. `existsSync(this.planPath)` in `plan_init` is replaced by `this.plan !== null`.
7. Direct external method usage in `recovery.ts` (`planService.plan_get()`) keeps the same return shape; `plan_get` becomes synchronous on the cache. The signature stays sync because the cache lives in memory; only `handleToolCall` (which is already `async`) is affected.

   For uniformity, the public methods called via `handleToolCallInner` stay sync; the queueing happens at the `handleToolCall` boundary (same place it does today). `plan_commit` remains `async` because git is async.

### What is removed

- All `readDocOrNull` calls inside the eleven tool methods.
- The `isMutatingPlanTool` predicate (the queue now applies to everything).
- The implicit "disk is the source of truth, in-memory is transient" model — replaced with an explicit cached owner.

### Risk

- Slightly more state to keep correct: every mutation must update both the cache and disk. We mitigate by performing the cache write only after `writeDoc` succeeds (so a Zod parse failure inside `writeDoc` doesn't leave the cache ahead of disk). On disk-write failure we re-throw and the cache stays at the prior value.
- Direct file edits while the service is running will no longer be observed (today, in principle, you could edit `plan.json` by hand and the next `plan_get` would see it). Per constraint 5 in the analysis this is not a supported workflow; we accept it.
- Deep cloning before return is required to keep the cache encapsulated. We use `structuredClone` (Node ≥ 17, available in Saivage's `engines`).

### What it enables

- **F22 migration is straightforward**: reads never touch disk, so the async-fs question reduces to "are writes serialised by the queue?" — already yes via `opQueue`.
- **F12-adjacent simplification**: the per-call `JSON.parse` + Zod work on the hot path goes away, reducing the budget pressure that motivates timing-related magic constants.
- Future per-stage `tasks.json` / report caching could plug into the same pattern.

### What it forbids

- External processes / scripts editing `plan.json` directly during a Saivage session — they will be silently overwritten on the next mutation. The architecture-first stance is that this is correct: the service owns the file while it runs.
- A multi-instance `PlanService` for the same project. Already implicitly forbidden (bootstrap creates one); now structurally enforced.

### Recommendation note

Proposal B fixes both halves of F34 (correctness AND performance) in one structural move, and is strictly enabling for F22. The added discipline (deep clone on return, write-then-update-cache) is one short helper. Recommended.

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

**Proposal B**. It is the minimum design that fixes both the correctness gap (reads not gated, cross-document non-atomicity) and the performance gap (per-call disk re-read), and it is precisely the precondition F22's async-fs migration needs. Proposal A is a partial fix; Proposal C adds an unjustified layer.

Cross-link: this design assumes F22 is still pending (so we cannot rely on async writes being safe by themselves) and that F08 will be handled independently in `recovery.ts`. F12 is not affected.
