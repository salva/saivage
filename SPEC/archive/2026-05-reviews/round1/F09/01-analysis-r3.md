# F09 — Functional analysis (R3)

## Changes from r2

Reviewer feedback in [04-review-r2.md](04-review-r2.md) flagged two remaining stale schema line references. Both are corrected here; no other content changed.

- **Reviewer required change 1a**: `TaskReportSchema.agent` link in §2.2 corrected from `types.ts L164` → [types.ts L160](../../../../src/types.ts#L160) (the `agent` enum sits on line 160; line 164 is `checklist_results`).
- **Reviewer required change 1b**: `TaskReportSchema` link in §5 corrected from `types.ts L161` → [types.ts L157](../../../../src/types.ts#L157) (the schema object literal begins on line 157, not on the field-list-opening brace).
- Re-verified all other `types.ts` references in this document (`TaskSchema` L106, `TaskSchema.type` L108, `TaskSchema.assigned_to` L109). They are correct and unchanged.

## Changes from r1

Reviewer feedback in [04-review-r1.md](04-review-r1.md) flagged stale file:line references. All line numbers in this r2 were re-verified by reading the source files directly.

- **Reviewer item 1 (stale refs)**: accepted. Corrected `parseTaskReport` line numbers (r1 had coder L257 / researcher L253 / data-agent L170; actual L263 / L260 / L176). Corrected `BaseAgent` terminal assistant-push reference (r1 said `base.ts ~L240`; actual L269). Corrected reviewer double-push reference (r1 said L122; actual L121). Corrected the `TaskSchema.type` / `assigned_to` line refs (r1 said L106 / L107; actual L108 / L109). Corrected `AgentRole` / `AgentResult` ranges. Also corrected inspector helper refs the reviewer themselves listed incorrectly (reviewer said inspector L207 / L237; actual L185 / L219) — flagged in §1 below with concrete evidence.
- **Reviewer item 2 (Proposal C reviewer-run semantics)**: addressed in [02-design-r2.md](02-design-r2.md). Analysis §2.5 still documents the current `run()`→`review()` delegation pattern as a behavioural fact that the refactor must preserve.
- **Reviewer item 3 (validation skill misattribution)**: addressed in [03-plan-r2.md](03-plan-r2.md). No analysis change.

## 1. Concrete duplication

Three helpers are reimplemented as module-private functions inside every worker-style agent file. All exact line refs verified against current `src/`:

| Helper | coder | researcher | data-agent | reviewer | designer (orphan) |
| --- | --- | --- | --- | --- | --- |
| `normalizeTask(raw: any): Task` | [coder.ts L212](../../../../src/agents/coder.ts#L212) | [researcher.ts L208](../../../../src/agents/researcher.ts#L208) | [data-agent.ts L125](../../../../src/agents/data-agent.ts#L125) | [reviewer.ts L148](../../../../src/agents/reviewer.ts#L148) | [designer.ts L142](../../../../src/agents/designer.ts#L142) |
| `parseTaskReport(text, input, startedAt, startMs): TaskReport` | [coder.ts L263](../../../../src/agents/coder.ts#L263) | [researcher.ts L260](../../../../src/agents/researcher.ts#L260) | [data-agent.ts L176](../../../../src/agents/data-agent.ts#L176) | [reviewer.ts L206](../../../../src/agents/reviewer.ts#L206) | [designer.ts L191](../../../../src/agents/designer.ts#L191) |
| `buildFailureReport(input, startedAt, startMs, reason): TaskReport` | [coder.ts L319](../../../../src/agents/coder.ts#L319) | [researcher.ts L313](../../../../src/agents/researcher.ts#L313) | [data-agent.ts L229](../../../../src/agents/data-agent.ts#L229) | [reviewer.ts L259](../../../../src/agents/reviewer.ts#L259) | [designer.ts L244](../../../../src/agents/designer.ts#L244) |

Per-worker LOC tied to these helpers (function bodies plus the per-agent message builder is excluded — that one is genuinely role-specific):

- `normalizeTask` body: ~28 lines, identical structurally in all 5 files.
- `parseTaskReport` body: ~50 lines (success path) + ~17 lines (fallback) = ~67 lines.
- `buildFailureReport` body: ~22 lines.
- Per file: ~117 lines of duplicated logic; across 5 files: ~585 lines. The issue text's "~750 lines" estimate also folded in the near-identical `run()` skeleton (try/catch, finishReason switch, log line) — see §4 below; that estimate is roughly correct if `run()` is also unified.

Reviewer additionally duplicates a one-line wrapper `normalizeWorkerInput` at [reviewer.ts L143](../../../../src/agents/reviewer.ts#L143) that exists nowhere else.

Inspector uses sibling helpers `normalizeInspectionRequest` at [inspector.ts L185](../../../../src/agents/inspector.ts#L185) and `parseInspectionReport` at [inspector.ts L219](../../../../src/agents/inspector.ts#L219) over the `InspectionRequest` / `InspectionReport` schemas. Same pattern, different schema — not consolidated with the worker five. (Reviewer cited L207 / L237 for these; that disagrees with the actual source — verified by `sed -n` over `src/agents/inspector.ts`. The correct lines are L185 / L219.)

## 2. Actual semantic differences between copies

The five worker copies are **not bit-identical**. Differences that matter for the refactor:

### 2.1 `normalizeTask` defaults that differ per file

| Field default | coder | researcher | data-agent | reviewer | designer |
| --- | --- | --- | --- | --- | --- |
| `type` fallback | `"code"` | `"research"` | `"data"` | `"review"` | `"design"` |
| `assigned_to` fallback | `"coder"` | `"researcher"` | `"data_agent"` | `"reviewer"` | `"designer"` |

`"design"` is not in `TaskSchema.type` ([types.ts L108](../../../../src/types.ts#L108) — enum is `code|research|data|review|test|document`) and `"designer"` is not in `TaskSchema.assigned_to` ([types.ts L109](../../../../src/types.ts#L109) — enum is `coder|researcher|data_agent|reviewer`). Designer's copy produces schema-invalid tasks; this is consistent with F01 calling designer an orphan but worth noting: validation never catches it because `normalizeTask` returns the object cast to `Task` without re-parsing through Zod.

### 2.2 `parseTaskReport` `agent` literal differs per file

Each copy hardcodes its own `agent: "coder" | "researcher" | "data_agent" | "reviewer" | "designer"` literal in both the parsed-success path and the fallback path. `"designer"` again is outside the `TaskReportSchema.agent` enum at [types.ts L160](../../../../src/types.ts#L160).

### 2.3 `buildFailureReport.issues_found` drift

Two distinct shapes in the wild:

- Empty: `issues_found: []` — [coder.ts L335](../../../../src/agents/coder.ts#L335), [researcher.ts L329](../../../../src/agents/researcher.ts#L329).
- Single error issue: `issues_found: [{ severity: "error", description: reason }]` — [data-agent.ts L249](../../../../src/agents/data-agent.ts#L249), [reviewer.ts L279](../../../../src/agents/reviewer.ts#L279), [designer.ts L264](../../../../src/agents/designer.ts#L264).

This is real drift, not stylistic: a Manager aggregating worker reports into `StageSummary` will see a failure issue from a failed Data Agent but not from a failed Coder. The "with issue" variant is the correct one — a failed task should surface its failure as an issue. Consolidation must pick one (recommendation: keep the issue) and apply it uniformly.

### 2.4 `parseTaskReport` parse-failure path always succeeds

All five copies swallow `JSON.parse` errors and silently produce `status: "completed"` with `summary: text.slice(0, 1000)`. This is the F03 problem and is out of F09's scope, but the F09 refactor removes 5 places to fix it down to 1.

### 2.5 `run()` skeleton near-duplicate

Each worker `run()` (coder, researcher, data-agent, reviewer, designer) is nearly identical:

1. `log.info("[role:id] Starting task ...")`,
2. `startedAt = ISO`, `start = Date.now()`,
3. `try { const { text, finishReason } = await this.runLoop(); }`,
4. branch on `finishReason in {abort, cancelled} → AgentResult kind: "abort"`,
5. branch on `finishReason in {max_compactions, error} → kind: "failure"`,
6. else `return { kind: "success", data: parseTaskReport(...) }`,
7. catch `err → kind: "failure"` with `buildFailureReport`.

Reviewer differs in two ways that matter, and these are behavioural facts the refactor must preserve:

- `ReviewerAgent.run()` at [reviewer.ts L102-L104](../../../../src/agents/reviewer.ts#L102-L104) is a one-line delegate that calls `this.review(this.input)`. `review()` at [reviewer.ts L106](../../../../src/agents/reviewer.ts#L106) owns the same try/catch/finishReason switch as the other workers, but additionally: re-normalises `input` on each call, increments `reviewCount`, and (for `reviewCount > 0`) injects a follow-up user message via `injectMessage`. The manager loop calls `reviewer.review(input)` directly on subsequent reviews — see the dispatch at [bootstrap.ts L372-L374](../../../../src/server/bootstrap.ts#L372-L374) which uses `agent.review(...)` when the agent is a `ReviewerAgent`.
- After `runLoop()` returns, `review()` manually pushes the assistant turn with `this.messages.push({ role: "assistant", content: text })` at [reviewer.ts L121](../../../../src/agents/reviewer.ts#L121). This duplicates what `BaseAgent.runLoop()` already did at [base.ts L269](../../../../src/agents/base.ts#L269) (the terminal "no tool calls" branch calls `this.pushMessage({ role: "assistant", content: assistantContent }, ...)`). Reviewer therefore stores two trailing assistant turns per review. This is the bug flagged in the subsystem map / F14; F09 fixes it as a side-effect because the unified worker base class owns the post-loop bookkeeping in one place and there is no reason to repeat it in `review()`.

Designer has no `assigned_to` route, no constructor in the dispatcher map; only its file existence keeps it linked into anything. Per F01 it is dead — confirmed by `grep -rnE "designer|DesignerAgent" src/ --include="*.ts"` returning no live references outside `src/agents/designer.ts` itself.

### 2.6 `validateFinalResponse` is per-agent

Each worker overrides `validateFinalResponse` with the same shape — `if (this.hasUsedAnyTool()) return null;` then a role-specific string. Coder says "Invalid final task response", researcher "Invalid final task response", data-agent "Invalid final task response", reviewer "Invalid final review response". These are real per-role copy. They belong with the role, not in the shared helper.

## 3. Contract these helpers serve

### `normalizeTask(raw)`

- **Input**: an arbitrary object the Manager LLM emitted into a `task` field. Field names are not validated — the LLM may write `objective` instead of `description`, `acceptance_criteria` instead of `checklist`, or omit fields entirely.
- **Output**: a `Task` ([types.ts L106](../../../../src/types.ts#L106)) safe enough for downstream use. Currently NOT re-validated against `TaskSchema`.
- **Tolerated alternates**: `description ↔ objective`, `checklist ↔ acceptance_criteria` (latter elements coerced to `{description: str, required: true}`), missing `id/type/assigned_to/status/tags/attempt/max_attempts` defaulted.
- **Side-effect on `description`**: appends `Suggested files or starting points:` (from `raw.files`) and `Detailed instructions from Manager:` (from `raw.instructions`) into the description string. This is a prompt-shaping concern, not pure normalisation — but it lives in `normalizeTask` because the constructed description feeds the initial user message.
- **Error modes**: none; the function never throws. Invalid input becomes a degraded Task with `id: "unknown"`, `description: "(no description)"`, etc.

### `parseTaskReport(text, input, startedAt, startMs)`

- **Input**: final LLM response text, the original worker input, timing.
- **Output**: a `TaskReport`. If text contains a `{...}` substring matching `/\{[\s\S]*\}/`, attempts `JSON.parse`; otherwise falls back. The success path overlays parsed fields onto defaults; the fallback synthesises `status: "completed"` with `summary: text.slice(0, 1000)`.
- **Error modes**: none surfaced; parse failures silently degrade to the fallback path. F03 is the issue covering this.
- **Constants in the contract**: `summary` is truncated to 500 chars in the success path and 1000 chars in the fallback. `agent` field is the role literal.

### `buildFailureReport(input, startedAt, startMs, reason)`

- **Input**: worker input, timing, a free-text reason.
- **Output**: a `TaskReport` with `status: "failed"`, `failure_reason: reason`, `summary: "Task failed: ${reason}"`, empty arrays for all enumerations.
- **Variance**: `issues_found` — see 2.3.
- **Error modes**: none.

## 4. Call sites and lifecycle

`agent.run()` is invoked from one place — the worker-dispatch switch in `bootstrap.ts`:

- [bootstrap.ts L306](../../../../src/server/bootstrap.ts#L306) `new CoderAgent(ctx, workerInput, ...)`
- [bootstrap.ts L316](../../../../src/server/bootstrap.ts#L316) `new ResearcherAgent(...)`
- [bootstrap.ts L326](../../../../src/server/bootstrap.ts#L326) `new DataAgent(...)`
- [bootstrap.ts L346](../../../../src/server/bootstrap.ts#L346) `new ReviewerAgent(...)` (manager loop later calls `reviewer.review(input)` directly via the dispatch at [bootstrap.ts L372-L374](../../../../src/server/bootstrap.ts#L372-L374))
- [bootstrap.ts L358](../../../../src/server/bootstrap.ts#L358) `new InspectorAgent(...)`
- [cli.ts L271](../../../../src/server/cli.ts#L271) `new InspectorAgent(ctx, { request })` — standalone inspector command.

No external code imports `normalizeTask`/`parseTaskReport`/`buildFailureReport`; all three are module-private. The refactor surface is entirely inside `src/agents/`.

Worker lifecycle, per agent instance:

1. `bootstrap` constructs `new <Role>Agent(ctx, workerInput, { childSpawner, abortSignal, onActivity })`.
2. Constructor: `normalizeTask(input.task)` → build initial user message → `super(ctx, { systemPrompt, skillContext, initialMessage, ...config })`.
3. `BaseAgent` constructor resolves skills, sets compaction config, registers child spawner with dispatcher, pushes the initial user message.
4. Bootstrap calls `await agent.run()` (or `await agent.review(input)` for reviewer follow-ups).
5. `run()` calls `await this.runLoop()` (in `BaseAgent`), which does the LLM/tool/compact loop until `finishReason` settles.
6. `run()` interprets `finishReason` and calls `parseTaskReport` or `buildFailureReport`.
7. Bootstrap receives `AgentResult` and routes it back to its caller (the manager loop) which writes `TaskReport` to `.saivage/stages/<stage-id>/reports/<task-id>.json` and updates EventBus.

Reviewer adds a "long-lived" twist: `ReviewerAgent.run()` delegates to `this.review(this.input)`, and the manager can call `reviewer.review(newInput)` again later to get follow-up reviews on the same stage. The second call re-runs normalisation and injects a follow-up user message — same lifecycle, just resumed.

## 5. Constraints any solution must respect

- **Zod schemas in [types.ts](../../../../src/types.ts)**: `TaskSchema` ([L106](../../../../src/types.ts#L106)), `TaskReportSchema` ([L157](../../../../src/types.ts#L157)), `InspectionRequestSchema`, `InspectionReportSchema`. The shared helper does not re-validate today; whatever replaces it should not silently drop validation that anything else depends on, and should be a natural site to add Zod validation later (cross-link F03).
- **`AgentRole` enum**: [agents/types.ts L20-L29](../../../../src/agents/types.ts#L20-L29). Five live worker roles in `TaskReport.agent`: `coder | researcher | data_agent | reviewer` plus manager via stage reports, plus inspector via `InspectionReport`. Designer is not in either enum.
- **`BaseAgent` boundary**: any worker base class lives strictly above `BaseAgent`; it must not touch the LLM call loop, compaction, dispatcher wiring, or `validateFinalResponse` semantics — those are `BaseAgent`'s contract.
- **`AgentResult` shape**: [agents/types.ts L31-L35](../../../../src/agents/types.ts#L31-L35). The `run()` return contract is shared with non-workers (planner, manager, chat). Any refactor must keep `AgentResult` as the wire type.
- **Reviewer public API**: `ReviewerAgent` is exported from [index.ts L61](../../../../src/index.ts#L61), and the manager loop relies on the distinction between `run()` (one-shot, used by the generic dispatcher) and `review(input)` (re-entrant, used directly from the dispatch in [bootstrap.ts L372-L374](../../../../src/server/bootstrap.ts#L372-L374)). Any refactor must keep `ReviewerAgent.run()` an explicit one-line delegate to `this.review(this.input)`; it must not silently inherit a generic worker `run()` that bypasses the `reviewCount`/`injectMessage` logic.
- **Prompt-injection cop boundary**: irrelevant here — the helpers operate on Manager-supplied task objects and on the agent's own final text, neither of which is web content. No constraint.
- **EventBus emissions**: none of the three helpers emit events. Event emission happens in `bootstrap`/manager around `agent.run()`. Refactor has no event-bus surface.
- **F01 (designer is orphan)**: any refactor that touches `designer.ts` should delete the file rather than port its helpers; otherwise the refactor preserves dead code. F09 should not be done before F01 decides designer's fate — but F09 is the natural moment to enact F01's verdict on this subtree.
- **F03 (naive JSON parsing)**: the regex `/\{[\s\S]*\}/` and the silent fall-through into success are owned by `parseTaskReport`. F09 makes F03 a one-place fix; F03 should be sequenced after F09.
- **F18 (prompt bloat)**: orthogonal; F09 does not touch prompts.

## 6. Correction to the issue text

- The evidence table in `F09-worker-agent-helpers-duplicated.md` does not enumerate the per-file drift documented in §2.3 (the `issues_found` divergence between the two-shape failure report). That is the most consequential semantic difference and should be called out — added here.
- The issue says the `parseTaskReport` line refs "see F03"; for navigation completeness the actual line refs are listed in §1 above.
- The "~750 lines" estimate is for the duplicated helpers + worker `run()` skeleton + `normalizeWorkerInput` together; the helper bodies alone are ~585 lines. Both numbers are consistent with the recommendation to lift the `run()` skeleton too (Proposal B/C in [02-design-r2.md](02-design-r2.md)).
