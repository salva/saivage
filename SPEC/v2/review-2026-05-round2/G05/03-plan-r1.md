# G05 — Plan r1

**Finding**: [../G05-worker-message-builder-duplicated-5x.md](../G05-worker-message-builder-duplicated-5x.md)
**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
**Design**: [02-design-r1.md](02-design-r1.md) — Proposal B (recommended)

## Sequenced steps

1. **Introduce `WorkerRoleSpec` and the unified renderer in `WorkerAgent`.**
   In [src/agents/worker.ts](../../../../src/agents/worker.ts):
   - Add `export interface WorkerRoleSpec { role: WorkerRole; heading: string; extraInstructionLines?: string[]; notesDir?: (stageId: string) => string; followUpInstruction?: string; promptKey: string; invalidFinalResponseMessage: string; ctor: new (ctx: AgentContext, input: WorkerInput, spec: WorkerRoleSpec, eagerSkillBlock: string, initialMessage: string, config?: Partial<BaseAgentConfig>) => WorkerAgent; }`.
   - Add a colocated `async function buildInitialMessage(spec: WorkerRoleSpec, ctx: AgentContext, input: WorkerInput, opts?: { headingSuffix?: string; prependFollowUp?: boolean }): Promise<string>` that renders the unified shape from [02-design-r1.md §Proposal A](02-design-r1.md) (checklist render → `await buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true })` → `## ${spec.heading}${opts?.headingSuffix ?? ""}` → `**Task/Stage/Type/Attempt:**` lines using `ROLE_TO_TASK_TYPE[spec.role]` for the default → `### Description` → optional `### Checklist` → `### Instructions` with (a) optional `spec.followUpInstruction` when `opts?.prependFollowUp`, (b) `spec.extraInstructionLines`, (c) `spec.notesDir?.(input.stageId)` line, (d) unified report-path line, (e) unified commit clause `Commit using MCP git with message prefix: [${input.task.id}] if you modify files.`, (f) `Return the full TaskReport JSON as your final response.`).
   - Add `static async createWorker<T extends WorkerAgent>(ctx: AgentContext, input: WorkerInput, spec: WorkerRoleSpec, config?: Partial<BaseAgentConfig>): Promise<T>` that calls `buildInitialMessage(spec, ctx, input)` and `buildEagerBlock(ctx.project.projectRoot, spec.role, input.task.description, input.task.tags ?? [])`, then `return new spec.ctor(ctx, input, spec, eagerSkillBlock, initialMessage, config) as T`.
   - Change the `WorkerAgent` constructor signature to `(ctx: AgentContext, input: WorkerInput, spec: WorkerRoleSpec, eagerSkillBlock: string, initialMessage: string, config?: Partial<BaseAgentConfig>)`. Inside, call `super(ctx, { systemPrompt: loadRolePrompt(spec.promptKey), eagerSkillBlock, skillContext: { agentRole: spec.role, description: task.description, tags: task.tags ?? [] }, initialMessage, ...config })` (mirrors today's body, just sourced from `spec`).
   - Delete the now-unused `WorkerAgentConfig` interface ([src/agents/worker.ts](../../../../src/agents/worker.ts#L29-L35)).
   - Add `import { loadRolePrompt } from "./prompts.js";` and `import { buildEagerBlock } from "../knowledge/eagerLoader.js";` and `import { buildHandoffContext } from "./handoff.js";` at the top of [src/agents/worker.ts](../../../../src/agents/worker.ts) (currently held by the subclasses).

2. **Shrink the four pure-worker subclasses.**
   For each of [src/agents/coder.ts](../../../../src/agents/coder.ts), [src/agents/researcher.ts](../../../../src/agents/researcher.ts), [src/agents/designer.ts](../../../../src/agents/designer.ts), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts):
   - Delete the file's `buildXxxMessage` free function, `static async create`, custom constructor, and all imports that become unused (`buildHandoffContext`, `buildEagerBlock`, `loadRolePrompt`, `BaseAgentConfig`, `AgentContext`).
   - Replace with: import `WorkerAgent`, `WorkerRoleSpec` from `./worker.js`; declare `export class XxxAgent extends WorkerAgent {}` (empty body — nominal class for `instanceof` and dispatcher matching); declare `export const XXX_SPEC: WorkerRoleSpec = { role, heading, extraInstructionLines?, promptKey, invalidFinalResponseMessage, ctor: XxxAgent }`.
   - Spec values:
     - `CODER_SPEC` ([src/agents/coder.ts](../../../../src/agents/coder.ts)): `{ role: "coder", heading: "Task Assignment", promptKey: "coder", invalidFinalResponseMessage: "Invalid final task response: you have not used any tools for this task yet." }`.
     - `RESEARCHER_SPEC` ([src/agents/researcher.ts](../../../../src/agents/researcher.ts)): `{ role: "researcher", heading: "Research Task Assignment", extraInstructionLines: ["Write findings under: research/"], promptKey: "researcher", invalidFinalResponseMessage: "Invalid final task response: you have not used any tools for this research task yet." }`.
     - `DESIGNER_SPEC` ([src/agents/designer.ts](../../../../src/agents/designer.ts)): `{ role: "designer", heading: "Design Task Assignment", extraInstructionLines: ["Produce design artifacts that are concrete enough for implementation and review."], promptKey: "designer", invalidFinalResponseMessage: "Invalid final design response: you have not used any tools for this design task yet." }`.
     - `DATA_AGENT_SPEC` ([src/agents/data-agent.ts](../../../../src/agents/data-agent.ts)): `{ role: "data_agent", heading: "Data Acquisition Task Assignment", extraInstructionLines: ["Write downloaded artifacts to the project-relative path that best fits the task; data/ is common but not mandatory.", "Write provenance notes under research/data-sources/ or another clearly named research/provenance path.", "Use retries, fallback source URLs, alternate access methods, and an attempt manifest when downloads are unreliable."], promptKey: "data-agent", invalidFinalResponseMessage: "Invalid final task response: you have not used any tools for this data task yet." }`.

3. **Rebuild `reviewer.ts` on top of the spec.**
   In [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts):
   - Delete `buildReviewerMessage` and its `reviewNumber` parameter.
   - Export `REVIEWER_SPEC: WorkerRoleSpec = { role: "reviewer", heading: "Stage Review Task Assignment", extraInstructionLines: ["Review the stage objectives, expected outcomes, acceptance criteria, task list, worker reports, changed artifacts, and any existing summary drafts.", "For data-heavy or ML/research stages, validate data provenance/suitability, leakage controls, statistical acceptance, benchmark comparison, and whether conclusions are supported."], notesDir: (stageId) => \`.saivage/stages/${stageId}/reviews/\`, followUpInstruction: "This is a follow-up review in the same stage-scoped reviewer session. Your previous reports and reasoning are above in this conversation. Focus first on the new corrective-task results, then verify whether earlier issues are resolved or still open.", promptKey: "reviewer", invalidFinalResponseMessage: "Invalid final review response: you have not used any tools to inspect evidence yet.", ctor: ReviewerAgent }`.
   - Keep `class ReviewerAgent extends WorkerAgent` because of the `private reviewCount = 0` field and the `override async run()` / `async review(input)` methods.
   - Inside `review(input)`, change the follow-up branch from `await buildReviewerMessage(this.ctx, this.input, this.reviewCount + 1)` to `await buildInitialMessage(REVIEWER_SPEC, this.ctx, this.input, { headingSuffix: \` - Follow-up Review ${this.reviewCount + 1}\`, prependFollowUp: true })` (imported from `./worker.js`).
   - Delete the now-unused imports `normalizeTask`, `buildHandoffContext`, `loadRolePrompt`, `buildEagerBlock`, `BaseAgentConfig` (the first stays only if still used by `review`'s `normalizeTask(input.task, "reviewer")` call — yes, keep `normalizeTask`).

4. **Wire the new factory into bootstrap.**
   In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts):
   - Add imports `import { CODER_SPEC } from "../agents/coder.js";` (and the four other `_SPEC` constants), and `import { WorkerAgent } from "../agents/worker.js";`.
   - In each of the five `case` branches at L319-L380, replace `await XxxAgent.create(ctx, workerInput, { onActivity: ... })` with `await WorkerAgent.createWorker<XxxAgent>(ctx, workerInput, XXX_SPEC, { onActivity: ... })`.
   - The reviewer branch at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L364) keeps its `const reviewer = await WorkerAgent.createWorker<ReviewerAgent>(...)` binding so that the subsequent `reviewer.review(...)` call (if present elsewhere in the runtime) still type-checks.

5. **Add the snapshot test for the unified renderer.**
   Create [src/agents/worker-initial-message.test.ts](../../../../src/agents/worker-initial-message.test.ts):
   - One `describe("buildInitialMessage")` with six `it` cases: coder, researcher, designer, data_agent, reviewer (first review), reviewer (follow-up review #2).
   - Each case constructs a fixture `AgentContext` whose `project.paths.plan` / `planHistory` point at temp files containing a minimal `Plan` and `PlanHistory`; the assertion is `expect(rendered).toMatchSnapshot()`.
   - Use `vi.mock("./handoff.js", () => ({ buildHandoffContext: vi.fn().mockResolvedValue("## Shared Project Context\n[FIXTURE HANDOFF]") }))` so the snapshots assert the *worker-message* shape, not the handoff body (which has its own tests via [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) if any; otherwise its shape is exercised by integration).
   - Six committed snapshot files under `src/agents/__snapshots__/worker-initial-message.test.ts.snap`.

6. **Add the roster cross-check.**
   In [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts), add `it("every WorkerRole has a registered WorkerRoleSpec", () => { ... })`:
   - Build a `WORKER_ROLE_SPECS: Record<WorkerRole, WorkerRoleSpec>` constant in a new tiny module [src/agents/worker-specs.ts](../../../../src/agents/worker-specs.ts) (re-exports `CODER_SPEC | RESEARCHER_SPEC | DESIGNER_SPEC | DATA_AGENT_SPEC | REVIEWER_SPEC`). This module is the registry the test consults — and is also a convenient single import for bootstrap (step 4) to replace the five named imports if desired.
   - The test asserts `for (const role of WORKER_ROLES) { const spec = WORKER_ROLE_SPECS[role]; expect(spec).toBeDefined(); expect(spec.heading).not.toBe(""); expect(spec.promptKey).not.toBe(""); expect(spec.invalidFinalResponseMessage).not.toBe(""); expect(spec.ctor).toBeDefined(); expect(spec.role).toBe(role); }`.
   - Refactor step 4 to import from [src/agents/worker-specs.ts](../../../../src/agents/worker-specs.ts) instead of five separate files.

7. **Build and run tests.**
   ```bash
   cd /home/salva/g/ml/saivage && pnpm typecheck && pnpm test -- src/agents
   ```
   Expect: no type errors; the six new snapshot cases generate fresh `.snap` files on first run (commit them); the roster cross-check passes; the existing eight agent test files keep passing unchanged.

8. **Manual sanity dispatch.**
   On the harness container, restart `saivage.service` and confirm a worker still kicks off correctly: dispatch a one-task stage, then inspect [.saivage/runtime/runtime-state.json](../../../../../saivage-v3/.saivage/runtime/runtime-state.json) on the harness and the worker's first conversation turn in the dashboard to verify the rendered initial message matches the new unified shape (heading, four metadata lines, role-specific Instructions, unified commit clause). No on-disk format changed, so no migration is needed.

## Validation

- `cd /home/salva/g/ml/saivage && pnpm typecheck` — green.
- `cd /home/salva/g/ml/saivage && pnpm test -- src/agents` — green; six new snapshots present under `src/agents/__snapshots__/worker-initial-message.test.ts.snap`; one new `roster.test.ts` case passing.
- `cd /home/salva/g/ml/saivage && pnpm build` — green (the `tsup` output for `src/agents/*.js` matches the new file shape).
- `cd /home/salva/g/ml/saivage && grep -rn -E "build(Coder|Researcher|Designer|DataAgent|Reviewer)Message" src/ test/` — **0 hits** (the five free functions are gone).
- `cd /home/salva/g/ml/saivage && grep -rn -E "\.(Coder|Researcher|Designer|DataAgent|Reviewer)Agent\.create" src/ test/` — **0 hits** (the five `static create` factories are gone).
- `cd /home/salva/g/ml/saivage && grep -rn "WorkerAgent.createWorker" src/ test/` — **5 hits** in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts).
- `cd /home/salva/g/ml/saivage && grep -rn "if you modify files\.\|if you create review files\." src/agents` — **0 hits** (the three drifted commit clauses are gone; only the unified clause exists, in the renderer body).
- On `saivage-v3` container after restart: `curl -fsS http://10.0.3.112:8080/api/notes` returns the live runtime; dispatch one short coder task; the conversation snapshot shows the new unified initial message; the worker writes its `TaskReport` to `.saivage/stages/<stage>/reports/<task>.json` (unchanged path, unchanged shape) and the stage completes normally.

## Rollback

- The refactor is a pure source-tree change; no on-disk format, no API contract, no provider/router/MCP plumbing touched.
- If validation fails: `git revert <merge-commit>` on the feature branch restores the five `buildXxxMessage` / `static create` / per-role constructors. No data migration to undo. No deployed-state drift to repair (the runtime renders the initial message at dispatch time; older renderings already on disk are inert conversation history).
- The snapshot test files (`worker-initial-message.test.ts.snap`) are deleted by the revert as well; nothing else references them.

## Cross-finding

- Round-1 F09 / F25 (`WorkerAgent` + `task-report.ts` extractions) — this plan completes the same lift.
- G01 ([../G01-supervisor-abort-priority-duplicates-roster.md](../G01-supervisor-abort-priority-duplicates-roster.md)), G02 ([../G02-dispatcher-limits-omit-designer.md](../G02-dispatcher-limits-omit-designer.md)), G03 ([../G03-role-tool-filter-ignores-roster.md](../G03-role-tool-filter-ignores-roster.md)), G04 ([../G04-manager-validate-final-response-hardcoded-tools.md](../G04-manager-validate-final-response-hardcoded-tools.md)) — same remedy pattern (move per-role values into a registry the base/runtime consults). The new `WORKER_ROLE_SPECS` module slots cleanly next to `ROSTER` and can be cross-linked from those findings' plans.
- G06–G08 — adjacent "duplication left behind by a partial round-1 extraction" findings; the snapshot-test pattern introduced in step 5 is reusable.
