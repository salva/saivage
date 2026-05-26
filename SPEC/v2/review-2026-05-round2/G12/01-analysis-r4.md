# G12 — Analysis (Round 4)

**Finding**: [../G12-prompt-injection-cop-fail-open-silent.md](../G12-prompt-injection-cop-fail-open-silent.md)
**Prior rounds**: [01-analysis-r3.md](01-analysis-r3.md), [02-design-r3.md](02-design-r3.md), [03-plan-r3.md](03-plan-r3.md)
**R3 review addressed**: [04-review-r3.md](04-review-r3.md) (verdict CHANGES_REQUESTED, 1 required change)

## R4 deltas vs R3

| Area | R3 stance | R4 stance |
| --- | --- | --- |
| `redactError` lookahead | Negative lookahead `(?!Bearer\s+<redacted>\b)` — relies on `\b` after the literal `>` in `<redacted>` | Negative lookahead `(?!Bearer\s+<redacted>(?:$|[\s,;]))` — uses an explicit end-of-string / delimiter alternation that matches what the placeholder is actually followed by |
| Worked-example outputs | Same canonical strings, but unreachable because the R3 regex never triggered the lookahead | Same canonical strings, now actually produced by the helper |
| E9 #9 expectation | `expect(msg).toBe("HTTP 401: Authorization: Bearer <redacted>")` plus behavioral invariants | Unchanged — the expectation was correct, only the helper needed to align with it |
| `McpRuntime.callTool` test rewrite (E12) | Uses `.rejects.toThrow(/scanner degraded/)` for all four data tools; separate filesystem inspection for `download_with_fallbacks` | Unchanged — R3 review explicitly approved this and asked for no further changes on that axis |

All other R3 scope (SecurityStatusRing, /api/debug/security, DebugView Security tab, five-cause degraded taxonomy, URL/source redaction, observer-throw resilience, `download_with_fallbacks` coverage, the R3 E12 rewrite) is preserved unchanged.

## 1. Why the R3 lookahead is broken

The R3 helper at [SPEC/v2/review-2026-05-round2/G12/03-plan-r3.md](03-plan-r3.md#L29-L36) ends the lookahead with `\b`:

```ts
.replace(
  /(authorization|api[-_]?key|token)\s*[:=]\s*(?!Bearer\s+<redacted>\b)[^\s,;]+/gi,
  "$1 <redacted>",
);
```

In JavaScript regex semantics, `\b` matches at a position between a word character (`[A-Za-z0-9_]`) and a non-word character (anything else, including string boundaries). The character immediately before the would-be boundary is `>`, which is non-word. The character immediately after is either:

- end-of-string — also non-word (string boundaries are treated as non-word for `\b`);
- whitespace (`" "`, `"\t"`) — non-word;
- `,` / `;` / `:` — non-word.

In every realistic input the cop produces during the credential pass, both sides of the candidate `\b` position are non-word. `\b` therefore fails to match. The positive `\b` failure means the surrounding negative lookahead `(?!...)` succeeds (the inner pattern did not match), and the credential pass proceeds to consume `Bearer` as the `[^\s,;]+` capture. The output is `"HTTP 401: Authorization <redacted> <redacted>"` — exactly the R2 failure the R3 lookahead was meant to prevent.

Trace, character by character, for input `"HTTP 401: Authorization: Bearer abcd1234.efghij"`:

1. Bearer pass: `Bearer abcd1234.efghij` → `Bearer <redacted>`. Buffer: `"HTTP 401: Authorization: Bearer <redacted>"`.
2. Credential pass anchored at `Authorization`: after `\s*[:=]\s*`, the cursor sits before `B` of `Bearer`. The lookahead tries `Bearer\s+<redacted>\b`:
   - `Bearer\s+<redacted>` matches the literal text `Bearer <redacted>`.
   - `\b` is tested at the position after `>`. Left side `>` is non-word. Right side is end-of-string, also non-word. `\b` fails.
   - The whole positive lookahead pattern fails. The negative lookahead `(?!...)` succeeds.
3. `[^\s,;]+` matches `Bearer`. The regex replaces `Authorization: Bearer` with `Authorization <redacted>`.
4. Final buffer: `"HTTP 401: Authorization <redacted> <redacted>"`. The canonical E9 #9 assertion `expect(msg).toBe("HTTP 401: Authorization: Bearer <redacted>")` fails.

The R3 review summarises this at [04-review-r3.md](04-review-r3.md) and asks for one of two fixes.

## 2. Decision: option (a)

Option (a) — replace the lookahead with a literal-only end-delimiter check — is selected. Option (b) (redefine the canonical output as `"Authorization <redacted>"` and update helper, examples, and E9 #9) was rejected on the same operator-signal grounds as in [01-analysis-r3.md](01-analysis-r3.md#L97-L101): keeping the `"Bearer <redacted>"` substring tells the operator the auth scheme the cop tripped over, which is cheap, free of false positives in practice, and matches the canonical-output expectation already pinned by E9 #9. No additional code paths, helpers, or tests are introduced; only the lookahead body changes.

## 3. Chosen helper shape

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

The only change vs R3 is `\b` → `(?:$|[\s,;])`. The `$` alternative matches end-of-string. The character class matches every delimiter `[^\s,;]+` would refuse to consume on its own, plus colon-less semicolon/comma framings the cop sees in practice. The placeholder `"<redacted>"` is generated only by the first replace pass, so the lookahead's literal anchor has no false-positive surface from external input.

### Trace, canonical input

Input: `"HTTP 401: Authorization: Bearer abcd1234.efghij"`.

1. Bearer pass → `"HTTP 401: Authorization: Bearer <redacted>"`.
2. Credential pass at `Authorization:`. After `\s*[:=]\s*`, lookahead tries `Bearer\s+<redacted>(?:$|[\s,;])`:
   - `Bearer\s+<redacted>` matches `Bearer <redacted>`.
   - `(?:$|[\s,;])` matches end-of-string. Positive lookahead succeeds; negative lookahead fails; no replacement.
3. Final: `"HTTP 401: Authorization: Bearer <redacted>"`. The E9 #9 `toBe(...)` assertion holds.

### Trace, embedded bearer with trailing comma

Input: `"upstream: Authorization: Bearer abc.def, retry=3"`.

1. Bearer pass → `"upstream: Authorization: Bearer <redacted>, retry=3"`.
2. Credential pass at `Authorization:`. Lookahead: `Bearer <redacted>` then `,` — `[\s,;]` matches. Lookahead succeeds; negative fails; no replacement of the `Bearer` slot.
3. Final: `"upstream: Authorization: Bearer <redacted>, retry=3"`. Stable.

### Trace, non-bearer credentials

- `"HTTP 403: api_key=ZZZZsecret123"`: first pass no-op; credential pass — lookahead anchored on `Bearer` cannot match, negative lookahead succeeds, `[^\s,;]+` consumes `ZZZZsecret123`. Output: `"HTTP 403: api_key <redacted>"`.
- `"request failed: token = supersecret, retry=3"`: same path. Output: `"request failed: token <redacted>, retry=3"`.
- `"Token: Bearer xyz.abc"`: first pass → `"Token: Bearer <redacted>"`. Credential pass anchored at `Token:`, lookahead matches `Bearer <redacted>` then end-of-string; negative fails; no replacement. Output preserved.

The non-bearer outputs are identical to R3's design table.

## 4. Worked-example table

| Input | R3 actual output (broken `\b`) | R4 output (option (a)) |
| --- | --- | --- |
| `HTTP 401: Authorization: Bearer abcd1234.efghij` | `HTTP 401: Authorization <redacted> <redacted>` | `HTTP 401: Authorization: Bearer <redacted>` |
| `upstream: Authorization: Bearer abc.def, retry=3` | `upstream: Authorization <redacted> <redacted>, retry=3` | `upstream: Authorization: Bearer <redacted>, retry=3` |
| `HTTP 403: api_key=ZZZZsecret123` | `HTTP 403: api_key <redacted>` | `HTTP 403: api_key <redacted>` |
| `request failed: token = supersecret, retry=3` | `request failed: token <redacted>, retry=3` | `request failed: token <redacted>, retry=3` |
| `Token: Bearer xyz.abc` | `Token <redacted> <redacted>` | `Token: Bearer <redacted>` |

R3's design table at [02-design-r3.md](02-design-r3.md) listed the R4 column as the R3 expected output; the R3 helper did not actually produce it. R4 makes the helper match the table.

## 5. Behavioral invariants (unchanged from R3)

For each input the tests assert:

1. The redacted output does not contain the raw secret token.
2. The redacted output does not contain any newline character.
3. The redacted output length is ≤ 240.
4. For inputs containing `Bearer <secret>`, the literal substring `"Bearer <redacted>"` is present in the output.
5. For inputs containing `api_key=<secret>` (no bearer), the literal substring `"api_key <redacted>"` is present.

These remain the canonical contract. E9 #9's `toBe("HTTP 401: Authorization: Bearer <redacted>")` is now a satisfiable pin in addition to the invariants, because the helper actually produces that string.

## 6. What did not change vs R3

- The E12 rewrite (`McpRuntime.callTool` is a throwing API; tests use `.rejects.toThrow(/scanner degraded/)` for all four data tools and inspect filesystem side effects out-of-band) is approved by the R3 review and unchanged.
- All five no-scan branches in `scanWithModel` still route to the typed degraded result with distinct `cause` values ([src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L80-L88), [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L117-L118), [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L122-L126)).
- `scanUntrustedText` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L149-L160) fails closed by throwing when `scanner === "degraded"`.
- `SecurityStatusRing`, `GET /api/debug/security`, `DebugView` Security tab, `SystemEvent.type = "security_cop_degraded"` (severity `"warning"`), URL/source redaction in the cop, and observer-throw resilience are all unchanged.
- E9 #1–#8 and #10–#12, and the three E9 #9 sibling tests (canonical bearer-in-Authorization, `api_key` without bearer, multi-line collapse with length cap) are unchanged in identity; only the canonical test's first assertion is now reachable.

## 7. Acceptance refinement

The R3 acceptance criteria stand. Item 5 (redaction tests) reads identically to R3 ([01-analysis-r3.md](01-analysis-r3.md#L99-L101)): for the canonical input `"HTTP 401: Authorization: Bearer abcd1234.efghij"`, the observer's `errorMessage` equals `"HTTP 401: Authorization: Bearer <redacted>"`, contains no raw secret substring, contains no newline, and has length ≤ 240. R4 makes the helper actually produce that string; no acceptance text needs to change.

## 8. Risk summary

- **Lookahead-vs-greedy-quantifier risk**: the negative lookahead is anchored on the literal string `"<redacted>"` followed by `$` or one of `\s,;`. The first replace pass is the only producer of the placeholder, so the only way the lookahead can succeed is on output the cop itself wrote one line earlier. There is no input shape that fools the lookahead into skipping a real secret value, because real secret values never end in the literal `<redacted>` substring.
- **Trailing-delimiter coverage**: the second-pass `[^\s,;]+` capture refuses to consume `\s`, `,`, or `;`, so every place the cop could have parked `"Bearer <redacted>"` is followed by one of the four delimiter cases (`$`, `\s`, `,`, `;`). The alternation `(?:$|[\s,;])` matches them all. The choice mirrors the negative character class in the same regex, which is the canonical way to keep a lookahead consistent with its base pattern's stop conditions.
- **No new runtime risk** beyond R3: the helper change is a one-token edit (`\b` → `(?:$|[\s,;])`). Tests, design, and helper all converge on the same canonical output.
- **Reviewer-side risk closed**: R3's review explicitly enumerated the two acceptable fixes; R4 picks one, applies it consistently across analysis, design, plan, and tests, and leaves the approved E12 rewrite untouched.
