# F03 - Librarian Agent Design Review R4

Reviewed on 2026-05-28 against the approved analysis and current source tree.

## Findings

### 1. Blocking - `update_memory` preflight still passes a non-source `checkScope` op

[saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r4.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r4.md#L213-L228) correctly fixes two parts of the R3 blocker: it calls `getMemory(saivageRoot, { id: input.id })`, treats the returned memory as a flat record with `prior.scope` and `prior.scope_ref`, and resolves the root with `saivageDir(ctx.projectRoot)`. Those match [saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts#L733-L757) and [saivage/src/config.ts](saivage/src/config.ts#L294-L299).

However, the same snippet still calls `checkScope(ctx.role, "update_memory", "memory", ...)`. Current [saivage/src/knowledge/permissions.ts](saivage/src/knowledge/permissions.ts#L16-L25) defines `KnowledgeOp` as `"create" | "update" | "supersede" | "archive" | "delete" | "read" | "list" | "search"`, and [saivage/src/knowledge/permissions.ts](saivage/src/knowledge/permissions.ts#L260-L267) takes that `KnowledgeOp` in `checkScope`. The checked-in tests also verify update scope behavior with `checkScope("coder", "update", "memory", ...)`, not a tool-name op, in [saivage/src/knowledge/permissions.test.ts](saivage/src/knowledge/permissions.test.ts#L202-L204).

This still diverges from the approved handler pseudo-code in [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md#L355-L361), which preflights the existing record via the handler's source-shaped `gateScope(role, "create", existing.scope, existing.scope_ref, { stageId: ctx.stageId })` path because update follows create in the matrix. If r4 wants to use `checkScope` directly instead of `gateScope`, the source-real op is `"update"`, not `"update_memory"`; the call should also use the resolved `role` rather than raw `ctx.role` to stay aligned with the handler.

Required change: replace the R4 preflight snippet with the approved `gateScope(role, "create", existing.scope, existing.scope_ref, ...)` version from analysis, or with a direct `checkScope(role, "update", "memory", existing.scope, existing.scope_ref, ...)` call that uses the real `KnowledgeOp` value.

## R3 Blocker Verification

- Roster blocker: fixed for review purposes. The entry at [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r4.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r4.md#L123-L144) contains the real `RosterEntry` fields from [saivage/src/agents/roster.ts](saivage/src/agents/roster.ts#L30-L62). Per the review instruction, the expanded source-field spelling is sufficient and this is not a blocker.
- `getMemory` shape: fixed. R4 uses `getMemory(saivageRoot, { id: input.id })` and reads flat `prior.scope` / `prior.scope_ref`, matching the source return shape.
- `saivageRoot` path: fixed. R4 uses `saivageDir(ctx.projectRoot)`, matching the source helper.
- `checkScope` signature: partially fixed. R4 uses the real six-argument shape, but the op value is still a tool name rather than a valid `KnowledgeOp`.

## Summary

R4 closes the roster review concern, the old nested-memory-record mistake, and the project-local `.saivage` path mistake. I found no additional regressions in the surrounding Manager routing, risk, or test-strategy sections. Approval is still blocked because the update preflight snippet remains source-incompatible at the `checkScope` op argument.

VERDICT: CHANGES_REQUESTED