# G05 — Design r1

**Finding**: [../G05-worker-message-builder-duplicated-5x.md](../G05-worker-message-builder-duplicated-5x.md)
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

Two proposals, ordered by blast radius. Recommendation: **Proposal B**.

---

## Proposal A — Extract a single `buildWorkerInitialMessage` helper alongside the five worker subclasses

### Idea

Pull the duplicated body into one function exported from a new module [src/agents/worker-initial-message.ts](../../../../src/agents/worker-initial-message.ts) (kept separate from [src/agents/worker.ts](../../../../src/agents/worker.ts) so the base class stays focused on the run-loop). Each subclass's `static create` calls it with a small per-role spec; the `buildXxxMessage` free functions are deleted. The shared `static create` factory shape is *not* extracted in this proposal — only the message builder.

### New module

[src/agents/worker-initial-message.ts](../../../../src/agents/worker-initial-message.ts):

```ts
import type { AgentContext, WorkerInput } from "./types.js";
import type { WorkerRole } from "./task-report.js";
import { buildHandoffContext } from "./handoff.js";

export interface WorkerMessageSpec {
  role: WorkerRole;
  heading: string;                   // e.g. "Task Assignment"
  headingSuffix?: string;            // reviewer follow-up only
  extraInstructionLines?: string[];  // role-specific Instructions lines
  notesDir?: string;                 // reviewer's `.saivage/stages/<id>/reviews/`
}

export async function buildWorkerInitialMessage(
  ctx: AgentContext,
  input: WorkerInput,
  spec: WorkerMessageSpec,
): Promise<string> { /* unified body, see Analysis §4 */ }
```

The body renders the checklist, calls `buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true })`, emits the four `**Task/Stage/Type/Attempt:**` lines (default type via `ROLE_TO_TASK_TYPE[spec.role]`), and writes one unified Instructions block:

```
### Instructions
{extraInstructionLines joined with "\n"}
{notesDir ? `Write optional detailed notes to: ${notesDir}\n` : ""}
Write the report to: .saivage/stages/${input.stageId}/reports/${input.task.id}.json
Commit using MCP git with message prefix: [${input.task.id}] if you modify files.
Return the full TaskReport JSON as your final response.
```

The three commit-clause variants collapse to one. The reviewer's follow-up marker becomes `spec.headingSuffix`.

### Files touched

- **New**: [src/agents/worker-initial-message.ts](../../../../src/agents/worker-initial-message.ts) — module above, ~60 lines.
- **New**: [src/agents/worker-initial-message.test.ts](../../../../src/agents/worker-initial-message.test.ts) — golden snapshot per `WorkerRole` (five cases) + reviewer follow-up case. Uses a fixture `AgentContext` with a stubbed `buildHandoffContext` (mocked) so the test asserts the shape, not the handoff body.
- **Edit**: [src/agents/coder.ts](../../../../src/agents/coder.ts) — delete `buildCoderMessage` (L50-L73); `static create` becomes one call to `buildWorkerInitialMessage(ctx, input, { role: "coder", heading: "Task Assignment" })`.
- **Edit**: [src/agents/researcher.ts](../../../../src/agents/researcher.ts) — delete `buildResearcherMessage` (L50-L75); spec `{ role: "researcher", heading: "Research Task Assignment", extraInstructionLines: ["Write findings under: research/"] }`.
- **Edit**: [src/agents/designer.ts](../../../../src/agents/designer.ts) — delete `buildDesignerMessage` (L50-L74); spec `{ role: "designer", heading: "Design Task Assignment", extraInstructionLines: ["Produce design artifacts that are concrete enough for implementation and review."] }`.
- **Edit**: [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts) — delete `buildDataAgentMessage` (L49-L71); spec `{ role: "data_agent", heading: "Data Acquisition Task Assignment", extraInstructionLines: [<3 lines>] }`.
- **Edit**: [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts) — delete `buildReviewerMessage` (L66-L96); spec built per call so `headingSuffix` and `notesDir` reflect the current `reviewCount`.

### Deletion list

- `buildCoderMessage` ([src/agents/coder.ts](../../../../src/agents/coder.ts#L50-L73))
- `buildResearcherMessage` ([src/agents/researcher.ts](../../../../src/agents/researcher.ts#L50-L75))
- `buildDesignerMessage` ([src/agents/designer.ts](../../../../src/agents/designer.ts#L50-L74))
- `buildDataAgentMessage` ([src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L49-L71))
- `buildReviewerMessage` ([src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L66-L96))
- The three drifted commit-clause sentences (designer/reviewer variants, plus the coder/researcher/data-agent plain form) — replaced by one unified clause.
- Per-subclass `type` defaults (5 occurrences) — derived from `ROLE_TO_TASK_TYPE`.

### Test impact

- No existing test imports any `build*Message` function (verified by grep in Analysis §7), so nothing is broken by removal.
- One new test file (`worker-initial-message.test.ts`) with six snapshot cases (one per role + reviewer follow-up). Drift becomes a failing snapshot test.
- Existing roster/agents/task-report tests are unchanged.

### Trade-offs

- ✅ Single source of truth for the worker-message contract.
- ✅ Commit-clause drift eliminated by construction.
- ✅ Self-contained: no change to `BaseAgent`/`WorkerAgent` semantics, no change to `WorkerInput` or `AgentContext`, no change to bootstrap dispatch.
- ❌ The five `static async create` factories still exist with the same shape (the `buildEagerBlock` + `new XxxAgent(...)` boilerplate) — this proposal does not touch them.
- ❌ The subclass constructor still spells out `role`, `systemPrompt: loadRolePrompt(...)`, `invalidFinalResponseMessage` — three small per-role strings — in each of five files.

---

## Proposal B (recommended) — Make initial-message construction a `WorkerAgent` lifecycle step; collapse the five subclasses to declarative specs

### Idea

Move the message construction *and* the factory boilerplate *and* the per-role config (prompt key, invalid-final message, eager-loader role string) one conceptual level up — into `WorkerAgent` itself. Each subclass becomes a ~12-line declarative file that exports a `WorkerRoleSpec` and a thin class that exists only as a nominal type for `instanceof` checks and dispatcher matching.

The new `WorkerAgent.createWorker(ctx, input, spec)` static factory replaces the five `static create` methods. It calls a single `buildInitialMessage(spec, ctx, input)` helper and `buildEagerBlock` once, then constructs an instance of the requested subclass (passed via `spec.ctor`). The per-role spec drives heading, extra instruction lines, role-specific notes path, system prompt, invalid-final message, and the (now unified) commit clause.

### Public API delta

- `WorkerAgent` gains:
  - `static async createWorker<T extends WorkerAgent>(ctx, input, spec): Promise<T>` — replaces the five `static create` methods (which are deleted).
  - A new (non-exported) helper `buildInitialMessage(spec, ctx, input)` colocated in [src/agents/worker.ts](../../../../src/agents/worker.ts) (or split into `src/agents/worker-initial-message.ts` as in Proposal A; we colocate to keep the role lifecycle in one place).
  - The `WorkerAgent` constructor signature simplifies to `(ctx, input, spec, config?)` — no more `initialMessage`/`eagerSkillBlock`/`systemPrompt`/`invalidFinalResponseMessage` positional plumbing through the subclass.
- The roster gains role-spec authority: `ROSTER` already owns role-keyed defaults; we add the new `WorkerRoleSpec` for each `WorkerRole` to a new map `WORKER_ROLE_SPECS` (or inline on `ROSTER` if cleaner — see step 1 of the plan).

### New / renamed types

```ts
// In src/agents/worker.ts (or worker-initial-message.ts):
export interface WorkerRoleSpec {
  role: WorkerRole;
  heading: string;
  extraInstructionLines?: string[];
  notesDir?: (stageId: string) => string;     // reviewer
  followUpInstruction?: string;               // reviewer (reviewCount > 1)
  promptKey: string;                          // for loadRolePrompt
  invalidFinalResponseMessage: string;
  ctor: new (ctx, input, spec, config?) => WorkerAgent;
}
```

`ROLE_TO_TASK_TYPE` in [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L29-L35) remains the source for the default `type` line — no change needed there.

### Files touched

- **Edit**: [src/agents/worker.ts](../../../../src/agents/worker.ts):
  - Replace `WorkerAgentConfig` with `WorkerRoleSpec` (above).
  - Constructor takes the spec instead of pre-rendered strings; it calls `loadRolePrompt(spec.promptKey)`, stores `spec.invalidFinalResponseMessage`, and accepts `initialMessage` + `eagerSkillBlock` as still-positional internal inputs from `createWorker`.
  - Add `static async createWorker<T extends WorkerAgent>(ctx, input, spec): Promise<T>` that runs `buildInitialMessage(spec, ctx, input)` and `buildEagerBlock(ctx.project.projectRoot, spec.role, input.task.description, input.task.tags ?? [])` then `new spec.ctor(ctx, input, spec, eagerSkillBlock, initialMessage)`.
  - Add `protected async buildInitialMessage(spec, ctx, input)` (or a free function colocated in the file) — the unified renderer from Proposal A.
- **Edit (shrink)**: [src/agents/coder.ts](../../../../src/agents/coder.ts), [src/agents/researcher.ts](../../../../src/agents/researcher.ts), [src/agents/designer.ts](../../../../src/agents/designer.ts), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts):
  - Each becomes ~15 lines: a `CODER_SPEC: WorkerRoleSpec` export, a `class CoderAgent extends WorkerAgent {}` nominal subclass, and `CODER_SPEC.ctor = CoderAgent`.
  - No `static create`, no `buildXxxMessage`, no positional constructor, no `loadRolePrompt` call in the subclass.
- **Edit**: [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts):
  - Still keeps an `override async run()` because reviewer's follow-up flow injects a second message between executions ([src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L52-L62)).
  - The follow-up render becomes `await this.buildInitialMessage({ ...REVIEWER_SPEC, headingSuffix: ` - Follow-up Review ${this.reviewCount + 1}`, prependFollowUp: true }, ctx, input)` — one call to the shared renderer, no second copy of the body.
- **Edit**: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L317-L383):
  - Replace each `await XxxAgent.create(ctx, workerInput, { onActivity: ... })` with `await WorkerAgent.createWorker<XxxAgent>(ctx, workerInput, XXX_SPEC, { onActivity: ... })`.
  - The `switch (role)` block shrinks because the five branches now differ only in the spec constant.
- **Edit**: [src/agents/worker.ts](../../../../src/agents/worker.ts) JSDoc — replace the round-1 doc paragraph that says `WorkerAgent` owns "normalise task → run loop → parse TaskReport → return" with "...build initial message → normalise task → run loop → ...".
- **New**: [src/agents/worker-initial-message.test.ts](../../../../src/agents/worker-initial-message.test.ts) — six snapshot cases (same as Proposal A).
- **New (optional, recommended)**: roster cross-check test in the existing [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts) asserting that every `WorkerRole` in `WORKER_ROLES` has a registered `WorkerRoleSpec` with a non-empty heading and a wired `ctor`. This makes "adding a sixth worker role without registering its spec" a compile-or-test failure.

### Deletion list (delta over Proposal A)

In addition to Proposal A's deletions:

- Five `static async create(...)` factories (one per worker subclass).
- Five subclass constructors that exist only to plumb `(initialMessage, eagerSkillBlock, config)` into `super(...)`.
- The `WorkerAgentConfig` interface in [src/agents/worker.ts](../../../../src/agents/worker.ts#L29-L35) (replaced by `WorkerRoleSpec`).
- Five `loadRolePrompt("<role>")` calls in subclass constructors.
- Five `invalidFinalResponseMessage` string literals in subclass constructors (moved into the spec).
- Five `buildEagerBlock(...)` calls in subclass `static create` (moved into `createWorker`).
- Per-role positional argument plumbing in the five subclass constructors — gone.

Net code reduction across the five subclass files: ~250 → ~75 lines.

### Test impact

- The new snapshot test covers the unified renderer (one body, six cases).
- The roster cross-check test (one new `it` block in [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts)) prevents partial registration of a new worker role.
- Existing [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts), [src/agents/task-report.test.ts](../../../../src/agents/task-report.test.ts), [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts), [src/agents/base.compaction.test.ts](../../../../src/agents/base.compaction.test.ts), [src/agents/conversation-snapshot.test.ts](../../../../src/agents/conversation-snapshot.test.ts), [src/agents/knowledge.agent.test.ts](../../../../src/agents/knowledge.agent.test.ts), [src/agents/chat.lifecycle.test.ts](../../../../src/agents/chat.lifecycle.test.ts), [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) — none reference the five builders or the five `static create` factories, so they keep passing.
- The five `*Agent.create` call sites in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L321-L379) are the only external surface to update.

### Trade-offs

- ✅ One source of truth for both the *contract* (renderer) and the *registration* (per-role spec). Adding a sixth worker role becomes: write the spec, write the empty subclass, register both — caught by the roster test if any step is forgotten.
- ✅ Eliminates the duplicated `static create` factories that Proposal A leaves behind.
- ✅ Subclass files shrink from ~75 lines each to ~15 — the role-specific content is now the only thing in the file.
- ✅ Architecture-first: this is the right shape if we were writing this today from scratch.
- ❌ Slightly larger blast radius: `WorkerAgent`'s constructor signature changes, and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) gets edited (mechanically — replace `XxxAgent.create` with `WorkerAgent.createWorker<XxxAgent>(..., XXX_SPEC, ...)`).
- ❌ The "nominal subclass for `instanceof` and dispatcher matching" pattern is slightly less obvious than a real class with methods; mitigated by keeping the `class XxxAgent extends WorkerAgent {}` declaration so existing `instanceof` and dispatcher type names continue to work without rewriting.

### Why B over A

- A fixes the *symptom* (the drifted commit clause) by sharing the body. B fixes the *cause* (per-role plumbing is duplicated boilerplate) by moving registration into the base class lifecycle.
- The architecture-first guideline says: refactor broadly when it improves the design, no minimal-change defaults. A is the minimal change. B is the design change.
- B costs one more touched file (`bootstrap.ts`) and a slightly larger `WorkerAgent` API surface. In return it deletes ~175 lines net (vs ~75 for A), removes the second category of duplication (factories + constructors), and makes the next worker-role addition a one-spec change instead of a ~75-line copy-paste.
- B is also a better fit for the cross-cutting findings (G02, G03) that all share the pattern "ROSTER is the single source of truth, sibling files keep drifting" — pushing the per-role spec into a registry that the base class consults is the same remedy.

---

## Recommendation

**Proposal B.** It collapses the entire duplication surface (builders + factories + constructors + per-role strings) into one declarative spec + one shared renderer, aligns with the roster-as-source-of-truth pattern already established by F25 / G01–G04, and reduces the cost of adding the next worker role from "copy 75 lines into a new file" to "write a 12-line spec".
