# F11 — Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F11-magic-constants-not-in-config.md](SPEC/v2/review-2026-05/F11-magic-constants-not-in-config.md)
- [SPEC/v2/review-2026-05/F11/01-analysis-r1.md](SPEC/v2/review-2026-05/F11/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F11/02-design-r1.md](SPEC/v2/review-2026-05/F11/02-design-r1.md)
- [SPEC/v2/review-2026-05/F11/03-plan-r1.md](SPEC/v2/review-2026-05/F11/03-plan-r1.md)

## Findings

### Analysis

The overall classification is strong: the packet correctly separates operator-facing knobs from internal guardrails, and the spot-checked constants in supervisor, MCP runtime, builtins, prompt-injection scanning, notes, and agent retry paths match the source.

One factual correction is required before approval: the analysis says the `EventBus` constructor override exists but no caller uses it in [SPEC/v2/review-2026-05/F11/01-analysis-r1.md](SPEC/v2/review-2026-05/F11/01-analysis-r1.md#L38), while the test suite does use `new EventBus(10)` in [src/events/bus.test.ts](src/events/bus.test.ts#L154-L157). The same analysis later correctly treats the `EventBus` timeout as a test hook that must be preserved or replaced in [SPEC/v2/review-2026-05/F11/01-analysis-r1.md](SPEC/v2/review-2026-05/F11/01-analysis-r1.md#L137-L153), so the document needs to reconcile those statements.

### Design

Proposal B is the right architectural direction for this issue. It avoids the over-configured version of the ticket and keeps the promoted surface small enough to reason about.

The `EventBus` part of the design still rests on the false caller inventory: [SPEC/v2/review-2026-05/F11/02-design-r1.md](SPEC/v2/review-2026-05/F11/02-design-r1.md#L38) says no caller overrides `handlerTimeoutMs`, but [src/events/bus.test.ts](src/events/bus.test.ts#L154-L157) does. Deleting the constructor parameter may still be acceptable, but the design must explicitly say how the timeout test is kept deterministic after the hook is removed, or else keep a non-production test seam with a clear reason.

### Plan

The implementation steps are mostly concrete, but the validation commands are not yet reliable. [SPEC/v2/review-2026-05/F11/03-plan-r1.md](SPEC/v2/review-2026-05/F11/03-plan-r1.md#L139-L143) runs Vitest against source files such as `src/runtime/supervisor.ts`, `src/runtime/notes.ts`, and `src/events/bus.ts`. The repo's Vitest include pattern only matches `src/**/*.test.ts` and `tests/**/*.test.ts` in [vitest.config.ts](vitest.config.ts#L5-L8), with `passWithNoTests` enabled, so these commands can silently execute zero tests. Replace them with real focused test paths, and add or name the focused test files that will cover supervisor force-cancel delay and notes TTL if those behaviours need direct coverage.

## Required changes

1. Correct the `EventBus` caller inventory in analysis/design and make the replacement for the current test-only timeout override explicit.
2. Replace the no-op Vitest source-file commands with executable focused test targets, adding targeted tests where no current `*.test.ts` file exists for the changed behaviour.

## Strengths

- The recommended Proposal B matches the project's architecture-first/no-premature-configurability guideline.
- The MCP timeout/cap promotion is scoped well and correctly sets up F12/F20 without trying to solve them here.
- The plan keeps defaults behaviourally stable while deleting dead fallbacks instead of preserving transitional aliases.

VERDICT: CHANGES_REQUESTED