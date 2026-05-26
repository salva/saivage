# F03 — Review (r3)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F03-naive-json-extraction.md](../F03-naive-json-extraction.md)
- [F03/04-review-r1.md](04-review-r1.md)
- [F03/04-review-r2.md](04-review-r2.md)
- [F03/01-analysis-r3.md](01-analysis-r3.md)
- [F03/02-design-r3.md](02-design-r3.md)
- [F03/03-plan-r3.md](03-plan-r3.md)
- Source spot-checks for the schema references, designer agent handling, supervisor `parseJsonObject`, and prompt-injection cop regex site.

## Findings

### Analysis

No blocking findings.

The r3 analysis resolves the first r2 finding. `extractJsonCandidates(text)` now contributes the whole trimmed message only when `text.trim().startsWith("{")`, so a non-empty prose-only response produces no whole-message candidate, no fenced candidate, no balanced-brace candidate, and therefore reaches `no_json`. The analysis also clearly separates that case from `invalid_json`, where raw candidates exist but none survive `JSON.parse`.

The source facts that matter to the r1/r2 corrections still match the tree: `TaskReportSchema.agent` omits `"designer"` in [src/types.ts](../../../../src/types.ts#L157-L176), designer injects `agent: "designer"` at runtime in [src/agents/designer.ts](../../../../src/agents/designer.ts#L191-L244), supervisor still owns the near-duplicate `parseJsonObject` in [src/runtime/supervisor.ts](../../../../src/runtime/supervisor.ts#L171-L218), and the prompt-injection cop still has the regex extraction site in [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L182-L196).

### Design

No blocking findings.

The r3 design resolves the second r2 finding. It consistently states that `parseLlmJsonAs` picks the last candidate that survives `JSON.parse`, schema-checks that single value, and returns `schema_mismatch` if that last parseable candidate has the wrong shape. It no longer specifies the contradictory "last schema-satisfying candidate wins" behaviour except when explicitly describing the removed r2 wording.

Proposal B remains aligned with the project guidelines: it deletes the duplicated extraction logic, validates at the LLM-output boundary, avoids a backward-compatible silent-success path, and keeps F03 independent from F01 by omitting `agent` from worker payload validation before injecting the runtime-owned role.

### Plan

No blocking findings.

The r3 plan is executable and internally consistent with the analysis and design. Step 1's candidate contract now matches Step 2's `no_json` test for prose-only input, and the typed-parser tests include the important r3 selection-rule assertion: an earlier schema-valid object followed by a later wrong-shaped object must return `schema_mismatch`, not silently fall back to the earlier object.

The implementation sequencing, focused Vitest coverage, straggler greps, and validation commands use the repo conventions from `_LOOP-CONVENTIONS.md`: `npm run typecheck`, `npm run build`, and `npx vitest run ...`.

## Required changes

None.

## Strengths

- Both r2 findings are resolved without introducing a new transition shim or cross-issue dependency.
- The final parser contract has a useful failure taxonomy: `no_json`, `invalid_json`, and `schema_mismatch` are all reachable and tested.
- The plan gives an implementer concrete edits, regression cases, and straggler checks for deleting the old regex sites and supervisor helper.

VERDICT: APPROVED