# G13 — Design (round 3)

**Analysis:** [01-analysis-r3.md](01-analysis-r3.md)
**Round 2:** [02-design-r2.md](02-design-r2.md)
**R2 review:** [04-review-r2.md](04-review-r2.md)

## R3 deltas vs r2

- No design change. The R2 review explicitly states "No design change is needed beyond [the] validation correction" ([04-review-r2.md](04-review-r2.md#L15)). Proposal A — extract the registry into `src/chat/localCommandRegistry.ts`, delete the second half of [src/agents/conventions.ts](../../../../src/agents/conventions.ts), and remove the unused `checkConvention` import from [src/agents/base.ts](../../../../src/agents/base.ts#L35) — stands.
- Module-boundaries table, behavioural invariants, layering rationale, test relocations, and the rejection of Proposal B are all unchanged.

## Proposal A (recommended)

Unchanged from [02-design-r2.md "Proposal A"](02-design-r2.md#L13).

## Module boundaries after the change

Unchanged from [02-design-r2.md "Module boundaries after the change"](02-design-r2.md#L17).

## Why this passes the layering check

Unchanged from [02-design-r2.md "Why this passes the layering check"](02-design-r2.md#L27).

## Test relocations

Unchanged from [02-design-r2.md "Test relocations"](02-design-r2.md#L34).

## Behavioural invariants

Unchanged from [02-design-r2.md "Behavioural invariants"](02-design-r2.md#L41).

## Proposal B (rejected)

Unchanged from [02-design-r2.md "Proposal B (rejected)"](02-design-r2.md#L48).

## Recommendation

Adopt Proposal A. The only r3 change lives in the validation section of the plan; see [03-plan-r3.md](03-plan-r3.md).
