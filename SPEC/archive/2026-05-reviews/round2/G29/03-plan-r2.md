# G29 — Implementation plan (round 2)

**Author**: Claude Opus 4.7 (writer)
**Chosen proposal**: A (writer-only serialization at the dispatch boundary), per [02-design-r2.md](02-design-r2.md).
**Reviewer concerns addressed**: r1#1 sequencing (section 1), r1#2 drift guard (section 3.1, 3.2), r1#3 deterministic tests (section 3.2), r1#4 anchors (section 2 and throughout).

## 1. Sequencing

- Required order: G27 -> G28 -> G29. G27 and G28 are APPROVED; G29 lands strictly after both.
- The G28 coordination note at [G28/03-plan-r2.md](../G28/03-plan-r2.md#L294-L299) requires G29 to be re-read post-G28 to confirm no two-cache-split dependency. The round 2 analysis confirms this — see [01-analysis-r2.md](01-analysis-r2.md) sections 4 and 6.
- G29 PR is independent of the LXC daemon redeploy required by G27/G28 — it only changes in-process dispatch and has no on-disk impact.

## 2. Files touched

Production code (one file):

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) — export PLAN_WRITER_TOOLS and PLAN_READER_TOOLS at module scope; change the body of handleToolCall at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L343-L348) to branch on writer set membership; keep serializeOp / opQueue / handleToolCallInner unchanged.

Tests (one file):

- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) — delete the F34 read/write-ordering test at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L653-L670); add three new tests (see 3.2).

No other files require changes:

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L169) — public handleToolCall signature unchanged.
- [src/mcp/notes-server.ts](../../../../src/mcp/notes-server.ts) — unrelated.
- Documentation under SPEC/v2/ — no operator-visible behaviour change; not amended in this PR.

## 3. Concrete edits

### 3.1 plan-server.ts

After the existing imports (top of [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L1-L25)), add the two exported Sets:

```
export const PLAN_WRITER_TOOLS: ReadonlySet<string> = new Set([
  "plan_set_stages",
  "plan_add_stage",
  "plan_remove_stage",
  "plan_set_current",
  "plan_complete_stage",
  "plan_init",
  "plan_commit",
]);

export const PLAN_READER_TOOLS: ReadonlySet<string> = new Set([
  "plan_get",
  "plan_get_stage",
  "plan_get_current_stage",
  "plan_get_history",
]);
```

Add a one-line code comment immediately above the Sets noting that the disjoint union must equal PlanService.getToolSchemas names — the drift guard test enforces this.

Replace the body of handleToolCall at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L343-L348) with:

```
async handleToolCall(
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown; isError: boolean }> {
  if (PLAN_WRITER_TOOLS.has(toolName)) {
    return this.serializeOp(() => this.handleToolCallInner(toolName, args));
  }
  return this.handleToolCallInner(toolName, args);
}
```

Unknown tools (not present in either Set) flow to the reader branch; the switch default at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L405-L407) still returns VALIDATION_ERROR with isError=true. This is correct because the default branch performs no mutation.

Leave serializeOp at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L350-L354), opQueue at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L52), and handleToolCallInner at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L356-L411) untouched.

### 3.2 runtime.test.ts

Delete the test "F34: concurrent reads/writes through handleToolCall are serialised in submission order" at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L653-L670). Its invariant is the exact behaviour G29 reverses.

Add three tests in the same describe block, after the writer/writer ordering test at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L579-L611). All three use the existing deferred helper at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L100-L112) — no setTimeout, no wall-clock thresholds.

Test 1 — "G29: a read does not wait for an in-flight slow write":

```
await planService.plan_init([]);
const gate = deferred<{ sha: string }>();
planService.setGitCommit(async () => gate.promise);

let commitSettled = false;
const commitPromise = planService
  .handleToolCall("plan_commit", { message: "x" })
  .then((r) => { commitSettled = true; return r; });

let getSettled = false;
const getPromise = planService
  .handleToolCall("plan_get", {})
  .then((r) => { getSettled = true; return r; });

// Drain microtasks deterministically; no timers.
for (let i = 0; i < 5; i++) await Promise.resolve();

expect(getSettled).toBe(true);
expect(commitSettled).toBe(false);

const getRes = await getPromise;
expect(getRes.isError).toBe(false);
expect((getRes.content as Plan).stages).toEqual([]);

gate.resolve({ sha: "abc123" });
const commitRes = await commitPromise;
expect(commitRes.isError).toBe(false);
```

Rationale: the assertion that getSettled is true while commitSettled is false after a finite microtask drain proves the reader did not join opQueue, because opQueue is still chained behind the unresolved gate.promise. This is deterministic against the JS event-loop, not a wall-clock budget.

Test 2 — "G29: a read issued after a write resolves observes the write through handleToolCall":

```
await planService.plan_init([]);
const addRes = await planService.handleToolCall("plan_add_stage", {
  stage: {
    id: "stg-1",
    objective: "do",
    starting_points: ["a"],
    expected_outcomes: ["b"],
    acceptance_criteria: ["c"],
    references: [],
    tags: [],
  },
});
expect(addRes.isError).toBe(false);

const readRes = await planService.handleToolCall("plan_get", {});
expect(readRes.isError).toBe(false);
expect((readRes.content as Plan).stages.map((s) => s.id)).toEqual(["stg-1"]);
```

Both calls go through handleToolCall (the dispatch boundary that G29 modifies), satisfying r1#3.

Test 3 — "G29: PLAN_WRITER_TOOLS and PLAN_READER_TOOLS partition the registered tool surface":

```
import { PLAN_WRITER_TOOLS, PLAN_READER_TOOLS, PlanService } from "../mcp/plan-server.js";
// ...
const registered = new Set(PlanService.getToolSchemas().map((s) => s.name));
const writers = new Set(PLAN_WRITER_TOOLS);
const readers = new Set(PLAN_READER_TOOLS);

// disjoint
for (const w of writers) expect(readers.has(w)).toBe(false);

// union equals the registered surface
const union = new Set<string>([...writers, ...readers]);
expect(union.size).toBe(registered.size);
for (const name of registered) expect(union.has(name)).toBe(true);
```

This is the implementable form of the drift guard the reviewer required at r1#2. It binds the classification to the public registry returned by [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L414-L502).

Existing tests preserved verbatim:

- "handleToolCall routes correctly" at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L572-L577).
- "serializes mutating tool calls across async boundaries" at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L579-L611).

## 4. Verification

Local checks:

- npx vitest run src/runtime/runtime.test.ts — all PlanService tests pass, including the three new G29 tests.
- npx tsc -p tsconfig.json — no new type errors. The two new exports are typed as ReadonlySet<string>.

Targeted regression gates:

- Writer/writer ordering test at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L579-L611) still passes — confirms writers remain serialised.
- All G27 tests (started_at preservation) untouched — confirms no schema regression.
- All G28 tests (single-writeDoc PlanDocument atomicity) untouched — confirms the writer queue still gates the merged-document write after G28.

Live deploy regression check (after merge, per workspace handoff and saivage-validation memory):

- Redeploy `saivage` (10.0.3.111), `saivage-v3` (10.0.3.112), `diedrico` (10.0.3.113). `saivage-v3-getrich-v2` (10.0.3.170) is on the v3 codebase and is not affected.
- Probe sequence per host (no secrets read): trigger a slow plan_commit (e.g. when the working tree has changes), concurrently issue an MCP plan_get via the SPA Plan tab, and verify plan_get returns before plan_commit completes. Use the standard health endpoints from the workspace handoff for liveness.

## 5. Backout

- Single-commit revert of the plan-server.ts diff and the test edits.
- No on-disk migration to undo.
- Backout is safe in any state relative to G27 and G28 because G29 does not touch schemas, document layout, or writeDoc.

## 6. Out of scope (explicitly deferred)

- Migration to a single immutable snapshot pointer (Proposal C in [02-design-r2.md](02-design-r2.md) section 3). File as a follow-up after G28 lands.
- Reader-side cloning policy changes. Readers continue to return structuredClone.
- notes-server, knowledge MCP servers, runtime dispatcher concurrency.

## 7. Effort and risk

- Code change: roughly 15 production lines (two exported Sets plus the new handleToolCall branch) and three tests (~60 lines) minus the deleted F34 test.
- Risk surface: classification drift between the writer/reader Sets and the schema registry. Mitigated by Test 3.
- Crash-safety: unchanged (writer queue retained; writeDoc atomic; G27/G28 invariants untouched).
