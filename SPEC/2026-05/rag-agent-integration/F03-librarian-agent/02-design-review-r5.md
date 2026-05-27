# F03 - Librarian Agent Design Review R5

Reviewed on 2026-05-28 against the approved analysis and current source tree.

## Findings

No blocking findings.

## R4 Blocker Verification

R5 fixes the remaining R4 blocker. The `update_memory` preflight in [02-design-r5.md](02-design-r5.md#L228-L233) now calls `checkScope(ctx.role, "update", "memory", ...)` rather than passing the tool name `"update_memory"`.

That matches the canonical `KnowledgeOp` union in [src/knowledge/permissions.ts](../../../../src/knowledge/permissions.ts#L16-L25), where `"update"` is valid and `"update_memory"` is not. It also matches the real `checkScope(role, op, kind, scope, scope_ref, ctx)` signature in [src/knowledge/permissions.ts](../../../../src/knowledge/permissions.ts#L260-L292) and the existing update-scope test shape in [src/knowledge/permissions.test.ts](../../../../src/knowledge/permissions.test.ts#L202-L204).

## Source Alignment Checks

- The preflight continues to use `getMemory(saivageRoot, { id })` and flat `prior.scope` / `prior.scope_ref`, matching [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L733-L757).
- The project-local `.saivage` root is resolved with `saivageDir(ctx.projectRoot)`, matching [src/config.ts](../../../../src/config.ts#L294-L299).
- The proposed Librarian `checkScope` branch is placed after the current non-`Y†` early return and before the existing worker-stage branch, matching the source control flow in [src/knowledge/permissions.ts](../../../../src/knowledge/permissions.ts#L260-L292).
- The roster entry uses the real `RosterEntry` fields and `ToolFilterKind` extension point from [src/agents/roster.ts](../../../../src/agents/roster.ts#L14-L62).
- The dispatch schema, prompt-key, prompt-loader, tool-filter, and non-worker agent wiring targets match the current source modules.
- The Manager retrieval-miss path remains prompt-level routing, matching the dispatcher source: child results are spawned and stringified, with no runtime hook on `issues_found`.
- The F02 dependency for the RAG MCP/admin-role surface is stated as a hard prerequisite; current source still lacks the seven RAG MCP tools, matching the approved analysis' prerequisite boundary.

## Summary

R5 closes the source-incompatible `KnowledgeOp` issue from R4. I found no other source mismatches in the reviewed design surfaces.

VERDICT: APPROVE