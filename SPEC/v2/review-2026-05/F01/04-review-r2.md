# F01 - Review (R2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)
- [F01-designer-agent-orphan.md](../F01-designer-agent-orphan.md)
- [04-review-r1.md](04-review-r1.md)
- [01-analysis-r2.md](01-analysis-r2.md)
- [02-design-r2.md](02-design-r2.md)
- [03-plan-r2.md](03-plan-r2.md)
- [../F09/02-design-r2.md](../F09/02-design-r2.md)
- [../F09/03-plan-r2.md](../F09/03-plan-r2.md)
- Spot checks: [src/agents/designer.ts](../../../../src/agents/designer.ts), [src/agents/types.ts](../../../../src/agents/types.ts), [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts), [src/types.ts](../../../../src/types.ts), [src/agents/manager.ts](../../../../src/agents/manager.ts), [src/agents/base.ts](../../../../src/agents/base.ts), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [src/routing/resolver.ts](../../../../src/routing/resolver.ts), [src/runtime/self-check.ts](../../../../src/runtime/self-check.ts), source grep for `DesignerAgent|\bdesigner\b|run_designer|"designer"` under [src](../../../../src)

## Findings

### Analysis

The r1 substantive analysis gap is fixed. [01-analysis-r2.md](01-analysis-r2.md) now adds the Manager prompt's valid-values sentence as a role-enumerating surface, and the live source confirms the sentence still excludes both `design` and `designer` at [src/agents/manager.ts](../../../../src/agents/manager.ts#L260). The contract table also carries that surface forward with the right required change.

The orphan evidence remains factually correct. A source grep for `DesignerAgent|\bdesigner\b|run_designer|"designer"` under [src](../../../../src) returns only [src/agents/designer.ts](../../../../src/agents/designer.ts), while the role union, dispatcher maps, task/report/runtime-state schemas, base dispatch-tool exposure, bootstrap spawner, routing map, self-check defaults, and manager prompt all omit Designer as described.

One convention-level reference error remains: [01-analysis-r2.md](01-analysis-r2.md#L27) links the issue file as `../../F01-designer-agent-orphan.md#L25-L27`. From the `F01/` directory that resolves to `SPEC/v2/F01-designer-agent-orphan.md`, which does not exist. The actual issue file is one level up at [F01-designer-agent-orphan.md](../F01-designer-agent-orphan.md), so the link should be `../F01-designer-agent-orphan.md#L25-L27`. This violates the loop convention requiring verified clickable file references.

### Design

The r1 constructor-shape objection is fixed. [02-design-r2.md](02-design-r2.md) changes the proposed public `DesignerAgent` constructor to `config?: Partial<BaseAgentConfig>`, imports `BaseAgentConfig` from [src/agents/base.ts](../../../../src/agents/base.ts), imports only `WorkerAgent` from the future [src/agents/worker.ts](../../../../src/agents/worker.ts), and aligns with the F09 worker-subclass pattern approved in [../F09/02-design-r2.md](../F09/02-design-r2.md).

Proposal C remains the right recommendation. It respects the operator note by making Designer wired in the terminal state, while avoiding the stale helper duplication in the current [src/agents/designer.ts](../../../../src/agents/designer.ts) and preserving F09's approved ordering.

### Plan

The r1 plan gaps are fixed. [03-plan-r2.md](03-plan-r2.md) now carries the `Partial<BaseAgentConfig>` constructor signature into Step 9, explains why the bootstrap spawner's `onActivity` call remains compatible, and explicitly updates the Manager prompt's valid-values sentence in Step 11.

The implementation plan is concrete enough to hand to an engineer after the broken analysis link is corrected. It lists the F09 precondition, all required role-enumerating surfaces, focused test coverage, repo-local Vitest/typecheck/build commands, rollback, and cross-issue ordering.

## Required changes

1. Fix [01-analysis-r2.md](01-analysis-r2.md#L27) so the operator-note link points to `../F01-designer-agent-orphan.md#L25-L27` instead of `../../F01-designer-agent-orphan.md#L25-L27`.

## Strengths

- The r2 documents address all three r1 required changes without changing the approved direction.
- The source claims checked against the current TypeScript files are accurate.
- Proposal C keeps F01 aligned with F09's approved `WorkerAgent` extraction and the project's architecture-first/no-duplication guideline.
- The plan now covers both prompt-level Manager surfaces: worker/tool exposure and the valid `type` / `assigned_to` sentence.

VERDICT: CHANGES_REQUESTED
