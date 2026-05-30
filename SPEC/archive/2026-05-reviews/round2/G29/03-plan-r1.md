# G29 — Implementation plan (round 1)

**Author**: Claude Opus 4.7 (writer)
**Chosen proposal**: A (writer-only serialization), per [02-design-r1.md](02-design-r1.md).

## 1. Sequencing

- Hard sequencing: none against G27 (orthogonal: schema-only) and none against G28 (orthogonal: document layout). G29 may merge before, between, or after G27/G28.
- Recommended order in the metaplan: G27 → G28 → G29. This keeps plan-server test churn co-located in the G28 PR rather than splitting it.
- G29 PR is independent of the LXC daemon redeploy required by G27/G28 — it only changes in-process dispatch.

## 2. Files touched

Production code:

- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) — add PLAN_WRITER_TOOLS Set; change handleToolCall to branch on it; keep serializeOp and opQueue (still used for writers); no other edits.

Tests:

- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) — replace the F34 read/write submission-order test (L653-L670) with two new G29 tests (see below); add a writer-set drift guard test.

No other files require changes:

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L169) — call site unchanged (public handleToolCall signature unchanged).
- [src/mcp/notes-server.ts](../../../../src/mcp/notes-server.ts) — unrelated; do not modify.
- Documentation under SPEC/v2/ — no operator-visible behaviour change; do not amend in this PR.

## 3. Concrete edits

### 3.1 plan-server.ts

Add immediately after the existing imports (top of file):

```
const PLAN_WRITER_TOOLS: ReadonlySet<string> = new Set([
  "plan_set_stages",
  "plan_add_stage",
  "plan_remove_stage",
  "plan_set_current",
  "plan_complete_stage",
  "plan_init",
  "plan_commit",
]);
```

Replace the body of handleToolCall ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L343-L348)) with:

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

Leave serializeOp, opQueue, and handleToolCallInner untouched.

### 3.2 runtime.test.ts

Delete the existing test at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L653-L670) ("F34: concurrent reads/writes through handleToolCall are serialised in submission order"). Replace with three tests:

1. G29: a read does not wait for an in-flight slow write.
   - planService.plan_init([]).
   - Install a deferred gitCommitFn so plan_commit blocks indefinitely.
   - Kick off planService.handleToolCall("plan_commit", { message: "x" }) — do not await.
   - Race planService.handleToolCall("plan_get", {}) against a 50 ms timeout.
   - Assert the plan_get resolves first with isError === false and stages === [].
   - Resolve the deferred to let plan_commit finish; await it; no leaks.

2. G29: a read issued after a write resolves observes the write.
   - planService.plan_init([]).
   - Await planService.handleToolCall("plan_add_stage", { stage: {...} }).
   - Await planService.handleToolCall("plan_get", {}).
   - Assert content.stages map id === ["stg-..."]. (This replicates the old submission-order intent without coupling it to the queue.)

3. G29: PLAN_WRITER_TOOLS matches the writer cases in handleToolCallInner.
   - Drift guard. The simplest expression: import the Set, plus the static list of tool schemas, and assert: union of writer set and a hard-coded reader list equals the names returned by PlanService.getToolSchemas(); intersection is empty. This catches drift if either a tool is added to the schemas or removed from one of the two sides.

The existing tests at L572 (routing) and L580-L611 (writer/writer ordering) are preserved verbatim.

## 4. Verification

Local:

- npx vitest run src/runtime/runtime.test.ts — must pass.
- npx tsc -p tsconfig.json — no new type errors.

Targeted regression gates:

- The writer/writer ordering test (L580-L611) still passes — confirms writers remain serialized.
- All G27 tests (schema and started_at preservation) untouched — confirms no schema regression.
- All G28 tests (single-document writeDoc atomicity) untouched once G28 lands — confirms writer queue still gates the merged document write.

Live deploy regression check (after merging):

- saivage (10.0.3.111), saivage-v3 (10.0.3.112), diedrico (10.0.3.113): redeploy, then issue a slow plan_commit (e.g. when the working tree has changes) and concurrently hit the WebSocket plan endpoint; verify the SPA Plan tab responds without waiting for the commit. saivage-v3-getrich-v2 (10.0.3.170) is on the v3 codebase and is not affected by this change.

## 5. Backout

- Single-commit revert of the plan-server.ts diff. No on-disk migration to undo. Tests revert with the same commit.
- Backout is safe in any state relative to G27 and G28 because G29 does not touch schemas, document layout, or writeDoc.

## 6. Out of scope (explicitly deferred)

- Migration to a single immutable snapshot pointer (Proposal C in [02-design-r1.md](02-design-r1.md)). File as a follow-up after G28 lands.
- Reader-side cloning policy changes. Readers continue to return structuredClone.
- notes-server, knowledge MCP servers, runtime dispatcher concurrency.

## 7. Effort and risk

- Code change is roughly 10 production lines plus three tests.
- Risk surface: classification drift between the writer Set and the switch. Mitigated by the drift guard test.
- Crash-safety: unchanged (writer queue retained; writeDoc atomic; G27/G28 invariants untouched).
