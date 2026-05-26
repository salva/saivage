# G12 — Analysis (Round 3)

**Finding**: [../G12-prompt-injection-cop-fail-open-silent.md](../G12-prompt-injection-cop-fail-open-silent.md)
**Prior rounds**: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md)
**R2 review addressed**: [04-review-r2.md](04-review-r2.md) (verdict CHANGES_REQUESTED, 2 required changes)

## R3 deltas vs R2

| Area | R2 stance | R3 stance |
| --- | --- | --- |
| MCP `callTool` contract assumption | E12 assumed `callTool` resolves with `{ isError: true, content }` for in-process tool errors | Confirmed against source: `McpRuntime.callTool` **throws** on `result.isError` and returns only `result.content` on success ([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L205)). E12 must use `.rejects.toThrow(...)` and inspect filesystem side effects out-of-band. |
| Existing test idiom | E12 used `await runtime.callTool(...); expect(a.isError).toBe(true)` | Existing prompt-injection tests at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L221-L262) already use `.rejects.toThrow("Prompt injection blocked")`. R3 aligns degraded coverage with the same idiom. |
| `redactError` contract | Two sequential regex passes whose expected outputs in E9 #9 (assert both `"Bearer <redacted>"` and `"authorization <redacted>"` are present) collide on a single line and produce an unstable result | One canonical sanitized output. Chosen: option (a) — preserve `Bearer <redacted>` by making the credential regex skip an already-redacted bearer scheme. Tests assert behavioral invariants (no raw secret, no newline, capped length) plus `"Bearer <redacted>"` present. |

All other R2 scope (SecurityStatusRing, /api/debug/security, DebugView Security tab, broadened degraded taxonomy with five causes, URL/source redaction, observer-throw resilience, `download_with_fallbacks` coverage) is preserved unchanged.

## 1. The `callTool` contract, verified against source

`McpRuntime.callTool` is defined at [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L205). Two relevant branches:

- In-process services at [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L175-L194). After the handler resolves, if `result.isError`, the runtime throws `new Error(\`Tool "${toolName}" on "${serviceName}" returned error: ${JSON.stringify(result.content)}\`)` ([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L192)). Otherwise it returns `result.content` (the bare content, *not* the wrapper object).
- External MCP clients at [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L196-L204). Same shape: throw on `isError`, return `result.content` on success.

Consequence: from a test author's point of view, `runtime.callTool(...)` is a *throwing* API on tool error. The R2 plan's `expect(a.isError).toBe(true)` cannot be reached because the awaited promise rejects before `a` is bound. The existing tests in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L221-L262) already use this idiom — R2 missed that and invented a non-existent return shape.

The thrown `Error.message` does carry the original tool error: the runtime serialises `result.content` via `JSON.stringify` and embeds it in the thrown message. So `.rejects.toThrow(/scanner degraded/)` does match against the original `attempts[i].error` text for `download_with_fallbacks`. Filesystem side effects (target file absence, manifest file presence and content) are inspected separately after the rejection is observed.

The existing R2 test for `download_with_fallbacks` no-cop coverage at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L207-L219) is itself a worked example: it uses `.rejects.toThrow("All download sources failed")`, then reads the manifest from disk and asserts on its contents. R3's E12 follows the same pattern for the degraded-cop case.

## 2. The redaction collision, verified by hand

R2's `redactError` ([SPEC/v2/review-2026-05-round2/G12/03-plan-r2.md](03-plan-r2.md#L155-L160)):

```ts
function redactError(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0] ?? raw;
  const scrubbed = firstLine
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>")
    .replace(/(authorization|api[-_]?key|token)\s*[:=]\s*[^\s,;]+/gi, "$1 <redacted>");
  return scrubbed.length > 240 ? scrubbed.slice(0, 237) + "..." : scrubbed;
}
```

Trace input `"HTTP 401: Authorization: Bearer abcd1234.efghij"`:

1. Bearer pass: `Bearer abcd1234.efghij` matches → `"HTTP 401: Authorization: Bearer <redacted>"`.
2. Credential pass at `Authorization`: regex consumes `Authorization`, then `\s*[:=]\s*`, then `[^\s,;]+` — which greedily matches `Bearer` (next whitespace ends the run). Substitution: `Authorization <redacted>`. Result: `"HTTP 401: Authorization <redacted> <redacted>"`.

R2's E9 test #9 ([SPEC/v2/review-2026-05-round2/G12/03-plan-r2.md](03-plan-r2.md#L445-L447)) asserts that the observer's `errorMessage` contains *both* `"Bearer <redacted>"` and `"authorization <redacted>"`. With the actual helper, `"Bearer <redacted>"` survives only as a fragment of `"<redacted> <redacted>"` — it is no longer a standalone substring. The test fails against the implementation it was paired with.

R3 picks option (a) from the reviewer's options and aligns helper and test.

### Chosen helper shape

```ts
function redactError(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0] ?? raw;
  const scrubbed = firstLine
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>")
    .replace(
      /(authorization|api[-_]?key|token)\s*[:=]\s*(?!Bearer\s+<redacted>\b)[^\s,;]+/gi,
      "$1 <redacted>",
    );
  return scrubbed.length > 240 ? scrubbed.slice(0, 237) + "..." : scrubbed;
}
```

The added negative lookahead `(?!Bearer\s+<redacted>\b)` blocks the credential pass from consuming a `Bearer <redacted>` value that the first pass produced. Effect on the canonical input:

1. Bearer pass: `"HTTP 401: Authorization: Bearer <redacted>"`.
2. Credential pass: at `Authorization:` the lookahead inspects what follows `\s*[:=]\s*` — finds `Bearer <redacted>`, lookahead fails, no replacement. No other matches in the string.

Final output: `"HTTP 401: Authorization: Bearer <redacted>"`. Stable. The literal substring `"Bearer <redacted>"` is preserved.

### Why option (a) over option (b)

Both options satisfy the safety invariants the reviewer named (no raw bearer value, no raw `abcd1234.efghij`, no newline/stack material, length capped). Option (a) was chosen because:

- The string `"Bearer <redacted>"` reads as the *kind* of credential that was scrubbed, which is useful operator signal when triaging "what broke the cop?". `"Authorization <redacted>"` alone loses the auth-scheme hint.
- Other common shapes the cop sees in practice (`api_key=...`, `token=...`, `Authorization: Token ...`) are still handled by the second pass — the lookahead is narrow and excludes only the specific case where the first pass already redacted a bearer.
- The behavioral invariants in R3's tests are weaker and cleaner than R2's collided exact-string assertion: tests assert that no raw secret survives and that the canonical token `"Bearer <redacted>"` is present. They do not assert any second redaction marker on the same line.

### Behavioral invariants pinned by tests

For each input case the tests assert:

1. The redacted output does not contain the raw secret token (the substring after `Bearer ` or after `:` / `=` in the original).
2. The redacted output does not contain any newline character (`\n` or `\r`).
3. The redacted output length is ≤ 240.
4. For inputs containing `Bearer <secret>`, the literal substring `"Bearer <redacted>"` is present in the output.
5. For inputs containing `api_key=<secret>` (not paired with a bearer), the literal substring `"api_key <redacted>"` is present.

These five invariants together are the canonical contract. They are pinned in [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) by E9 #9 (rewritten in R3) and pin every property the security contract needs without over-specifying the helper's output shape.

## 3. What did not change vs R2

The following R2 conclusions stand and need no R3 revision; they are restated only so the implementer does not have to chase R2 to confirm scope.

- All five no-scan branches in `scanWithModel` route to the typed degraded result with distinct `cause` values (`provider_missing`, `provider_unavailable`, `provider_availability_error`, `llm_call_failed`, `llm_unparseable`). ([src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L80-L88), [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L117-L118), [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L122-L126))
- `scanUntrustedText` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L160) fails closed by *throwing* when `scanner === "degraded"`. All four data-tool call sites pass `toolName` through.
- `SecurityStatusRing` (in-memory, capacity 100, most-recent-first) is constructed alongside the EventBus in bootstrap and exposed on `SaivageRuntime`.
- New `GET /api/debug/security` route on [src/server/server.ts](../../../../src/server/server.ts) returns `{ entries: ring.list(50) }`.
- New `security` tab in [web/src/components/DebugView.vue](../../../../web/src/components/DebugView.vue) polls the route every 8 s through the existing `fetchAll` cadence.
- Redaction of source URLs (origin + truncated pathname; no userinfo, query, fragment) lives in the cop, not in callers, and is exercised through the observer-detail tests.
- `SystemEvent.type` gains `"security_cop_degraded"` with severity `"warning"`. The TypeScript exhaustiveness check on `EVENT_SEVERITY` at [src/events/bus.ts](../../../../src/events/bus.ts#L27-L34) enforces the new entry.

## 4. Acceptance refinement

The R2 acceptance criteria stand. R3 adjusts only the two items the reviewer flagged:

- Item 6 (`download_with_fallbacks` test) now reads: the call rejects with an error whose message contains `"scanner degraded"`; the target file is absent on disk; the manifest file is present on disk; the persisted `attempts` array (parsed from the manifest) contains at least one entry whose `error` field contains `"scanner degraded"`.
- Item 5 (redaction tests) now reads: for the canonical input `"HTTP 401: Authorization: Bearer abcd1234.efghij"`, the observer's `errorMessage` contains `"Bearer <redacted>"`, does not contain the literal `"abcd1234.efghij"`, does not contain a newline, and has length ≤ 240. URL-redaction tests (no userinfo, no query, no fragment, signed-URL signature gone, oversize pathnames truncated with `"..."`) are unchanged.

No other criterion changes.

## 5. Risk summary

- **Reviewer-side risk**: the R2 review correctly caught a wrong API assumption. R3's E12 rewrite uses the actual contract verified against [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L205). The risk of the same class of mistake recurring is mitigated by following the existing prompt-injection test patterns at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L221-L262) verbatim.
- **Redaction-side risk**: lookahead-based skip in `redactError` is narrower than R2's chained-replace approach. The risk that a future credential shape sneaks through (e.g. `Token: Bearer ...` with `Token` instead of `Authorization`) is bounded — the existing R2 second regex already matches `token\s*[:=]\s*...`, so `Token: Bearer abc` → first pass yields `Token: Bearer <redacted>` → second pass: lookahead at `Token:` checks `Bearer <redacted>`, lookahead fails, no further match. The `Token` prefix is preserved as-is and the secret is gone. That is the desired behaviour.
- **No new runtime risk** beyond R2: the helper changes do not affect runtime behaviour outside the cop's redaction step, and the test changes do not affect what is asserted at the policy boundary.
