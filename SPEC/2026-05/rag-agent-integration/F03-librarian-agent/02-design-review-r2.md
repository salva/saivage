# F03 - Librarian Agent Design Review R2

Reviewed on 2026-05-27 against the approved analysis, R1 review, and current source tree.

## Findings

### 1. Blocking - Roster entry no longer matches the actual `RosterEntry` shape

[saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md#L119-L132) expands the roster entry, but the proposed object omits required current fields and adds fields that do not exist at top level. Current [saivage/src/agents/roster.ts](saivage/src/agents/roster.ts#L30-L62) requires `dispatchTool`, `abortPriority`, `selfCheckFrequency`, `convention`, `displayName`, `summary`, and `workerInit`. It does not define top-level `promptKey` or `writeTerritory` fields.

This also diverges from the approved full entry in [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md#L200-L220), which correctly includes `dispatchTool: "run_librarian"`, `abortPriority: 8`, `selfCheckFrequency: 20`, the nested `convention`, `displayName`, `summary`, and `workerInit: null`.

Required change: make A.3 either say "verbatim from analysis section 3.1" again or replace the snippet with the approved source-real `RosterEntry` object. Do not leave the current abbreviated object as the implementation design.

### 2. Blocking - `checkScope` pseudo-code is not source-real and moves topic enforcement into the wrong layer

[saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md#L152-L166) says the `checkScope` branch should use `ctx.role`, `record.scope.kind`, and `record.topic.domain`, and return a failure object with `message`. Current [saivage/src/knowledge/permissions.ts](saivage/src/knowledge/permissions.ts#L246-L267) defines `checkScope(role, op, kind, scope, scope_ref, ctx)` and `ScopeCheckResult` requires `reason`, not `message`. There is no `record` parameter in this function.

The approved analysis keeps these concerns split: [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md#L317-L329) adds a Librarian `Y†` branch based on `role` and `scope`, while [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md#L334-L368) keeps topic-domain and topic-subject checks in the `create_memory` / `update_memory` handlers.

Required change: rewrite A.5 so `checkScope` uses the real signature and returns `{ ok: false, code: "UNAUTHORIZED_SCOPE", reason: ... }`; keep `topic.domain === "rag"` and allowed subject enforcement in the knowledge-memory handler guard only.

## R1 Blocker Verification

- Fixed: `LibrarianAgent` now mirrors the Inspector non-worker pattern. [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md#L37-L112) defines a non-generic `BaseAgent` subclass, `static async create`, a constructor that calls `super(ctx, { ... })`, and `run(): Promise<AgentResult>` around `this.runLoop()`. This matches [saivage/src/agents/inspector.ts](saivage/src/agents/inspector.ts#L22-L82) and current [saivage/src/agents/base.ts](saivage/src/agents/base.ts#L183-L250).
- Fixed: Manager retrieval-miss routing now supplies the required `objective` and treats `collection_id` / `context` as optional-but-useful fields. [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md#L215-L236) matches the approved dispatch schema requirement in [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/01-analysis-r6.md#L232-L238).
- Fixed: `ragService.adminRoles` bootstrap mutation is now explicitly F02-dependent. [saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md](saivage/SPEC/2026-05/rag-agent-integration/F03-librarian-agent/02-design-r2.md#L195-L213) states that F02 must expose `RagService` to bootstrap first and that F03 will not land without it. That is the needed acknowledgement because the current bootstrap switch still has no `ragService` dependency in [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L320-L395).

## Summary

The three R1 blockers are addressed in R2. Approval is still blocked because R2 introduces or exposes two source-incompatible implementation snippets: the roster entry shape and the `checkScope` branch. Both are straightforward doc fixes: restore the analysis-approved roster entry and make the ACL pseudo-code match the current `permissions.ts` API.

VERDICT: CHANGES_REQUESTED