# G33 — Analysis r4

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Round 3 baseline**: [01-analysis-r3.md](01-analysis-r3.md); reviewer critique [04-review-r3.md](04-review-r3.md).

**Writer**: Claude Opus 4.7 (round 4).

Round 4 keeps the root-cause framing and the helper-ownership direction from r3. Deltas vs r3 are confined to the two blocking findings in [04-review-r3.md](04-review-r3.md#L7-L11). Sections not listed below are unchanged from r3.

## 1. What the code does today (re-anchored)

Live anchors unchanged from r3 against the current tree:

- `case "web_search":` block: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761).
- Hardcoded DDG endpoint: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L741-L742).
- Unbounded `fetch(...)` + `await response.text()`: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L743-L744).
- Regex-over-HTML loop: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L745-L758).
- Second `decodeURIComponent` on the already-decoded `uddg` value: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L751-L753).
- Empty-results-as-success final return: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L760).
- Tool schema entry still says "default 8, max 20": [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L666).
- Module-level `let`s to extend: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43).
- Existing `BuiltinServicesOptions`: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L124-L126).
- `registerBuiltinServices` wiring block: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1081).
- Live `mcp` config block (pre-G34): [src/config.ts](../../../../src/config.ts#L137-L145), with `maxFetchChars` at [src/config.ts](../../../../src/config.ts#L143).

## 2. Root cause (unchanged from r1/r2/r3)

See [01-analysis-r1.md §2](01-analysis-r1.md#L42-L66).

## 3. Blast radius (re-anchored against G34 r3)

G34 r3 ([../G34/02-design-r3.md](../G34/02-design-r3.md)) is now the FINAL G34 contract. G33 still adds exactly one new import line from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts), but the shape of the values that flow across that boundary has changed:

- `fetchWithTimeout` now returns a `TimedFetch` object: `{ response, signal, timedOut(), dispose() }` (see [../G34/02-design-r3.md](../G34/02-design-r3.md#L57-L102) for the type and [../G34/02-design-r3.md](../G34/02-design-r3.md#L72-L86) for the explicit `dispose()` contract). It does not return a bare `Response`.
- `readBoundedTextBody(response, maxBytes, signal)` accepts an explicit `AbortSignal` and **throws** on mid-body abort rather than returning a partial-success envelope ([../G34/02-design-r3.md](../G34/02-design-r3.md#L137-L191)). The caller must thread `timed.signal` into the bounded read so that timer-driven cancels reach the helper.
- `classifyNetworkError(err, url, ctx)` takes a third `{ timedOut?: boolean }` parameter that short-circuits to `code: "TIMEOUT"` ([../G34/02-design-r3.md](../G34/02-design-r3.md#L235-L242)). Callers pass `{ timedOut: timed.timedOut() }` from the body-read catch so an abort that fired while reading body bytes maps to TIMEOUT regardless of how the underlying `AbortError` was named.
- The caller is responsible for calling `timed.dispose()` in a `finally` block on every exit path; this includes success, every early-fail branch, and the body-read catch (see G34 r3 `fetch_url` precedent at [../G34/02-design-r3.md](../G34/02-design-r3.md#L433-L497)).

The G33 / G34 co-touch is still narrow (one new import line, one handler rewrite, one config-block insertion); only the **values** the handler manipulates change.

## 4. Project-rule check (unchanged)

See [01-analysis-r1.md §4](01-analysis-r1.md#L90-L106). The round-3 ownership reversal (G33 imports rather than owns) and the round-4 contract alignment both honour the architecture-first / no-backward-compat rules: no shim layer is introduced between G33 and the post-G34 helpers; G33 calls them directly with their final shape.

## 5. Constraints carried into design (r4 deltas vs r3)

Unchanged carry-overs from r3 (Proposal A, `node-html-parser@^6.1.13`, `extractDdgResults` exported, `parseNonNegativeInt` owned by G31, fixture-and-prose alignment around the `uddg` nested-escape row, named-group config-order convention, structured-envelope failure contract) all stand.

Two corrections vs r3 in response to [04-review-r3.md](04-review-r3.md#L7-L11):

- **G34 contract alignment (blocker 1).** The r3 handler sketch in [02-design-r3.md §3.6](02-design-r3.md#L263-L294) treats `fetchWithTimeout` as returning a bare `Response` and calls `readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES)` without a signal. That matches no version of the G34 contract. The FINAL contract is G34 r3 ([../G34/02-design-r3.md](../G34/02-design-r3.md)): `fetchWithTimeout` returns `TimedFetch`; `readBoundedTextBody` takes an explicit `AbortSignal` and throws on mid-body abort; `classifyNetworkError` takes a `{ timedOut }` flag from the body-read catch; the caller must run `timed.dispose()` in a `finally` block. G33 r4 rewrites the handler around this shape. The r3 prose at [02-design-r3.md §3.6](02-design-r3.md#L348-L349) claiming "no explicit signal is needed because the helper composes its own timeout signal" is deleted: with G34 r3 the helper composes a controller-driven signal internally, but the caller still has to forward `timed.signal` into the bounded read so the cancel propagates into the active `reader.read()` loop ([../G34/02-design-r3.md](../G34/02-design-r3.md#L153-L174)).

- **Post-G34 config shape (blocker 2).** The r3 plan in [03-plan-r3.md](03-plan-r3.md#L46-L56) tells the implementer to append the web-search group immediately after the current `maxDownloadBytes` line at [src/config.ts](../../../../src/config.ts#L143). After G34 r3 lands, that line is followed by the renamed `maxFetchBytes` (which replaces `maxFetchChars` at [src/config.ts](../../../../src/config.ts#L143)) and a new `fetchTimeoutMs` field in the same size-caps group ([../G34/02-design-r3.md](../G34/02-design-r3.md#L334-L341), referring back to [02-design-r2.md §3](02-design-r2.md#L222-L264)). G33 r4 retargets its insertion point to "after `fetchTimeoutMs`" and refreshes the convention table so the size-caps group reads `maxOutputBytes`, `maxFetchBytes`, `maxDownloadBytes`, `fetchTimeoutMs` (no `maxFetchChars` mentioned anywhere). The web-search group still goes at the end, after the size-caps group, with the same three alphabetised fields. No migration shim for the rename.

## 6. Open questions deferred to design

- The exact `try/finally` shape around `timed.dispose()` in the `web_search` handler, and the explicit signal-passing into `readBoundedTextBody`. Resolved in [02-design-r4.md §3.6](02-design-r4.md).
- The exact post-G34 size-caps ordering and the web-search insertion target. Resolved in [02-design-r4.md §2.5 / §3.2](02-design-r4.md).
