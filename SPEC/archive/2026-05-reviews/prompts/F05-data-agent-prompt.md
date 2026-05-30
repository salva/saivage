# F05 — data-agent.md

**File under review:** [prompts/data-agent.md](../../../prompts/data-agent.md) (53 lines — shortest worker)
**Agent:** Data Agent — [src/agents/dataAgent.ts](../../../src/agents/dataAgent.ts)
**Runtime contract:** roster entry [data_agent](../../../src/agents/roster.ts#L194), tool filter `worker`.

## Summary

Shortest worker prompt. Review against the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Whether 53 lines is enough to cover the role correctly, or whether something
  important is missing (data validation, provenance manifest, fallback URLs —
  some of those are in `workerInit.extraInstructionLines` in
  [roster.ts](../../../src/agents/roster.ts) and may be duplicated or
  contradicted here).
- Overlap with `coder.md` and `researcher.md`.
- Conciseness is unlikely to be the main finding here; specificity / missing
  rules might be.

## Category

Review.

## Severity / Transversality

Severity: medium.
Transversality: local.
