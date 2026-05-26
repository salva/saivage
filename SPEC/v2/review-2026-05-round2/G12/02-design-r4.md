# G12 — Design (Round 4)

**Companion docs**: [01-analysis-r4.md](01-analysis-r4.md), [03-plan-r4.md](03-plan-r4.md)
**R3 review addressed**: [04-review-r3.md](04-review-r3.md) (1 required change)

## R4 deltas vs R3

| Required change | R3 design | R4 design |
| --- | --- | --- |
| `redactError` negative lookahead | Trailed in `\b`, which after `>` in `<redacted>` is not a JS regex word boundary; the lookahead never triggered and the canonical input produced `"HTTP 401: Authorization <redacted> <redacted>"` | Trails in `(?:$|[\s,;])`, a literal end-delimiter alternation that exactly matches what the helper's own first-pass output is followed by. Canonical input now produces `"HTTP 401: Authorization: Bearer <redacted>"`. |

Everything else in [02-design-r3.md](02-design-r3.md) (cop result type, observer detail, scan request shape, URL redaction, cop wiring, `SystemEvent` taxonomy, `SecurityStatusRing`, bootstrap wiring, debug route, DebugView tab, MCP boundary fail-closed semantics, the E12 `.rejects.toThrow` idiom) is unchanged.

## Redaction rules — R4 update (the cop owns these)

### Source

Unchanged from R2 / R3 ([02-design-r2.md](02-design-r2.md#L113-L137)). Origin + truncated pathname; userinfo, query, fragment all stripped.

### Error

R4 helper:

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

Difference vs R3: the lookahead's trailing `\b` is replaced with `(?:$|[\s,;])`. The end-of-string alternative and the explicit delimiter class together cover every position the first replace pass can park a `"Bearer <redacted>"` placeholder at, because the second pass's own `[^\s,;]+` capture refuses to consume `\s`, `,`, or `;`. The placeholder text is generated only by the first pass, so the lookahead has no external false-positive surface.

| Input | R4 output | Why |
| --- | --- | --- |
| `HTTP 401: Authorization: Bearer abcd1234.efghij` | `HTTP 401: Authorization: Bearer <redacted>` | First pass redacts the bearer. Second pass at `Authorization:` sees `Bearer <redacted>` followed by end-of-string; lookahead `(?:$|[\s,;])` matches `$`; negative fails; no further replacement. |
| `upstream: Authorization: Bearer abc.def, retry=3` | `upstream: Authorization: Bearer <redacted>, retry=3` | First pass redacts the bearer. Second pass at `Authorization:` sees `Bearer <redacted>,`; `[\s,;]` matches the comma; negative fails; no further replacement. The trailing `retry=3` does not match the credential pattern. |
| `HTTP 403: api_key=ZZZZsecret123` | `HTTP 403: api_key <redacted>` | First pass no-op (no Bearer). Second pass: lookahead anchored on `Bearer` cannot match, negative succeeds, `[^\s,;]+` consumes the secret. |
| `request failed: token = supersecret, retry=3` | `request failed: token <redacted>, retry=3` | Same as above; the `token = ...` form is handled by the second pass as in R3. |
| `Token: Bearer xyz.abc` | `Token: Bearer <redacted>` | First pass redacts the bearer. Second pass at `Token:` sees `Bearer <redacted>` followed by end-of-string; lookahead matches `$`; negative fails; no further replacement. |

R3's design table at [02-design-r3.md](02-design-r3.md#L38-L48) listed these strings as expected outputs; R4's helper actually produces them.

### Behavioral contract pinned by tests

For redacted error output, the cop still guarantees (verbatim from R3):

1. No substring of the original secret token remains (verified per-input).
2. No newline (`\n` or `\r`) appears in the output (first-line-only construction).
3. Output length ≤ 240 characters.
4. For inputs containing `Bearer <secret>`, the literal `"Bearer <redacted>"` is present.
5. For inputs containing `api_key=<secret>` (no bearer), the literal `"api_key <redacted>"` is present.

These invariants are unchanged. Additionally, E9 #9's `toBe("HTTP 401: Authorization: Bearer <redacted>")` is a reachable pin in R4 (it was unreachable in R3).

### Visible in `reason`

Unchanged from R2 / R3:

```ts
result.reason = `scanner degraded (${cause})${errorMessage ? `: ${errorMessage}` : ""}`;
```

`errorMessage` is the output of `redactError`. No raw source material reaches `reason`.

## Why the trailing alternation, not `\b`

In JavaScript regex semantics, `\b` requires a transition between a word character (`[A-Za-z0-9_]`) and a non-word character or string boundary. After the literal `>` in the placeholder `<redacted>`:

- left side `>` is non-word;
- right side is end-of-string, whitespace, `,`, or `;` — all non-word.

Both sides being non-word means `\b` never matches at that position. The full positive sub-pattern `Bearer\s+<redacted>\b` therefore always fails, the surrounding negative lookahead always succeeds, and the credential pass always consumes `Bearer` — producing the double-redaction failure mode the R3 helper was meant to prevent.

`(?:$|[\s,;])` is the literal enumeration of every character the second pass's `[^\s,;]+` capture refuses to consume, plus end-of-string. It matches at exactly the positions where the first pass parked its placeholder. There is no realistic input class the alternation misses, because the placeholder text only ever appears as the immediate output of the first pass, and the first pass writes it before the same delimiters the second pass enumerates in its negated class.

The placeholder text `"<redacted>"` is a fixed string produced inside the cop. User-supplied input cannot inject the placeholder text earlier than the first replace pass, so there is no path by which a real secret value could end in the literal `<redacted>` substring at the position the lookahead inspects.

## MCP degraded fail-closed test — unchanged from R3

The R3 review explicitly approved the E12 rewrite and asked for no further changes on that axis. The R3 contract analysis at [02-design-r3.md](02-design-r3.md#L62-L102) stands:

- `McpRuntime.callTool` throws on `result.isError` for both in-process services ([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L188-L192)) and external services ([src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L200-L204)).
- E12 uses `.rejects.toThrow(/scanner degraded/)` for `fetch_url`, `fetch_page_text`, `download_file`, and `download_with_fallbacks`.
- For `download_with_fallbacks`, filesystem side effects (target absent, manifest present, persisted `attempts` carries `"scanner degraded"`) are inspected with `existsSync` + `readFileSync` + `JSON.parse` after the rejection is observed.

The R4 plan reproduces the R3 E12 test block verbatim; see [03-plan-r4.md](03-plan-r4.md).

## Cop wiring, observer detail, SystemEvent, ring, route, DebugView

All unchanged from R2 / R3 ([02-design-r2.md](02-design-r2.md#L141-L271)). Restated only for orientation:

- Observer interface still receives `{ toolName, sourceKind, sourceSummary, contentType, inputLength, cause, errorMessage, timestamp }` where both `sourceSummary` and `errorMessage` are pre-redacted by the cop.
- The five-cause taxonomy (`provider_missing`, `provider_unavailable`, `provider_availability_error`, `llm_call_failed`, `llm_unparseable`) is wired through the rewritten `scanWithModel`.
- Bootstrap moves the `EventBus` constructor before `registerBuiltinServices` and adds `securityStatusRing` beside it.
- New route `GET /api/debug/security` on [src/server/server.ts](../../../../src/server/server.ts) returns `{ entries: runtime.securityStatusRing.list(50) }`.
- `DebugView.vue` gains a fourth `security` tab fed by the new route on the existing 8 s `fetchAll` cadence.

## Why option (a) over option (b) for redaction

Both options satisfy the safety invariants in [01-analysis-r4.md](01-analysis-r4.md). Option (a) was chosen for the reasons enumerated in [01-analysis-r3.md](01-analysis-r3.md#L97-L101) and confirmed by R3's review (the R3 review presented (a) and (b) as alternatives without preference; the project picks (a) for operator-signal value):

- Operator signal value: `"Bearer <redacted>"` tells the operator *what kind* of credential the cop tripped over. `"Authorization <redacted>"` alone loses the bearer-scheme hint.
- Smaller helper surface: a single one-token edit (`\b` → `(?:$|[\s,;])`) on the existing R3 helper. Option (b) would require restructuring helper, examples, and the E9 #9 expectation.
- Stable for non-bearer credential shapes: `api_key=...`, `token=...`, and `token: ...` all still collapse to `"<key> <redacted>"` as in R2 and R3.

The lookahead is anchored on the literal `"<redacted>"` placeholder, which is the only sequence the first pass can produce. There is no risk of regressing on user-supplied input that happens to contain the placeholder text, because the placeholder text would only appear at this point in the pipeline if the cop itself put it there.

## Open design questions — R4 status

All R3 design questions ([02-design-r3.md](02-design-r3.md)) remain resolved. R4 adds none.

## Out of scope (unchanged)

- No `failurePolicy` knob, no metrics façade, no cop interface refactor.
- No persistence of the security-status ring across restarts.
- No DebugView Vue test harness.
- No saivage-v3 changes.
