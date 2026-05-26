# G29 — Design (round 2)

**Author**: Claude Opus 4.7 (writer)
**Status**: round 2 — addresses all four r1 numbered concerns from [04-review-r1.md](04-review-r1.md).

## 1. Goals

- Reads (plan_get, plan_get_stage, plan_get_current_stage, plan_get_history) must not block behind writers.
- Writers remain mutually exclusive so that cache and disk stay consistent — preserves G28's single-writeDoc invariant.
- Drift between writer classification and the public tool registry is caught by a compile-or-test-time guard tied to PlanService.getToolSchemas (addresses r1#2).
- Tests assert non-blocking behaviour without timer-based races (addresses r1#3).
- Sequencing aligned with approved G27 -> G28 -> G29 order (addresses r1#1).
- No backward compatibility, no migration shims, dead code removed if unreachable.

## 2. Non-goals

- Cross-document atomicity (owned by G28).
- Snapshot semantics for readers across multi-step writer transactions (no current consumer needs this).
- Replacing writeDoc atomicity (unchanged).

## 3. Proposals considered

### Proposal A — Writer-only serialization at the dispatch boundary (RECOMMENDED)

Classify each registered tool name as a reader or a writer. Readers run synchronously through handleToolCallInner without joining opQueue. Writers run through serializeOp as today.

Mechanics (refined to be implementable; addresses r1#2):

- Export two named constants at module scope in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts):

  ```
  export const PLAN_WRITER_TOOLS = new Set<string>([
    "plan_set_stages",
    "plan_add_stage",
    "plan_remove_stage",
    "plan_set_current",
    "plan_complete_stage",
    "plan_init",
    "plan_commit",
  ] as const);

  export const PLAN_READER_TOOLS = new Set<string>([
    "plan_get",
    "plan_get_stage",
    "plan_get_current_stage",
    "plan_get_history",
  ] as const);
  ```

- handleToolCall at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L343-L348) becomes:

  ```
  async handleToolCall(toolName, args) {
    if (PLAN_WRITER_TOOLS.has(toolName)) {
      return this.serializeOp(() => this.handleToolCallInner(toolName, args));
    }
    return this.handleToolCallInner(toolName, args);
  }
  ```

  An unknown tool name (not in either set) falls through the reader path and the switch's default branch at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L405-L407) still returns the VALIDATION_ERROR shape with isError=true. That is correct because the default branch performs no mutation.

- handleToolCallInner switch is unchanged structurally.

Correctness argument:

- Readers read this.plan / this.history exactly once via structuredClone. Because JS is single-threaded and writers mutate the cache by a single synchronous assignment (this.plan = nextPlan and this.history = nextHistory) after the awaited writeDoc, every reader observes either the pre-write or post-write value. No tearing. The argument is unchanged across G28 because post-G28 the assignment becomes a single this.snapshot = nextSnapshot — still atomic in a single microtask.
- Writers are still serial: opQueue chains every writer onto its predecessor.
- Disk semantics unchanged: writeDoc atomic; writer order matches submission order.

Pros:
- Minimal diff (one helper line, two exported Sets, an updated handleToolCall body, three new tests, one deleted test).
- Composes verbatim with G27 (which only changes Stage shape) and G28 (which only changes writer bodies and the cache field shape).
- The drift guard is expressible because PLAN_WRITER_TOOLS and PLAN_READER_TOOLS are explicit exported surfaces that the test imports directly.

Cons:
- The two Sets must stay in sync with PlanService.getToolSchemas. Mitigated by the drift guard test (section 7 item 3) which asserts the disjoint union equals the registered tool names.

### Proposal B — Drop the queue entirely

Premise: JS is single-threaded; cache assignments are synchronous. Writers could mutate cache before or after awaiting writeDoc without any queue.

Rejected: two writers reaching await writeDoc concurrently each base nextPlan on the cache at the time they ran, then commit in arbitrary order — last-writer-wins. The loser's mutation is silently dropped and disk may end up inconsistent with cache. This is exactly what serializeOp prevents, and G28 explicitly relies on writers being mutually exclusive when computing the next merged PlanDocument from the prior snapshot. Proposal B trades a latency bug for a correctness bug. Not viable.

### Proposal C (deferred follow-up, not for this PR)

Single immutable snapshot pointer + writer semaphore. Replace the cache fields with one this.snapshot: PlanDocument. Readers return the pointer (callers opt in to clone). Writers compute nextSnapshot from this.snapshot, await writeDoc, then atomically swap. This is the right end-state but it changes the public reader contract (no implicit clone), and it is cleanest after G28's PlanDocument is in place. Filed as a follow-up to be opened after G28 ships; not bundled into G29.

## 4. Recommended proposal: A

Reasons:

- Smallest viable change that solves the reported defect.
- Aligns with required G27 -> G28 -> G29 sequencing (addresses r1#1): G29 runs last and inherits G28's single-writeDoc invariant for plan_complete_stage with no design changes.
- Strictly preserves crash-safety: writers remain serial; writeDoc remains atomic.
- The drift guard exists at a real, exported surface and is implementable as written (addresses r1#2).

## 5. Behaviour change summary

- Reads submitted while a write is in flight no longer wait for the write to commit. They return the cache value at the moment they execute (pre-write snapshot).
- Reads submitted after a write resolves see the post-write value (unchanged from today).
- Concurrent writes are still totally ordered by submission.
- Tool registration, schemas, and on-disk format unchanged.

## 6. API and observable contract

- Public method handleToolCall signature unchanged.
- Result shape unchanged (`{ content, isError }`).
- Error codes unchanged.
- New module-level exports: PLAN_WRITER_TOOLS, PLAN_READER_TOOLS (consumed by tests; not exposed via MCP).
- Cache invariants:
  - readers return structuredClone of the cache at the moment of execution;
  - writers serially compute next, persist via writeDoc, then commit cache via single assignment.

## 7. Test surface changes (addresses r1#3)

Three new tests; one obsolete test deleted. All concurrency assertions use the existing deferred helper at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L100-L112) and microtask draining. No setTimeout, no wall-clock thresholds.

Microtask-drain pattern. To assert that a promise has settled without using a timer, await a small fixed sequence of resolved promises (`for (let i = 0; i < 5; i++) await Promise.resolve();`). In V8/Node this drains all currently enqueued microtasks, including the chained continuations attached by serializeOp. A promise that has not yet been allowed to progress past an await of an unresolved deferred remains pending after the drain; a promise that only depended on synchronous-then-microtask hops (e.g. the reader path that does not await any external work) settles before the drain completes. The assertion is therefore deterministic against the JS event-loop semantics, not a wall-clock budget.

Test 1 — non-blocking read.

- planService.plan_init([]) (await).
- Install a gated git callback: const gate = deferred<{ sha: string }>(); planService.setGitCommit(async () => gate.promise);
- Track settlement flags:
  - let commitSettled = false;
  - const commitPromise = planService.handleToolCall("plan_commit", { message: "x" }).then((r) => { commitSettled = true; return r; });
  - let getSettled = false;
  - const getPromise = planService.handleToolCall("plan_get", {}).then((r) => { getSettled = true; return r; });
- Drain microtasks (5 iterations of await Promise.resolve()).
- Assert getSettled === true and commitSettled === false. This is the dispatch-boundary assertion: it proves the reader bypassed serializeOp because commitPromise is still awaiting gate.promise.
- await getPromise; assert isError === false and (content as Plan).stages === [].
- gate.resolve({ sha: "abc123" });
- await commitPromise; assert isError === false. Confirms no leak.

Test 2 — post-write read observes the write through handleToolCall (both calls go through the dispatch boundary, per r1#3).

- planService.plan_init([]) (await).
- await planService.handleToolCall("plan_add_stage", { stage: { id: "stg-1", ... } }) — confirm isError === false.
- const readRes = await planService.handleToolCall("plan_get", {}); confirm isError === false.
- Assert (readRes.content as Plan).stages.map((s) => s.id) deepEquals ["stg-1"]. This replicates the old submission-order intent without coupling it to the queue and exercises the new branch in handleToolCall for both writer and reader paths.

Test 3 — drift guard against the public registry (replaces the unimplementable r1 sketch; addresses r1#2).

- import { PLAN_WRITER_TOOLS, PLAN_READER_TOOLS, PlanService } from the plan-server module.
- const registered = new Set(PlanService.getToolSchemas().map((s) => s.name));
- Assert PLAN_WRITER_TOOLS and PLAN_READER_TOOLS are disjoint (intersection size === 0).
- Assert their union, as a set, deepEquals `registered`. This catches:
  - adding a tool to getToolSchemas without classifying it (union missing a name);
  - removing a tool from getToolSchemas without removing it from the Sets (union has extra name);
  - accidentally listing the same tool in both sets (intersection non-empty).

Existing tests preserved:

- "handleToolCall routes correctly" at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L572-L577) — unchanged; remains a basic dispatch smoke test.
- "serializes mutating tool calls across async boundaries" at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L579-L611) — unchanged; verifies writer/writer ordering is preserved.

Obsolete test deleted:

- "F34: concurrent reads/writes through handleToolCall are serialised in submission order" at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L653-L670) — its invariant is the exact behaviour G29 reverses (reads no longer queue behind writers). Tests 1 and 2 above cover the replacement contract.

## 8. Crash-safety regression analysis

- writeDoc atomicity: unchanged.
- Writer serialization: unchanged.
- Cache vs disk consistency: unchanged — writer queue still gates cache mutation.
- G27 invariants (started_at presence on active Stage): unchanged — schema and writer paths untouched.
- G28 invariants (single writeDoc per plan_complete_stage on the merged PlanDocument): unchanged — G29 does not touch any writer body; it edits only the dispatch branch in handleToolCall.

No regression.

## 9. Sequencing (revised; addresses r1#1)

- Required order: G27 -> G28 -> G29. G27 and G28 are already APPROVED; G29 lands after both.
- Rationale: G28's coordination note in [G28/03-plan-r2.md](../G28/03-plan-r2.md#L294-L299) requires G29 to be re-read after G28 to confirm no residual dependency on the two-cache split. Round 2 confirms this (see [01-analysis-r2.md](01-analysis-r2.md) section 4 and section 6). Landing G29 last also keeps the test-surface churn co-located: G28 already touches plan-server tests for the merged document; layering G29 on top is a strictly additive diff.
- No parallel execution is recommended; the win is small and the merge-coordination cost is not worth it.

## 10. Composition with G28's single-writeDoc invariant

After G28 lands, plan_complete_stage performs exactly one writeDoc on the merged PlanDocument and commits the cache via a single assignment. G29 preserves this verbatim because:

- the body of plan_complete_stage is not touched by G29;
- the writer queue at handleToolCall continues to wrap plan_complete_stage (it is in PLAN_WRITER_TOOLS), so two concurrent invocations remain totally ordered;
- the reader proof in [01-analysis-r2.md](01-analysis-r2.md) section 4 is stated against a generic single-snapshot model and therefore holds without modification once G28 collapses this.plan and this.history to one snapshot.

## 11. Risks

- Classification drift between PLAN_WRITER_TOOLS / PLAN_READER_TOOLS and getToolSchemas. Mitigated by Test 3.
- A future reader tool that performs disk I/O (none today) would need re-evaluation. The drift test catches its registration; the design comment in plan-server.ts (added by this PR) flags the invariant.
- None observed for crash-safety or backout (see [03-plan-r2.md](03-plan-r2.md) section 5).
