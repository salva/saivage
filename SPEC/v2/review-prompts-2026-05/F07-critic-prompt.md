# F07 — critic.md

**File under review:** [prompts/critic.md](../../../prompts/critic.md) (66 lines)
**Agent:** Critic — [src/agents/critic.ts](../../../src/agents/critic.ts)
**Runtime contract:** roster entry [critic](../../../src/agents/roster.ts#L290), tool filter `reviewer`, `stageScoped: true`.

## Summary

Newest role. Reviews **design documents**, not code. Same tool filter as the
reviewer but distinct territory and target (designer artifacts). Review against
the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Clear separation from `reviewer.md` — must not blur into code review.
- Coupling with `designer.md` — the two prompts together define the
  design-critique loop.
- Follow-up semantics (same as reviewer; runtime injects the banner).
- Output convention — the critic writes a standalone critique document AND a
  `TaskReport.issues_found[]`. Verify both surfaces are described once and
  consistently.

## Category

Review.

## Severity / Transversality

Severity: medium.
Transversality: cross-cuts F08 (designer).
