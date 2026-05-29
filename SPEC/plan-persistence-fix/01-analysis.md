# Saivage Plan-Persistence Drift — Analysis

> Round 3 analysis document for the plan-persistence-fix workstream.
> Out of scope: solutions, designs, remediation plans. Those belong in 02 and 03.

## Symptom

**User's phrasing (verbatim, 2026-05-29 ~15:08 local):**
The chat agent told the user at 15:06:42 that "queued work is currently complete,
active plan: empty, current stage: none, most recent result: stage-340", while
in reality stage-362 was mid-execution on the same host. The user objected that
this was wrong, and at 15:08:58 the chat agent wrote what it called an "urgent
permanent note" for the planner about it.

**Precise restatement:**
The authoritative plan document at [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json)
and its embedded history ([codemacs/.saivage/plan-history.json](codemacs/.saivage/plan-history.json)
mirror) are weeks out of date with respect to the work the runtime is actually
executing. Stages are being chosen, dispatched, executed, and completed — task
reports and summaries are landing under
[codemacs/.saivage/stages/](codemacs/.saivage/stages/) for stage-348 through
stage-362 — without any corresponding mutation to the plan document. Every read
path that trusts [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json) as
the source of truth (the chat agent, the HTTP API consumed by the dashboard,
the planner's own restart prompts) therefore reports a project state that
diverged on 2026-05-11 and has never recovered.

## Evidence

All facts in this section are dated 2026-05-29 unless otherwise noted, and
constitute a point-in-time snapshot: [codemacs/.saivage/tmp/state/runtime.json](codemacs/.saivage/tmp/state/runtime.json)
mutates continuously and the on-disk `current_stage_id` value will have
advanced past stage-362 by the time this document is read.

### Plan document is frozen at 2026-05-11

- [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json)
  - mtime: **2026-05-11 17:38:39**
  - contents (verbatim): `{"updated_at":"2026-05-11T15:38:39.988Z","current_stage_id":null,"stages":[]}`
- [codemacs/.saivage/plan-history.json](codemacs/.saivage/plan-history.json)
  - mtime: **2026-05-11 17:38:39**
  - last recorded stage id: `stage-340-session-delete-rename-management`

### Runtime is in fact executing stage-362 today

- [codemacs/.saivage/tmp/state/runtime.json](codemacs/.saivage/tmp/state/runtime.json)
  - mtime: **2026-05-29 17:15** (today)
  - `current_stage_id: "stage-362-c02-long-tail-discoverability-audit-slice"`
  - status: `running`
  - active agents: planner (started **10:17:39**) and manager (started
    **14:56:26**) — both start times read from
    [codemacs/.saivage/tmp/state/runtime.json](codemacs/.saivage/tmp/state/runtime.json)
    (mtime 2026-05-29 17:15).
- Stage directories present on disk today, newest first: stage-362, 361, 360,
  359, 358, 357, 356, 355, 354, 353, 352, 351, 350, 349, 348 — enumerated by
  `ls -1t .saivage/stages/ | head` against
  [codemacs/.saivage/stages/](codemacs/.saivage/stages/) on the codemacs
  project today, 2026-05-29. **None of these appear in
  [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json) or
  [codemacs/.saivage/plan-history.json](codemacs/.saivage/plan-history.json).**
- Stage-362 produced real task work today:
  - t1 (coder) committed `2b25361` at 15:10 — per
    [codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/reports/t1-audit-and-implement-c02-long-tail-descriptors.json](codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/reports/t1-audit-and-implement-c02-long-tail-descriptors.json)
    (written 2026-05-29) and corroborated by the journal at
    `2026-05-29 15:10:55` showing
    `[agent:coder:agent-191p98w62t49] LLM response: ... task_id: t1-audit-and-implement-c02-long-tail-descriptors ... status: completed`.
  - t2 (reviewer) returned `approved_with_residual_risks` at 15:13 — per
    [codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/reports/t2-review-stage.json](codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/reports/t2-review-stage.json)
    (written 2026-05-29) and corroborated by the journal at
    `2026-05-29 15:13:58` showing
    `[agent:reviewer:agent-8xiz4ewvb702] LLM response: ... review_result: approved_with_residual_risks`.

### No plan-mutation MCP tool has been invoked since the morning restart

The following exact alternation pattern was run against the systemd journal
for `saivage.service`:

```text
plan_add_stage|plan_set_stages|plan_remove_stage|plan_set_current|plan_complete_stage|plan_commit|plan_init|plan_done|PLAN_NOT_FOUND|STAGE_NOT_FOUND|STAGE_EXISTS
```

Command: `journalctl -u saivage.service --since "2026-05-29 10:17:30"`.
Result: **0 matches across 2,991 journal lines**.

That pattern covers all seven plan-writer tools declared by the plan MCP
service —

1. `plan_init`
2. `plan_set_stages`
3. `plan_add_stage`
4. `plan_remove_stage`
5. `plan_set_current`
6. `plan_complete_stage`
7. `plan_commit`

— plus `plan_done` (the planner-terminal reader/writer used for recovery
hand-off) and all three plan-service error codes that the writer tools throw
on rejection:

- `PLAN_NOT_FOUND`
- `STAGE_NOT_FOUND`
- `STAGE_EXISTS`

The runtime was restarted today at 10:17:37 (PID 517) on the saivage LXC. The
deployed code on that LXC (deployment path on the saivage host, not a
workspace file — therefore uncited) is at commit
`eb65ab41575308208e9f778e10213cc9ecc45cb1`. Across the 6+ hours of journal
since that restart, neither a successful nor a rejected plan-mutation call
appears.

### Chat agent incident at 15:06:42

The chat agent answered "active plan: empty, current stage: none, most recent
result: stage-340" because it called the `plan_get` MCP tool, which read the
in-memory cache hydrated from the May-11
[codemacs/.saivage/plan.json](codemacs/.saivage/plan.json)
([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L137-L141)).
The reply was internally consistent with the document — it was the document
that was wrong.

### Plan-writer tool surface that is going unused

The plan MCP service declares exactly seven writer tools and five reader
tools ([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L29-L45)):

```text
PLAN_WRITER_TOOLS: plan_set_stages, plan_add_stage, plan_remove_stage,
                   plan_set_current, plan_complete_stage, plan_init, plan_commit
PLAN_READER_TOOLS: plan_get, plan_get_stage, plan_get_current_stage,
                   plan_get_history, plan_done
```

The journal evidence above shows none of the writer tools fired today. The
drift is therefore caused by **absence of writer-tool calls**, not by
writer-tool failures.

## Reproduction conditions

The drift appears when **all** of the following hold:

1. `runtime.continuousImprovement` is true in the live
   [codemacs/.saivage/saivage.json](codemacs/.saivage/saivage.json), so the
   recovery loop keeps restarting the planner with the
   `CONTINUOUS_IMPROVEMENT_PROMPT` directive
   ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L587-L599),
   [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L670-L686)).
2. The planner produces a stage object inline in its conversation and dispatches
   it directly via `run_manager(stage)` without first calling `plan_add_stage`
   or `plan_set_stages` plus `plan_set_current`.
3. The manager accepts the dispatch, writes its per-stage task list
   under [codemacs/.saivage/stages/](codemacs/.saivage/stages/) per its
   initial-message instructions
   ([saivage/src/agents/manager.ts](saivage/src/agents/manager.ts#L156-L168)),
   and the workers run normally.
4. The manager emits a `StageSummary` whose `result` is `completed | failed |
   escalated` but, because `plan_set_current` was never called, the planner
   cannot legally call `plan_complete_stage` (that tool validates the stage is
   in `doc.stages` and has `started_at`, see
   [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L254-L273)).

The drift does **not** appear when the planner follows the prompt literally —
the `CONTINUOUS_IMPROVEMENT_PROMPT` explicitly says to call `plan_add_stage()`
or `plan_set_stages()`
([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L596-L597))
— or when starting from a fresh project where
[codemacs/.saivage/plan.json](codemacs/.saivage/plan.json) does not yet exist
(the planner is then forced through `plan_init` first).

## Code path causing the drift

The missing precondition is in the manager-dispatch case of the child spawner.

`createChildSpawner` returns a dispatch function whose `case "manager"` branch
reads the incoming stage object, sets the runtime tracker's "current stage" to
whatever id it contains, and constructs a `ManagerAgent` — with no reference
to `runtime.planService` at all:

[saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L374-L385)

```ts
case "manager": {
  const managerInput = input as import("../agents/types.js").ManagerInput;
  const managerSpawner = createChildSpawner(runtime);
  ctx.stageId = managerInput.stage?.id;
  agent = await ManagerAgent.create(ctx, managerInput, managerSpawner, {
    onActivity: (agentId) => tracker.agentActivity(agentId),
    onCompactionUpdate: tracker.agentCompactionUpdate.bind(tracker),
  });
  tracker.setCurrentStage(managerInput.stage?.id ?? null);
  break;
}
```

There is no `await runtime.planService.plan_get_stage(managerInput.stage.id)`
guard, no check that `plan.current_stage_id === managerInput.stage.id`, and
no fall-through that would call `plan_add_stage` / `plan_set_current` if the
stage is missing. The dispatcher is structurally agnostic to the plan
document.

The worker-dispatch normalizer one level down validates that `stageId` is a
non-empty string
([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L474-L519),
with the required-string check at
[saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L483-L486))
but likewise consults nothing in `planService` — so coder/reviewer/etc.
dispatches inherit the same drift.

`ManagerAgent.create` and `ManagerAgent.run` then proceed entirely off the
in-memory stage object. `normalizeStage` happily synthesizes a `Stage` from a
record whose only required field at runtime is `id` (function declared at
[saivage/src/agents/manager.ts](saivage/src/agents/manager.ts#L118-L129),
body spanning L120-L129 with closing brace at L129), and the initial
message tells the manager to write its per-stage task list under
[codemacs/.saivage/stages/](codemacs/.saivage/stages/) regardless of whether
the plan knows the stage exists
([saivage/src/agents/manager.ts](saivage/src/agents/manager.ts#L156-L168)).

The roster confirms this is by design: `manager`'s write-territory is
[codemacs/.saivage/stages/](codemacs/.saivage/stages/) with no mention of
[codemacs/.saivage/plan.json](codemacs/.saivage/plan.json)
([saivage/src/agents/roster.ts](saivage/src/agents/roster.ts#L92-L111)),
i.e. the manager is not expected to touch the plan document and the
dispatcher does not enforce that someone else did before invoking it.

### Why the CONTINUOUS_IMPROVEMENT_PROMPT does not save us

The recovery loop re-queues the directive that explicitly tells the planner to
call `plan_add_stage`/`plan_set_stages`
([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L587-L599)),
and the recovery branch that restarts the planner after `plan_done` is
[saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L673-L686).
This is **a prompt-level instruction with no enforcement layer**. If the
planner ignores it — as today's journal shows it has since 10:17 — nothing in
the runtime corrects the omission.

## Blast radius

Every consumer that reads [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json)
(directly or via the `plan_get*` MCP tools) sees the May-11 view of the world.

1. **Chat agent / dashboard "what is queued" answers** — `plan_get` returns the
   stale `ActivePlanView` from the in-memory cache hydrated at startup
   ([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L137-L141)).
   Concrete impact: today's 15:06:42 reply quoted in the Symptom section.

2. **`GET /api/plan`** — the primary dashboard endpoint returns
   `{ plan: activePlanView(doc), history: historyView(doc) }` from
   [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json)
   ([saivage/src/server/server.ts](saivage/src/server/server.ts#L188-L191)).
   The dashboard's plan view is therefore the May-11 view.

3. **`GET /api/state`** — combines [codemacs/.saivage/tmp/state/runtime.json](codemacs/.saivage/tmp/state/runtime.json)
   (current) with [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json)
   (stale) into a single response
   ([saivage/src/server/server.ts](saivage/src/server/server.ts#L216-L221)).
   The two halves disagree: the runtime-state half will name stage-362 while
   `plan.current_stage_id` is `null`.

4. **`GET /api/debug/state`** — same shape, plus raw config
   ([saivage/src/server/server.ts](saivage/src/server/server.ts#L493-L514)).

5. **`GET /api/debug/errors`** — enumerates failed/escalated stages from the
   plan history before walking [codemacs/.saivage/stages/](codemacs/.saivage/stages/)
   directories
   ([saivage/src/server/server.ts](saivage/src/server/server.ts#L517-L543)).
   Stage-3{41..62} failures or escalations recorded only in stage summaries
   will appear; ones the planner forgot to record in history will not be
   double-counted, but the plan-history half of the report stops at May 11.

6. **`GET /api/debug/timeline`** — walks plan history first for
   `stage_started`/`stage_completed` events
   ([saivage/src/server/server.ts](saivage/src/server/server.ts#L665-L695)).
   The whole May-12-to-today window of plan-derived timeline events is empty;
   only task-report-derived events survive.

7. **Planner recovery prompts** — both `RECOVERY_PROMPT` and
   `CONTINUOUS_IMPROVEMENT_PROMPT` instruct the planner to "Call plan_get() to
   read the current plan state" and "Call plan_get_history() to see what
   stages have completed"
   ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L576-L599)).
   On every restart the planner sees an empty active plan and only stage-340
   in history, so its own model of "what work has been done" is wrong by
   ~22 stages. This is the feedback loop that probably caused the drift to
   persist: the planner sees "nothing in flight, last result stage-340", so it
   confabulates a fresh stage object and dispatches it without first writing
   it into the plan.

(That is more than the three required; #2, #6, and #7 are the most
operationally damaging.)

## What is NOT broken

The following continue to function correctly and should **not** be touched by
the fix:

- **Stage directories under [codemacs/.saivage/stages/](codemacs/.saivage/stages/)** —
  stage-348 through stage-362 are present on disk, each containing a per-stage
  task list ([example: stage-362 tasks.json](codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/tasks.json)),
  a per-stage report directory
  ([example: stage-362 reports/](codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/reports/)),
  and (where finished) a per-stage summary
  ([example: stage-362 summary.json](codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/summary.json)).
  The manager-writes-stage-files path
  ([saivage/src/agents/manager.ts](saivage/src/agents/manager.ts#L156-L168))
  is doing its job; the roster's write-territory rule for `manager`
  ([saivage/src/agents/roster.ts](saivage/src/agents/roster.ts#L92-L111))
  is being honored.
- **[codemacs/.saivage/tmp/state/runtime.json](codemacs/.saivage/tmp/state/runtime.json)** —
  accurately reflects the live process: today's mtime (2026-05-29 17:15),
  correct `current_stage_id`, correct per-agent `started_at`. The
  `RuntimeTracker` lifecycle in the dispatcher
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L374-L385),
  [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L388-L420))
  is functioning correctly.
- **Worker task execution** — stage-362 t1 (coder, commit `2b25361` at 15:10)
  and t2 (reviewer, `approved_with_residual_risks` at 15:13) prove the
  manager → coder → reviewer pipeline executes and produces task reports. The
  task-report files
  [codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/reports/t1-audit-and-implement-c02-long-tail-descriptors.json](codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/reports/t1-audit-and-implement-c02-long-tail-descriptors.json)
  and
  [codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/reports/t2-review-stage.json](codemacs/.saivage/stages/stage-362-c02-long-tail-discoverability-audit-slice/reports/t2-review-stage.json)
  (both written 2026-05-29), together with the matching journal lines at
  15:10:55 and 15:13:58, confirm worker execution end-to-end. The
  `WorkerAgent.createWorker` / stage-scoped caching path in the dispatcher
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L388-L420))
  is fine.
- **Plan MCP service itself** — `PlanService` is correctly hydrated at
  startup ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L188-L202)),
  its writer tools validate inputs — e.g. `plan_set_stages`
  ([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L163-L196)),
  `plan_add_stage`
  ([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L199-L218)),
  and `plan_set_current`
  ([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L237-L254))
  — and `plan_complete_stage` correctly refuses unknown stages or stages with
  no `started_at`
  ([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L262-L275)).
  If the planner had been calling these tools, the document would be in sync.
- **Today's runtime config changes** — the `runtime.continuousImprovement`
  flag, the per-role `models.*` routing, the failover list, the
  `idleShutdownMs` value, and the upstream provider config are being read and
  applied correctly. The recovery loop's continuous-improvement branch
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L673-L686))
  is firing, and the planner is in fact running continuously as intended —
  the drift is orthogonal to the run-forever decision.
- **Crash-recovery and single-instance guards** — `isAnotherInstanceRunning`
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L207))
  plus `acquireRuntimeLock`
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L212))
  prevented a double-start at the 10:17:37 restart; `recoverFromCrash`
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L215))
  ran cleanly.
- **`GET /api/plan/stages/:id`** — this endpoint reads the per-stage task
  list, summary, and report files directly out of
  [codemacs/.saivage/stages/](codemacs/.saivage/stages/) and is unaffected by
  the stale plan document
  ([saivage/src/server/server.ts](saivage/src/server/server.ts#L193-L211)).
- **Stage-scoped reviewer caching** within stage-362 (the
  `getCachedStageWorker`/`cacheStageWorker` helpers,
  [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L327-L350))
  is working — t2 reused the reviewer instance per the roster's
  `stageScoped: true` declaration
  ([saivage/src/agents/roster.ts](saivage/src/agents/roster.ts#L204)).

## Open questions

These could not be determined from static reading of the five inputs alone and
should be confirmed before remediation design begins:

1. **Did the planner ever try to call a plan-writer tool today and get a
   `PLAN_NOT_FOUND` / `STAGE_NOT_FOUND` / `STAGE_EXISTS` response that we then
   missed?** The journal grep covered both the tool names and the error codes
   and matched nothing, but the grep was scoped to `saivage.service`. If the
   in-process plan service ever surfaces errors via a different log channel
   (e.g. through `log.warn` inside `PlanService` itself), those would not be
   in the unit grep. Worth confirming by reading the planner's full
   conversation transcript for today and checking whether any
   `plan_add_stage` / `plan_set_stages` call appears in the model output
   without a corresponding journal line.

2. **Why did the planner stop calling plan-writer tools after 2026-05-11?**
   The May-11 [codemacs/.saivage/plan-history.json](codemacs/.saivage/plan-history.json)
   last entry is `stage-340-session-delete-rename-management`. Static reading
   cannot tell whether a code change, a prompt change, or a model-behavior
   change is responsible. Git log on
   [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts),
   [saivage/src/agents/planner.ts](saivage/src/agents/planner.ts), and the
   planner system prompt around May 11 would be needed to decide.

3. **Are stage-348..361 truly stages the planner intended to record, or did
   the manager invent some of them?** The dispatcher accepts any
   `managerInput.stage.id` string and `normalizeStage`
   ([saivage/src/agents/manager.ts](saivage/src/agents/manager.ts#L118-L129))
   defaults missing fields. We have not cross-referenced the 15 on-disk
   stage ids against planner conversation logs to confirm the planner is the
   author of each one.

4. **Does the chat agent's "urgent permanent note" (written at 15:08:58 to the
   planner) actually get consumed?** The recovery-loop `queuePlannerDirective`
   path ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L611-L613))
   appends to `runtime.plannerStartupDirectives`, which is spliced into the
   next planner startup
   ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L543)).
   But chat-agent notes go through `NoteManager`, not through
   `plannerStartupDirectives`. Whether a chat-written note is read by the
   planner on its next recovery iteration was not verifiable from the five
   input files.

5. **`tracker.setCurrentStage` is called from the manager dispatch case
   ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L382))
   and from the worker dispatch case
   ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L418))
   but `getCurrentStage` is also read in the planner-startup context**
   ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L544)).
   If two stages execute back-to-back, the planner's view of "current stage"
   may briefly disagree with the runtime tracker depending on dispatch
   ordering. Whether this matters for the drift, or is just a separate
   smaller concern, requires reading the planner's conversation construction
   code, which was out of scope for this round.
