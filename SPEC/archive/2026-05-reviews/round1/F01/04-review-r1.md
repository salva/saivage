# F01 - Review (R1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)
- [F01-designer-agent-orphan.md](../F01-designer-agent-orphan.md)
- [01-analysis-r1.md](01-analysis-r1.md)
- [02-design-r1.md](02-design-r1.md)
- [03-plan-r1.md](03-plan-r1.md)
- [../F09/APPROVED.md](../F09/APPROVED.md)
- [../F09/02-design-r2.md](../F09/02-design-r2.md)
- [../F09/03-plan-r2.md](../F09/03-plan-r2.md)
- Spot checks: [src/agents/designer.ts](../../../../src/agents/designer.ts), source grep for `Designer|designer` under [src](../../../../src)

## Findings

### Analysis

The orphan claim is factually correct. The source grep for `Designer|designer` under [src](../../../../src) returns only hits inside [src/agents/designer.ts](../../../../src/agents/designer.ts), and the checked surfaces omit Designer exactly as described: barrel exports, [src/agents/types.ts](../../../../src/agents/types.ts#L19-L28), [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L16-L33), [src/types.ts](../../../../src/types.ts#L108-L109), [src/types.ts](../../../../src/types.ts#L160), [src/types.ts](../../../../src/types.ts#L274-L283), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L290-L367), [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L3-L16), and [src/runtime/self-check.ts](../../../../src/runtime/self-check.ts#L10-L19).

The analysis misses one required role-enumeration surface: the Manager prompt's task-list schema instructions at [src/agents/manager.ts](../../../../src/agents/manager.ts#L260). That line explicitly lists valid `Task.type` and `assigned_to` values and would continue telling the Manager that only `code/research/data/review/test/document` and `coder/researcher/data_agent/reviewer` are valid. Since F01's own contract says every role-enumerating surface must mention Designer, this omission needs to be added to the contract table and carried into the design/plan.

### Design

Proposal C is the right architecture and aligns with F09's approved ordering: F09 lands first, deletes the stale orphan, and F01 recreates Designer as a minimal `WorkerAgent` subclass with full runtime wiring. That satisfies the operator note as the terminal state while avoiding the duplicated helpers F09 is removing.

The proposed `DesignerAgent` constructor does not align with F09's approved subclass shape. [02-design-r1.md](02-design-r1.md#L76-L84) uses `config?: Partial<WorkerAgentConfig>` and then spreads `...config` after the fixed Designer fields. But F09 defines `WorkerAgentConfig` as including invariant worker fields such as `role`, `systemPrompt`, `buildInitialMessage`, and `invalidFinalResponseMessage` ([../F09/02-design-r2.md](../F09/02-design-r2.md#L215-L220)), while its concrete worker example exposes only `config?: Partial<BaseAgentConfig>` at the subclass boundary ([../F09/02-design-r2.md](../F09/02-design-r2.md#L286-L294)). As written, an external caller could override `role: "designer"` or the prompt builder through config, which violates the fixed-role worker pattern F09 establishes.

### Plan

The implementation plan inherits both gaps:

- [03-plan-r1.md](03-plan-r1.md#L96-L110) repeats the `Partial<WorkerAgentConfig>` constructor shape and should be changed to F09's `Partial<BaseAgentConfig>` pattern, with imports adjusted accordingly.
- [03-plan-r1.md](03-plan-r1.md#L116-L119) updates the Manager roster/tool-reference/guard surfaces, but does not include [src/agents/manager.ts](../../../../src/agents/manager.ts#L260). The plan must explicitly update that valid-values sentence to include `design` and `designer` so the prompt and widened Zod schemas agree.

## Required changes

1. Revise [01-analysis-r1.md](01-analysis-r1.md) to add [src/agents/manager.ts](../../../../src/agents/manager.ts#L260) as a required Designer wiring surface, and propagate that surface into the contract table.
2. Revise [02-design-r1.md](02-design-r1.md) and [03-plan-r1.md](03-plan-r1.md) so the new `DesignerAgent` subclass follows F09's public constructor pattern: `config?: Partial<BaseAgentConfig>` or an equivalently narrow type that cannot override the worker invariant fields.
3. Revise [03-plan-r1.md](03-plan-r1.md) Step 11 to update the Manager prompt's valid task type and assignee list at [src/agents/manager.ts](../../../../src/agents/manager.ts#L260), adding `design` and `designer`.

## Strengths

- The source-level orphan evidence is accurate and well supported.
- The recommended sequencing respects F09's approved `WorkerAgent` extraction instead of wiring duplicated helper code.
- The plan covers the main runtime surfaces that would make Designer actually reachable: role union, schemas, routing, self-check, dispatcher, dispatch tool schema, bootstrap spawner, barrel export, manager tool exposure, and smoke coverage.

VERDICT: CHANGES_REQUESTED