# G43 — Analysis r1 (`planning` built-in skill teaches a fictional plan format)

## 1. What G43 reports vs. what the file says

The filed evidence at
[../G43-planning-skill-fictional-plan-format.md](../G43-planning-skill-fictional-plan-format.md)
captures the headline: the `planning` SKILL.md tells the planner to emit
JSON with a `steps` array, lists an `executor` agent, and uses
`dependsOn`. None of that exists in the running system. The real planner
mutates a `Plan` document through MCP `plan_*` tools; there is no
`executor` role; ordering is by `stages[]` array position, not by an
explicit dependency field.

Two of the round-1 claims are sharper than they need to be and one is
slightly wrong:

- Round-1 says "ordering is by `position` not `dependsOn`." Reality:
  `StageSchema` has no `position` field —
  [src/types.ts](../../../../src/types.ts#L35-L48). Stages are ordered
  by their index in the `stages: Stage[]` array. There is no field for
  the planner to set.
- Round-1 frames the bug as "skill instructs the planner to output a
  plan JSON blob." That is one fictional claim; the file contains six
  independent fabrications (Section 3 enumerates them).
- Round-1 lists `planner, manager, coder, researcher, reviewer,
  inspector, chat, data_agent, designer` as the roster. Correct as of
  today — verified against
  [src/agents/roster.ts](../../../../src/agents/roster.ts#L42-L210).

## 2. The skill body as the LLM sees it

The file on disk is 45 lines. Pre-G42 the production walker
([src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122))
does not strip the YAML preamble, so the LLM literally receives the
`---`-fenced frontmatter as Markdown too. Verbatim:

```
---
name: planning
description: Structured planning for complex tasks
version: 0.1.0
agentTypes: [planner]
triggers: [plan, design, architect, break down, decompose]
---

## Planning Guidelines

1. **Output structured JSON** with a `steps` array.
2. **Each step must be actionable** by a single agent (coder, researcher, executor).
3. **Identify dependencies** between steps with `dependsOn` arrays.
4. **Keep steps small.** A step should take one agent 5-30 iterations.
5. **Include verification.** Add test/check steps after implementation steps.

### Plan Format

```json
{
  "summary": "Brief description of the plan",
  "steps": [
    { "id": 1, "type": "research", "goal": "…", "dependsOn": [] },
    { "id": 2, "type": "code",     "goal": "…", "dependsOn": [1] },
    { "id": 3, "type": "execute",  "goal": "…", "dependsOn": [2] }
  ]
}
```
```

Source: [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L45).

## 3. Every fictional element, line-by-line, with the contradicting code

The skill body asserts ten distinct facts. Nine of them are wrong; one
is harmless filler. Numbered below; numbers in `[brackets]` cite the
SKILL.md line.

### F1. "Output structured JSON" `[L9]`

The planner never outputs a plan JSON document. `PlannerAgent.run()`
calls `runLoop()` and the only exit signals it inspects are tool calls
and a literal text token `PLAN_COMPLETE` —
[src/agents/planner.ts](../../../../src/agents/planner.ts#L83-L91).
Plan state is mutated exclusively through MCP `plan_*` tools registered
by `PlanService` —
[src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L143-L243).
The planner's own system prompt explicitly says so:

> All plan state is managed through the plan MCP service. The
> authoritative state lives in `.saivage/plan.json` … (managed by
> `plan_*` tools, NOT by direct file I/O).

[prompts/planner.md](../../../../prompts/planner.md#L20-L21).

There is no consumer anywhere in the codebase that reads a
`{summary, steps}` blob from the planner's assistant text. `grep -RIn
'"steps"' src/` returns only test fixtures unrelated to the planner.

### F2. "with a `steps` array" `[L9]`

The real plan document is `{updated_at, current_stage_id, stages[]}` —
[src/types.ts](../../../../src/types.ts#L46-L51). The field is `stages`,
not `steps`. Each entry is a `Stage`, not a `Step`.

### F3. "Each step must be actionable by a single agent (coder, researcher, **executor**)" `[L10]`

There is no `executor` role. The exhaustive roster is `planner`,
`manager`, `coder`, `researcher`, `data_agent`, `reviewer`, `designer`,
`inspector`, `chat` —
[src/agents/roster.ts](../../../../src/agents/roster.ts#L42-L210). The
type system enforces this: `AgentRole` is derived as
`(typeof ROSTER)[number]["role"]` —
[src/agents/roster.ts](../../../../src/agents/roster.ts#L212), and
`WorkerRole` (the values accepted by `TaskSchema.assigned_to`) is the
subset with `worker: true` —
[src/agents/roster.ts](../../../../src/agents/roster.ts#L214) /
[src/types.ts](../../../../src/types.ts#L99). Anything outside the
roster would fail Zod parse.

Also wrong: the skill conflates stages and tasks. Stages have no
`assigned_to` field at all
([src/types.ts](../../../../src/types.ts#L35-L44)); they are dispatched
wholesale via `run_manager(stage)` —
[prompts/planner.md](../../../../prompts/planner.md#L46). It is the
*Manager* (not the Planner) that builds a `TaskList` whose entries each
have `assigned_to: WorkerRole`.

### F4. "Identify dependencies between steps with `dependsOn` arrays" `[L11]`

`StageSchema` has no dependency field of any kind —
[src/types.ts](../../../../src/types.ts#L35-L44). Stages run
sequentially in the order they appear in `stages[]`; ordering is
controlled by inserting/reordering entries via `plan_set_stages` —
[src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L114-L141)
— or appending via `plan_add_stage` —
[src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L143-L163).

`TaskSchema` does carry a `dependencies: string[]` field —
[src/types.ts](../../../../src/types.ts#L100), but tasks belong to the
Manager's working set, not the Planner's, and the spelling is
`dependencies`, not `dependsOn`.

### F5. "A step should take one agent 5-30 iterations" `[L12]`

There is no per-iteration budget configured on tasks or stages, and the
budget actually present (`max_attempts: number` default 3 on Task —
[src/types.ts](../../../../src/types.ts#L106) — and the planner's
`MAX_NUDGES = 15` —
[src/agents/planner.ts](../../../../src/agents/planner.ts#L18)) counts
something else entirely. The "5–30 iterations" rule of thumb is
unsourced and unactionable.

### F6. "Add test/check steps after implementation steps" `[L13]`

The Stage schema has an `acceptance_criteria: string[]` field that
captures verification per stage —
[src/types.ts](../../../../src/types.ts#L40). The Manager's
`TaskSchema.type` enum contains `"test"` —
[src/types.ts](../../../../src/types.ts#L97), but again that belongs to
the Manager's task decomposition, not the planner's stage queue. The
skill confuses the two levels.

### F7. Example uses `summary` at the top level `[L20]`

`PlanSchema` has no top-level `summary` field —
[src/types.ts](../../../../src/types.ts#L46-L51). `Stage` likewise has
no `summary` —
[src/types.ts](../../../../src/types.ts#L35-L44). The closest match is
`StageSummary.summary` —
[src/types.ts](../../../../src/types.ts#L188), but a `StageSummary` is
produced by the Manager *after* a stage runs, never by the planner up
front.

### F8. Example uses numeric `id` fields `[L23-L25]`

`Stage.id`, `Task.id`, `TaskList.stage_id`, `CompletedStage.id` are all
strings (`z.string()`) —
[src/types.ts](../../../../src/types.ts#L36),
[src/types.ts](../../../../src/types.ts#L95),
[src/types.ts](../../../../src/types.ts#L113),
[src/types.ts](../../../../src/types.ts#L57). Numeric IDs would fail
schema parse. There is no on-disk document anywhere in the runtime that
keys plan/task entities by integers.

### F9. Example `type` values include `"execute"` `[L25]`

`TaskSchema.type` is `z.enum(["code", "research", "data", "review",
"test", "document", "design"])` —
[src/types.ts](../../../../src/types.ts#L97). There is no `"execute"`
member; it would fail Zod parse if the Manager actually tried to write
it. `Stage` carries no `type` field at all.

### F10. Example uses `goal` for each step `[L23]`

`Stage` uses `objective: string` (max 1000 chars) —
[src/types.ts](../../../../src/types.ts#L37). `Task` uses
`description: string` —
[src/types.ts](../../../../src/types.ts#L98). Neither has `goal`. The
field name is consistent across the codebase, the SPEC, and the
external API.

### F11. Frontmatter side-effects (already covered by G42)

`agentTypes: [planner]`, `version: 0.1.0`, and the triggers list are
all silently dropped by the production walker — see
[../G42/01-analysis-r1.md](../G42/01-analysis-r1.md#L88-L107). Today
they end up shipped as literal Markdown inside the eager skill block.
G43 is not the right place to fix that; G42 owns the loader fix.

## 4. What the planner already knows from its system prompt

The planner's system prompt already documents:

- The full MCP tool surface —
  [prompts/planner.md](../../../../prompts/planner.md#L41-L51).
- The `Stage` shape (`id`, `objective`, `starting_points`,
  `expected_outcomes`, `acceptance_criteria`, `references`, `tags`) —
  [prompts/planner.md](../../../../prompts/planner.md#L42),
  [prompts/planner.md](../../../../prompts/planner.md#L73).
- The four `StageSummary` results and how to react to each —
  [prompts/planner.md](../../../../prompts/planner.md#L60-L67).
- The escalation contract, repo-layout block, dispatch model, and
  PLAN_COMPLETE protocol —
  [prompts/planner.md](../../../../prompts/planner.md#L57-L102).
- The structured planning guidelines (small focused stages, concrete
  acceptance criteria, continuous improvement, data foundation) —
  [prompts/planner.md](../../../../prompts/planner.md#L104-L113).

The eager `planning` skill duplicates none of this with anything true,
and contradicts it on every numbered fiction in Section 3.

## 5. Why the bug is currently dormant

The skill body is only injected into the planner if the eager loader
delivers it (today: yes — every agent gets every built-in because of
G42) AND the planner's prompt does not actively contradict it (today:
the prompt does contradict it on every point). The empirical outcome,
verified by reading the planner's transcript on the running
`saivage-v3` harness, is that the planner ignores the SKILL.md body and
calls `plan_get`/`plan_init`/`plan_add_stage`/`run_manager` as the
system prompt directs. Tokens are wasted; no incorrect plan is written.

That equilibrium is fragile. The moment G42 lands, the loader will
correctly target this skill at the planner role and the LLM-readable
block will go from "skills/coding, skills/planning, skills/research,
skills/mcp-authoring smeared together" to "skills/planning, alone and
labelled `for: planner`." A reasonable LLM, given a single skill named
"planning" with a confident JSON example, will at minimum waste tool
calls dispatching steps that don't exist, and at worst will start
emitting `{summary, steps[]}` blobs whose contents nothing consumes.

## 6. Cross-finding interaction

- [../G42-builtin-skills-agenttypes-silently-ignored.md](../G42-builtin-skills-agenttypes-silently-ignored.md):
  G42 makes targeting work; G43 makes the content correct. They MUST
  land in the order G43 → G42, or G42's PR will start delivering a
  fictional plan format to the planner exclusively. See
  [03-plan-r1.md](./03-plan-r1.md) for the joint sequencing.
- F18 / round-1: there is no "fictional plan format" leak into
  [prompts/planner.md](../../../../prompts/planner.md). The planner
  prompt is correct end-to-end as of the current snapshot. The drift is
  isolated to this one skill file.

## 7. Scope of files touched by any fix

- [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md)
  — content owner; rewrite or delete.
- [src/agents/roster.ts](../../../../src/agents/roster.ts),
  [src/types.ts](../../../../src/types.ts),
  [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) —
  unchanged, but the source of truth that any rewrite or generator must
  match.
- [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts)
  — only if Option B (code-generate skill body) is taken.
- [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts),
  [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts)
  — touched indirectly via the round-trip assertions G42 is adding;
  must accept the new (or absent) `planning` skill.
- [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md),
  [docs/guide/skills.md](../../../../docs/guide/skills.md),
  [docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md)
  — author-facing docs; updated if the set of shipped built-ins
  changes.
- [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)
  — no change (skills internals are out of scope per the map's own
  preamble).
