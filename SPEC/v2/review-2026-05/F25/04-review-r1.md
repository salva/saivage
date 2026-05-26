# F25 Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F25/01-analysis-r1.md](SPEC/v2/review-2026-05/F25/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F25/02-design-r1.md](SPEC/v2/review-2026-05/F25/02-design-r1.md)
- [SPEC/v2/review-2026-05/F25/03-plan-r1.md](SPEC/v2/review-2026-05/F25/03-plan-r1.md)
- [SPEC/v2/review-2026-05/F25-prompt-injection-cop-regex-fp.md](SPEC/v2/review-2026-05/F25-prompt-injection-cop-regex-fp.md)
- Spot-check: [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts)

## Findings

### Analysis

The analysis is accurate. The code runs `scanHeuristically` before model adjudication and returns a blocking `scanner: "heuristic"` result before `scanWithModel` can evaluate the content ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L84-L94), [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L156-L180)). The documented false-positive mechanism is therefore real, and the call-site description is also correct: `downloadUrl` catches the thrown block and records it as `attempt.error` before returning `null` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L235)).

### Design

The recommended Proposal B is the right architecture-first direction: delete the regex detector entirely rather than demoting it to a no-op hint. That aligns with the project rule against dead transitional machinery and with the LLM prompt's stated policy to allow academic/security discussion. However, the design and plan understate the scope of removing the `"heuristic"` scanner value. The result is not only an internal implementation detail: `prompt_injection_scan` is part of MCP tool output ([src/mcp/builtins.ts](src/mcp/builtins.ts#L121), [src/mcp/builtins.ts](src/mcp/builtins.ts#L235), [src/mcp/builtins.ts](src/mcp/builtins.ts#L819), [src/mcp/builtins.ts](src/mcp/builtins.ts#L851)), and existing MCP tests construct scan results with `scanner: "heuristic"` ([src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L215-L226), [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L235-L246)). No compatibility shim is needed, but the design must explicitly acknowledge the visible response-shape change and include the test updates.

### Plan

The plan is not yet executable as written. It scopes implementation to three files ([SPEC/v2/review-2026-05/F25/03-plan-r1.md](SPEC/v2/review-2026-05/F25/03-plan-r1.md#L1-L35)) and states no MCP-level tests are required ([SPEC/v2/review-2026-05/F25/03-plan-r1.md](SPEC/v2/review-2026-05/F25/03-plan-r1.md#L42)), but narrowing the scanner union will force updates to [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L215-L246). Additionally, the plan proposes removing the `"Prompt injection blocked:"` prefix from `scanUntrustedText` and adding a new prefix only in `downloadUrl` ([SPEC/v2/review-2026-05/F25/03-plan-r1.md](SPEC/v2/review-2026-05/F25/03-plan-r1.md#L33-L37)). That misses the `fetch_url` and `fetch_page_text` catch sites, which also use `scanUntrustedText` and currently surface its error string directly ([src/mcp/builtins.ts](src/mcp/builtins.ts#L800-L819), [src/mcp/builtins.ts](src/mcp/builtins.ts#L832-L851)). Either keep the existing prefix in `scanUntrustedText`, or update all three caller paths and their tests consistently.

The rollback note also needs a factual correction: `prompt_injection_scan` is present in the MCP response payload, so the claim that the wire shape never carried `"heuristic"` as an externalized contract is inaccurate ([SPEC/v2/review-2026-05/F25/03-plan-r1.md](SPEC/v2/review-2026-05/F25/03-plan-r1.md#L63)). The desired no-backward-compat conclusion can remain; the document just needs to name the intentional breaking cleanup instead of saying it is source-only.

## Required changes

1. Revise the design/plan scope for Proposal B to include [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) and any assertions affected by changing block error text or removing `scanner: "heuristic"`.
2. Make the `scanUntrustedText` error-prefix strategy consistent across `download_file`, `fetch_url`, and `fetch_page_text`: either keep the prefix in `scanUntrustedText`, or move/prefix it at every catch site and update tests accordingly.
3. Correct the rollback/API-impact language so it acknowledges that `prompt_injection_scan.scanner` is visible in MCP tool output, while still following the project guideline to remove the old `"heuristic"` value without a compatibility shim.

## Strengths

- Correctly identifies the regex-first false-positive root cause.
- Chooses the clean deletion design rather than preserving a useless heuristic layer.
- Keeps F03 and F04 separate instead of mixing parser/model-routing cleanup into this issue.

VERDICT: CHANGES_REQUESTED