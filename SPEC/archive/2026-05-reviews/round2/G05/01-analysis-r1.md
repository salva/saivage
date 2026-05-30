# G05 — Analysis r1

**Finding**: [../G05-worker-message-builder-duplicated-5x.md](../G05-worker-message-builder-duplicated-5x.md)
**Subsystem**: agents (worker subclasses; `WorkerAgent` base)
**Round-1 reference**: F25/F09 extracted `WorkerAgent`, `task-report.ts`, and `normalizeTask`/`parseTaskReport`/`buildFailureReport` — but stopped at the initial-message builder, which is what this finding addresses.

## 1. What the finding says

Round-1 F09/F25 lifted task-report plumbing into [src/agents/worker.ts](../../../../src/agents/worker.ts) and [src/agents/task-report.ts](../../../../src/agents/task-report.ts), but the "build the initial user message that kicks off a worker" step was left in each subclass. Five files now hold a near-identical `buildXxxMessage(ctx, input)` plus a near-identical `static async create(...)` factory. The five copies have already drifted on the commit-clause wording (three different phrasings for one rule), proving the duplication is not benign.

## 2. The five duplicated builders

All five live in `src/agents/` and follow the same skeleton: checklist render → `await buildHandoffContext(ctx, { stageId, includeTasks: true })` → `## <heading>` → `**Task ID/Stage ID/Type/Attempt:**` lines → `### Description` → optional `### Checklist` → `### Instructions` → `Return the full TaskReport JSON as your final response.`

- [src/agents/coder.ts](../../../../src/agents/coder.ts#L50-L73) — `buildCoderMessage`. Heading: `## Task Assignment`. Type default `"code"`. Instructions: report path + `Commit using MCP git with message prefix: [${id}]`.
- [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L50-L75) — `buildResearcherMessage`. Heading: `## Research Task Assignment`. Type default `"research"`. Extra Instruction line: `Write findings under: research/`. Commit clause: `Commit using MCP git with message prefix: [${id}]`.
- [src/agents/designer.ts](../../../../src/agents/designer.ts#L50-L74) — `buildDesignerMessage`. Heading: `## Design Task Assignment`. Type default `"design"`. Extra Instruction line: `Produce design artifacts that are concrete enough for implementation and review.`. Commit clause variant: `Commit using MCP git with message prefix: [${id}] if you modify files.`.
- [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L49-L71) — `buildDataAgentMessage`. Heading: `## Data Acquisition Task Assignment`. Type default `"data"`. Extra Instruction lines: three (`Write downloaded artifacts ...`, `Write provenance notes ...`, `Use retries, fallback ...`). Commit clause: `Commit using MCP git with message prefix: [${id}]`.
- [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L66-L96) — `buildReviewerMessage(ctx, input, reviewNumber = 1)`. Heading: `## Stage Review Task Assignment${reviewNumber > 1 ? " - Follow-up Review N" : ""}`. Type default `"review"`. Extra Instruction lines: a follow-up paragraph when `reviewNumber > 1`, plus two stage-review guidance lines (`Review the stage objectives ...`, `For data-heavy or ML/research stages ...`) and a stage-scoped notes path (`.saivage/stages/${stageId}/reviews/`). Commit clause third variant: `Commit using MCP git with message prefix: [${id}] if you create review files.`.

## 3. Line-for-line diff of the five copies

### 3.1 Heading line

| File | Heading |
|---|---|
| coder.ts | `## Task Assignment` |
| researcher.ts | `## Research Task Assignment` |
| designer.ts | `## Design Task Assignment` |
| data-agent.ts | `## Data Acquisition Task Assignment` |
| reviewer.ts | `## Stage Review Task Assignment[ - Follow-up Review N]` |

### 3.2 Default `type` value

Coder `"code"`, researcher `"research"`, designer `"design"`, data-agent `"data"`, reviewer `"review"`. Each subclass repeats the role→type mapping that already lives once in [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L29-L35) as `ROLE_TO_TASK_TYPE`.

### 3.3 Commit-clause drift (the proof that duplication has cost)

| File | Sentence |
|---|---|
| coder.ts | `Commit using MCP git with message prefix: [${id}]` |
| researcher.ts | `Commit using MCP git with message prefix: [${id}]` |
| data-agent.ts | `Commit using MCP git with message prefix: [${id}]` |
| designer.ts | `Commit using MCP git with message prefix: [${id}] if you modify files.` |
| reviewer.ts | `Commit using MCP git with message prefix: [${id}] if you create review files.` |

Three different phrasings for one rule ("prefix every commit, if any, with the task id"). The trailing-period inconsistency is also visible: coder/researcher/data-agent have no period; designer and reviewer end with `.`.

### 3.4 Role-specific Instruction lines (the only interesting bit)

| File | Role-specific lines |
|---|---|
| coder.ts | none |
| researcher.ts | `Write findings under: research/` |
| designer.ts | `Produce design artifacts that are concrete enough for implementation and review.` |
| data-agent.ts | `Write downloaded artifacts to ...` / `Write provenance notes ...` / `Use retries, fallback ...` (3 lines) |
| reviewer.ts | optional follow-up paragraph + `Review the stage objectives ...` + `For data-heavy or ML/research stages ...` + `Write optional detailed notes to: .saivage/stages/${stageId}/reviews/` |

### 3.5 `buildHandoffContext` call

All five pass `{ stageId, includeTasks: true }`. Reviewer is **not** an exception today (the original finding's claim that "Reviewer is the only file that calls `buildHandoffContext(ctx, { stageId, includeTasks: true })`" is inaccurate — every worker passes the same options now). The follow-up marker is reviewer-only and lives in the heading, not in handoff options.

### 3.6 `static async create(...)` factory

Five identical 6-line idioms ([src/agents/coder.ts](../../../../src/agents/coder.ts#L16-L30), [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L16-L30), [src/agents/designer.ts](../../../../src/agents/designer.ts#L16-L30), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L15-L29), [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L17-L32)):

```ts
static async create(ctx, input, config?) {
  const initialMessage = await buildXxxMessage(ctx, input);
  const eagerSkillBlock = await buildEagerBlock(
    ctx.project.projectRoot, "<role>",
    input.task.description, input.task.tags ?? [],
  );
  return new XxxAgent(ctx, input, initialMessage, eagerSkillBlock, config);
}
```

The four arguments to `buildEagerBlock` are identical across all five except for the literal role string, which is already the `WorkerRole` we are constructing the worker around.

### 3.7 Subclass constructor

Same shape across the five ([src/agents/coder.ts](../../../../src/agents/coder.ts#L32-L48), [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L32-L48), [src/agents/designer.ts](../../../../src/agents/designer.ts#L32-L48), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L31-L47), [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L34-L50)): a positional `(ctx, input, initialMessage, eagerSkillBlock, config?)` constructor that calls `super(ctx, input, { role, systemPrompt: loadRolePrompt("<role>"), eagerSkillBlock, initialMessage, invalidFinalResponseMessage: "...", ...config })`. The only per-role bits are the role literal, the prompt key, and the `invalidFinalResponseMessage` string.

## 4. Common structure → contract surface

Compressing §3 gives one builder shape:

```
inputs:
  ctx: AgentContext
  input: WorkerInput
  spec:
    role: WorkerRole              (also drives type default + eager loader)
    heading: string               (no trailing newline)
    headingSuffix?: string         (reviewer follow-up only)
    extraInstructionLines?: string[]
    extraNotesPath?: string       (reviewer only — `### Instructions` first line)

output:
  string in the canonical worker-message shape with:
    - one unified commit clause: `Commit using MCP git with message prefix: [<id>] if you modify files.`
    - one report-path line
    - one final-response line
```

Default `type` for the `**Type:**` line comes from `ROLE_TO_TASK_TYPE` ([src/agents/task-report.ts](../../../../src/agents/task-report.ts#L29-L35)) — no need to repeat it per file.

The five role-specific differences collapse to: heading text (5 values), 0–3 extra instruction lines (4 distinct sets), and reviewer's follow-up paragraph + notes-dir line.

## 5. Other agents — confirmed out of scope

The finding scopes to the five `WorkerAgent` subclasses. The other agents have unrelated initial-message shapes:

- [src/agents/manager.ts](../../../../src/agents/manager.ts) — `buildManagerMessage`: stage-scoped, not task-scoped; no Task ID / Attempt / report-path lines.
- [src/agents/planner.ts](../../../../src/agents/planner.ts) — `buildPlannerMessage`: project-scoped; no stage at all.
- [src/agents/inspector.ts](../../../../src/agents/inspector.ts) — `buildInspectorMessage`: read-only; no commit/report directives.
- [src/agents/chat.ts](../../../../src/agents/chat.ts#L94) — literal `Chat session started ...` string; no builder.

None of these share the `## <X> Task Assignment` + Task-ID/Stage-ID/Type/Attempt skeleton, so they stay out of the refactor. (The factory-shape duplication in 3.6 is also present in manager/planner/inspector but the only piece shared with the workers is `buildEagerBlock`; that is a separate finding scope, not G05.)

## 6. Why this matters (concrete)

- Anyone changing the worker contract — adding a `**Trace ID:**` line, switching commit prefix, refining checklist render, tightening the report-path convention — has to touch five files and rely on review to catch the one they missed. The existing commit-clause divergence is a real, already-shipped instance of this failure.
- Adding a sixth worker role means copy-pasting ~75 lines of boilerplate plus a near-identical factory.
- The structural noise hides the actual per-role contract (three roles have ≤ 1 line of role-specific content; only data-agent and reviewer carry real role-specific guidance).
- There is no compile-time link between the five copies, so the drift goes silent. A shared builder + a per-role snapshot test turns drift into a failing test.

## 7. Test impact today

`grep -rn 'build(Coder|Researcher|Designer|DataAgent|Reviewer)Message' src/ test/` returns only the five definitions and their five intra-file callers. No external test imports the builders by name. The factories `*Agent.create` are invoked exclusively from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L321-L380); no test constructs workers via `.create`. So:

- Removing the five `buildXxxMessage` functions and the five `static create` factories is a self-contained internal refactor; no test file needs to change unless we choose to add a new snapshot test.
- There is no existing snapshot of the rendered initial message; the refactor is the right moment to add one.

## 8. Cross-finding

- Round-1 F09/F25 (`WorkerAgent` + `task-report.ts`) — this finding completes the same extraction.
- G02 ([../G02-dispatcher-limits-omit-designer.md](../G02-dispatcher-limits-omit-designer.md)), G03 ([../G03-role-tool-filter-ignores-roster.md](../G03-role-tool-filter-ignores-roster.md)) — same theme: round-1 lifted partial state into `roster.ts` / shared bases and left siblings out of sync. Same remedy (single source of truth).
- G06–G08 — same family of "extracted one helper, left the adjacent one duplicated" findings.
