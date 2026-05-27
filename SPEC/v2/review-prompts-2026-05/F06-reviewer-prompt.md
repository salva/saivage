# F06 — reviewer.md

**File under review:** [prompts/reviewer.md](../../../prompts/reviewer.md) (60 lines)
**Agent:** Reviewer — [src/agents/reviewer.ts](../../../src/agents/reviewer.ts)
**Runtime contract:** roster entry [reviewer](../../../src/agents/roster.ts#L226), tool filter `reviewer`, `stageScoped: true`.

## Summary

The reviewer is stage-scoped — the same agent instance receives multiple
follow-up dispatches within a stage, so the prompt must not pretend each
dispatch is a fresh conversation. Review against the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Follow-up semantics — the runtime already injects a banner from
  `workerInit.followUpInstruction` in
  [roster.ts](../../../src/agents/roster.ts); the prompt should not re-explain
  it in detail.
- Tool filter `reviewer` (read-only fs + knowledge); verify the prompt does not
  promise write tools it does not have.
- Return shape `TaskReport` with `issues_found[]` semantics — verify against
  [src/types.ts](../../../src/types.ts).
- Voice/terminology consistency with `critic.md` (both are review-shaped roles
  with similar conventions but distinct duties).

## Category

Review.

## Severity / Transversality

Severity: medium-high (review quality gates everything).
Transversality: local, possibly cross-cuts F07 (critic) and F11 (shared).
