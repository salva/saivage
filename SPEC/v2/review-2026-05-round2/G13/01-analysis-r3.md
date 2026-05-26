# G13 — Functional analysis (round 3)

**Finding:** [SPEC/v2/review-2026-05-round2/G13-conventions-file-mixes-two-concerns.md](../G13-conventions-file-mixes-two-concerns.md)
**Subsystem map row:** Agents + Chat — see [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)
**Round 2:** [01-analysis-r2.md](01-analysis-r2.md)
**R2 review:** [04-review-r2.md](04-review-r2.md)

## R3 deltas vs r2

- No substantive change. The R2 review accepts the functional analysis ("the substantive R1 blockers are fixed") and only flags a validation-command bug in the plan ([04-review-r2.md](04-review-r2.md#L1)).
- Restate one fact made sharper by the R2 review: the surviving [src/agents/conventions.ts](../../../../src/agents/conventions.ts) consumers after the split all use **same-directory** imports ([src/agents/roster.ts](../../../../src/agents/roster.ts#L11), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L10), [src/agents/roster.test.ts](../../../../src/agents/roster.test.ts#L24) — all `from "./conventions.js"`). The two cross-directory consumers in [src/chat/localCommands.ts](../../../../src/chat/localCommands.ts#L14) and [src/chat/localCommands.test.ts](../../../../src/chat/localCommands.test.ts#L21) (`from "../agents/conventions.js"`) are removed by the split. This is the fact the r2 validation grep failed to verify; the analysis itself is unchanged.

## 1. What the code does today

Unchanged from [01-analysis-r2.md §1](01-analysis-r2.md#L19).

## 2. Why the mix is wrong

Unchanged from [01-analysis-r2.md §2](01-analysis-r2.md#L24).

## 3. Scope of the fix

Unchanged from [01-analysis-r2.md §3](01-analysis-r2.md#L31).

## 4. Constraints

Unchanged from [01-analysis-r2.md §4](01-analysis-r2.md#L40).

## 5. Risks if left as-is

Unchanged from [01-analysis-r2.md §5](01-analysis-r2.md#L48).
