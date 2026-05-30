# F11 — Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F11-magic-constants-not-in-config.md](SPEC/v2/review-2026-05/F11-magic-constants-not-in-config.md)
- [SPEC/v2/review-2026-05/F11/04-review-r1.md](SPEC/v2/review-2026-05/F11/04-review-r1.md)
- [SPEC/v2/review-2026-05/F11/01-analysis-r2.md](SPEC/v2/review-2026-05/F11/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F11/02-design-r2.md](SPEC/v2/review-2026-05/F11/02-design-r2.md)
- [SPEC/v2/review-2026-05/F11/03-plan-r2.md](SPEC/v2/review-2026-05/F11/03-plan-r2.md)

## Findings

### Analysis

Approved. The r1 factual blocker is corrected: the analysis now identifies `EventBus.handlerTimeoutMs` as a real test seam, not absent configurability. That matches the implementation in [src/events/bus.ts](src/events/bus.ts#L54-L57) and the fake-timer test in [src/events/bus.test.ts](src/events/bus.test.ts#L154-L167). The broader classification is also consistent with the spot-checked source: supervisor dead fallbacks and force-cancel delay in [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L8-L12), notes TTL in [src/runtime/notes.ts](src/runtime/notes.ts#L60), and MCP caps/floor handling in [src/mcp/builtins.ts](src/mcp/builtins.ts#L33-L42) and [src/mcp/builtins.ts](src/mcp/builtins.ts#L377-L408).

### Design

Approved. Proposal B remains the right architectural answer for the issue: promote only constants with a real operator scenario, delete schema-shadowing fallbacks, preserve existing deterministic test seams, and leave protocol/internal guardrails inline. The design no longer deletes the `EventBus` constructor parameter, so it no longer violates the existing test contract. The removal of `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS` is explicitly called out as a breaking cleanup, which is acceptable under this review's no-backward-compatibility policy.

### Plan

Approved. The r1 validation blocker is fixed: the plan replaces no-op source-file Vitest commands with real `*.test.ts` targets and adds focused tests for supervisor force-cancel delay and notes TTL. The MCP wiring plan is executable from the current call sites in [src/server/bootstrap.ts](src/server/bootstrap.ts#L140-L142), [src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L187), and [src/mcp/builtins.ts](src/mcp/builtins.ts#L1103-L1114). Typecheck plus the full Vitest run are sufficient to catch any remaining constructor or registration call-site updates as the signatures move.

## Required changes

None.

## Strengths

- Correctly resolves both r1 objections without broadening the issue into config sprawl.
- Keeps the recommended change aligned with the architecture-first/no-premature-configurability guideline.
- Gives implementers concrete tests for the newly configurable behaviours and retains the existing EventBus seam coverage.

VERDICT: APPROVED
