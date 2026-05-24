# F25 Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F25/04-review-r1.md](SPEC/v2/review-2026-05/F25/04-review-r1.md)
- [SPEC/v2/review-2026-05/F25/01-analysis-r1.md](SPEC/v2/review-2026-05/F25/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F25/02-design-r2.md](SPEC/v2/review-2026-05/F25/02-design-r2.md)
- [SPEC/v2/review-2026-05/F25/03-plan-r2.md](SPEC/v2/review-2026-05/F25/03-plan-r2.md)
- Spot-check: [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts), [src/mcp/builtins.ts](src/mcp/builtins.ts), [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts)

## Findings

### Analysis

The r1 analysis remains accurate and sufficient for this round. The current implementation still exposes the false-positive root cause: `scan()` invokes `scanHeuristically` before model adjudication and returns a blocking `scanner: "heuristic"` result immediately on regex hits ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L82-L94), [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L156-L176)). The analysis also correctly identifies the consumer path: MCP data tools surface successful scans through `prompt_injection_scan`, while blocked downloads are converted into an error string by `scanUntrustedText` / `downloadUrl` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L160), [src/mcp/builtins.ts](src/mcp/builtins.ts#L211-L235)).

### Design

The r2 design resolves the r1 scope gap. Proposal B now explicitly treats removal of `"heuristic"` from `PromptInjectionScanResult.scanner` as a visible MCP response-shape change, not an internal-only refactor, which matches the current `prompt_injection_scan` payloads returned by `download_file`, `fetch_url`, and `fetch_page_text` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L121), [src/mcp/builtins.ts](src/mcp/builtins.ts#L235), [src/mcp/builtins.ts](src/mcp/builtins.ts#L819), [src/mcp/builtins.ts](src/mcp/builtins.ts#L851)). That is the correct no-shim cleanup under the project guidelines.

The error-prefix strategy is also now consistent. Keeping the single `"Prompt injection blocked: "` prefix in `scanUntrustedText` means `download_file`, `fetch_url`, and `fetch_page_text` all surface the same error string without catch-site formatting drift ([src/mcp/builtins.ts](src/mcp/builtins.ts#L149-L160), [src/mcp/builtins.ts](src/mcp/builtins.ts#L794-L819), [src/mcp/builtins.ts](src/mcp/builtins.ts#L825-L851)).

### Plan

The r2 plan is executable. It includes all files that must change for Proposal B: the cop module, the cop tests, and the MCP tests that currently construct `scanner: "heuristic"` stub results ([src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L18-L49), [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts#L1-L17), [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L215-L226), [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L235-L246)). It also correctly leaves [src/mcp/builtins.ts](src/mcp/builtins.ts) out of the edit scope because the existing single-prefix behavior already satisfies the desired contract.

The validation commands use the repo's Vitest/typecheck/build conventions and include both focused suites touched by the change. No missing deliverables remain.

## Required changes

## Strengths

- Correctly keeps Proposal B as the architecture-first fix: delete regex-based blocking rather than demote it into dead routing machinery.
- Resolves all r1 objections without adding compatibility shims, transitional enum aliases, or catch-site special cases.
- Names the visible MCP response-shape change honestly and updates the affected MCP tests.

VERDICT: APPROVED