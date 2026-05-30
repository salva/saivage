# G12 Review (Round 2)

Reviewer: GPT-5.5

## Findings

1. The proposed MCP degraded-cop test is incompatible with the real runtime API.

R2 correctly adds `download_with_fallbacks` to the degraded fail-closed coverage, but the concrete E12 test awaits `runtime.callTool(...)` and then asserts `a.isError`, `a.content`, `d.isError`, and `d.content` [SPEC/v2/review-2026-05-round2/G12/03-plan-r2.md](03-plan-r2.md#L507-L546). That is not how the current `McpRuntime.callTool` contract behaves. In-process tool handlers may return `{ content, isError: true }`, but `callTool` immediately throws when it sees `result.isError` and only returns `result.content` on success [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L183-L193). It does the same for external MCP clients [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L200-L205). The existing prompt-injection tests already use `.rejects.toThrow(...)` for blocked fetch/download cases [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L221-L262), which matches the runtime contract.

Required change: rewrite E12 to assert rejected promises for `fetch_url`, `fetch_page_text`, and `download_file`. For `download_with_fallbacks`, catch the thrown error or use `.rejects.toThrow("scanner degraded")`, then inspect the filesystem side effects separately: target file absent, manifest file present, and persisted `attempts` containing `scanner degraded`. If the test needs the structured error payload, parse it out of the thrown `Tool ... returned error: ...` message or test the handler one layer below `McpRuntime.callTool`. As written, V2 will fail even if the runtime implementation is correct.

2. The redaction helper and its own expected test output contradict each other.

E2 specifies `redactError` as two sequential replacements: first `Bearer\s+...` to `Bearer <redacted>`, then `(authorization|api[-_]?key|token)\s*[:=]\s*...` to `$1 <redacted>` [SPEC/v2/review-2026-05-round2/G12/03-plan-r2.md](03-plan-r2.md#L156-L160). E9 then asks a thrown `Error("HTTP 401: Authorization: Bearer abcd1234.efghij")` to produce an observer `errorMessage` containing both `Bearer <redacted>` and `authorization <redacted>` [SPEC/v2/review-2026-05-round2/G12/03-plan-r2.md](03-plan-r2.md#L445-L447). With the helper as written, the first pass yields `Authorization: Bearer <redacted>`, and the second pass matches `Authorization: Bearer`, replacing that part with `Authorization <redacted>` and leaving at most an extra redacted marker. The planned exact assertion is therefore not stable against the planned implementation.

Required change: choose one canonical sanitized format and make helper and tests agree. A good test assertion here is behavioral rather than over-specific: no raw bearer value, no raw authorization credential, no newline/stack material, and length capped. If the desired output is to preserve the phrase `Bearer <redacted>`, change the credential regex so it does not consume an already-redacted bearer scheme after `Authorization:`; if the desired output is a normalized `Authorization <redacted>`, remove the expectation that `Bearer <redacted>` remains. This matters because redaction is one of the R1 blockers, not just polish.

## What Looks Solid

R2 fixes the main architectural miss from R1. The current server has only `/api/debug/state`, `/api/debug/errors`, and `/api/debug/timeline`, all backed by plan/runtime/report documents rather than the event bus [src/server/server.ts](../../../../src/server/server.ts#L477-L658). The current DebugView only knows the three `state | errors | timeline` tabs, polls those three endpoints, and renders only those panes [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L23-L60) [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue#L107-L184). R2's `SecurityStatusRing` plus `/api/debug/security` plus a DebugView Security tab is the right minimum scope to satisfy operator visibility without requiring an active chat session.

The broadened degraded taxonomy also matches the current source. Today `scan()` collapses every `null` from `scanWithModel()` into `allowed: true`, `scanner: "llm"`, and `reason: "llm unavailable; allowing"` [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L64-L74). The missing-provider and unavailable-provider branches silently return `null` [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L81-L88), and the unparseable-verdict and chat-failure branches also collapse to `null` [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L115-L127). R2's five causes cover those branches cleanly.

The core policy split remains sound: the cop reports `scanner: "degraded"`, while the MCP data boundary refuses to admit unscanned text. That matches the single production helper surface at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L160) and the four URL-bearing data-tool paths, including the fallback loop at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L858-L884). Rejecting a `failurePolicy` knob and a parallel metrics subsystem is still consistent with the project rules.

## Required Revision Summary

1. Fix E12 so it tests `McpRuntime.callTool` as a throwing API on `isError`, while still verifying the fallback manifest and no-write behavior.
2. Make the redaction helper and redaction tests agree on one canonical sanitized output, with assertions that primarily prove no raw credential material survives.

VERDICT: CHANGES_REQUESTED