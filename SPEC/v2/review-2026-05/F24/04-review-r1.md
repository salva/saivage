# F24 — Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F24-shutdown-handoff-delete-on-read.md](SPEC/v2/review-2026-05/F24-shutdown-handoff-delete-on-read.md)
- [SPEC/v2/review-2026-05/F24/01-analysis-r1.md](SPEC/v2/review-2026-05/F24/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F24/02-design-r1.md](SPEC/v2/review-2026-05/F24/02-design-r1.md)
- [SPEC/v2/review-2026-05/F24/03-plan-r1.md](SPEC/v2/review-2026-05/F24/03-plan-r1.md)
- Spot-checks: [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74-L88), [src/server/bootstrap.ts](src/server/bootstrap.ts#L255-L257), [src/store/documents.ts](src/store/documents.ts#L6-L17)

## Findings

### Analysis

The analysis correctly identifies the current delete-on-read behavior: `writeShutdownSummary` deletes the request after summary write, and `consumeShutdownHandoff` deletes either the summary or fallback request before returning planner text ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74-L88)). It also correctly notes that bootstrap queues the returned directive only after `consumeShutdownHandoff` returns ([src/server/bootstrap.ts](src/server/bootstrap.ts#L255-L257)).

One correctness tension needs to be resolved before approval: the constraints say stale files from a prior process generation must not be re-consumed as fresh ([SPEC/v2/review-2026-05/F24/01-analysis-r1.md](SPEC/v2/review-2026-05/F24/01-analysis-r1.md#L39-L40)), but the same analysis accepts pre-existing unsuffixed `shutdown-summary.json` being consumed on first start after the fix ([SPEC/v2/review-2026-05/F24/01-analysis-r1.md](SPEC/v2/review-2026-05/F24/01-analysis-r1.md#L44)). Since the current consumer reads any valid unsuffixed summary at startup, the design must state a concrete freshness or ownership rule if stale replay is still part of the required fix.

### Design

Proposal A preserves forensics after a successful read, but it does not close the skipped-consume stale-replay half that the analysis requires. The proposed rename happens only inside the consumer ([SPEC/v2/review-2026-05/F24/02-design-r1.md](SPEC/v2/review-2026-05/F24/02-design-r1.md#L17-L20)); if startup never reaches `consumeShutdownHandoff`, the old `shutdown-summary.json` remains unsuffixed and a later bootstrap will still treat it as pending. The recommendation therefore overclaims when it says Proposal A closes both halves of the bug, including "no stale replay" ([SPEC/v2/review-2026-05/F24/02-design-r1.md](SPEC/v2/review-2026-05/F24/02-design-r1.md#L102)).

There is also a concrete filename contract mismatch. The design names consumed files as `shutdown-summary.consumed.json` / `*.consumed.json` ([SPEC/v2/review-2026-05/F24/02-design-r1.md](SPEC/v2/review-2026-05/F24/02-design-r1.md#L5-L20)), while the plan implements `${path}.consumed`, producing `shutdown-summary.json.consumed` ([SPEC/v2/review-2026-05/F24/03-plan-r1.md](SPEC/v2/review-2026-05/F24/03-plan-r1.md#L16-L24)). Either spelling can work, but the approved design and implementation plan must use one contract throughout.

### Plan

The implementation steps are otherwise executable in the current codebase: `renameSync` is already imported by the document store ([src/store/documents.ts](src/store/documents.ts#L6-L17)), and the listed source edits line up with the current delete sites ([src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L74-L88)).

The planned new test only covers replacing a consumed file after two successful consume cycles ([SPEC/v2/review-2026-05/F24/03-plan-r1.md](SPEC/v2/review-2026-05/F24/03-plan-r1.md#L44-L46)). That does not exercise the stale-replay condition where a valid old unsuffixed summary survives because no consumer ran. The plan also says the operator memory note becomes obsolete once consume rename-stamps the file ([SPEC/v2/review-2026-05/F24/03-plan-r1.md](SPEC/v2/review-2026-05/F24/03-plan-r1.md#L49)), but that is only true after a consume path has actually executed.

## Required changes

1. Reconcile the stale-replay requirement across analysis, design, and plan. Either revise the chosen proposal so a valid old unsuffixed handoff from a prior process generation cannot be consumed as fresh, or explicitly narrow the issue to forensic preservation after read and remove the "closes both halves" / "memory note obsolete" claims.
2. Make the consumed-file suffix contract consistent everywhere: design, plan, tests, operator examples, and rollback text must all use either `*.consumed.json` or `*.json.consumed`.
3. Add or revise the test plan to cover the chosen stale-file semantics. If stale replay remains in scope, include a case with a valid unsuffixed old `shutdown-summary.json` / `shutdown-request.json` that survived because consume was skipped.

## Strengths

- The current behavior and bootstrap call site are mapped accurately.
- Proposal A is appropriately small for the forensic-preservation part of the bug.
- Proposal B usefully captures the future append-only history direction without forcing it into this round.
- The validation commands use the Saivage repo's Vitest/typecheck/build conventions.

VERDICT: CHANGES_REQUESTED
