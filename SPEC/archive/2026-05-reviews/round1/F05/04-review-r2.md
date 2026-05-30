# F05 - Review (R2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F05-supervisor-regex-undermines-llm.md](../F05-supervisor-regex-undermines-llm.md)
- [SPEC/v2/review-2026-05/F05/04-review-r1.md](04-review-r1.md)
- [SPEC/v2/review-2026-05/F05/01-analysis-r2.md](01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F05/02-design-r2.md](02-design-r2.md)
- [SPEC/v2/review-2026-05/F05/03-plan-r2.md](03-plan-r2.md)
- Spot-checks: [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts), [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts), [src/log.ts](../../../../src/log.ts)
- Command checks: `rg -n 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src` and fallback `grep -RnE 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src --include='*.ts'`

## Findings

### Analysis

The r2 analysis resolves the r1 factual-documentation blocker. I re-checked the live [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts) file: it is 272 lines, `askModel` is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L125-L147), the log collection block is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L126-L128), the normalizer call is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L146), the supervisor prompt is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L161-L168), `parseVerdict` is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L176-L202), `parseJsonObject` is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L204-L220), the normalizer body is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L222-L257), and the three private predicates are [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L259-L272). Those anchors now point at the symbols and behavior they claim to cite.

The core diagnosis remains correct: the LLM is already instructed to return `stuck=false` for provider throttling, long-running external work, and single transient warnings in [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L161-L168), but the current code still post-processes `parseVerdict(...)` through `normalizeNonStuckOperationalVerdict(...)` at [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L146). The r2 analysis accurately explains both contamination paths: verdict text alone and verdict text plus the 400-line recent-log buffer.

### Design

Proposal B remains the right recommendation. It deletes the duplicate regex policy engine instead of narrowing it, preserves the system prompt as the single policy source, and keeps F03's schema-validation work cleanly separated from F05's post-processor removal. This matches the architecture-first/no-backward-compatibility rule: no transition flag, no legacy regex fallback, and no new configuration surface.

The cross-issue composition is sound. F03 can replace `parseVerdict` internals, F23 can expand abort priority, F04 can change the selected model, and F05 can remove the `SupervisorVerdict.stuck` mutation without requiring those changes in the same patch.

### Plan

The r2 plan is executable. The edit steps are scoped to deleting `normalizeNonStuckOperationalVerdict` and its private predicates, returning `parseVerdict(response.content, provider)` directly from [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L146), and rewriting the two existing supervisor tests at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L198-L252) so the mocked LLM emits `stuck=false` for throttling and long-running work.

The r1 command gap is fixed. I ran the new `rg -n 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src` form from the repo root, and it searches recursively without the `grep: src/: Is a directory` failure. I also ran the documented fallback `grep -RnE 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src --include='*.ts'`; it is likewise recursive and executable. In the current pre-implementation tree both commands correctly print the existing call/definition sites; after the planned deletion they should print no matches.

The validation set uses the repo's real tooling (`npm run typecheck`, `npm run build`, `npx vitest run src/runtime/runtime.test.ts`, `npx vitest run`) and no longer mentions Jest. No additional test deliverable is missing for this issue; the two rewritten tests cover the new contract that the supervisor obeys the LLM verdict it requested.

## Required changes

None.

## Strengths

R2 directly addresses both r1 blockers without changing the approved architectural direction. The final plan is small, deletive, and easy to hand to an implementer: remove the regex adjudicator, trust the parsed verdict, and update the tests to encode that contract.

VERDICT: APPROVED