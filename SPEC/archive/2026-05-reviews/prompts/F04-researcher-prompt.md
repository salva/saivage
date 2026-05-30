# F04 — researcher.md

**File under review:** [prompts/researcher.md](../../../prompts/researcher.md) (118 lines)
**Agent:** Researcher — [src/agents/researcher.ts](../../../src/agents/researcher.ts)
**Runtime contract:** roster entry [researcher](../../../src/agents/roster.ts#L162), tool filter `worker`.

## Summary

The researcher does not write source code; outputs go under `research/`.
Review against the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- Web-fetch tool availability vs the `worker` filter in `src/mcp/`.
- Output-path rules vs `convention.writeTerritory` in
  [roster.ts](../../../src/agents/roster.ts).
- Knowledge-service write permissions in
  [src/knowledge/permissions.ts](../../../src/knowledge/permissions.ts) — the
  researcher must not be told it can write skills/memories it cannot.
- Overlap with `coder.md` and `data-agent.md` (same-shape `worker` filter, but
  different territory) — keep what is researcher-specific, lift common bits
  into a shared include if it would shrink the prompt.

## Category

Review.

## Severity / Transversality

Severity: medium.
Transversality: possibly cross-cutting if a shared "worker basics" include is
proposed.
