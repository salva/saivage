# F01 — planner.md

**File under review:** [prompts/planner.md](../../../prompts/planner.md) (140 lines)
**Agent:** Planner — [src/agents/planner.ts](../../../src/agents/planner.ts)
**Runtime contract:** roster entry [planner](../../../src/agents/roster.ts#L75), tool filter `planner`.

## Summary

The planner is the top-level strategist. Its prompt is the single longest
non-manager prompt and frames the entire system. Review the prompt as a whole
against the project-wide axes in
[00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md#project-wide-review-axes-apply-to-every-issue),
with special attention to:

- The opening "The Saivage System" block and how it overlaps with
  `{{ roster_summary }}` (this prompt currently hand-rolls it).
- The Tools Available list — verify each named tool against the actual
  `planner` tool filter and the Plan MCP surface.
- The "CRITICAL RULE" block and the rules around `plan_done` — verify against
  the Plan MCP handlers in [src/mcp/plan.ts](../../../src/mcp/plan.ts).
- The Execution Model / Step 1 startup script — flag over-specification or
  contradictions with the actual bootstrap path in
  [src/server/bootstrap.ts](../../../src/server/bootstrap.ts).

## Category

Review (correctness + conciseness + over-featurism).

## Severity / Transversality

Severity: high (planner sets the tone for the whole system; bad planner
behaviour cascades).
Transversality: local (edits in one prompt file, possibly the shared include).
