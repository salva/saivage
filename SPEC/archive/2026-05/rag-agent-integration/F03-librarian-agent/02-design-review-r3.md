# F03 - Librarian Agent Design Review R3

Reviewed on 2026-05-28 against the approved analysis and current source tree.

## Findings

### 1. Blocking - Roster entry has the full interface shape but is not verbatim from approved analysis section 3.1

[saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r3.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r3.md#L117-L143) now includes the required current `RosterEntry` fields from [saivage/src/agents/roster.ts](saivage/src/agents/roster.ts#L30-L62): `dispatchTool`, `abortPriority`, `selfCheckFrequency`, `convention`, `displayName`, `summary`, and `workerInit`. That closes the interface-shape part of the R2 blocker.

However, the same paragraph says the object is "verbatim from analysis section 3.1", and it is not. The approved entry in [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md#L200-L219) includes `excludeTerritory: ["src/", "research/", "data/"]`, description `"Librarian writes project-scope rag-policy memories only."`, and the exact one-line summary `"Curates unprotected RAG collections — registers, ingests, queries, prunes, and diagnoses drift. Returns reports."`. R3 instead omits `"data/"`, changes the convention description, and changes the prompt summary.

Required change: replace the A.3 snippet with the approved analysis section 3.1 object exactly, or remove the claim that it is verbatim and get explicit approval for the changed convention and roster summary.

### 2. Blocking - `update_memory` preflight pseudo-code still does not match the real source contracts

The `checkScope` branch itself is substantially fixed: [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r3.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r3.md#L173-L190) uses the real `checkScope(role, op, kind, scope, scope_ref, ctx)` shape, returns `{ ok: false, code: "UNAUTHORIZED_SCOPE", reason }`, and no longer inspects topic inside `checkScope`. The topic guard is now described in the handler layer at [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r3.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r3.md#L192-L206).

But the immediately following `update_memory` preflight snippet remains source-incompatible. [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r3.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r3.md#L213-L219) calls `getMemory(store, { id: input.id })`, passes `ctx.role`, uses the non-existent op string `"update_memory"`, and reads `prior.record.scope.kind` / `prior.record.scope.ref`. Current [saivage/src/knowledge/permissions.ts](saivage/src/knowledge/permissions.ts#L260-L267) accepts `KnowledgeOp` values such as `"create"` or `"update"`, not tool names, and current memory records expose flat `scope` / `scope_ref` fields in [saivage/src/knowledge/types.ts](saivage/src/knowledge/types.ts#L75-L84). `getMemory` returns a flattened memory record or `null`, not `{ record: ... }`, in [saivage/src/knowledge/lifecycle.ts](saivage/src/knowledge/lifecycle.ts#L733-L756).

This also diverges from the approved analysis, which uses the resolved `role`, `getMemory(root, { id: String(args.id) })`, `gateScope(role, "create", existing.scope, existing.scope_ref, { stageId: ctx.stageId })`, and `existing.topic` in [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md#L355-L369).

Required change: replace the R3 preflight snippet with the approved source-real handler pseudo-code from analysis section 5. Keep topic-domain checks in the handler guard, but express them against `args.topic` for create and `existing.topic` for update.

## R2 Blocker Verification

- Roster blocker: partially fixed. The current interface fields are present, but the object is not verbatim from the approved analysis entry.
- Scope/topic blocker: partially fixed. The `checkScope` branch and failure shape are corrected, and topic enforcement moved out of `checkScope`; the `update_memory` preflight snippet still calls source APIs with the wrong names and shapes.

## Summary

R3 is closer than R2, but approval is still blocked by source/analysis drift in the roster snippet and the update preflight pseudo-code. Both fixes are documentation-only: paste the approved roster entry exactly and use the approved `getMemory`/`gateScope`/`existing.topic` preflight shape.

VERDICT: CHANGES_REQUESTED