# F31 Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F31-base-agent-prompt-doc-mismatch.md](SPEC/v2/review-2026-05/F31-base-agent-prompt-doc-mismatch.md)
- [SPEC/v2/review-2026-05/F31/01-analysis-r1.md](SPEC/v2/review-2026-05/F31/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F31/02-design-r1.md](SPEC/v2/review-2026-05/F31/02-design-r1.md)
- [SPEC/v2/review-2026-05/F31/03-plan-r1.md](SPEC/v2/review-2026-05/F31/03-plan-r1.md)
- [SPEC/v2/review-2026-05/F18/02-design-r2.md](SPEC/v2/review-2026-05/F18/02-design-r2.md)
- Supporting check: [SPEC/v2/review-2026-05/F18/03-plan-r2.md](SPEC/v2/review-2026-05/F18/03-plan-r2.md) and [SPEC/v2/review-2026-05/F18/APPROVED.md](SPEC/v2/review-2026-05/F18/APPROVED.md)
- Spot-checked: [src/agents/base.ts](src/agents/base.ts#L104-L105), plus the absence of a repo-local `prompts/` directory before F18 lands.

## Findings

### Analysis

No blocking issues. The analysis correctly identifies the real contract mismatch: `BaseAgentConfig.systemPrompt` is currently an already-rendered string, while its JSDoc promises a `prompts/<role>.md` source layout that does not exist yet. The requested spot-check confirms the stale comment is exactly at [src/agents/base.ts](src/agents/base.ts#L104-L105), and the repository currently has no `prompts/` tree under the Saivage repo root.

The relationship to F18 is also accurate. F18's approved Proposal B creates the prompt tree, adds the loader, ships `prompts/` into `dist/`, and rewrites this same JSDoc to point at the now-real layout. The original inventory entry's older line reference has drifted, but the operative F31 analysis uses the current line reference and is therefore sufficient.

### Design

Approved. Proposal A is the cleanest design because it avoids two issues fighting over the same two lines in [src/agents/base.ts](src/agents/base.ts#L104-L105). Since F18 is already approved and explicitly owns both the prompt-loader implementation and the JSDoc rewrite, F31 should not create a temporary source edit that F18 immediately replaces.

Proposal B is a valid fallback: if F18 is blocked or descoped, replacing the stale JSDoc with `Rendered system prompt string` is a truthful one-line fix with no migration shim or compatibility story. Proposal C is correctly rejected because an F31-owned loader would duplicate F18's approved architecture and split ownership of the same prompt subsystem.

### Plan

Approved. The recommended plan is executable as a zero-source-edit administrative closure: wait for F18, verify that the stale `from prompts/<role>.md` wording is gone, verify the rendered-role JSDoc and prompt tree exist, and carry F31 as closed-by-F18 in the metaplan. This approval should be read as approval of the F31 plan, not as evidence that the live source issue is already fixed before F18 lands.

The fallback path is also sufficiently specified if F18 stops being available: one file, one JSDoc replacement, standard typecheck/build validation, and no invented future layout. The cross-issue ordering note is correct that an independent F31 patch should not precede F18 unless the fallback is deliberately selected.

## Required changes

None.

## Strengths

- Correctly avoids churn and merge conflict on the exact line F18 already owns.
- Keeps the fallback small, truthful, and free of backward-compatibility machinery.
- Makes the dependency on F18 explicit enough for the final metaplan to sequence F31 without a separate implementation batch.

VERDICT: APPROVED