# F03 — coder.md

**File under review:** [prompts/coder.md](../../../prompts/coder.md) (119 lines)
**Agent:** Coder — [src/agents/coder.ts](../../../src/agents/coder.ts)
**Runtime contract:** roster entry [coder](../../../src/agents/roster.ts#L131), tool filter `worker`.

## Summary

The coder is a one-shot worker; the prompt must drive a single task to
completion and a `TaskReport`. Review against the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Tools list vs the actual `worker` filter (fs, git, test runner, knowledge
  read).
- Test/commit etiquette vs what runtime enforces (commit hooks, eslint).
- `TaskReport` shape per [src/types.ts](../../../src/types.ts).
- Convention/territory rules vs `convention.writeTerritory` in
  [roster.ts](../../../src/agents/roster.ts).
- Self-check frequency mentions (the runtime injects self-check banners; prompt
  should not re-implement the policy in prose).

## Category

Review.

## Severity / Transversality

Severity: high (coder volume == most LLM cost).
Transversality: local.
