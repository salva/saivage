# F03 — Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F03-naive-json-extraction.md](SPEC/v2/review-2026-05/F03-naive-json-extraction.md)
- [SPEC/v2/review-2026-05/F03/04-review-r1.md](SPEC/v2/review-2026-05/F03/04-review-r1.md)
- [SPEC/v2/review-2026-05/F03/01-analysis-r2.md](SPEC/v2/review-2026-05/F03/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F03/02-design-r2.md](SPEC/v2/review-2026-05/F03/02-design-r2.md)
- [SPEC/v2/review-2026-05/F03/03-plan-r2.md](SPEC/v2/review-2026-05/F03/03-plan-r2.md)
- Source spot-checks for the regex sites, `parseJsonObject`, schemas, worker failure helpers, and provider structured-output claims.

## Findings

### Analysis

The r2 analysis resolves the r1 factual correction about fenced JSON: the old regex starts at the first `{` and ends at the last `}`, so a single fenced JSON object parses today, while the real failure remains greedy merging across multiple objects or later stray braces. The source count also checks out: the current tree has eight regex extraction sites, including [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L182-L196), plus supervisor's local `parseJsonObject` at [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L204-L218). The `TaskReportSchema.agent` constraint is factual as well: [src/types.ts](src/types.ts#L157-L170) still omits `"designer"`, while [src/agents/designer.ts](src/agents/designer.ts#L191-L244) injects `agent: "designer"` at runtime.

One r1 consistency issue is not fully closed. The analysis now defines `extractJsonCandidates(text)` as returning the trimmed whole message, fenced bodies, and balanced brace spans, while `no_json` is defined as `extractJsonCandidates` returning `[]`. If the trimmed whole message is always a candidate, then any non-empty prose-only response has a candidate and becomes `invalid_json`, not `no_json`. That conflicts with the E1 contract and with the r2 plan's tests for prose-only input.

### Design

Proposal B remains the right architectural direction. It deletes the duplicated extraction logic, validates at the LLM-output boundary, removes silent-success fallbacks for worker/manager/inspector paths, and correctly decouples F03 from F01 by validating worker payloads with `TaskReportSchema.omit({ agent: true }).partial()`.

The extractor contract still needs one precise correction before implementation. The design says `extractJsonCandidates` returns the whole `text.trim()` candidate so clean provider JSON is handled, but `parseLlmJsonAs` reports `no_json` only when the candidate list is empty. This makes `no_json` unreachable for non-empty prose-only model output. The design should either include the whole-message candidate only when it is plausibly JSON, or redefine the public reasons and tests so prose-only output is intentionally `invalid_json`. The current documents state both behaviours.

There is also a wording mismatch in the typed-parser rule. The r2 change notes say `parseLlmJsonAs` picks the last candidate that both parses and satisfies the schema, but the detailed algorithm parses all candidates and schema-checks only the last parseable candidate. The latter is the better rule for F03 because a later wrong-shaped final report should surface as `schema_mismatch` instead of falling back to an earlier example. The documents should state that rule consistently.

### Plan

The plan is mostly executable and names the correct validation commands for this repo. The source spot-checks confirm the referenced schemas and existing failure helpers exist: worker `buildFailureReport` functions are present in the five worker files, `buildFailureSummary` exists in [src/agents/manager.ts](src/agents/manager.ts#L439), `InspectionReportSchema` exists at [src/types.ts](src/types.ts#L234-L246), and provider structured-output support is not currently wired beyond unrelated `tool_choice` handling in [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L108).

However, Step 1 and Step 2 currently contradict each other. Step 1 says the extractor always returns `text.trim()` as a candidate "even if it does not look like JSON"; Step 2 says `extractJsonCandidates` returns `[]` for prose-only input with no `{`, and `parseLlmJsonAs` should return `no_json` for the same case. An implementer following Step 1 will fail the Step 2 tests and will not get the advertised reason taxonomy.

## Required changes

1. Make the candidate-enumeration contract internally consistent across analysis, design, and plan. In particular, decide whether non-empty prose-only text produces no candidates (`no_json`) or one raw whole-message candidate (`invalid_json`), then align `extractJsonCandidates`, `parseLlmJsonAs`, E1/E2, and the Step 2 tests with that decision.
2. State the typed-parser selection rule consistently. If the intended rule is "schema-check the last parseable candidate and return `schema_mismatch` if it is the wrong shape," remove the wording that says `parseLlmJsonAs` picks the last schema-satisfying candidate. If the intended rule is instead "last schema-valid wins," update the detailed algorithm and tests accordingly.

## Strengths

- The r1 fenced-code factual error was corrected cleanly.
- The source inventory and provider structured-output assessment match the current tree.
- Proposal B now handles the designer/F01 interaction without requiring cross-issue sequencing.
- The plan uses the repo's Vitest/typecheck/build conventions and gives implementers focused regression tests for the core failure modes.

VERDICT: CHANGES_REQUESTED
