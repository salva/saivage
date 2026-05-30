# F09 — inspector.md

**File under review:** [prompts/inspector.md](../../../prompts/inspector.md) (113 lines)
**Agent:** Inspector — [src/agents/inspector.ts](../../../src/agents/inspector.ts)
**Runtime contract:** roster entry [inspector](../../../src/agents/roster.ts#L326), tool filter `inspector`.

## Summary

Deep-analysis agent. Dispatched by Planner and Chat (not Manager). Produces an
`InspectionReport`. Review against the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Tool filter `inspector` — read-only fs, inspector workspace, `.saivage/tools/inspector/`.
- Workspace conventions vs `convention.writeTerritory` in
  [roster.ts](../../../src/agents/roster.ts).
- `InspectionReport` shape per [src/types.ts](../../../src/types.ts).
- Distinction from reviewer/critic — the inspector is not a quality gate, it is
  an investigator. The prompt must make that crystal clear.
- Dispatch-by-Chat path — chat can dispatch the inspector but the inspector
  must not refer to "the manager" as its parent.

## Category

Review.

## Severity / Transversality

Severity: medium.
Transversality: local.
