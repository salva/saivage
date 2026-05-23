# F05 - Review (R1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F05-supervisor-regex-undermines-llm.md](../F05-supervisor-regex-undermines-llm.md)
- [SPEC/v2/review-2026-05/F05/01-analysis-r1.md](01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F05/02-design-r1.md](02-design-r1.md)
- [SPEC/v2/review-2026-05/F05/03-plan-r1.md](03-plan-r1.md)
- Spot-checks: [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts), [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts), [SPEC/v2/review-2026-05/F03/03-plan-r1.md](../F03/03-plan-r1.md)

## Findings

### Analysis

The functional diagnosis is correct. The current supervisor takes the parsed model verdict and immediately runs it through `normalizeNonStuckOperationalVerdict` at [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L146), while the system prompt already instructs the model to mark provider throttling and long-running external work as `stuck=false` at [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L161-L168). The analysis also correctly identifies the two-pass contamination path: verdict text first, then verdict text plus recent logs inside [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L222-L257).

The dependency and test analysis is materially accurate. The existing throttling and long-running tests at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L198-L252) currently feed `stuck=true` and only pass because the normalizer flips the verdict, so rewriting them to feed `stuck=false` is the right contract shift.

There is one factual-documentation problem: several `src/runtime/supervisor.ts` line anchors in the submitted docs no longer point at the cited symbols. The broad ranges mostly still include the relevant code, but the helper-specific anchors do not.

### Design

Proposal B is the right recommendation. It removes the duplicate policy engine, obeys the architecture-first/no-backward-compatibility guideline, and avoids adding configuration or transition shims. Proposal A is correctly described as only narrowing the bad pattern rather than removing it. Proposal C is correctly rejected as a provider-layer structured-output refactor, and the spot-check found no provider-native structured-output API currently wired through [src/providers](../../../../src/providers).

The design composes cleanly with F03: F03 owns `parseVerdict` and `parseJsonObject`, while F05 can remove the normalizer wrapper and predicates without requiring parser work in the same change.

### Plan

The implementation steps are mostly executable and scoped: delete the normalizer and private predicates, change `askModel` to return `parseVerdict(response.content, provider)`, and rewrite the two tests so the mocked LLM emits `stuck=false` for throttling/long-running cases.

The plan has one genuine executability gap. The sanity-grep command is written as `grep -nE '...' src/`, but on this repo/host that form errors because `src/` is a directory. The command must be made recursive or replaced with `rg` before the plan is handoff-ready.

## Required changes

1. Re-verify and update the `src/runtime/supervisor.ts` line anchors across [SPEC/v2/review-2026-05/F05/01-analysis-r1.md](01-analysis-r1.md), [SPEC/v2/review-2026-05/F05/02-design-r1.md](02-design-r1.md), and [SPEC/v2/review-2026-05/F05/03-plan-r1.md). In the current file, the normalizer call is at [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L146), the normalizer body is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L222-L257), `looksLikeLongRunningExternalWork` is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L259-L264), `looksLikeProviderThrottling` is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L266-L268), and `looksLikeMalformedOrCrashed` is [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L270-L272).
2. Fix the sanity-grep command in [SPEC/v2/review-2026-05/F05/03-plan-r1.md](03-plan-r1.md). Use `rg -n 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src` or `grep -RnE 'normalizeNonStuckOperationalVerdict|looksLikeLongRunningExternalWork|looksLikeProviderThrottling|looksLikeMalformedOrCrashed' src --include='*.ts'` in both the Step 3 section and the concrete validation commands.

## Strengths

The core architectural judgment is strong: the plan deletes the internal regex adjudicator instead of tuning it. The test rewrite is also pointed at the right behavior, namely that the supervisor obeys the LLM verdict it requested. The cross-issue sequencing notes for F03, F11, F20, F23, and F04 are useful and do not over-expand F05's implementation scope.

VERDICT: CHANGES_REQUESTED