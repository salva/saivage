# F02 — Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F02-agent-roster-drift.md](SPEC/v2/review-2026-05/F02-agent-roster-drift.md)
- [SPEC/v2/review-2026-05/F02/01-analysis-r1.md](SPEC/v2/review-2026-05/F02/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F02/02-design-r1.md](SPEC/v2/review-2026-05/F02/02-design-r1.md)
- [SPEC/v2/review-2026-05/F02/03-plan-r1.md](SPEC/v2/review-2026-05/F02/03-plan-r1.md)
- Source spot-checks: [src/agents/types.ts](src/agents/types.ts), [src/types.ts](src/types.ts), [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts), [src/runtime/supervisor.ts](src/runtime/supervisor.ts), [src/agents/base.ts](src/agents/base.ts), [src/agents/planner.ts](src/agents/planner.ts), [src/agents/manager.ts](src/agents/manager.ts), [src/config.ts](src/config.ts), [src/routing/resolver.ts](src/routing/resolver.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts), [src/runtime/self-check.ts](src/runtime/self-check.ts), [src/agents/conventions.ts](src/agents/conventions.ts), [SPEC/v2/00-AGENT-SYSTEM.md](SPEC/v2/00-AGENT-SYSTEM.md), [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md)

## Findings

### Analysis

The factual inventory is broadly accurate. The spot-check confirms the key drift sites: `TaskSchema.assigned_to` includes the four worker roles in [src/types.ts](src/types.ts#L109), `AgentStateSchema.agent_type` includes the eight live non-designer roles in [src/types.ts](src/types.ts#L269-L278), dispatcher tools include manager/coder/researcher/data_agent/reviewer/inspector in [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L16-L32), supervisor abort priority is the five-role list in [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L14-L20), and the SPEC is stale for task/report/runtime enums in [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L163-L193) and [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L351).

One analysis claim becomes a plan requirement that is not carried through: [SPEC/v2/review-2026-05/F02/01-analysis-r1.md](SPEC/v2/review-2026-05/F02/01-analysis-r1.md#L77) says the SPEC enum lists will be asserted by a doctests-style check against the roster. The implementation plan updates the SPEC manually but does not add that check.

### Design

Proposal A does not fully close one of the concrete F02 symptoms it identifies. The analysis correctly says the Planner prompt omits Data Agent and Reviewer in [SPEC/v2/review-2026-05/F02/01-analysis-r1.md](SPEC/v2/review-2026-05/F02/01-analysis-r1.md#L39), matching the current source at [src/agents/planner.ts](src/agents/planner.ts#L25). But the recommended design leaves prompt headers handwritten until F18 in [SPEC/v2/review-2026-05/F02/02-design-r1.md](SPEC/v2/review-2026-05/F02/02-design-r1.md#L84) and [SPEC/v2/review-2026-05/F02/03-plan-r1.md](SPEC/v2/review-2026-05/F02/03-plan-r1.md#L127). The statement that handwritten prompts "no longer can disagree with the schemas" in [SPEC/v2/review-2026-05/F02/02-design-r1.md](SPEC/v2/review-2026-05/F02/02-design-r1.md#L145-L146) is false if those prompts are not generated from the roster. This is a completeness problem, not a stylistic preference.

The config-model-key proposal is also underspecified. The current schema accepts `planner`, `manager`, `inspector`, `executor`, and `chat` model keys in [src/config.ts](src/config.ts#L38-L46), while routing maps planner/manager/inspector to `orchestrator` and `executor` to `executor` in [src/routing/resolver.ts](src/routing/resolver.ts#L4-L12). Deriving schema keys only from `defaultModelKey` values as sketched in [SPEC/v2/review-2026-05/F02/03-plan-r1.md](SPEC/v2/review-2026-05/F02/03-plan-r1.md#L49-L56) would not necessarily remove only `executor`; it can also remove the accepted planner/manager/inspector keys if those entries keep `defaultModelKey: "orchestrator"`. That may be the right cleanup, but the design must state it and test it.

### Plan

Step 11 is not type-executable as written. The plan says to narrow the bootstrap spawner parameter to a dispatchable-role type in [SPEC/v2/review-2026-05/F02/03-plan-r1.md](SPEC/v2/review-2026-05/F02/03-plan-r1.md#L75), but `ChildSpawner` is still typed as accepting any `AgentRole` in [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L36-L39), and `createChildSpawner()` returns `ChildSpawner` in [src/server/bootstrap.ts](src/server/bootstrap.ts#L268-L270). Under `strictFunctionTypes`, a function accepting a narrower `DispatchableRole` is not a valid replacement for a function type that promises to accept every `AgentRole`. The plan needs to either change the dispatcher contract to `DispatchableRole` end-to-end or keep the public `AgentRole` parameter and perform a narrowing before the exhaustive switch.

The rollback/external-behaviour paragraph is factually wrong about config parsing. [SPEC/v2/review-2026-05/F02/03-plan-r1.md](SPEC/v2/review-2026-05/F02/03-plan-r1.md#L120) says operators with `models.executor` would get a Zod strict-parse error, but the config schema is a normal `z.object` parsed at [src/config.ts](src/config.ts#L34-L46) and [src/config.ts](src/config.ts#L195), with no `.strict()`, `.catchall()`, or `.passthrough()`. Unknown keys are stripped by Zod by default, not rejected. Either make the schema strict and document that broader behavioural change, or revise the plan to reflect the actual stripping behaviour.

## Required changes

1. Revise the recommendation so the selected proposal actually resolves prompt-role drift, or explicitly rescope F02 and remove the false claim that handwritten prompts cannot disagree. Acceptable fixes include selecting Proposal B, or extending Proposal A/Plan to compose or update the Planner/agent role headers from `renderRosterSummary()` in the same change.
2. Make the `models` key semantics precise. State whether planner/manager/inspector keys are intentionally removed or retained, align `defaultModelKey` and `configSchema` with that decision, update router tests accordingly, and correct the rollback/external-behaviour text about Zod strictness.
3. Specify the dispatchable-role type change end-to-end. Export a derived `DispatchableRole`/`DISPATCHABLE_ROLES`, use it for `DISPATCH_ROLE_MAP`, `ChildSpawner`, and `createChildSpawner()` if narrowing is desired, or otherwise keep `AgentRole` and add an explicit narrowing helper before `assertExhaustive()`.
4. Either add the promised SPEC enum consistency check to the plan and tests, or remove the analysis claim that the SPEC lists will be asserted by a doctests-style check.

## Strengths

- The source inventory is careful and mostly verified against the current tree.
- The recommended direction of a single declarative roster is architecturally sound and matches the no-backward-compat guideline.
- The plan has the right validation baseline for this repo: typecheck, build, and focused Vitest runs.

VERDICT: CHANGES_REQUESTED