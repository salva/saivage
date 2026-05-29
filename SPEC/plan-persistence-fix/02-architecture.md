# Saivage Plan-Persistence Drift — Architecture

> Round 1 architecture document for the plan-persistence-fix workstream.
> Builds on the ground truth established in [saivage/SPEC/plan-persistence-fix/01-analysis.md](saivage/SPEC/plan-persistence-fix/01-analysis.md).
> Out of scope: file-by-file change lists, ordered task breakdowns, exact
> diffs. Those belong in doc 03.

---

## 1. Overview

The drift described in [01-analysis.md](saivage/SPEC/plan-persistence-fix/01-analysis.md)
is caused by **one missing invariant** at the manager-dispatch boundary and
**two cascading consequences** of having tolerated that omission for weeks.
This design proposes a single coordinated change with three coordinated
parts:

1. **The spine — a dispatcher invariant.** Before
   [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L374-L385)
   constructs a `ManagerAgent`, it must verify that the incoming stage exists
   in the plan document and is the active `current_stage_id`. If not, the
   dispatch is rejected with a structured `PlanError`-shaped failure. This
   single gate makes "plan knows the stage" a runtime invariant that every
   downstream consumer (the manager, the worker dispatches it spawns, the
   read-paths in [saivage/src/server/server.ts](saivage/src/server/server.ts),
   the chat agent's `plan_get`) can rely on.

2. **Backfill — recover the lost history.** Independently of the live fix,
   stage-341..362 already exist on disk under
   [codemacs/.saivage/stages/](codemacs/.saivage/stages/) but were never
   recorded in [codemacs/.saivage/plan-history.json](codemacs/.saivage/plan-history.json).
   A one-shot, idempotent operator script reconstructs `CompletedStage`
   entries from each stage's `summary.json` (or, as fallback, its
   `reports/*.json`) and appends them to the embedded history.

3. **Prompt — close the behavioural loop.** Update
   `CONTINUOUS_IMPROVEMENT_PROMPT` and `RECOVERY_PROMPT` in
   [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L575-L599)
   so the precondition for `run_manager` is stated as a hard requirement
   that mirrors the new dispatcher invariant, with the exact tool sequence
   spelled out and the new error code documented so the planner can
   self-correct.

The hierarchy matters: **Fix 1 is the enforcement layer**, the spine of the
solution. Fix 2 repairs the historical damage that accumulated in its
absence. Fix 3 aligns the planner's mental model with the new contract so
the dispatcher gate fires rarely. Without Fix 1, Fix 3 is just another
prompt-level instruction with no enforcement (which is precisely what
01-analysis.md identified as the root cause —
[01-analysis.md "Why the CONTINUOUS_IMPROVEMENT_PROMPT does not save us"](saivage/SPEC/plan-persistence-fix/01-analysis.md)).

---

## 2. Fix 1 — Dispatcher invariant (the spine)

### 2.1 Contract

**Before** the dispatcher in
[saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L374-L385)
constructs a `ManagerAgent`, the following must hold:

1. `managerInput.stage?.id` is a non-empty string.
2. `runtime.planService.plan_get(...)` returns an `ActivePlanView` (not a
   `PLAN_NOT_FOUND` error) — i.e. `plan.json` has been initialised.
3. The plan's `current_stage_id` exactly equals `managerInput.stage.id`.
4. The stage with that id is present in `plan.stages` (i.e. the active
   list, not history) and has a non-null `started_at` (the same precondition
   `plan_complete_stage` already enforces in
   [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L262-L275)).

If any of these fail, the dispatcher MUST reject the dispatch *before*
calling `ManagerAgent.create`, *before* `tracker.setCurrentStage` mutates
[codemacs/.saivage/tmp/state/runtime.json](codemacs/.saivage/tmp/state/runtime.json),
and *before* any worker can be spawned.

What the contract **guarantees** to downstream code:

- `ManagerAgent.run` runs only on stages the plan knows about — so
  `normalizeStage` in
  [saivage/src/agents/manager.ts](saivage/src/agents/manager.ts#L118-L129)
  no longer silently rescues missing-id stages produced inline by the
  planner.
- The worker-dispatch normalizer at
  [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L474-L519)
  inherits the invariant: a manager that was admitted by the gate carries a
  `stage.id` that is, by construction, present in the plan, so every
  `WorkerInput.stageId` it forwards to coder/reviewer/etc. is similarly
  valid.
- Every read-path in
  [saivage/src/server/server.ts](saivage/src/server/server.ts#L188-L221)
  — `/api/plan`, `/api/state`, `/api/debug/state`, `/api/debug/timeline` —
  is guaranteed to be a consistent view: if the runtime says stage X is
  current, the plan document also says stage X is current.

### 2.2 Placement

The check belongs **inside the `case "manager":` arm** of `createChildSpawner`
([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L374-L385)),
executed before `ManagerAgent.create` is called and before
`tracker.setCurrentStage` is invoked. The natural form is a small async
helper (still inside `createChildSpawner`'s closure so it has access to
`runtime.planService`) that performs the four checks above and either
returns the validated `Stage` or throws a structured error.

We deliberately do **not** put the check in:

- `ManagerAgent.create` itself. The manager has no reason to know about
  `planService`; the roster says the manager's write-territory is
  [codemacs/.saivage/stages/](codemacs/.saivage/stages/) and only the planner
  has write access to [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json)
  (per the planner/manager entries in
  [saivage/src/agents/roster.ts](saivage/src/agents/roster.ts#L92-L111)).
  Putting plan-coupling in the manager violates that separation.
- The worker-dispatch normalizer
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L474-L519)).
  Once the manager gate holds, worker dispatches inherit a valid `stageId`
  by construction; an additional per-worker check would be defensive
  duplication. (See §2.4 for why we explicitly choose this trade-off.)
- The plan service itself. `PlanService` exposes data, not policy; adding
  an "assertCurrent" tool to the MCP surface would couple the agent
  transport to a runtime invariant.

The dispatcher is the right home because it is the single chokepoint
between "planner wrote a stage object into a tool call" and "manager begins
real work".

### 2.3 Error semantics

The dispatcher does not get to invent a new error vocabulary. It reuses the
shape and codes already defined by the plan service in
[saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L48-L54):

| Precondition that failed | Code reused / introduced | Source of truth |
| --- | --- | --- |
| `plan.json` is absent | `PLAN_NOT_FOUND` | existing, [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L48-L54) |
| Stage id is not in `plan.stages` | `STAGE_NOT_FOUND` | existing, same |
| Stage exists but is not the current one | `STAGE_MISMATCH` (new) | added to the same `PlanErrorCode` union for symmetry |
| Stage exists, is current, but `started_at` is null | reuse `VALIDATION_ERROR` with the same wording `plan_complete_stage` already uses ([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L262-L275)) | existing |

`STAGE_MISMATCH` is the one new code. It is justified because reusing
`STAGE_NOT_FOUND` would conflate "I have never heard of this stage" (the
planner skipped `plan_add_stage`) with "I have heard of this stage, but
you're not supposed to be running it right now" (the planner skipped
`plan_set_current`). The two diagnostics map to different planner-side
corrective actions (see Fix 3), so collapsing them would degrade
self-recovery.

**How the rejection propagates back to the planner.** `run_manager` is a
dispatch tool routed through the `ChildSpawner` machinery from
[saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L329-L370).
Today the spawner returns an `AgentResult`. A dispatch that is rejected
*before* an agent runs must surface as a `failure`-kind result whose
`reason` carries a structured payload `{ code, error }` matching the
`PlanError` shape — not a thrown exception that crashes the planner's
tool-call turn. The planner's `runLoop` then receives this as a normal
failed tool result, exactly as it would receive a `plan_add_stage`
rejection today, and the prompt update from Fix 3 teaches it the corrective
sequence.

### 2.4 Why not also enforce on worker dispatch?

The dispatcher's worker branch
([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L388-L420)
plus the normalizer at
[saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L474-L519)) already validates
that `stageId` is a non-empty trimmed string. We recommend **not** adding a
plan-existence check there, for three reasons:

1. **Inheritance.** Workers are only ever spawned from inside a running
   `ManagerAgent`. If the gate at the manager arm holds, the worker's
   `stageId` is, by construction, the same id the manager was admitted for.
   A second check would never fail in normal flow.
2. **Latency.** Worker dispatches happen many times per stage (one per
   task plus reviewer iterations); the plan-service call has to acquire
   the `opQueue` shared by every other plan operation
   (see [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L71)). The
   gate cost belongs at the once-per-stage manager boundary, not in every
   task spawn.
3. **Failure mode preference.** If a manager somehow forged a `stageId`
   mid-run (which it cannot today —
   [saivage/src/agents/manager.ts](saivage/src/agents/manager.ts#L118-L129) only fixes up
   missing fields, it doesn't invent ids), we'd rather catch it during
   stage-summary write or `plan_complete_stage` than late inside worker
   plumbing.

We do, however, leave a single defensive log line in the worker normalizer
("stageId not found in plan; possible upstream bug") rather than a hard
reject, so that drift, if it ever recurs, becomes immediately visible
without crashing live workers.

### 2.5 Test strategy outline

- **Unit (dispatcher gate):** with a stub `PlanService` returning a fixture
  doc, exercise the four pass cases (stage present + current + started; the
  legitimate happy path) and the four fail cases (no doc; unknown id;
  known-but-not-current id; current-but-not-started). Assert each fail case
  produces an `AgentResult` of kind `failure` whose payload carries the
  expected `code`. Assert no side effects on `tracker.setCurrentStage` for
  fail cases.
- **Unit (error code carry-through):** verify the planner-side
  `ChildSpawner` consumer sees the structured `{code,error}` object inside
  the failure reason and that the new `STAGE_MISMATCH` code is exposed in
  the dispatch-tool's schema docs.
- **Integration (full agent loop, mocked LLM):** scripted planner that
  emits `run_manager(stage)` *without* a preceding `plan_add_stage` /
  `plan_set_current`. Assert the manager is never constructed, no stage
  directory is created under [codemacs/.saivage/stages/](codemacs/.saivage/stages/),
  and the planner conversation receives a `STAGE_MISMATCH` (or
  `STAGE_NOT_FOUND`) failure.
- **Integration (regression on happy path):** scripted planner that does
  the right sequence — `plan_add_stage`, `plan_set_current`, `run_manager`
  — confirming the gate is invisible to compliant behaviour, including the
  reviewer-rerun and stage-scoped worker caching paths from
  [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L388-L420).
- **E2E smoke:** boot the runtime against a temp `.saivage` directory,
  let the planner dispatch one stage end-to-end, confirm
  [codemacs/.saivage/plan.json](codemacs/.saivage/plan.json) and
  [codemacs/.saivage/tmp/state/runtime.json](codemacs/.saivage/tmp/state/runtime.json)
  agree on `current_stage_id` at every observable transition.

---

## 3. Fix 2 — History replay (backfill stage-341..362)

### 3.1 Contract

A one-shot, idempotent operator script reconstructs the missing
`CompletedStage` entries from on-disk artefacts and appends them to
[codemacs/.saivage/plan-history.json](codemacs/.saivage/plan-history.json)
(which is the embedded `history` field of the same `PlanDocument`, exposed
as the `PlanHistoryView` constructed by `historyView` in
[saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L114-L116)).

**Inputs.** Each stage directory under
[codemacs/.saivage/stages/](codemacs/.saivage/stages/) whose id does not
already appear in either `plan.stages` or `plan.history`.

**Primary source per stage.** `summary.json` (the same `StageSummary` shape
the manager writes per
[saivage/src/agents/manager.ts](saivage/src/agents/manager.ts#L156-L168)) — fields
`stage_id`, `result`, `summary`, `started_at`, `completed_at`,
`outcomes_achieved`, `escalation?`, `abort_reason?` map straight onto
`CompletedStage` per the `plan_complete_stage` synthesis in
[saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L262-L286).

**Fallback source per stage.** If `summary.json` is missing, infer from
`tasks.json` (start time → earliest task `created_at`; objective →
`tasks.json.stage_id`-derived) plus the latest mtime across `reports/*.json`
(end time). Mark such entries with `summary: "[backfilled from reports;
no manager summary written]"` and `result: "completed"` only if every
report's `status === "completed"`, otherwise `"failed"`. Stages with neither
`summary.json` nor any `reports/*.json` are presumed mid-flight and **not**
backfilled.

**Output guarantees.**

- Output is a deterministic, time-ordered append to the existing `history`
  array (ordered by `completed_at`, falling back to lexicographic stage id
  when timestamps tie or are inferred — this addresses the
  "stage numbers don't always match start-time order" edge case).
- Re-running the script is a no-op: stages already in `history` are
  skipped by id.
- The script writes through `PlanService` rather than directly touching
  `plan.json`, so it inherits the atomic tmp-rename guarantees of
  `writeDoc` ([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L118-L121))
  and respects the in-memory cache.

### 3.2 Placement — script vs MCP tool vs HTTP endpoint

We recommend **operator script under `saivage/scripts/`**, run offline
against a stopped runtime. The three options ranked:

| Option | Pros | Cons | Verdict |
| --- | --- | --- | --- |
| **CLI script under `saivage/scripts/`** | Runs against the lock-free disk; can be re-run from any host; no live concurrency to coordinate; uses existing `PlanService` programmatically the same way `bootstrap.ts` does in [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L188-L202). | Requires runtime to be stopped (or to be safely run during shutdown). | **Chosen.** |
| New MCP tool (`plan_backfill_from_disk`) | Operates inside the running PlanService; uses the `opQueue` for serialisation. | Adds a permanent admin-only tool to the public agent surface for what is a one-shot operator action; expands the writer-tool set the planner can call by mistake. | Rejected — surface bloat for a one-shot. |
| HTTP admin endpoint | Discoverable from the dashboard. | Requires authn/authz design we don't have; same surface-bloat objection. | Rejected. |

The script acquires the runtime lock via the same
`acquireRuntimeLock(project.saivageDir)` path the bootstrap uses in
[saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L207-L213). If the lock
is held (i.e. the daemon is up), the script refuses to run and prints the
PID. Operators must `systemctl stop saivage.service` first. This sidesteps
all live-concurrency questions.

### 3.3 Idempotency model

The script's correctness predicate is: **for every stage directory `S` on
disk that has a `summary.json` or a complete `reports/` set, exactly one
`CompletedStage` entry with `id === S` exists in `plan.history` after the
script runs, regardless of how many times the script runs.**

Design properties (not an ordered implementation outline — file-level
ordering and the actual code go in doc 03):

- The script's view of "already-known stage ids" is the union of the live
  `plan.stages` set and the existing `plan.history` set; both are read
  through `PlanService` so the in-memory cache stays authoritative.
- The script only appends to `plan.history`; it never mutates existing
  entries (see edge cases in §3.4 for duplicate-id handling).
- Append order is fixed by the sort key `(completed_at, id)` defined in
  the contract (§3.1); this makes the produced suffix of `plan.history`
  deterministic across runs and machines.
- The full write goes through `writeDoc`
  ([saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L118-L121))
  so a crash mid-write leaves the on-disk plan in a consistent state and
  the next run resumes correctly.

### 3.4 Edge cases

- **No `summary.json`, partial `reports/`.** Some reports completed,
  others missing or `status=failed`. Treat the stage as `failed` with
  `summary: "[backfilled; N of M tasks completed, no manager summary]"`.
  `outcomes_achieved` is empty (we cannot infer them).
- **Empty stage directory (no `tasks.json`, no `reports/`).** Skip
  entirely — looks like an aborted-before-start artefact.
- **Stage present in BOTH `plan.stages` and on disk.** Means a stage was
  started, recorded with `plan_add_stage`/`plan_set_current`, but
  `plan_complete_stage` was never called. Out of scope for this script
  (the live runtime will close it when it next picks up). Log and skip.
- **Stage id already present in history.** Treated as a hard duplicate:
  the script skips the new candidate and emits a warning. It does **not**
  overwrite, merge, or amend existing history entries under any
  circumstance — historical records are immutable. The dry-run output
  flags any duplicates so operators can decide whether to investigate
  before `--apply`.
- **Stage id present in history with different `result`.** Same handling
  as the duplicate case above; this is the specialisation that surfaces
  the data-integrity question rather than a silent no-op.
- **Out-of-order stage numbers.** The 01-analysis evidence lists ids
  `stage-348..362` chronologically but the symptom report also mentioned
  stages whose number does not match start time. Ordering is by
  `(completed_at, id)`, which is robust to that.

### 3.5 Validation / dry-run

The script supports `--dry-run` as a first-class mode (and we recommend
making it the *default*, requiring `--apply` to actually write). Dry-run:

- Prints the proposed appended entries in JSON-Lines form to stdout.
- Prints the resulting history-tail count.
- Computes a SHA-256 over the proposed `history` array so operators can
  diff two dry-runs and verify determinism.
- Exits non-zero if any anomalies were detected (missing summary +
  incomplete reports, duplicate ids, etc.) so CI gating is possible.

Apply mode writes through `PlanService` (atomic tmp+rename per
[saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L118-L121)) and
prints a final `sha256` of the written `plan.json` for audit.

### 3.6 Test strategy outline

- **Unit (synthesis):** golden-file tests on fixture `summary.json` files
  drawn from [codemacs/.saivage/stages/stage-362-...](codemacs/.saivage/stages/) —
  assert the synthesized `CompletedStage` validates against
  `CompletedStageSchema` (the same one `plan_complete_stage` uses, see
  [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L262-L290)).
- **Unit (fallback):** fixture stage dir with no `summary.json` and a
  mixed `reports/` set; assert correct `result` classification and
  `summary` wording.
- **Unit (idempotency):** run the script twice against the same fixture
  workspace; assert second run is a no-op and the resulting `plan.json` is
  byte-identical (or at least `history`-equal — `updated_at` may change).
- **Unit (ordering determinism):** shuffle on-disk mtimes; assert sort key
  guarantees stable order across runs.
- **Integration (lock interlock):** start a stub runtime that holds the
  lock; assert the script refuses to run.
- **E2E (replay against today's drift):** point the script at a copy of
  [codemacs/.saivage/](codemacs/.saivage/) on a scratch path, run
  `--dry-run`, eyeball-verify the proposed 21+ entries match the
  on-disk evidence enumerated in
  [01-analysis.md "Runtime is in fact executing stage-362 today"](saivage/SPEC/plan-persistence-fix/01-analysis.md);
  then `--apply` and confirm `/api/plan` returns the recovered view.

---

## 4. Fix 3 — Planner prompt update

### 4.1 Contract

Update `CONTINUOUS_IMPROVEMENT_PROMPT` and `RECOVERY_PROMPT` in
[saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L575-L599)
so that the precondition for `run_manager` is stated as a **hard runtime
requirement**, not a soft instruction. The contract the prompt must convey:

1. The exact, ordered tool sequence required for any stage execution:
   `plan_add_stage` → `plan_set_current` → `run_manager` →
   `plan_complete_stage`.
2. Explicit mention that the dispatcher will reject `run_manager` with
   `STAGE_MISMATCH` / `STAGE_NOT_FOUND` / `PLAN_NOT_FOUND` if the
   sequence is violated.
3. A self-recovery clause: on receiving such a rejection, do not
   re-dispatch the same stage; instead, run the missing precondition tool
   and retry.

The prompt update does not change tool behaviour or the planner agent's
code; it changes only the natural-language directive injected via
`queuePlannerDirective` ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L611-L613)).

### 4.2 Phrasing changes (qualitative — exact diff is doc 03's job)

The existing `CONTINUOUS_IMPROVEMENT_PROMPT` at
[saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L587-L599) already
contains step 6 ("Create at least one concrete, bounded next stage with
`plan_add_stage()` or `plan_set_stages()`") and step 7 ("Dispatch the next
stage with `run_manager()`"). The qualitative changes:

- **Promote the sequence to a named precondition block** above the
  numbered cycle (e.g. a "Plan-mutation contract" header), so it is
  visually separated from the heuristics about ML workflow and data
  quality. Today it reads as one bullet among seven; it must read as
  a non-negotiable.
- **Insert `plan_set_current` explicitly** between `plan_add_stage` and
  `run_manager`. The current text omits `plan_set_current` entirely —
  yet without it, `plan_complete_stage` will reject the stage at
  end-of-run because `started_at` is null (see
  [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L262-L275)).
  This is the single most important phrasing fix and is independent of
  Fix 1.
- **Add a worked example** showing the four-call sequence as a single
  coherent block, immediately under the contract header.
- **Add an error-handling clause** ("If `run_manager` returns
  `STAGE_MISMATCH` or `STAGE_NOT_FOUND`, the dispatcher is telling you
  that `plan_add_stage` or `plan_set_current` was skipped — run the
  missing call and retry; do not escalate.") This is the bridge to
  Fix 1's structured errors.
- **Apply the identical contract block to `RECOVERY_PROMPT`** at
  [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L575-L585).
  Recovery currently says "Call `plan_set_current()` on the next stage
  and dispatch it with `run_manager()`" but never mentions
  `plan_add_stage` for new stages — fine for a stage recovered from
  `plan.stages`, ambiguous for a planner that decides recovery requires
  inventing a corrective stage.

### 4.3 Interaction with existing prompt structure

Both prompts already begin with "Call `plan_get()` to read the current
plan state" / "Call `plan_get_history()` to see what stages have
completed" ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L575-L599)).
The new precondition block sits *after* those read calls and *before* the
heuristics about next-stage selection. Concretely:

1. Read (`plan_get`, `plan_get_history`) — existing.
2. **New: precondition contract block (plan-mutation sequence + error
   recovery clause).**
3. Strategic heuristics (data-quality assessment, research→data→eval
   cycle) — existing.
4. Concrete next-step instruction ("Create at least one concrete,
   bounded next stage…") — existing, now references the contract block
   above for the exact sequence.
5. Terminal clause (`plan_done` rules) — existing.

This ordering means: read → know-the-rules → think → act. Today's prompts
are read → think → act with the rules embedded inside the "act" step,
which is too late.

The interaction with the existing eagerly-loaded role prompt
([saivage/src/agents/planner.ts](saivage/src/agents/planner.ts#L37-L46)) is benign:
that role prompt is a system message describing *what the planner is*; the
directive injected via `plannerStartupDirectives` is a *user-channel*
runtime instruction. They do not overlap.

### 4.4 Should the prompt teach self-correction?

**Yes — and the recommended phrasing is in §4.2's "error-handling
clause" above.** Without it, a dispatcher rejection becomes a tool error
that the planner's `runLoop` (see [saivage/src/agents/planner.ts](saivage/src/agents/planner.ts#L72-L101))
will surface as a normal nudge, and the planner may interpret it as a
plan-service bug, attempt unrelated corrective work, or escalate. With it,
the planner has an unambiguous recipe: "rejection X means missing tool Y;
call Y and retry." This is the difference between an invariant that
mostly works (Fix 1 alone) and a system that self-heals around the
invariant (Fix 1 + Fix 3).

### 4.5 Test strategy outline

- **Snapshot test** on the two prompt strings to catch accidental
  regressions. (We're treating these prompts as part of the public
  contract now.)
- **Behavioural test against a recorded LLM** (or a deterministic stub
  that pattern-matches the prompt): inject the new prompt, assert the
  model's first three tool calls under both `RECOVERY_PROMPT` and
  `CONTINUOUS_IMPROVEMENT_PROMPT` follow the
  `plan_add_stage`→`plan_set_current`→`run_manager` order.
- **Self-correction test:** stub the dispatcher to return a
  `STAGE_MISMATCH` failure on the first `run_manager`; assert the
  planner's *next* tool call is `plan_set_current` (or `plan_add_stage`
  if the stage is also absent), not a duplicate `run_manager` or a
  `plan_done`.
- **Negative test for `plan_init` re-entry:** the existing prompt
  already says "DO NOT call `plan_init()`" in continuous-improvement
  mode ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L587-L599));
  confirm the new precondition block does not accidentally re-enable
  it.

---

## 5. Cross-cutting concerns

### 5.1 Ordering of the three fixes

The fixes can ship independently but the **safe deployment order** is:

1. **Fix 3 first (prompt only, lowest risk).** Adding `plan_set_current`
   to the prompt sequence and the worked example may already reduce
   the drift rate in production before any code lands.
2. **Fix 2 second (offline backfill).** Run against a stopped runtime
   to recover the lost history. Now consumers of `/api/plan`,
   `/api/state`, `/api/debug/timeline`, and the planner's own
   `plan_get_history()` see a coherent view, and the planner restarted
   after Fix 2 will no longer be told "last result: stage-340" — which
   is the feedback loop 01-analysis.md identifies in its "Planner
   recovery prompts" entry under blast radius.
3. **Fix 1 last (the gate).** With history backfilled and the planner
   already biased toward the correct sequence by Fix 3, the gate
   should fire rarely on the first deploy. Shipping it last minimises
   the chance of cascading rejections on a planner still operating off
   the old prompt.

Each fix is independently valuable; this is a recommended ordering, not a
hard dependency chain.

### 5.2 Dependencies

- Fix 1 *uses* the same `PlanService` API Fix 2 uses, but neither fix
  modifies that API. The only shared change is the new `STAGE_MISMATCH`
  error code, owned by Fix 1.
- Fix 2 has no code-level dependency on Fix 1; it operates on disk while
  the runtime is stopped.
- Fix 3 has no code-level dependency on either, but its error-handling
  clause is *meaningless* until Fix 1 ships (the dispatcher won't emit
  `STAGE_MISMATCH` until then). It's still harmless to ship early.

### 5.3 Runtime restart implications

- **Fix 1** changes a hot path. It must be deployed via the normal
  runtime restart (no special migration). The single-instance guard
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L207-L213))
  ensures a clean handoff.
- **Fix 2** requires the runtime to be stopped (see §3.2). Deployment
  flow: stop runtime → run `--dry-run` → review → run `--apply` →
  restart runtime. The `recoverFromCrash` pass at startup
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L215-L221)) will
  observe the updated `plan.json` and proceed normally.
- **Fix 3** takes effect on the next planner restart because the
  directive is read at planner-create time via `plannerStartupDirectives`.
  In a long-running session, operators can force this via
  `plannerControl.requestRestart` already exposed at
  [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L83-L107).

### 5.4 Observability

We add the minimum needed to detect recurrence:

- **Log line on every dispatcher gate rejection**, including the
  rejection code, the offending stage id, and the planner agent id. This
  is the journal pattern the next "is the drift back?" investigation
  will grep for, mirroring the journal-grep methodology in
  [01-analysis.md "No plan-mutation MCP tool has been invoked"](saivage/SPEC/plan-persistence-fix/01-analysis.md).
- **`plan_updated` event on the existing `EventBus`** when the gate
  fires (so the dashboard's timeline shows the rejection alongside
  legitimate stage transitions). The event bus is already used for
  `plan_updated` summaries in `runPlannerWithRecovery`
  ([saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L670-L690));
  this slot in.
- **One-time INFO log on script completion** for Fix 2, recording the
  number of stages backfilled and the resulting history length.

No new metrics infrastructure, no new dashboards. Existing primitives
suffice.

### 5.5 Rollback story

- **Fix 1 rollback** = revert the dispatcher diff. The plan service is
  unchanged, the worker normalizer is unchanged, the runtime tracker is
  unchanged. Single-file revert restores prior behaviour. The new
  `STAGE_MISMATCH` code becomes dead code if not referenced, harmless.
- **Fix 2 rollback** = the script writes history *append-only*. If the
  appended entries are wrong, manually edit `plan.json` to truncate the
  `history` array, or restore from a git snapshot (the operator script
  should commit `plan.json` to git as its final step via the existing
  `plan_commit` path, [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts)).
- **Fix 3 rollback** = revert the two prompt constants. Effective on
  next planner restart.

All three fixes are individually reversible without data loss.

---

## 6. Open questions from 01-analysis.md — disposition

| # from 01-analysis | Question (summarised) | Disposition |
| --- | --- | --- |
| 1 | Did the planner try to call a plan-writer tool today and get an error we missed? | **Out of scope (needs runtime investigation).** This design is robust either way — the dispatcher gate fires regardless of whether prior silent failures occurred. Confirming the journal-grep was complete is a debugging task for whoever runs the backfill (Fix 2) in dry-run mode and notices anomalies. |
| 2 | Why did the planner stop calling plan-writer tools after 2026-05-11? | **Out of scope (needs runtime/git investigation).** The architecture deliberately does not depend on knowing the answer: Fix 1 enforces the invariant whatever the cause, Fix 3 closes the prompt-level loop whatever the cause. A git-blame on the prompt constants and the planner system prompt should still happen, but it does not block this design. |
| 3 | Are stage-348..361 truly the planner's intended stages, or did the manager invent some? | **Answered by this design (defensively).** Fix 1 makes "did the planner intend this stage" a runtime-enforceable property going forward. Fix 2 treats every on-disk stage as legitimate-by-evidence (has a summary or has reports) — if a manager invented one, it is recorded in history as a completed-by-evidence stage, which is the conservative, no-data-loss choice. A definitive "who authored stage-X" answer requires conversation-log analysis and is deferred. |
| 4 | Does the chat agent's "urgent permanent note" actually get consumed? | **Deferred to doc 03 (and possibly a separate workstream).** Unrelated to the dispatcher-invariant root cause; Fix 1 + Fix 3 obsolete the *need* for that note. |
| 5 | `tracker.setCurrentStage` (manager + worker dispatch) vs `tracker.getCurrentStage` (planner-startup context) — transient disagreement risk. | **Answered by this design.** Fix 1's gate runs *before* `tracker.setCurrentStage` is called in the manager arm at [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L382), so the tracker can no longer advance to a stage the plan does not know about. Worker dispatches at [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L418) only run downstream of an admitted manager, so they inherit the same property. The planner-startup `tracker.getCurrentStage()` read at [saivage/src/server/bootstrap.ts](saivage/src/server/bootstrap.ts#L544) is therefore consistent with the plan document. The narrower "is there a transient window between gate-pass and tracker-write where things look inconsistent" question is itemised as a new open question in §7 (see item 5 there). |

---

## 7. Open questions raised by this design

1. **`STAGE_MISMATCH` vocabulary placement — resolved.** Per §2.3, the new
   code is added to the shared `PlanErrorCode` union in
   [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L48-L54)
   for symmetry, so every consumer has one place to look up codes. (No
   longer an open question.)
2. **Should the gate also fire on `inspector` / `librarian`
   dispatches?** Today only `manager` constructs a real stage; inspector
   and librarian operate without a `stageId`. If a future role acquires
   a `stageId`, do we revisit the gate placement? Recommend a code
   comment marking the gate as "manager-only by current roster" with a
   pointer to [saivage/src/agents/roster.ts](saivage/src/agents/roster.ts).
3. **Fix 2's handling of `aborted` stages.** If a stage directory has a
   `summary.json` with `result: "aborted"`, do we record it in history
   (it's a legitimate terminal state per
   [saivage/src/mcp/plan-server.ts](saivage/src/mcp/plan-server.ts#L254-L275))
   or skip it? Recommend record-with-warning; flagging here in case
   the reviewer disagrees.
4. **Dashboard impact of the new gate-rejection events.** The
   `plan_updated` event on rejection will appear in the timeline. Do we
   want a distinct event type (`plan_dispatch_rejected`) or is reusing
   `plan_updated` with a descriptive `summary` enough? Leaning toward
   reuse for now (no schema churn).
5. **Should Fix 1 also cover the `tracker.setCurrentStage` write?** The
   gate prevents bad dispatches but the runtime tracker is updated
   *after* `ManagerAgent.create` succeeds. If `ManagerAgent.create`
   throws between the gate and the tracker write, we leave a transient
   inconsistency. Probably fine (tracker is best-effort), but worth a
   second look during implementation.
