# G12 Review (Round 4)

Reviewer: GPT-5.5

## Findings

No blocking findings.

R4 resolves the one R3-required change. The R3 review asked for the broken `\b` boundary to be replaced with a sentinel that works after the literal `>` in `<redacted>`, explicitly offering the end/delimiter form `(?!Bearer\s+<redacted>(?:$|[\s,;]))` as an acceptable fix [SPEC/v2/review-2026-05-round2/G12/04-review-r3.md](SPEC/v2/review-2026-05-round2/G12/04-review-r3.md#L7-L11). R4 adopts that exact shape in the planned helper [SPEC/v2/review-2026-05-round2/G12/03-plan-r4.md](SPEC/v2/review-2026-05-round2/G12/03-plan-r4.md#L30-L35), keeps the canonical E9 assertion [SPEC/v2/review-2026-05-round2/G12/03-plan-r4.md](SPEC/v2/review-2026-05-round2/G12/03-plan-r4.md#L73-L79), and updates acceptance so the canonical input must produce `"HTTP 401: Authorization: Bearer <redacted>"` [SPEC/v2/review-2026-05-round2/G12/03-plan-r4.md](SPEC/v2/review-2026-05-round2/G12/03-plan-r4.md#L146).

I verified the proposed helper mechanically against the required canonical input `"HTTP 401: Authorization: Bearer abcd1234.efghij"`; it returns exactly `"HTTP 401: Authorization: Bearer <redacted>"`. The reason is the one R4 states: after the first pass writes `Bearer <redacted>`, the second-pass lookahead sees the placeholder followed by end-of-string or a delimiter and therefore prevents the credential regex from consuming `Authorization: Bearer` [SPEC/v2/review-2026-05-round2/G12/01-analysis-r4.md](SPEC/v2/review-2026-05-round2/G12/01-analysis-r4.md#L70-L80) [SPEC/v2/review-2026-05-round2/G12/02-design-r4.md](SPEC/v2/review-2026-05-round2/G12/02-design-r4.md#L71-L80). This is fundamental progress over R3, not the same regex-correctness failure repeating.

## Source Verification

The current source tree is still pre-G12, which is expected for a plan review but important for the implementer. Today the scanner type has no `"degraded"` variant [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L17-L24), `scan()` still collapses model trouble into `"llm unavailable; allowing"` [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L64-L74), the no-scan branches still return `null` [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L77-L88) [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L116-L127), and the focused cop tests still assert the old fail-open behavior [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts#L55-L61). The planned G12 implementation must replace those surfaces with the R2/R3/R4 design, including the R4 redactor.

The MCP runtime side remains correctly understood and does not need another design cycle. `McpRuntime.callTool` throws on `result.isError` for in-process tools and returns bare `result.content` only on success [src/mcp/runtime.ts](src/mcp/runtime.ts#L188-L193), with the same throw-on-error contract for external clients [src/mcp/runtime.ts](src/mcp/runtime.ts#L201-L206). R3 already corrected E12 to use rejected-promise assertions and preserve fallback-manifest inspection, and R4 intentionally leaves that approved axis unchanged [SPEC/v2/review-2026-05-round2/G12/04-review-r3.md](SPEC/v2/review-2026-05-round2/G12/04-review-r3.md#L15-L22).

## What Looks Solid

The R4 docs are internally consistent: analysis, design, plan, E9, and acceptance now all name the same canonical bearer-in-Authorization output. The helper remains narrow, private, and indirectly tested through the public `scan(...)` observer path, which is the right surface for this codebase. R4 also preserves the architecture-first choices already accepted in earlier rounds: typed degraded state, fail-closed MCP data boundaries, operator-visible security ring and debug tab, redaction inside the cop, no compatibility shim, no failure-policy knob, and no metrics side system.

## Implementation Notes

When the plan is implemented, run the focused V2 test set from the plan after applying the source changes. The current source cannot pass those tests yet because it intentionally has not received the G12 edits; that is not a round-4 design defect.

VERDICT: APPROVED