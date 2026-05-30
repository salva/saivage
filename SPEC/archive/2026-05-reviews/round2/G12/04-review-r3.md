# G12 Review (Round 3)

Reviewer: GPT-5.5

## Findings

1. The R3 redaction regex still does not produce the canonical output it promises.

R3 correctly chooses a single canonical output for the bearer-in-Authorization case, but the proposed negative lookahead does not actually skip an already-redacted bearer value. The helper in [SPEC/v2/review-2026-05-round2/G12/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G12/03-plan-r3.md#L29-L36) and [SPEC/v2/review-2026-05-round2/G12/02-design-r3.md](SPEC/v2/review-2026-05-round2/G12/02-design-r3.md#L26-L35) uses `(?!Bearer\s+<redacted>\b)`, while the plan asserts that this makes `"HTTP 401: Authorization: Bearer abcd1234.efghij"` become `"HTTP 401: Authorization: Bearer <redacted>"` [SPEC/v2/review-2026-05-round2/G12/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G12/03-plan-r3.md#L12-L13) and pins that exact string in E9 [SPEC/v2/review-2026-05-round2/G12/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G12/03-plan-r3.md#L73-L79). In JavaScript regex semantics, `\b` after the literal `>` in `<redacted>` is not a word boundary; both `>` and end-of-string or whitespace are non-word positions. The positive lookahead therefore fails, the negative lookahead succeeds, and the second replacement still consumes `Authorization: Bearer`, yielding `HTTP 401: Authorization <redacted> <redacted>`.

That means R3 has not yet satisfied the R2 requirement to make the helper and tests agree on one canonical sanitized format [SPEC/v2/review-2026-05-round2/G12/04-review-r2.md](SPEC/v2/review-2026-05-round2/G12/04-review-r2.md#L17-L30). The planned V2 focused test will fail even if the implementer copies the helper exactly. Required change: replace the boundary with a sentinel that works for the placeholder, for example skip `Bearer <redacted>` with a literal-only lookahead or with an end/delimiter check such as `(?!Bearer\s+<redacted>(?:$|[\s,;]))`, then keep the canonical-output test. Alternatively choose the normalized `Authorization <redacted>` output, but then update the helper, examples, and E9 expectation consistently.

## What Looks Solid

The MCP runtime contract is now handled correctly. `McpRuntime.callTool` throws when `result.isError` is true and only returns `result.content` on success for both in-process and external services [src/mcp/runtime.ts](src/mcp/runtime.ts#L188-L193) [src/mcp/runtime.ts](src/mcp/runtime.ts#L201-L206). R3 updates E12 to use `.rejects.toThrow(/scanner degraded/)` for `fetch_url`, `fetch_page_text`, `download_file`, and `download_with_fallbacks`, then inspects filesystem side effects separately for the fallback manifest [SPEC/v2/review-2026-05-round2/G12/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G12/03-plan-r3.md#L154-L200). That matches the existing prompt-injection and fallback-manifest test idioms [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L206-L218) [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L240-L262). The current data-tool implementation also preserves the scanner-degraded cause in per-attempt errors before the runtime serializes the error payload [src/mcp/builtins.ts](src/mcp/builtins.ts#L214-L216) [src/mcp/builtins.ts](src/mcp/builtins.ts#L858-L884), so the R3 rejection assertions are compatible with the actual code.

The broader R2 architecture remains sound: typed `scanner: "degraded"`, fail-closed at `scanUntrustedText`, source/error redaction inside the cop, a `SecurityStatusRing`, `/api/debug/security`, and a DebugView Security tab are still the right amount of machinery for operator-visible security degradation without adding a compatibility shim, config knob, or metrics subsystem.

## Required Revision Summary

1. Fix the R3 `redactError` negative lookahead so the canonical bearer-in-Authorization input actually yields the canonical output, or choose a different canonical output and update helper, examples, and tests together.
2. Keep the R3 `McpRuntime.callTool` test rewrite; no further changes are needed on that axis.

VERDICT: CHANGES_REQUESTED