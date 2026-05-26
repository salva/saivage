# G29 — Analysis (round 1)

**Subsystem**: mcp (plan-server)
**Severity**: low
**Transversality**: module
**Author**: Claude Opus 4.7 (writer)

## 1. What the issue claims

The plan MCP service funnels every tool call — reads and writes alike — through a single FIFO queue. A slow writer (notably plan_commit, which awaits an external git callback, and post-G28 plan_complete_stage) blocks every concurrent read on the same in-process server. Since reads after F34 hit an in-memory cache that needs no locking in a single-threaded JS runtime, this defeats the cache's latency benefit.

## 2. Code under review

The serialization wrapper and its single call site:

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L53) — opQueue field initialised to a resolved promise.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L343-L348) — handleToolCall delegating every tool to serializeOp.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L350-L354) — serializeOp body. It chains every call onto opQueue, so call N waits for call N-1 regardless of whether either is a reader or a writer.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L356-L412) — handleToolCallInner switch dispatching all 11 tools.

Cache state and read methods (proof that reads do not need the queue):

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L57-L58) — in-memory cache fields plan and history, hydrated by init.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L71-L75) — init reads disk once into the cache.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L88-L91) — plan_get returns structuredClone(this.plan) synchronously after the async fence.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L94-L102) — plan_get_stage reads cache only.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L105-L110) — plan_get_current_stage reads cache only.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L245-L250) — plan_get_history reads cache only.

Writer pattern (proof that cache updates are atomic at a single statement after the awaited disk write):

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L113-L137) — plan_set_stages: builds nextPlan, awaits writeDoc, then assigns this.plan = nextPlan.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L139-L159) — plan_add_stage.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L161-L178) — plan_remove_stage.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L180-L194) — plan_set_current.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L196-L243) — plan_complete_stage (two writeDoc calls today; collapses to one after G28).
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L253-L276) — plan_init.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L278-L312) — plan_commit awaits an external git callback (gitCommitFn) whose duration is unbounded.

Callers and tests:

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L169) — only registration site for the plan service.
- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L572-L578) — handleToolCall routing test.
- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L580-L611) — write/write submission-order test (still required after G29).
- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L653-L670) — F34 read/write submission-order test that this finding renders obsolete (must be replaced, see plan).

## 3. Root cause

Three converging facts:

1. JavaScript is single-threaded. Mutations of this.plan and this.history are bare assignments executed in a single microtask after the awaited writeDoc resolves. There is no window in which a reader observing this.plan can see torn state.
2. Read tools never touch disk. They only call structuredClone on the cache.
3. The opQueue chain was added (F34, round 1) to serialise WRITERS so that two concurrent mutations cannot produce a last-writer-wins overwrite where cache and disk disagree. Including readers in the same chain was over-application of the same primitive.

The defect is therefore not a correctness bug but a structural one: a single concurrency primitive guarding two different invariants — disk/cache consistency for writers (necessary) and serial ordering for readers (unnecessary).

## 4. Impact

- Latency. A read submitted while plan_commit is awaiting the git callback (which can take seconds) is held in the queue with no progress. Supervisor and chat code paths that call plan_get during a slow write may time out at the MCP layer even though the cached answer is immediately available.
- Cache value defeated. F34 added the cache specifically so reads would not pay disk-I/O cost; queuing them behind writers reintroduces a worse cost.
- No correctness defect. The current code is conservative-correct: queuing reads cannot return wrong data; it merely returns the right data late.

## 5. Constraints from neighbours

- G27 (approved). Adds an optional started_at field to active Stage. Schema-only change, orthogonal to queueing. No interaction.
- G28 (approved). Collapses plan.json and plan-history.json into a single PlanDocument; atomicity of plan_complete_stage becomes a property of a single writeDoc. The writer queue must remain in place — G28 still relies on writes being serial so that the in-memory snapshot used to compute the next document is not stale.
- Sequencing. G29 may land independently of G27 and G28 (queue is orthogonal to schema/layout). After G28, plan_complete_stage performs one writeDoc instead of two; the residual cross-document gap noted in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L230-L233) disappears under G28, not G29.

## 6. Crash-safety regression check

- writeDoc remains atomic (tmp + rename) — unchanged.
- Writer queue retained — concurrent writers still serialised; cache and disk never diverge.
- Reads observe a single snapshot (the current value of this.plan / this.history) taken synchronously inside structuredClone. They can return stale-but-consistent data if a writer has not yet committed; they cannot return torn or partially-updated data.

No regression to F34, G27, or G28 crash-safety invariants.

## 7. Out of scope

- The note service [src/mcp/notes-server.ts](../../../../src/mcp/notes-server.ts) does not use serializeOp and is unaffected.
- Knowledge MCP servers (skills/memory) are outside this subsystem.
- Reader fairness across concurrent writers (e.g. starvation under continuous writes) is a non-issue: writers are bounded in cadence by the agent loop.
