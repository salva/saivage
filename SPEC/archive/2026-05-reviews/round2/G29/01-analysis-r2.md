# G29 — Analysis (round 2)

**Subsystem**: mcp (plan-server)
**Severity**: low
**Transversality**: module
**Author**: Claude Opus 4.7 (writer)
**Round 1 reviewer**: GPT-5.5 — see [04-review-r1.md](04-review-r1.md). All four numbered concerns addressed below; cross-references appear inline.

## 1. What the issue claims

The plan MCP service funnels every tool call — reads and writes alike — through a single FIFO queue. A slow writer (notably plan_commit, which awaits an external git callback, and plan_complete_stage which today performs two awaited disk writes) blocks every concurrent read on the same in-process server. Since reads after F34 hit an in-memory cache that needs no locking in a single-threaded JS runtime, the queue defeats the cache's latency benefit.

## 2. Live-code anchors (refreshed against current main; addresses r1#4)

Round 1 cited stale offsets. The current line ranges in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) and [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) are:

Plan service — reader methods (cache-only, no disk read):

- plan_get at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L90-L93).
- plan_get_stage at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L96-L104).
- plan_get_current_stage at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L107-L111).
- plan_get_history at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L265-L270).

Plan service — writer methods (await writeDoc, then assign cache):

- plan_set_stages writeDoc at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L133).
- plan_add_stage writeDoc at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L158).
- plan_remove_stage writeDoc at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L176).
- plan_set_current writeDoc at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L192).
- plan_complete_stage — two awaited disk writes today at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L249-L250); G28 collapses this to one writeDoc on the merged PlanDocument.
- plan_init writeDoc at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L294).
- plan_commit awaits the external gitCommitFn at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L302-L321).

Dispatch boundary (the only code G29 edits):

- handleToolCall at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L343-L348).
- serializeOp at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L350-L354).
- handleToolCallInner switch at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L356-L411).
- getToolSchemas at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L414-L502) — the public tool registry the drift guard tests against (addresses r1#2).

Tests:

- deferred helper at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L100-L112).
- handleToolCall routing test at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L572-L577).
- writer/writer ordering test at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L579-L611).
- F34 read/write-ordering test (to be replaced) at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L653-L670).

Sole call site:

- bootstrap registers PlanService at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L169) — public handleToolCall signature is unchanged by G29.

## 3. Root cause

Three converging facts:

1. JavaScript is single-threaded. Mutations of this.plan and this.history are bare assignments executed in a single microtask after the awaited writeDoc resolves. There is no window in which a reader observing this.plan can see torn state.
2. Read tools never touch disk. They return structuredClone over the cache, which is a synchronous deep copy that takes a consistent snapshot at the microtask in which it runs.
3. The opQueue chain was added (F34, round 1) to serialise WRITERS so that two concurrent mutations cannot produce a last-writer-wins overwrite where cache and disk disagree. Including readers in the same chain was over-application of the same primitive.

The defect is therefore structural: a single concurrency primitive guarding two different invariants — disk/cache consistency for writers (necessary) and serial ordering for readers (unnecessary).

## 4. Why in-process MCP reads are safe without the queue (addresses r1#1)

The reviewer required the safety proof to be expressed in terms that survive G28's collapse to a single PlanDocument writeDoc. The proof below holds under both the current two-file layout and the post-G28 single-document layout, because it depends only on:

- writers being mutually exclusive (preserved: writer queue retained);
- the cache being mutated by a single synchronous assignment after the awaited disk write (true today on both this.plan and this.history; remains true post-G28 on the merged snapshot pointer);
- readers performing a single synchronous structuredClone over the current cache pointer (no await between observing this.plan and copying it).

Reader observation lattice. At any microtask, this.plan is either the pre-write snapshot S_n or the post-write snapshot S_{n+1}. A reader executing structuredClone(this.plan) inside one synchronous microtask observes exactly one of those two values; it cannot observe a partially-mutated object because writers do not mutate in place — they build nextPlan, await writeDoc, then assign this.plan = nextPlan as a single statement.

Cross-document residual. Today plan_complete_stage performs two awaited writeDoc calls in sequence at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L249-L250) and only commits this.plan and this.history after both succeed. A reader scheduled between the two awaits sees the old cache for both fields — it never sees plan updated but history stale. Post-G28 this entire concern dissolves because there is one writeDoc on the merged PlanDocument. G29 does not change the proof either way; it only removes the queue from readers.

## 5. Impact

- Latency. A read submitted while plan_commit is awaiting the git callback (which can take seconds) is held in the queue with no progress. Supervisor and chat code paths that call plan_get during a slow write may time out at the MCP layer even though the cached answer is immediately available.
- Cache value defeated. F34 added the cache specifically so reads would not pay disk-I/O cost; queuing them behind writers reintroduces a worse cost.
- No correctness defect. The current code is conservative-correct: queuing reads cannot return wrong data; it merely returns the right data late.

## 6. Constraints from approved neighbours (revised; addresses r1#1)

- G27 is APPROVED — see [G27/APPROVED.md](../G27/APPROVED.md). Adds started_at to active Stage and a preserveStartedAt helper; schema-only change. No interaction with the dispatch boundary.
- G28 is APPROVED — see [G28/APPROVED.md](../G28/APPROVED.md). Collapses plan.json + plan-history.json into a single PlanDocument; plan_complete_stage becomes one writeDoc; reader semantics are clarified for downstream consumers.
- Required sequencing: G27 -> G28 -> G29. This replaces round 1's claim that G29 could land independently. Rationale:
  - G28's coordination note at [G28/03-plan-r2.md](../G28/03-plan-r2.md#L294-L299) states G29 must be re-read after G28 to confirm it no longer depends on the prior two-cache split. Round 2 confirms this: the safety proof (section 4) is expressed against a generic cache-snapshot model that holds equally under the two-cache layout and the post-G28 single-document layout. G29 has no residual dependency on the two-cache split.
  - Landing G29 before G28 would force G28 to merge against an already-modified handleToolCall, complicating its test-surface diff (G28 already amends plan-server tests for the merged document).
  - Landing G29 after G28 keeps the writer-set classification unchanged (the same 7 mutating tool names) because G28 does not add or remove tools.

## 7. Crash-safety regression check

- writeDoc atomicity: unchanged (tmp + rename).
- Writer mutual exclusion: unchanged — opQueue still gates every writer.
- Cache vs disk consistency: unchanged — writer queue still totally orders writer cache mutations relative to disk commits.
- G27 invariants (started_at presence on active Stage): unchanged — schema and writer paths untouched.
- G28 invariants (single writeDoc per plan_complete_stage on PlanDocument): unchanged — G29 does not touch any writer body.

No regression to F34, G27, or G28 crash-safety invariants.

## 8. Out of scope

- The note service [src/mcp/notes-server.ts](../../../../src/mcp/notes-server.ts) does not use serializeOp.
- Knowledge MCP servers (skills/memory) are outside this subsystem.
- Reader fairness across concurrent writers (starvation under continuous writes): non-issue; writer cadence is bounded by the agent loop.
- Migration to an immutable single-snapshot pointer with explicit opt-in cloning is filed as a follow-up to be opened after G28 lands; not in this finding (see [02-design-r2.md](02-design-r2.md) section 3).
