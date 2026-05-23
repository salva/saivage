# F01 — Analysis (R1)

## Problem restated

[src/agents/designer.ts](../../../../src/agents/designer.ts) is a 267-line module that defines `DesignerAgent extends BaseAgent implements Agent` with a ~120-line `DESIGNER_PROMPT` and its own private `normalizeTask` / `buildDesignerMessage` / `parseTaskReport` / `buildFailureReport` helpers, yet nothing in the running system can construct or dispatch it. It is reachable only by direct deep-import from outside the package, which no in-tree consumer does. Concretely:

- **Not exported from the barrel.** [src/index.ts](../../../../src/index.ts#L55-L65) re-exports `CoderAgent`, `ResearcherAgent`, `DataAgent`, `ReviewerAgent`, `ManagerAgent`, `PlannerAgent`, `InspectorAgent`, `ChatAgent` — eight roles; `DesignerAgent` is absent.
- **Not in the `AgentRole` enum.** [src/agents/types.ts](../../../../src/agents/types.ts#L19-L28) enumerates `"planner" | "manager" | "coder" | "researcher" | "data_agent" | "reviewer" | "inspector" | "chat"`. `"designer"` is not a member, so no `AgentContext.role` value can name it and `createChildSpawner` cannot switch on it.
- **Not in the dispatcher tool set.** [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L16-L33) registers `DISPATCH_TOOLS = {run_manager, run_coder, run_researcher, run_data_agent, run_reviewer, run_inspector}` and the matching `DISPATCH_ROLE_MAP`. There is no `run_designer` entry, so the Manager (or Planner) cannot reach it through a tool call.
- **Not advertised to the LLM.** [src/agents/base.ts](../../../../src/agents/base.ts#L857-L955) declares `RUN_CODER_SCHEMA`, `RUN_RESEARCHER_SCHEMA`, `RUN_DATA_AGENT_SCHEMA`, `RUN_REVIEWER_SCHEMA`, and the manager `ROLE_DISPATCH_TOOLS` entry [base.ts L962](../../../../src/agents/base.ts#L962) lists only those four. No `RUN_DESIGNER_SCHEMA` exists.
- **Not in the Zod schemas.** `TaskSchema.assigned_to` at [src/types.ts L109](../../../../src/types.ts#L109) is `z.enum(["coder", "researcher", "data_agent", "reviewer"])`. `TaskReportSchema.agent` at [src/types.ts L160](../../../../src/types.ts#L160) is the same enum. `AgentStateSchema.agent_type` at [src/types.ts L274-L283](../../../../src/types.ts#L274-L283) lists `planner, manager, coder, researcher, data_agent, reviewer, inspector, chat`. A Designer would fail schema validation on every path that persists or reads it.
- **Not in the bootstrap spawner switch.** [src/server/bootstrap.ts L268-L367](../../../../src/server/bootstrap.ts#L268-L367) `createChildSpawner` has cases for `manager / coder / researcher / data_agent / reviewer / inspector` and falls through to `{ kind: "failure", reason: "Unknown agent role: ${role}" }` for anything else.
- **Not in the routing key map.** [src/routing/resolver.ts L3-L16](../../../../src/routing/resolver.ts#L3-L16) `ROUTING_ROLE_TO_MODEL_KEY` has entries for every live role plus `executor / supervisor / security / default`; no `designer`.
- **Not in the self-check schedule.** [src/runtime/self-check.ts L10-L19](../../../../src/runtime/self-check.ts#L10-L19) `DEFAULT_SELF_CHECK_FREQUENCY` is a `Record<AgentRole, number>`; because `AgentRole` lacks `designer`, the record cannot mention it.
- **Not referenced anywhere else in `src/`.** `rg -n "designer|DesignerAgent" src/ --type ts` outside `src/agents/designer.ts` returns no matches.
- **Not in any test.** [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) imports `CoderAgent` and `ReviewerAgent`; no test mentions `DesignerAgent`.

## Operator constraint

[F01-designer-agent-orphan.md L25-L27](../../F01-designer-agent-orphan.md#L25-L27) carries an explicit operator note: "Wire this agent in the system! Do not remove it!!!". The repo owner wants a Designer role to exist, not just stale code carrying the name. Deletion is therefore disallowed as the terminal outcome; the only question is whether wiring lands before or after [F09](../F09/APPROVED.md).

## Entanglement with F09

[F09 is APPROVED](../F09/APPROVED.md) with Proposal C — extract a `WorkerAgent extends BaseAgent` base class, move the duplicated `normalizeTask` / `parseTaskReport` / `buildFailureReport` helpers into a shared `src/agents/task-report.ts`, and shrink each worker file to a system prompt plus a minimal `WorkerAgent` subclass. F09's plan also commits to **deleting** `src/agents/designer.ts` because every helper in it is a stale near-duplicate of the live workers (the `parseTaskReport` body at [designer.ts L191-L240](../../../../src/agents/designer.ts#L191-L240) and the `buildFailureReport` at [designer.ts L242-L267](../../../../src/agents/designer.ts#L242-L267) are diverged copies that no test exercises). F09 explicitly anticipates this issue in its cross-issue note: "If F01 is independently resolved beforehand with a different verdict (e.g. 'wire designer up properly'), F09 should land first and a fresh F01 commit can wire the now-`WorkerAgent`-based designer with ~20 lines of subclass code." ([F09/03-plan-r2.md §5](../F09/03-plan-r2.md)).

Wiring the current orphan in-place would re-introduce the same duplication F09 was approved to remove. Therefore F01 must either (a) wire in-place and accept that F09 will rewrite the wired file anyway, or (b) sequence after F09 so the new Designer is a direct `WorkerAgent` subclass from the start.

## Contract a wired Designer must satisfy

If `DesignerAgent` becomes a real role, every place that enumerates roles must mention it. Concretely:

| Surface | File | Required change |
| --- | --- | --- |
| `AgentRole` union | [src/agents/types.ts L19-L28](../../../../src/agents/types.ts#L19-L28) | add `"designer"` |
| `Task.type` | [src/types.ts L108](../../../../src/types.ts#L108) | add `"design"` |
| `Task.assigned_to` | [src/types.ts L109](../../../../src/types.ts#L109) | add `"designer"` |
| `TaskReport.agent` | [src/types.ts L160](../../../../src/types.ts#L160) | add `"designer"` |
| `AgentState.agent_type` | [src/types.ts L274-L283](../../../../src/types.ts#L274-L283) | add `"designer"` |
| Routing key map | [src/routing/resolver.ts L3-L16](../../../../src/routing/resolver.ts#L3-L16) | add `designer: "designer"` (own model key) or alias to an existing worker key |
| Self-check defaults | [src/runtime/self-check.ts L10-L19](../../../../src/runtime/self-check.ts#L10-L19) | add `designer: 15` (parity with other workers) |
| Dispatcher tool set | [src/runtime/dispatcher.ts L16-L33](../../../../src/runtime/dispatcher.ts#L16-L33) | add `"run_designer"` to `DISPATCH_TOOLS` and `run_designer: "designer"` to `DISPATCH_ROLE_MAP` |
| Dispatch tool schema | [src/agents/base.ts L857-L962](../../../../src/agents/base.ts#L857-L962) | add `RUN_DESIGNER_SCHEMA` and include it in `ROLE_DISPATCH_TOOLS.manager` |
| Bootstrap spawner switch | [src/server/bootstrap.ts L290-L367](../../../../src/server/bootstrap.ts#L290-L367) | add a `case "designer":` branch that constructs the agent |
| Public barrel | [src/index.ts L55-L65](../../../../src/index.ts#L55-L65) | export `DesignerAgent` |
| Manager prompt | [src/agents/manager.ts L29-L51](../../../../src/agents/manager.ts#L29-L51) (worker roster narrative) and [manager.ts L77-L116](../../../../src/agents/manager.ts#L77-L116) (tool reference block) | add a Designer paragraph + `run_designer({ task, stageId })` reference |
| Manager dispatch guard | [src/agents/manager.ts L335](../../../../src/agents/manager.ts#L335) `hasUsedToolNamed(...)` | add `"run_designer"` to the list |
| Tests | [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) | add a `DesignerAgent` smoke test mirroring the `CoderAgent` test |

This roster of touch sites is itself evidence that the role was never wired — eleven independent surfaces all omit it consistently.

## Call sites & dependencies of the orphan file today

There are none. The file imports `BaseAgent`, `AgentContext`, `AgentResult`, `WorkerInput`, `Agent`, `TaskReport`, `log`, and `buildHandoffContext`. Nothing imports it back. Removing the file therefore breaks no compile.

## Constraints any solution must respect

1. **Project guideline: architecture-first, no backward compatibility.** The four worker helper copies are about to be deleted by F09 in favour of `src/agents/task-report.ts` + `src/agents/worker.ts`. Any new Designer must use those shared modules; copying the orphan's helpers forward is forbidden.
2. **Operator instruction.** Deletion-without-replacement is not an acceptable terminal state. The Designer role must exist in the wired system.
3. **F09 is approved and will land.** F09's plan ([F09/03-plan-r2.md step 7](../F09/03-plan-r2.md)) explicitly deletes [src/agents/designer.ts](../../../../src/agents/designer.ts) inside the F09 commit. F01's design must either pre-empt that step (wire first, then F09 rewrites) or follow it (F09 deletes, F01 re-creates clean).
4. **Schemas are persisted on disk.** Adding `"designer"` to `Task.assigned_to` / `TaskReport.agent` / `AgentState.agent_type` is purely additive at the type level (existing on-disk JSON without `designer` continues to validate), so this widening is safe and does not need a migration.
5. **Out of scope per [_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md):** anything under `src/skills/` and the skills/memory specs. The `skillContext.agentRole: "designer"` channel used by skill loading lives outside F01's remit — it is enough that the new role string is consistent; the skill subsystem owner can pick it up.
