# F08 — designer.md

**File under review:** [prompts/designer.md](../../../prompts/designer.md) (64 lines)
**Agent:** Designer — [src/agents/designer.ts](../../../src/agents/designer.ts)
**Runtime contract:** roster entry [designer](../../../src/agents/roster.ts#L258), tool filter `worker`, `stageScoped: true`.

## Summary

Produces design artifacts. Stage-scoped: receives multiple follow-up dispatches
within a stage (often in response to critic feedback). Review against the
project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Coupling with `critic.md` (F07) — the two prompts together define the loop.
- Follow-up semantics — runtime injects the banner; prompt should not duplicate.
- Output paths vs `convention.writeTerritory` in
  [roster.ts](../../../src/agents/roster.ts).
- Boundary with coder — the designer must not be told to ship implementation.

## Category

Review.

## Severity / Transversality

Severity: medium.
Transversality: cross-cuts F07 (critic).
