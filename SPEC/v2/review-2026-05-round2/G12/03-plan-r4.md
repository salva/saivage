# G12 — Plan (Round 4)

**Companion docs**: [01-analysis-r4.md](01-analysis-r4.md), [02-design-r4.md](02-design-r4.md)
**R3 review addressed**: [04-review-r3.md](04-review-r3.md) (1 required change)

All edits land in [saivage](../../../../) (Saivage v2 tree). No changes to `saivage-v3/`.

## R4 deltas vs R3

| Area | R3 plan | R4 plan |
| --- | --- | --- |
| E2 helper (`redactError`) | Second regex used negative lookahead `(?!Bearer\s+<redacted>\b)`. The `\b` after `>` in `<redacted>` is not a JS regex word boundary, so the lookahead never triggered and the helper produced `"HTTP 401: Authorization <redacted> <redacted>"` for the canonical input. | Second regex uses negative lookahead `(?!Bearer\s+<redacted>(?:$|[\s,;]))`. The end-of-string / delimiter alternation matches what the first pass's placeholder is actually followed by, so the lookahead triggers and the helper produces `"HTTP 401: Authorization: Bearer <redacted>"` for the canonical input. |
| E9 #9 test body | Asserts `expect(msg).toBe("HTTP 401: Authorization: Bearer <redacted>")` plus the four behavioral invariants. Unreachable because the R3 helper did not produce that string. | Unchanged source — the R3 expectation is correct. The R4 helper finally produces the asserted string. |
| E12 (MCP fail-closed test) | Uses `.rejects.toThrow(/scanner degraded/)` for all four data tools; separate filesystem inspection for `download_with_fallbacks` | Unchanged. R3 review explicitly approved this rewrite and asked for no further changes on that axis. |

Everything else in [03-plan-r3.md](03-plan-r3.md) (E1, E3–E8, E10, E11, E13, E14, validation, acceptance) is unchanged unless explicitly noted below.

## Edit set — R4 changes only

### E2 — Redaction helpers (R4 update)

File: [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts) (same file as E1; helpers at module scope, not exported)

`inferSourceKind` and `redactSource` are unchanged from R2 ([03-plan-r2.md](03-plan-r2.md#L131-L150)).

`redactError` becomes:

```ts
function redactError(raw: string): string {
  const firstLine = raw.split(/\r?\n/)[0] ?? raw;
  const scrubbed = firstLine
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer <redacted>")
    .replace(
      /(authorization|api[-_]?key|token)\s*[:=]\s*(?!Bearer\s+<redacted>(?:$|[\s,;]))[^\s,;]+/gi,
      "$1 <redacted>",
    );
  return scrubbed.length > 240 ? scrubbed.slice(0, 237) + "..." : scrubbed;
}
```

Sole difference vs R3: the lookahead trailer changes from `\b` to `(?:$|[\s,;])`. Rationale and worked traces in [01-analysis-r4.md](01-analysis-r4.md) and [02-design-r4.md](02-design-r4.md).

The helpers remain private to the module. Indirect coverage through the public `scan(...)` path (driving redacted output into the observer detail) is the contract surface.

### E9 — Cop tests (no source change vs R3; new contract is reachable)

File: [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts)

All tests in R3's E9 list ([03-plan-r3.md](03-plan-r3.md#L43-L130)) — items #1 through #12 — are kept verbatim. The three #9 sibling tests (canonical bearer-in-Authorization, `api_key` without bearer, multi-line collapse with length cap) are unchanged. R4 only makes the canonical test reachable; the test code itself is identical to R3.

For completeness, the canonical test that R3 wrote and R4 retains:

```ts
it("redacts bearer tokens and credential-shaped substrings in observer error message", async () => {
  const observer = makeRecordingObserver();
  const router = makeRouterThrowing(
    new Error("HTTP 401: Authorization: Bearer abcd1234.efghij"),
  );
  const cop = makeCop(router, observer);

  const result = await cop.scan({
    source: "https://example.com/path",
    content: "benign",
    contentType: "text/plain",
    toolName: "fetch_url",
    sourceKind: "url",
  });

  expect(result.scanner).toBe("degraded");
  expect(observer.events).toHaveLength(1);

  const msg = observer.events[0]!.errorMessage ?? "";
  // Canonical sanitized output.
  expect(msg).toBe("HTTP 401: Authorization: Bearer <redacted>");
  // Behavioral invariants (per [02-design-r4.md](02-design-r4.md)):
  expect(msg).not.toContain("abcd1234");
  expect(msg).not.toContain("efghij");
  expect(msg).not.toMatch(/[\r\n]/);
  expect(msg.length).toBeLessThanOrEqual(240);
  expect(msg).toContain("Bearer <redacted>");
});
```

The two sibling tests (`api_key` without bearer; multi-line collapse) are reproduced verbatim from [03-plan-r3.md](03-plan-r3.md#L77-L116) and not re-listed here.

### E12 — MCP fail-closed test (unchanged from R3)

File: [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)

The R3 E12 block at [03-plan-r3.md](03-plan-r3.md#L132-L207) is retained verbatim. R3 review approved it explicitly and asked for no further changes. For convenience and to keep this plan self-contained, the R4 implementer should land exactly the block at [03-plan-r3.md](03-plan-r3.md#L132-L207); no edits are needed there relative to R3.

Key contract notes (same as R3):

- The runtime serialises the in-process tool result's `content` and embeds it in the thrown `Error.message`. For `download_with_fallbacks`, the content includes the `attempts[]` array, each entry's `error` carries the literal `"scanner degraded"` substring, so `.rejects.toThrow(/scanner degraded/)` matches the rejection text directly from the runtime ([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L192) and [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L200-L204)).
- The filesystem side effects (target absent, manifest present, manifest content) are inspected with `existsSync` + `readFileSync` + `JSON.parse`, matching the existing R2 test idiom for the no-cop fallback case at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L213-L218).
- The substring check on `persisted.attempts[].error` is the operator-facing proof that the manifest does not mask the security failure as an ordinary network miss.

Required imports at the top of the test file (unchanged from R3):

- `existsSync`, `readFileSync` — already imported.
- `join` from `node:path` — already imported.
- `PromptInjectionCop` type — already imported.

No new fixture, no new helper, no new module-level state.

### E1, E3–E8, E10, E11, E13, E14

Unchanged from R2 / R3. See [03-plan-r2.md](03-plan-r2.md):

- E1 — Cop: structured degraded result + observer hook (all five causes) ([03-plan-r2.md](03-plan-r2.md#L26-L116)).
- E3 — Bootstrap: ring + reordering + observer wire-up ([03-plan-r2.md](03-plan-r2.md#L167-L207)).
- E4 — `SystemEvent` taxonomy + severity ([03-plan-r2.md](03-plan-r2.md#L209-L218)).
- E5 — New module `SecurityStatusRing` ([03-plan-r2.md](03-plan-r2.md#L220-L270)).
- E6 — New `GET /api/debug/security` route ([03-plan-r2.md](03-plan-r2.md#L272-L282)).
- E7 — DebugView Security tab ([03-plan-r2.md](03-plan-r2.md#L284-L327)).
- E8 — MCP boundary: fail-closed + toolName propagation ([03-plan-r2.md](03-plan-r2.md#L329-L355)).
- E10 — `SecurityStatusRing` tests ([03-plan-r2.md](03-plan-r2.md#L455-L463)).
- E11 — `EventBus` severity test ([03-plan-r2.md](03-plan-r2.md#L465-L475)).
- E13 — `SaivageRuntime` shutdown cleanup ([03-plan-r2.md](03-plan-r2.md#L548-L552)).
- E14 — Touch-up grep ([03-plan-r2.md](03-plan-r2.md#L554-L560)).

## Out of edit set (R4)

Same as R3 ([03-plan-r3.md](03-plan-r3.md#L213-L215)) and R2 ([03-plan-r2.md](03-plan-r2.md#L562-L570)). R4 introduces no new excluded items.

## Validation

V0–V7 from R2 ([03-plan-r2.md](03-plan-r2.md#L572-L658)) are unchanged. R4 adds no new validation step; the regex change is mechanically covered by V2 (focused vitest of [src/security/prompt-injection-cop.test.ts](../../../../src/security/prompt-injection-cop.test.ts) and [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)) and V3 (full vitest).

For convenience, the V2 invocation:

```bash
npx vitest run src/security/prompt-injection-cop.test.ts src/security/status-ring.test.ts src/mcp/builtins.test.ts src/events/bus.test.ts
```

This single command exercises E9 #9 (now reachable in R4), E9 sibling tests for `api_key` and multi-line, and E12 (unchanged from R3).

## Operator-gated saivage-v3 restart

Unchanged from R3: not required for G12. All R4 edits remain in `/home/salva/g/ml/saivage` (Saivage v2). No container restart is part of normal implementation.

## Acceptance

The R3 acceptance criteria ([03-plan-r3.md](03-plan-r3.md#L237-L241)) hold without modification.

- Item 5 (redaction tests): the canonical sanitized output for `"HTTP 401: Authorization: Bearer abcd1234.efghij"` is `"HTTP 401: Authorization: Bearer <redacted>"`. The redacted output also satisfies: no `"abcd1234"`/`"efghij"` substring, no newline, length ≤ 240, contains `"Bearer <redacted>"`. URL-redaction assertions (no userinfo, no query, no fragment, signed-URL signature gone, oversize pathnames truncated with `"..."`) are unchanged. R4 makes this criterion mechanically achievable by the helper; R3 left a gap.
- Item 6 (`download_with_fallbacks` test): the call rejects with `/scanner degraded/`; the target file is absent on disk; the manifest file is present on disk; the persisted `attempts` array contains at least one entry whose `error` field contains `"scanner degraded"`. The three other data tools (`fetch_url`, `fetch_page_text`, `download_file`) also reject with `/scanner degraded/`. `download_file` also verifies the target file is absent on disk. Unchanged from R3.

All other R3 acceptance criteria (E1–E13 implemented and merged; V0, V0b, V1, V2, V3, V4, V5, V6a, V6b pass; all five no-scan branches route to typed degraded; old `"llm unavailable; allowing"` string is gone; no `failurePolicy` knob; no parallel metrics façade) are unchanged.
