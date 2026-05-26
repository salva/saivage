# G43 — Design r2 (three options + recommendation)

Round-2 delta over [02-design-r1.md](./02-design-r1.md): the shared
context now matches the revised dormancy model in
[01-analysis-r2.md](./01-analysis-r2.md#5-why-the-bug-is-currently-dormant-revised).
The three options, their files-touched lists, deletion lists, test
impacts, trade-offs, and the Option-C recommendation are unchanged in
substance.

## Shared context

The `planning` SKILL.md body contradicts the actual plan-server contract
on ten distinct points (see
[01-analysis-r2.md](./01-analysis-r2.md#3-every-fictional-element-line-by-line-with-the-contradicting-code)).
The planner's system prompt
[prompts/planner.md](../../../../prompts/planner.md) already documents
every MCP tool, the `Stage` schema, the escalation protocol, and the
planning guidelines correctly. The eager skill block is therefore at
best a redundant restatement of the prompt and at worst (post-G42) a
contradicting one.

Today the planner never sees the body at all — the walker emits a
synthetic record with bare-topic triggers and empty `target_agents`,
the scorer rejects bare triggers, and the resolver drops zero-score
non-survivors
([01-analysis-r2.md](./01-analysis-r2.md#5-why-the-bug-is-currently-dormant-revised)).
The G42 loader rewrite removes those three filters in one step
(parses the frontmatter, honours `agentTypes`/`target_agents`,
stops synthesising bare triggers), so the latent body becomes live
the moment G42 lands. All three options below must therefore land
before G42; see
[03-plan-r2.md](./03-plan-r2.md#sequencing-relative-to-g42) for the
joint sequencing contract.

Per the workspace architecture-first rule there is no migration path;
any option below changes the file on disk in-place. None of the three
options preserves the current body.

---

## Option A — Hand-rewrite the skill body to match plan-server + roster

### Idea

Replace the 45-line body with a planner-targeted skill whose content is
*derived from* but distinct from the system prompt: a tight
"checklist + tool cheatsheet" the planner reads before each replanning
decision. Concretely:

- One paragraph framing the planner's contract (long-lived; mutates
  `Plan` via MCP; never emits JSON; signals completion with
  `PLAN_COMPLETE`).
- A `Stage` fields list copy-pasted from
  [src/types.ts](../../../../src/types.ts#L35-L44) (`id`, `objective`,
  `starting_points`, `expected_outcomes`, `acceptance_criteria`,
  `references`, `tags`) with one-line guidance per field.
- The `plan_*` tool cheatsheet copied from
  [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L196-L320)
  `getToolSchemas()` (tool name + one-line `description`), plus the two
  dispatch tools `run_manager` and `run_inspector` —
  [src/agents/roster.ts](../../../../src/agents/roster.ts#L59),
  [src/agents/roster.ts](../../../../src/agents/roster.ts#L175).
- The four `StageSummary.result` codes and the canonical reaction for
  each, copied from
  [prompts/planner.md](../../../../prompts/planner.md#L60-L67).
- An explicit "what the planner does NOT do" section listing the
  fictions from Section 3 of the analysis (no `executor` role, no
  `dependsOn`, no `summary/steps` JSON, no numeric IDs, no `type:
  execute`, no `goal` field) so the LLM sees the negative space.

### Files touched

- [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L45)
  — full body rewrite. Frontmatter normalised in concert with G42 (use
  `target_agents: [planner]` instead of `agentTypes: [planner]`; drop
  `version:`).
- [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts)
  / [src/knowledge/regression.test.ts](../../../../src/knowledge/regression.test.ts)
  — add one loose assertion that the `planning` skill body contains
  `plan_add_stage` (or another sentinel from the rewritten body) so a
  future regression that re-introduces fictional content is caught.

### Deletion list

- The entire body of
  [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L8-L45)
  — the 5-rule numbered list and the JSON code fence.
- The `version: 0.1.0` frontmatter key (no consumer; G42 will start
  rejecting unknown keys).

### Test impact

- One new positive assertion in `eagerLoader.test.ts` or
  `regression.test.ts` to pin the body to the real plan-server
  vocabulary.
- The G42 round-trip assertion (loads every `skills/builtin/*/SKILL.md`
  and parses with the new strict schema) automatically covers the
  frontmatter normalisation.
- No other test references this skill by name; verified via
  `grep -RIn 'skills/builtin/planning' .` showing only doc/spec hits.

### Trade-offs

- Cheap: rewrites one Markdown file. Author and reviewer can verify
  correctness by diffing against
  [src/types.ts](../../../../src/types.ts#L35-L44) and
  [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L196-L320).
- Drift risk persists. The hand-written body restates two contracts
  (Stage schema + plan-server tools) that already exist in TypeScript;
  any future change to those contracts has to be remembered here. This
  is exactly the failure mode that produced G43 in the first place
  (the file was written when an `executor` role and a `steps[]` plan
  format were apparently planned but never built).

---

## Option B — Code-generate the skill body from `ROSTER` + `StageSchema` + `PlanService.getToolSchemas()`

### Idea

Make `skills/builtin/planning/SKILL.md` a *frontmatter-only* file (or a
template stub with `{{stage_fields}}` / `{{plan_tools}}` /
`{{dispatch_tools}}` placeholders) and have the eager loader expand the
placeholders at load time from the canonical TypeScript values:

```ts
// src/knowledge/eagerLoader.ts (sketch)
import { ROSTER } from "../agents/roster.js";
import { StageSchema } from "../types.js";
import { PlanService } from "../mcp/plan-server.js";

function renderPlanningSkillBody(): string {
  const stageFields = describeZodObject(StageSchema);             // Section 2 of body
  const planTools  = PlanService.getToolSchemas()                  // Section 3
    .map(t => `- \`${t.name}\` — ${t.description}`).join("\n");
  const dispatchTools = ROSTER
    .filter(r => r.dispatchTool && r.dispatchableBy.includes("planner"))
    .map(r => `- \`${r.dispatchTool}\` — dispatch a ${r.displayName}`).join("\n");
  return PLANNING_SKILL_TEMPLATE
    .replace("{{stage_fields}}", stageFields)
    .replace("{{plan_tools}}", planTools)
    .replace("{{dispatch_tools}}", dispatchTools);
}
```

The same generator (or a small build-time variant) re-renders the file
on disk so reviewers can read the expanded form in the git tree without
running the loader. CI fails if `git diff` shows drift between the
checked-in `planning/SKILL.md` and the generator's output.

Optionally extend to the other three built-ins (`coding`,
`mcp-authoring`, `research`) by table-driving them, but those skills
have less internal-contract content and the marginal benefit is
smaller; the recommendation here scopes the generator to `planning`
only.

### Files touched

- [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L45)
  — becomes a template (with `{{…}}` placeholders) checked in to disk
  for human reviewability. Or stays as the generator's last-rendered
  output, with a `// generated; edit planning.tmpl.md` header line.
- new `skills/builtin/planning/planning.tmpl.md` (if templates and
  output are kept separate) — the literal Markdown frame with
  placeholders.
- new `src/knowledge/builtin-planning.ts` — exports
  `renderPlanningSkillBody(): string` and a CLI entry usable by
  `tsup`/`npm run build` for the regenerate step.
- [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L93-L122)
  — when the topic is `planning`, substitute the in-process render for
  the file body. (Coordinated with G42, which moves frontmatter parsing
  into this same function.)
- new `src/knowledge/builtin-planning.test.ts` — asserts the rendered
  body contains every `plan_*` tool name and every `Stage` field name,
  and asserts equality with the checked-in file (the drift guard).
- new `scripts/render-builtin-skills.ts` (or a small `npm run` entry) —
  rewrites the on-disk file from the template; CI runs it in
  check-only mode and fails on diff.
- [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md)
  — author guidance: for skills that encode internal contracts, write
  a generator + template + drift test rather than a hand-edited body.

### Deletion list

- The entire current body of
  [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L8-L45)
  (same as Option A).
- Any hand-written enumeration of `Stage` fields, plan tools, or
  dispatch targets inside that file — replaced by the placeholder.

### Test impact

- New unit test for `renderPlanningSkillBody()` (positive: contains
  every name; negative: contains none of the fictional tokens
  `executor`, `dependsOn`, `"steps"`, `"type": "execute"` — note the
  precise shape; bare `summary` is not a fiction marker per
  [01-analysis-r2.md](./01-analysis-r2.md#f7-example-uses-summary-at-the-top-level-l20)).
- New CI step (drift guard): rendered output must equal checked-in
  body. Implemented as a `vitest` assertion comparing
  `readFileSync(SKILL.md)` to `renderPlanningSkillBody()`.
- The G42 round-trip test continues to apply; the rendered body must
  pass the strict frontmatter parse.

### Trade-offs

- Single source of truth: the Stage schema, MCP tool list, and roster
  cannot drift from the skill body — a refactor that renames
  `plan_add_stage` or removes the `acceptance_criteria` field
  immediately breaks the drift guard.
- New machinery (generator file, CI step, template format) for one
  skill file. The marginal complexity is real and the
  architecture-first rule cuts both ways here: removing the file
  entirely (Option C) also removes the drift surface, without adding
  any machinery.
- The skill body is still a redundant restatement of the planner
  system prompt, just one that cannot drift. The fundamental
  duplication (two channels — system prompt and eager skill — teaching
  the same content to the same role) is not addressed.

---

## Option C — Delete the `planning` built-in skill outright

### Idea

The planner system prompt
[prompts/planner.md](../../../../prompts/planner.md) already covers
every topic the skill purports to teach, with the canonical
vocabulary, and is the channel the agent already reads on every turn.
The eager skill block is a duplicate channel that exists for
*role-targeted* domain knowledge a system prompt can't conveniently
carry — e.g. coding conventions delivered to the Coder, research
patterns delivered to the Researcher. The planner already has its
domain knowledge in its prompt because the planner is the one role
that has a hand-written prompt covering nothing but planning.

Therefore: delete the file. After G42 lands, the planner's eager skill
block legitimately contains nothing (or, if other planner-targeted
skills are created in future, only those). The Stage schema and plan
tools live in TypeScript; the planner-facing prose lives in
[prompts/planner.md](../../../../prompts/planner.md); the `planning`
skill is the third copy and the only one that has ever drifted.

### Files touched

- [skills/builtin/planning/SKILL.md](../../../../skills/builtin/planning/SKILL.md#L1-L45)
  — deleted.
- `skills/builtin/planning/` directory — deleted (currently contains
  only `SKILL.md`; verify before `git rm -r`).
- [SPEC/v2/skills/skill-creation.md](../../../../SPEC/v2/skills/skill-creation.md)
  — if any example references the `planning` skill, update.
- [docs/guide/skills.md](../../../../docs/guide/skills.md),
  [docs/internals/skill-loader.md](../../../../docs/internals/skill-loader.md)
  — if either lists the four built-ins by name, drop `planning` from
  the list and note (one sentence) why: "Planner-facing planning prose
  lives in `prompts/planner.md`; the eager skill block has no extra
  content to add."
- G42's planned round-trip test in
  [src/knowledge/eagerLoader.test.ts](../../../../src/knowledge/eagerLoader.test.ts)
  iterates over the bundled directories, so it adapts automatically
  (one fewer entry); the explicit `planner -> planning` assertion in
  [SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](../G42/03-plan-r1.md#L117)
  must be removed in the same merge — coordination detail in
  [03-plan-r2.md](./03-plan-r2.md#cross-finding-coordination-with-g42).

### Deletion list

- `skills/builtin/planning/SKILL.md` (entire file).
- `skills/builtin/planning/` (entire directory).
- Any documentation enumeration of "the four built-in skills" updated
  to "the three built-in skills."
- The `planner -> planning` symmetry assertion in G42's plan
  ([SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](../G42/03-plan-r1.md#L74),
  [SPEC/v2/review-2026-05-round2/G42/03-plan-r1.md](../G42/03-plan-r1.md#L117)).

### Test impact

- No new tests required.
- Negative test (cheap): G42's round-trip will assert there are exactly
  three SKILL.md files under `skills/builtin/`; the count line in that
  test is the only mechanical edit needed.

### Trade-offs

- Largest single-step reduction in drift surface: removing the file
  eliminates the bug class, not just this instance.
- Leaves the planner without any eager skill block (until/unless future
  skills are added for the role). Tested empirically as a no-op on the
  running `saivage-v3` harness (Section 5 of the analysis) — the
  current eager block is already empty for the planner because the
  resolver drops every built-in candidate today.
- Forecloses Option B's "code-generated skill body" pattern for the
  planner specifically. Option B could still be adopted later for the
  other built-ins (`coding`, `research`, `mcp-authoring`) without
  re-introducing a `planning` file; that is a separate, future
  decision.

---

## Recommendation: Option C

The workspace architecture-first rule is explicit: "Don't create
helpers or abstractions for one-time operations." Option B builds a
template + generator + drift test to keep one file in sync with three
TypeScript modules; Option C removes the file and the drift problem
disappears.

Option A is the smallest patch but recreates the original failure mode
— a hand-written enumeration of contracts that already exist as code.
The next plan-server change that adds, renames, or removes a `plan_*`
tool re-creates G43 in miniature.

Option B is the right pattern *if* the planner needed planner-targeted
domain content the system prompt can't carry. It doesn't: every
`Stage` field, every `plan_*` tool, every escalation reaction, and
every planning guideline is already in
[prompts/planner.md](../../../../prompts/planner.md). The skill is a
strict subset of the prompt with worse fidelity.

Option C also has the smallest blast radius for the joint
G43+G42 release: G43 deletes a file, G42 rewrites the loader. There is
no overlap on `planning/SKILL.md` lines and the two PRs can be
reviewed independently. See
[03-plan-r2.md](./03-plan-r2.md#cross-finding-coordination-with-g42)
for the joint sequencing.

If a reviewer disagrees with the "delete" outcome and wants a
planner-facing skill to remain, fall back to Option B (not Option A) —
generator-backed content beats hand-written content for any skill that
encodes an internal contract.
