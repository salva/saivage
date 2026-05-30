# G29 — Design (round 1)

**Author**: Claude Opus 4.7 (writer)
**Status**: round 1 — for reviewer vetting.

## 1. Goals

- Reads (plan_get, plan_get_stage, plan_get_current_stage, plan_get_history) must not block behind writers.
- Writers remain mutually exclusive so that cache and disk stay consistent.
- No reliance on G28's collapsed PlanDocument; design must work today and compose cleanly with G28 when it lands.
- No backward compatibility, no migration shims, dead code removed if it becomes unreachable.

## 2. Non-goals

- Cross-document atomicity (owned by G28).
- Snapshot semantics for readers across multi-step writer transactions (no current consumer needs this).
- Replacing writeDoc atomicity. (Unchanged.)

## 3. Proposals considered

### Proposal A — Writer-only serialization (RECOMMENDED)

Classify each tool name as reader or writer at the dispatch boundary. Readers run synchronously through handleToolCallInner without joining opQueue. Writers run through serializeOp as today.

Mechanics:

- Define a const Set PLAN_WRITER_TOOLS containing: plan_set_stages, plan_add_stage, plan_remove_stage, plan_set_current, plan_complete_stage, plan_init, plan_commit. Everything else is a reader. The default branch (unknown tool) is routed as a reader because it cannot mutate state.
- handleToolCall becomes:
  - if writer: return this.serializeOp(() => this.handleToolCallInner(toolName, args))
  - else: return this.handleToolCallInner(toolName, args)
- handleToolCallInner is unchanged structurally.

Correctness argument:

- Readers read this.plan / this.history exactly once via structuredClone. Because JS is single-threaded and writers mutate the cache by a single synchronous assignment (this.plan = nextPlan) after the awaited writeDoc, every reader observes either the pre-write or post-write value. No tearing.
- Writers are still serial. Two concurrent mutations cannot interleave read-compute-write cycles.
- Disk semantics unchanged: writeDoc is atomic and writers remain mutually exclusive in submission order.

Pros:
- Minimal diff (single helper + a Set).
- Independent of G27 and G28.
- Naturally evolves toward Proposal C once G28's PlanDocument is in place.

Cons:
- Adds a small classification table that must be kept in sync when a new tool is added. Mitigated by exhaustive switch coverage in handleToolCallInner — adding a tool there forces a Set update via a unit test asserting that the union of writer+reader tool names equals the switch's case set.

### Proposal B — Drop the queue entirely

Premise: JS is single-threaded; cache assignments are synchronous. Writers could mutate cache before awaiting writeDoc (or after) without any queue.

Rejected because: two writers reaching await writeDoc concurrently will each base nextPlan on the cache at the time they ran, then commit in arbitrary order. Result: last-writer-wins where the surviving disk state may be inconsistent with the surviving cache state, and the loser's mutation is silently dropped. This is exactly what serializeOp prevents. Proposal B trades a latency bug for a correctness bug. Not viable.

### Proposal C — Single immutable snapshot + writer semaphore (one conceptual level up)

After G28 lands, the cache becomes a single PlanDocument. Replace the two-field cache (this.plan + this.history) with one immutable pointer this.snapshot: PlanDocument. Readers return this.snapshot (callers clone if they intend to mutate). Writers take a writer semaphore, compute nextSnapshot from this.snapshot, await writeDoc, then atomically assign this.snapshot = nextSnapshot.

Pros:
- Cleanest mental model. Reads are pointer reads. Writers commit via atomic pointer swap.
- One concept (snapshot pointer) instead of two (cache + queue + clone-on-read).
- Aligns with the projection types ActivePlanView / PlanHistoryView already chosen by G28.

Cons:
- Couples G29 to G28 landing first. G29 currently has no such sequencing dependency.
- Requires reader callers that expect to mutate the returned object to opt-in to a clone. The current API contract returns clones by default; changing this is a behaviour change beyond the scope of "stop queuing reads".

Verdict: Proposal C is the right end-state but the wrong starting point for this finding. Recommend doing Proposal A now and revisiting C as a follow-up after G28 lands — that follow-up should be filed as a fresh finding, not bundled here, to avoid scope creep.

## 4. Recommended proposal: A

Reasons:
- Smallest viable change that solves the reported defect.
- No sequencing dependency on G27 or G28.
- Composes with G28's writeDoc-atomicity guarantee: the writer queue G28 implicitly relies on is preserved verbatim.
- Strictly preserves crash-safety: writers remain serial; writeDoc remains atomic.

## 5. Behaviour change summary

- Reads submitted while a write is in flight no longer wait for the write to commit. They return the cache value at the moment they execute (pre-write).
- Reads submitted after a write resolves see the post-write value (unchanged).
- Concurrent writes are still totally ordered by submission.
- Tool registration, schemas, and on-disk format unchanged.

## 6. API and observable contract

- Public method handleToolCall signature unchanged.
- Result shape unchanged.
- Error codes unchanged.
- Cache invariants:
  - readers return structuredClone of the cache at the moment of execution;
  - writers serially compute next, persist via writeDoc, then commit cache via single assignment.

## 7. Test surface changes

- runtime.test.ts L653 "F34: concurrent reads/writes through handleToolCall are serialised in submission order" — this test asserts that an add then a get returns the post-add stage list. After G29 the get may run before the add resolves and return an empty list. Replace with two tests:
  1. "G29: a read does not wait for an in-flight slow write" — kick off plan_commit with a deferred git callback, then issue plan_get; the plan_get resolves before commitGate.resolve is called.
  2. "G29: a read issued AFTER a write resolves observes the write" — await plan_add_stage; then plan_get returns the new stage.
- runtime.test.ts L580-L611 "serializes mutating tool calls across async boundaries" — keep as-is. It tests writer/writer ordering, which Proposal A preserves.
- runtime.test.ts L572 "handleToolCall routes correctly" — unchanged.
- Add: "G29: PLAN_WRITER_TOOLS matches the writer cases in handleToolCallInner" — guards against future drift between the Set and the switch.

## 8. Crash-safety regression analysis

- writeDoc atomicity: unchanged.
- Writer serialization: unchanged.
- Cache/disk consistency: unchanged (writer queue still gates cache mutation).
- G27 invariants (started_at presence on active Stage): unchanged — schema and writer paths untouched.
- G28 invariants (single writeDoc per plan_complete_stage): unchanged — G29 does not touch the body of any writer, only the queue gating around the dispatch.

No regression.

## 9. Sequencing

- G29 has no hard ordering dependency on G27 or G28.
- Recommended landing order in the metaplan: G27 → G28 → G29. Rationale: G28 is the larger refactor; landing G29 after G28 keeps the test surface stable (G28 already touches plan-server tests for the merged document). Landing G29 before G28 is also safe but would require a one-line patch to G28's test edits.
- If reviewer prefers parallel execution: G29 can be developed against current main and rebased after G28 lands; the merge is trivial because G29 only edits handleToolCall and adds one Set plus tests.

## 10. Risks

- Adding a writer tool without updating PLAN_WRITER_TOOLS would silently route it as a reader and lose serialization. Mitigated by the drift test (item 4 of section 7) and by exhaustive switch coverage.
- A future tool that does a read on disk (not cache) would need re-evaluation; today no such reader exists.
