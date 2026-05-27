# F11 — shared/execution-style.md

**File under review:** [prompts/shared/execution-style.md](../../../prompts/shared/execution-style.md) (7 lines)
**Agents:** all roles that include `{{> shared/execution-style }}`.

## Summary

The only shared include. 7 lines that prescribe the "visible execution style"
(narrate tool calls in the same turn, batch summarization, no separate text
turns). Review against the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Is the include actually pulled by every role prompt? Verify and report which
  roles do not include it (those duplicate the rules inline or do not have
  them at all — both are bugs).
- Is the wording short enough to belong in the shared include without forcing
  per-role overrides?
- Does anything currently sit in shared/ that should NOT (over-generic rules
  that distort one role's behaviour)?
- Are there rules currently duplicated across role prompts that SHOULD be
  lifted here (the prime candidate from inspection: `TaskReport` finalization
  etiquette, follow-up acknowledgement banners, self-check banners)?

## Category

Review (cross-cutting — a finding here can shrink every role prompt).

## Severity / Transversality

Severity: medium (small file, but the lever to remove duplication elsewhere).
Transversality: highly cross-cutting (touches every role prompt by definition).
