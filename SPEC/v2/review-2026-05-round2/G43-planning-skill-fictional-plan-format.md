# G43 — `planning` built-in skill teaches the planner a fictional plan format

- **Subsystem**: skills (`skills/builtin/planning/SKILL.md`)
- **Category**: bug, content drift
- **Severity**: high (would be critical if G42 weren't silently neutralising it)

## Summary

The `planning` built-in skill instructs the planner agent to *"output structured
JSON with a `steps` array"*, lists `executor` as a valid agent type, and uses a
`{summary, steps:[{id, type, goal, dependsOn}]}` example. The real planner
does not output a plan JSON blob at all — it mutates `Plan` documents through
MCP `plan_set_*` / `plan_add_stage` tools, using a `stages[]` shape with
nested `tasks[]`, and there is no `executor` agent in the roster.

## Evidence

The skill content:

```
1. **Output structured JSON** with a `steps` array.
2. **Each step must be actionable** by a single agent (coder, researcher, executor).
3. **Identify dependencies** between steps with `dependsOn` arrays.
…
{
  "summary": "Brief description of the plan",
  "steps": [
    { "id": 1, "type": "research", "goal": "…", "dependsOn": [] },
    { "id": 2, "type": "code",     "goal": "…", "dependsOn": [1] },
    { "id": 3, "type": "execute",  "goal": "…", "dependsOn": [2] }
  ]
}
```

[skills/builtin/planning/SKILL.md](skills/builtin/planning/SKILL.md#L1-L45)

The real `Plan` schema uses `stages[]`, each stage has its own `tasks[]`, and
ordering is by `position` not `dependsOn`:

[src/types.ts](src/types.ts#L40-L120)

The real planner manipulates state through MCP tools (`plan_add_stage`,
`plan_set_stage_status`, `plan_set_task_status`, …) — never by emitting a
JSON document — see the plan service interface in
[src/mcp/plan-server.ts](src/mcp/plan-server.ts).

The agent roster contains `planner`, `manager`, `coder`, `researcher`,
`reviewer`, `inspector`, `chat`, `data_agent`, `designer`. There is no
`executor` role:

[src/agents/roster.ts](src/agents/roster.ts).

## Why this matters

This is the only built-in skill targeted at the planner role; if it ever did
reach the planner (today it doesn't, thanks to G42), the LLM would attempt to
emit a JSON blob that the runtime would simply ignore — wasting context tokens
on a never-read artefact and at worst confusing the planner into not calling
the real `plan_*` MCP tools. The combination *G42 + G43* is "the skill never
loads, so the broken content has no effect" — fix G42 alone and you break the
planner; fix the skill content first.

The mention of `executor` is doubly broken: it teaches the planner about an
agent role that does not exist, which (post-G42 fix) would lead to references
to a non-existent role in plan stages.

## Rough remediation direction

Rewrite `skills/builtin/planning/SKILL.md` to teach the *actual* planning
protocol: stage decomposition into tasks, the MCP tools used to mutate the
plan, the real `assigned_role` values from the roster, the relationship
between stages and tasks, and the `position`-based ordering. Reference
[src/types.ts](src/types.ts#L40-L120) and [src/mcp/plan-server.ts](src/mcp/plan-server.ts)
for ground truth. Remove the JSON example entirely — the planner does not
output structured JSON.

**Level up**: any skill that teaches the LLM about an *internal* contract
(plan shape, MCP tools, roster, conventions) should be code-generated, not
hand-written. The roster, MCP tool catalog, and plan schema already exist as
TypeScript values; render them into the skill body at build time so they
cannot drift again.

## Cross-links

- G42 — built-in skills' `agentTypes:` is silently ignored, masking this bug
  in production.
- F18 — system-prompt bloat; the same fictional plan format also tends to
  appear in `prompts/planner.md`-style files (verify when reading the live
  prompt).
