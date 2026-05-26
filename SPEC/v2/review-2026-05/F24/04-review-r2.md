# F24 — Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F24-shutdown-handoff-delete-on-read.md](SPEC/v2/review-2026-05/F24-shutdown-handoff-delete-on-read.md)
- [SPEC/v2/review-2026-05/F24/04-review-r1.md](SPEC/v2/review-2026-05/F24/04-review-r1.md)
- [SPEC/v2/review-2026-05/F24/01-analysis-r2.md](SPEC/v2/review-2026-05/F24/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F24/02-design-r2.md](SPEC/v2/review-2026-05/F24/02-design-r2.md)
- [SPEC/v2/review-2026-05/F24/03-plan-r2.md](SPEC/v2/review-2026-05/F24/03-plan-r2.md)
- Spot-checks: [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74-L95), [src/store/documents.ts](src/store/documents.ts#L6-L17), [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L113-L173), [src/server/bootstrap.ts](src/server/bootstrap.ts#L255-L259)

## Findings

### Analysis

No blocking findings. The r2 analysis resolves the r1 contradiction by explicitly narrowing F24 to delete-on-read forensics loss and post-consume preservation, while moving cross-generation stale replay into an out-of-scope lineage problem. That is an acceptable response to r1 required change 1 because the docs no longer claim that Proposal A prevents an unsuffixed handoff from a prior process generation being consumed as fresh.

The current code spot-check supports the restated scope: [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74-L95) deletes the request after summary write and deletes either the summary or fallback request during consume. The analysis also correctly preserves the operator mitigation for repurposed-harness stale files instead of declaring it obsolete.

### Design

No blocking findings. Proposal A now uses one filename contract throughout: `${path}.consumed`, producing `shutdown-summary.json.consumed` and `shutdown-request.json.consumed`. The design's claim is properly limited to forensic preservation, preventing runtime re-read of already consumed files, and preserving data for operator recovery after the consume-before-queue failure window.

Proposal B remains a valid one-conceptual-level-up alternative and is reasonably rejected for this round as over-broad. The limitation around cross-generation stale replay is stated in the risk section rather than hidden behind a migration shim or transitional compatibility path, which matches the loop conventions.

### Plan

No blocking findings. The edit plan is executable against the current source: [src/store/documents.ts](src/store/documents.ts#L6-L17) already imports `renameSync`, and [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74-L95) has the three delete sites the plan replaces. The test plan updates the existing delete-on-read assertions in [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts#L113-L173) and adds targeted coverage for both one-slot replacement and non-re-read of `.consumed` files.

The validation commands use the Saivage repo conventions (`npm run typecheck`, focused Vitest, `npm run build`). The cross-issue ordering note correctly keeps this before any F22 document-store async rewrite and independent of F08.

## Required changes

None.

## Strengths

- The r2 revision directly answers all three r1 required changes without expanding scope.
- The recommended proposal is small, architectural, and avoids backward-compatibility shims.
- The tests document the exact lifecycle contract: pending files are unsuffixed; consumed files are forensic-only.

VERDICT: APPROVED