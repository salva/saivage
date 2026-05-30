# F01 — Implementation plan (R1)

Plan for the **recommended Proposal C** from [02-design-r1.md](02-design-r1.md): land F09 first, then land F01 as a single follow-up commit that creates a fresh `DesignerAgent extends WorkerAgent` and wires it into every role surface.

All paths absolute under `/home/salva/g/ml/saivage/`. Every reference numbered below is verified against the current source; line numbers may shift by ±5 once F09 has merged but the symbols / surfaces are stable.

## 1. Pre-condition

[F09](../F09/APPROVED.md) must be merged. F09 must have produced:

- New file `src/agents/task-report.ts` exporting `WorkerRole`, `ROLE_TO_TASK_TYPE`, `normalizeTask`, `parseTaskReport`, `buildFailureReport`.
- New file `src/agents/worker.ts` exporting `WorkerAgent extends BaseAgent` and `WorkerAgentConfig`.
- Deletion of `src/agents/designer.ts` per F09 step 7.

If F09 is still in-flight, F01 waits. Do **not** attempt to interleave.

## 2. Ordered edit steps

1. **Widen `WorkerRole`** in [src/agents/task-report.ts](../../../../src/agents/task-report.ts) (file created by F09).
   - Change `export type WorkerRole = "coder" | "researcher" | "data_agent" | "reviewer";` to `export type WorkerRole = "coder" | "researcher" | "data_agent" | "reviewer" | "designer";`.
   - Add `designer: "design"` to the `ROLE_TO_TASK_TYPE` lookup.

2. **Add `"designer"` to the `AgentRole` union** at [src/agents/types.ts L19-L28](../../../../src/agents/types.ts#L19-L28). Insert between `"reviewer"` and `"inspector"` to match the existing manager/worker/inspector ordering.

3. **Widen the four Zod enums** in [src/types.ts](../../../../src/types.ts):
   - `TaskSchema.type` at [L108](../../../../src/types.ts#L108): add `"design"`.
   - `TaskSchema.assigned_to` at [L109](../../../../src/types.ts#L109): add `"designer"`.
   - `TaskReportSchema.agent` at [L160](../../../../src/types.ts#L160): add `"designer"`.
   - `AgentStateSchema.agent_type` at [L274-L283](../../../../src/types.ts#L274-L283): add `"designer"`.

4. **Add routing key** in [src/routing/resolver.ts L3-L16](../../../../src/routing/resolver.ts#L3-L16): insert `designer: "designer"` after the `reviewer` entry. This gives Designer its own model-routing key; operators who want it to share the coder model can set a routing override in `.saivage/saivage.json` per existing routing semantics.

5. **Add self-check default** in [src/runtime/self-check.ts L10-L19](../../../../src/runtime/self-check.ts#L10-L19): add `designer: 15` (parity with coder/researcher/data_agent/reviewer/inspector). Required because `DEFAULT_SELF_CHECK_FREQUENCY` is typed as `Record<AgentRole, number>` and the compiler will demand the new key after step 2.

6. **Register dispatch tool** in [src/runtime/dispatcher.ts L16-L33](../../../../src/runtime/dispatcher.ts#L16-L33):
   - Add `"run_designer"` to `DISPATCH_TOOLS`.
   - Add `run_designer: "designer"` to `DISPATCH_ROLE_MAP`.

7. **Add tool schema and manager exposure** in [src/agents/base.ts](../../../../src/agents/base.ts):
   - Add `RUN_DESIGNER_SCHEMA: ToolSchema` after `RUN_REVIEWER_SCHEMA` ([base.ts L932-L955](../../../../src/agents/base.ts#L932-L955)), copying the shape of `RUN_CODER_SCHEMA` ([base.ts L857-L880](../../../../src/agents/base.ts#L857-L880)) verbatim with `name: "run_designer"` and a one-line description ("Dispatch a design task to a Designer worker agent. Returns a TaskReport.").
   - Append `RUN_DESIGNER_SCHEMA` to `ROLE_DISPATCH_TOOLS.manager` at [base.ts L962](../../../../src/agents/base.ts#L962).

8. **Add bootstrap spawner case** in [src/server/bootstrap.ts L290-L367](../../../../src/server/bootstrap.ts#L290-L367) `createChildSpawner`'s `switch (role)`:

   ```ts
   case "designer": {
     const workerInput = normalizeWorkerDispatchInput(input, role);
     agent = new DesignerAgent(ctx, workerInput, {
       onActivity: (agentId) => tracker.agentActivity(agentId),
     });
     taskId = workerInput.task?.id;
     tracker.setCurrentStage(workerInput.stageId);
     break;
   }
   ```

   Insert between the `data_agent` case ([bootstrap.ts L325-L333](../../../../src/server/bootstrap.ts#L325-L333)) and the `reviewer` case. Add `import { DesignerAgent } from "../agents/designer.js";` at the top of the file alongside the other agent imports.

9. **Create the new agent file** at `src/agents/designer.ts`:

   ```ts
   /**
    * Saivage - Designer Agent
    * Produces product, UX, interface, architecture, and design-system artifacts.
    */

   import { WorkerAgent, type WorkerAgentConfig } from "./worker.js";
   import type { AgentContext, WorkerInput } from "./types.js";
   import { buildHandoffContext } from "./handoff.js";

   const DESIGNER_PROMPT = `# Designer - System Prompt
   ... // exact prompt body lifted from the pre-F09 designer.ts (was at L17-L70 of the deleted file)
   `;

   function buildDesignerMessage(ctx: AgentContext, input: WorkerInput): string {
     const checklist = (input.task.checklist ?? [])
       .map((c) => `- [${c.required ? "REQUIRED" : "optional"}] ${c.description}`)
       .join("\n");
     return (
       `## Design Task Assignment\n\n` +
       `${buildHandoffContext(ctx, { stageId: input.stageId, includeTasks: true })}\n\n` +
       `**Task ID:** ${input.task.id}\n` +
       `**Stage ID:** ${input.stageId}\n` +
       `**Type:** ${input.task.type ?? "design"}\n` +
       `**Attempt:** ${input.task.attempt ?? 1} of ${input.task.max_attempts ?? 3}\n\n` +
       `### Description\n${input.task.description}\n\n` +
       (checklist ? `### Checklist\n${checklist}\n\n` : "") +
       `### Instructions\n` +
       `Produce design artifacts that are concrete enough for implementation and review.\n` +
       `Write the report to: .saivage/stages/${input.stageId}/reports/${input.task.id}.json\n` +
       `Commit using MCP git with message prefix: [${input.task.id}] if you modify files.\n` +
       `Return the full TaskReport JSON as your final response.`
     );
   }

   export class DesignerAgent extends WorkerAgent {
     constructor(ctx: AgentContext, input: WorkerInput, config?: Partial<WorkerAgentConfig>) {
       super(ctx, input, {
         role: "designer",
         systemPrompt: DESIGNER_PROMPT,
         buildInitialMessage: (i) => buildDesignerMessage(ctx, i),
         invalidFinalResponseMessage:
           "Invalid final design response: you have not used any tools for this design task yet.",
         ...config,
       });
     }
   }
   ```

   The exact `WorkerAgentConfig` field names match F09's Proposal C shape ([F09/02-design-r2.md → "Proposal C → Shape"](../F09/02-design-r2.md)). If F09's final field names differ trivially (e.g. `initialMessageBuilder` instead of `buildInitialMessage`), use whichever F09 actually shipped.

   Lift the `DESIGNER_PROMPT` body verbatim from git history (pre-F09 [src/agents/designer.ts L17-L70](../../../../src/agents/designer.ts#L17-L70)). Do not rewrite the prompt as part of F01; that is out of scope (F18 covers prompt extraction).

10. **Export from the barrel** in [src/index.ts L55-L65](../../../../src/index.ts#L55-L65): add `export { DesignerAgent } from "./agents/designer.js";` alongside the other seven worker exports.

11. **Update manager prompt** in [src/agents/manager.ts L29-L51](../../../../src/agents/manager.ts#L29-L51) (worker roster narrative) and [L77-L116](../../../../src/agents/manager.ts#L77-L116) (tool reference block):
    - Add a Designer paragraph to the worker introductions explaining that `run_designer({ task, stageId })` dispatches design tasks (briefs, UX flows, architecture decisions) and that it produces design artifacts but does not write production code.
    - Add `\`run_designer({ task, stageId })\` — Dispatch a design task to a Designer agent. ...` entry to the tool reference block (same format as the other workers).
    - Add `"run_designer"` to the `hasUsedToolNamed(...)` guard at [manager.ts L335](../../../../src/agents/manager.ts#L335).

12. **Add Designer smoke test** in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts):
    - Mirror the structure of the existing `CoderAgent` test at [agents.test.ts L439-end](../../../../src/agents/agents.test.ts#L439).
    - Stub the router with a single completion turn that returns a valid `TaskReport` JSON.
    - Assert `result.kind === "success"`, `result.data.agent === "designer"`, and that the schema validates.
    - Assert `DesignerAgent` is exported from `src/index.ts` (one-line import test).

## 3. Test strategy

### Existing tests that cover the wiring

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) — existing `CoderAgent` and `ReviewerAgent` tests should pass unchanged. They will catch any accidental signature break in `WorkerAgent` caused by widening `WorkerRole`.
- Schema tests (if any in `src/types.test.ts` or similar) — the new enum members are additive, so existing fixtures still validate.

### New test in `src/agents/agents.test.ts`

```ts
it("DesignerAgent runs a design task and returns a Designer TaskReport", async () => {
  const ctx = makeTestCtx({ role: "designer" });
  const input: WorkerInput = {
    stageId: "S001",
    task: { id: "T1", type: "design", assigned_to: "designer",
      description: "Design the dashboard layout", checklist: [],
      dependencies: [], status: "pending", attempt: 1, max_attempts: 3 },
  };
  const agent = new DesignerAgent(ctx, input);
  const result = await agent.run();
  expect(result.kind).toBe("success");
  if (result.kind === "success") {
    const report = result.data as TaskReport;
    expect(report.agent).toBe("designer");
    expect(() => TaskReportSchema.parse(report)).not.toThrow();
  }
});
```

### Commands to run

After each numbered step, and at the end:

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npx vitest run src/agents/ src/runtime/ src/routing/
```

Final whole-package gate before considering F01 done:

```bash
cd /home/salva/g/ml/saivage
npm run typecheck
npm run lint
npx vitest run
npm run build
```

## 4. Validation

This change is TypeScript-only inside `src/`. No web UI, no docs, no LXC redeploy.

The workspace skill at [/home/salva/g/ml/.github/skills/saivage-development-validation/SKILL.md](../../../../../.github/skills/saivage-development-validation/SKILL.md) is **not applicable** here: its commands are scoped to `/home/salva/g/ml/saivage-v3` (Jest-based), while F01 modifies `/home/salva/g/ml/saivage` (Vitest, per [package.json L17](../../../../package.json#L17), and `tsc --noEmit` per [package.json L20](../../../../package.json#L20)).

Repo-local validation:

1. `npm run typecheck` — must pass. The strict-mode TypeScript compile will catch every missed enum / role-keyed record (this is the main protection that all 11 surfaces were updated).
2. `npm run lint` — must pass.
3. `npx vitest run src/agents/` — focused agent tests must pass.
4. `npx vitest run` — full suite must pass.
5. `npm run build` — must succeed.
6. Smoke check (optional): with `saivage-v3-getrich-v2` or a scratch project, write a one-task `design` stage and trigger a manager run; confirm `agent dispatched run_designer`, a `TaskReport` is written under `.saivage/stages/<id>/reports/`, and the runtime-state JSON contains an `agent_type: "designer"` entry. This is the operator-meaningful end-to-end check that the role is genuinely wired and not just type-checked.

## 5. Rollback strategy

Single commit. Rollback is `git revert <sha>`:

- The new `src/agents/designer.ts` is deleted.
- The eleven wiring surfaces revert to "no `designer`" (which is the post-F09 state).
- `WorkerRole` shrinks back to four roles.
- No on-disk schema migration. Any in-flight `Task`/`TaskReport`/`AgentState` JSON with `agent: "designer"` after the revert would fail Zod validation, but because Designer is being wired in F01 there is no existing on-disk data with that value at the time of the rollback decision.

## 6. Cross-issue ordering

- **Hard ordering: F01 lands strictly AFTER [F09](../F09/APPROVED.md).** F01 depends on F09 having created `src/agents/task-report.ts` and `src/agents/worker.ts`, and on F09 having deleted the old `src/agents/designer.ts`. Attempting F01 before F09 forces Proposal A or B from [02-design-r1.md](02-design-r1.md), which the recommendation explicitly rejects.
- **F02 (agent roster drift)**: F01 fixes one of the F02 evidence items (the `AgentStateSchema.agent_type` vs `TaskSchema.assigned_to` mismatch widens to consistently include Designer). When F02's writer picks up that issue, they should treat F01's enum additions as already done. F02 may still need to reconcile other roster differences, but Designer is no longer one of them.
- **F18 (prompt bloat)**: orthogonal. F01 keeps the `DESIGNER_PROMPT` as an inline template literal; whichever solution F18 settles on (e.g. external `.md` prompt files) will sweep up Designer alongside the other workers.
- **F03 (naive JSON parsing)**: orthogonal. F01 inherits `parseTaskReport` from `src/agents/task-report.ts`, so when F03 lands its fix in that one location, Designer benefits automatically.
