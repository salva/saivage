# G05 — Analysis r2

**Finding**: [../G05-worker-message-builder-duplicated-5x.md](../G05-worker-message-builder-duplicated-5x.md)
**Round-1 reference**: F25/F09 extracted `WorkerAgent`, `task-report.ts`, and `normalizeTask`/`parseTaskReport`/`buildFailureReport` — but stopped at the initial-message builder, which is what this finding addresses.
**Round-1 review pointer**: [04-review-r1.md](04-review-r1.md) confirmed the source facts; this r2 keeps that body and adds §9 to document the metadata-ownership accounting that drives the r2 design's choice of `ROSTER` as the single source of truth.

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

All five pass `{ stageId, includeTasks: true }`. Reviewer is **not** an exception today. The follow-up marker is reviewer-only and lives in the heading, not in handoff options.

### 3.6 `static async create(...)` factory

Five identical 6-line idioms ([src/agents/coder.ts](../../../../src/agents/coder.ts#L16-L30), [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L16-L30), [src/agents/designer.ts](../../../../src/agents/designer.ts#L16-L30), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L15-L29), [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L17-L32)). The four arguments to `buildEagerBlock` are identical across all five except for the literal role string, which is already the `WorkerRole` the worker is constructed around.

### 3.7 Subclass constructor

Same shape across the five ([src/agents/coder.ts](../../../../src/agents/coder.ts#L32-L48), [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L32-L48), [src/agents/designer.ts](../../../../src/agents/designer.ts#L32-L48), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L31-L47), [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L34-L50)): a positional `(ctx, input, initialMessage, eagerSkillBlock, config?)` constructor that calls `super(ctx, input, { role, systemPrompt: loadRolePrompt("<role>"), eagerSkillBlock, initialMessage, invalidFinalResponseMessage: "...", ...config })`. The only per-role bits are the role literal, the prompt-file key, and the `invalidFinalResponseMessage` string.

## 4. Common structure → contract surface

Compressing §3 gives one builder shape:

```
inputs:
  ctx: AgentContext
  input: WorkerInput
  role: WorkerRole              (drives type default + eager loader + prompt key)
  init: {
    heading: string             (no trailing newline)
    extraInstructionLines?: string[]
    notesDir?(stageId): string  (reviewer only — `### Instructions` first line)
    followUpInstruction?: string (reviewer follow-up only)
    invalidFinalResponseMessage: string
    promptKey: RolePromptName   (maps role → prompt file; needed because `data_agent` → `data-agent`)
  }

opts (per-call):
  headingSuffix?: string        (reviewer follow-up only)
  prependFollowUp?: boolean     (reviewer follow-up only)

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

`grep -rn 'build(Coder|Researcher|Designer|DataAgent|Reviewer)Message' src/ test/` returns only the five definitions and their five intra-file callers. No external test imports the builders by name. The factories `*Agent.create` are invoked exclusively from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L321-L380); no test constructs workers via `.create`. The runtime path that actually wires workers is `createChildSpawner` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L283-L407), so the **behavioural** surface that has zero coverage today is:

- which subclass `createChildSpawner` constructs per `role`,
- that `onActivity` is wired through to every subclass,
- that `normalizeTask` runs (via the `WorkerAgent` constructor) so `task.type` is back-filled from `ROLE_TO_TASK_TYPE`,
- the reviewer stage-session cache at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L353-L374) (one `ReviewerAgent` per `stageId`, follow-up call goes via `agent.review(input)` not `agent.run()` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L402-L403)).

The refactor will replace the only constructors that exercise that surface, so r2 adds a consumer-level test against `createChildSpawner` (see Plan §6c). A snapshot-only test would prove the renderer but leave the dispatch swap unverified.

## 8. Cross-finding

- Round-1 F09/F25 (`WorkerAgent` + `task-report.ts`) — this finding completes the same extraction.
- G01 ([../G01/APPROVED.md](../G01/APPROVED.md)) — approved roster-as-source-of-truth pattern (`getAbortPriority`, `getToolFilter`, `getDispatchToolsFor`, `isConcurrencyLimitedDispatch`). The r2 design follows the same pattern: add a `workerInit` field to the relevant `ROSTER` entries and a `getWorkerInitMeta(role)` accessor; do not add a second registry.
- G02/G03/G04 — subsumed by G01.
- G06–G08 — adjacent "duplication left behind by a partial round-1 extraction" findings; same remedy family.

## 9. Metadata ownership count (drives the r2 design)

Round-1 review of r1 flagged that the r1 plan introduced a second worker-spec registry (`WORKER_ROLE_SPECS`) while the design claimed roster alignment ([04-review-r1.md](04-review-r1.md#L20-L24)). The current source already has multiple role-keyed tables, and the refactor must **reduce** the count, not add another:

| Owner | Source | Per-role data it holds |
|---|---|---|
| `ROSTER` | [src/agents/roster.ts](../../../../src/agents/roster.ts#L40-L210) | role, worker, dispatchTool, dispatchableBy, toolFilter, abortPriority, selfCheckFrequency, convention, defaultModelKey, displayName, summary |
| `ROLE_TO_TASK_TYPE` | [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25-L35) | role → default `task.type` for `**Type:**` line |
| `RolePromptName` (union) + `substitutions()` map | [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L16-L25), [src/agents/prompts.ts](../../../../src/agents/prompts.ts#L54-L61) | role → prompt-file name (only difference: `data_agent` → `"data-agent"`) |
| Per-subclass `loadRolePrompt(...)` arg + `invalidFinalResponseMessage` string + `buildXxxMessage` body | five files in [src/agents/](../../../../src/agents/) | prompt-key string, invalid-final string, heading, extra instruction lines, notes dir, follow-up paragraph |

The r2 design folds the fourth row into `ROSTER` (as a new optional `workerInit` field populated only on worker entries) and `ROLE_TO_TASK_TYPE` stays untouched (the renderer reads it). The `RolePromptName` mapping moves out of `prompts.ts`'s ad-hoc `role === "data-agent" ? "data_agent" : role` branch and becomes a roster field (`workerInit.promptKey`) for workers; the four non-worker roles continue to call `loadRolePrompt("<literal>")` directly, so the prompts module's `RolePromptName` union still serves them. Net owner count for worker-role metadata: 1 (`ROSTER`), down from 4 today.

The one residual table is `WORKER_CTORS: Map<WorkerRole, new (...) => WorkerAgent>` in [src/agents/worker.ts](../../../../src/agents/worker.ts) — a binding from role string to TypeScript class. This is not role *metadata*; it is the ctor wiring that cannot live on `ROSTER` without a cyclic import (ROSTER must not import from any agent class because every agent class imports from ROSTER). It is populated by a one-line `registerWorkerCtor("<role>", <Class>)` call at the bottom of each subclass file, and a roster-cross-check test (Plan §7) asserts every `WorkerRole` is registered. This is structurally the same pattern G01 uses for `getToolFilter` consumers: the table is exhaustive-checked, not parallel metadata.
