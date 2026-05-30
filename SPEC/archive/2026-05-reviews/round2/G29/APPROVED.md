# G29 — APPROVED

**Chosen proposal**: Proposal A (per [02-design-r2.md](02-design-r2.md)) — writer-only serialization. Plan-server tools are classified into exported `PLAN_WRITER_TOOLS` and `PLAN_READER_TOOLS` sets; `handleToolCall` routes writer tools through the existing `serializeOp` FIFO while readers bypass the queue entirely. A registry drift guard asserts that the disjoint union of the two sets equals the names exposed by `getToolSchemas`. Proposal B (drop the queue entirely) is rejected as a correctness regression. Proposal C (immutable snapshot pointer) is deferred as a post-G28 follow-up to avoid scope creep.

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md). Touches [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) (export the two tool-name sets and branch in `handleToolCall`) and [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) (replace the F34 test with three deterministic G29 tests using the existing deferred helper). No `setTimeout`-based races.

**Sequencing**: Land G27 before G28 before G29 (G27 → G28 → G29). The writer queue is retained so G28's single-`writeDoc` invariant for the merged `PlanDocument` is preserved through composition; the change is orthogonal to G27/G28 in terms of schema or layout coupling.

**Daemon impact**: None observable for correctness; readers no longer wait behind slow writers (notably `plan_commit`'s git callback). Any saivage-v3 restart remains operator-gated.
