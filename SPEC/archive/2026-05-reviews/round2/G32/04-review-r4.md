# G32 - Review r4

**Reviewer**: GPT-5.5 (Copilot)

**Inputs reviewed**: [SPEC/v2/review-2026-05-round2/G32/01-analysis-r4.md](01-analysis-r4.md#L1), [SPEC/v2/review-2026-05-round2/G32/02-design-r4.md](02-design-r4.md#L1), [SPEC/v2/review-2026-05-round2/G32/03-plan-r4.md](03-plan-r4.md#L1), [SPEC/v2/review-2026-05-round2/G32/04-review-r3.md](04-review-r3.md#L1), [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1)

## Summary

Round 4 fixes the r3 obsolete-literal direction: the removal gate now expects zero `pattern must be non-empty` hits, and the new-message gate now expects exactly one `INVALID_ARGUMENT: pattern must be a non-empty string` hit. Those changes address the specific false pass and false fail called out in r3.

I cannot approve r4 yet because the source-gate proof still overclaims. The presence gate is not handler-scoped, and the helper-body gate does not actually cover the whole r3 `globToRegExp` helper. As written, the three corrected grep gates are not jointly satisfiable only by the r3 design.

## Required Changes

### 1. Scope the new-message presence gate to the `search_files` handler

The r3 review asked for a handler-level occurrence of the new empty-pattern error at [SPEC/v2/review-2026-05-round2/G32/04-review-r3.md](04-review-r3.md#L21), matching the handler contract at [SPEC/v2/review-2026-05-round2/G32/02-design-r3.md](02-design-r3.md#L177-L185). Round 4 records the same location requirement in the design: the single occurrence must sit inside `case "search_files":`, not inside `globToRegExp` or another helper, at [SPEC/v2/review-2026-05-round2/G32/02-design-r4.md](02-design-r4.md#L108-L115).

The actual r4 plan gate at [SPEC/v2/review-2026-05-round2/G32/03-plan-r4.md](03-plan-r4.md#L95-L99) is only a whole-module count of the full message. That proves the literal exists exactly once somewhere in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1), but it does not prove the handler-boundary return exists. A stray comment, unused constant, or helper-local throw with that message can satisfy the presence gate while leaving the request-boundary `INVALID_ARGUMENT` contract unimplemented.

Required fix: make the presence gate source-aware in the same way the text describes it. For example, extract the `case "search_files":` handler body and assert the full `INVALID_ARGUMENT: pattern must be a non-empty string` message appears exactly once there, while separately asserting it does not appear in `globToRegExp` or other local helpers. The behavioural empty-pattern test remains necessary, but the grep gate itself must prove the location it claims to prove.

### 2. Make the helper-body gate cover the complete `globToRegExp` helper

The helper-body gate at [SPEC/v2/review-2026-05-round2/G32/03-plan-r4.md](03-plan-r4.md#L101-L106) uses a fixed `grep -nA 25` window and then states that the 25-line window covers the helper body. It does not. The r3 helper starts at [SPEC/v2/review-2026-05-round2/G32/02-design-r3.md](02-design-r3.md#L78) and does not return until [SPEC/v2/review-2026-05-round2/G32/02-design-r3.md](02-design-r3.md#L120), with the post-helper text beginning at [SPEC/v2/review-2026-05-round2/G32/02-design-r3.md](02-design-r3.md#L124). A 25-line window from the function declaration only reaches the middle of the helper.

Because of that window, a reintroduced `pattern.length === 0` branch after the first 25 lines of the helper can pass the removal gate, pass the new-message presence gate, and pass the helper-body gate. That invalidates the r4 self-consistency claim at [SPEC/v2/review-2026-05-round2/G32/03-plan-r4.md](03-plan-r4.md#L110-L127) and the design-layer claim at [SPEC/v2/review-2026-05-round2/G32/02-design-r4.md](02-design-r4.md#L126-L138) that these three gates are jointly satisfiable only by the r3 design.

Required fix: replace the fixed-line window with a delimiter-scoped helper extraction, such as from `^function globToRegExp` through the helper's top-level closing brace, then run the helper-body checks against that extracted body. At minimum, the gate must inspect the full helper span from the function declaration through the `return new RegExp` and closing brace shown in r3.

## Verified Fixes From r3

- The obsolete-guard removal check now expects zero `pattern must be non-empty` hits at [SPEC/v2/review-2026-05-round2/G32/03-plan-r4.md](03-plan-r4.md#L87-L93), which fixes the old r3 false-pass case described at [SPEC/v2/review-2026-05-round2/G32/04-review-r3.md](04-review-r3.md#L17-L21).
- The new literal check now uses `INVALID_ARGUMENT: pattern must be a non-empty string` at [SPEC/v2/review-2026-05-round2/G32/03-plan-r4.md](03-plan-r4.md#L95-L99), matching the r3 handler copy at [SPEC/v2/review-2026-05-round2/G32/02-design-r3.md](02-design-r3.md#L181-L185). The remaining problem is location proof, not the literal choice.
- The exit criteria repeat the same round-4 split at [SPEC/v2/review-2026-05-round2/G32/03-plan-r4.md](03-plan-r4.md#L232-L242), so fixing the two gates above in Step 4 must be mirrored there.

## Notes

- The live checkout is still pre-G32 for this finding: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L29-L35) still imports and promisifies `execFile`, and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L310-L320) still shells out through `find`. That remains consistent with the prerequisite sequencing noted in r3, not a new r4 regression.

VERDICT: CHANGES_REQUESTED