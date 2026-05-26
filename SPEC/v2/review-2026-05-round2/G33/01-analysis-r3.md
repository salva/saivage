# G33 — Analysis r3

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Round 2 baseline**: [01-analysis-r2.md](01-analysis-r2.md); reviewer critique [04-review-r2.md](04-review-r2.md).

**Writer**: Claude Opus 4.7 (round 3).

Round 3 keeps the same root-cause framing as r1/r2. The deltas vs r2 are confined to the three blocking findings and three required corrections in [04-review-r2.md](04-review-r2.md#L7-L31). Sections not listed below are unchanged from r2 and are not re-stated.

## 1. What the code does today (re-anchored)

The live handler still uses the regex extractor, the silent-success contract on zero results, and the `decodeURIComponent` second-decode bug at the verified locations:

- `case "web_search":` block: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761) (24 lines, ends one blank line before `case "fetch_url":`).
- Hardcoded DDG endpoint construction: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L741-L742).
- Unbounded direct `fetch(...)` then `await response.text()`: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L743-L744).
- Regex-over-HTML loop: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L745-L758).
- Second `decodeURIComponent` on the already-decoded `uddg` value: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L751-L753).
- Empty-results-as-success final return: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L760).
- Tool schema (outer description + `max_results` description) still says "default 8, max 20": [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L666).

`parseNonNegativeInt` is still absent from the file (verified by `grep -n 'parseNonNegativeInt' src/mcp/builtins.ts`); G31 r4 adds it.

`fetchWithTimeout`, `readBoundedTextBody`, and `classifyNetworkError` are not yet in the tree either. G34 r1 introduces the new module [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) that owns those four helpers — see G34 r1 design [../G34/02-design-r1.md](../G34/02-design-r1.md#L73-L83) and the G34 r1 reviewer's explicit endorsement of G34 as owner [../G34/04-review-r1.md](../G34/04-review-r1.md#L13-L13).

The existing in-process server test seam is `withTextServer` plus `registerBuiltinServices(runtime, cfg.mcp, ...)`: [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L12-L23) and [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L231-L240). The helper mints a `http://127.0.0.1:PORT` URL and passes it to tools that accept a URL argument. `web_search` does not accept a URL argument; the in-process server cannot be reached by the existing pattern without a new endpoint seam.

## 2. Root cause (unchanged from r1/r2)

See [01-analysis-r1.md §2](01-analysis-r1.md#L42-L66).

## 3. Blast radius (re-anchored)

Same-file co-touch matrix unchanged from r1. The G33 / G34 co-touch is now narrower than r2 implied: G33 only adds a single `import` line from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) (the new module created by G34). G33 no longer touches G34's helper bodies, signatures, or exports.

## 4. Project-rule check (unchanged from r1/r2)

See [01-analysis-r1.md §4](01-analysis-r1.md#L90-L106).

## 5. Constraints carried into design (r3 deltas vs r2)

Carried from r2 (unchanged):

- G31/G32-style envelope `{ content: { error, code, ...context }, isError: true }` on failure; `{ content: { ...payload }, isError: false }` on success.
- No regex over HTML for structural extraction.
- Fixture test must fail loudly when the parser produces zero results from a known-good fixture.
- `extractDdgResults` is a named export of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) so parser-level tests can call it directly. The export discipline mirrors G31 r4's exported `classifyFsError` ([../G31/02-design-r4.md](../G31/02-design-r4.md#L41-L48)).
- `uddg` is decoded exactly once: trust `URLSearchParams.get("uddg")`, validate with `new URL(value)`, no second `decodeURIComponent`.
- `parseNonNegativeInt` is owned by G31; G33 declares an ordering dependency on G31 r4 landing first.
- `node-html-parser@^6.1.13` is the structural extractor; transitive deps `he@1.2.0` and `css-select@^5.1.0`; unpacked 165 KB.
- Wider fixture matrix (class-attr reordering, multi-class anchors, `<div>`-form snippet, missing-snippet row kept, malformed-href skipped).
- Tool schema description lists the new `code` enumeration and the configured ceiling (default 20, max 50).

Revised / corrected in r3 from reviewer r2:

- **Helper ownership reversed: G34 owns the HTTP helpers; G33 imports them.** The r2 design exported `readBoundedTextBody` from [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts); that directly contradicts G34 r1's shared-module design and the G34 r1 reviewer's required correction at [../G34/04-review-r1.md](../G34/04-review-r1.md#L13-L13). Round 3 yields ownership to G34 because (a) G34 has four consumers (`fetch_url`, `fetch_page_text`, `download_file`, `download_with_fallbacks`) plus the internal `downloadUrl` against G33's one, (b) G34 also defines the binary-body reader and the timeout/classifier wrappers that G33 has no business owning, and (c) the G34 r1 reviewer makes G34 ownership a required correction. G33 r3's handler imports `fetchWithTimeout`, `readBoundedTextBody`, and `classifyNetworkError` from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts); it defines and exports no HTTP helpers itself. ([04-review-r2.md §1.1](04-review-r2.md#L11-L11) blocker resolved.)
- **Concrete `web_search` endpoint seam.** The hardcoded `https://duckduckgo.com/html/` URL is replaced by a module-level `let WEB_SEARCH_ENDPOINT: string` whose default is the production URL and which is overridden via a new option on `registerBuiltinServices`. Tests construct a `createServer`, derive `http://127.0.0.1:PORT/html/` from the listening socket, and pass it as `webSearchEndpoint` through the existing options bag at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L124-L126). The handler then talks to the in-process server for rows 10–16 of the test matrix. ([04-review-r2.md §1.2](04-review-r2.md#L13-L13) blocker resolved.)
- **`uddg` nested-escape fixture reconciled.** The fixture, prose, and test row all assert the same target. The fixture href contains the target encoded once for URL form: `/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fref%3Da%252Bb%252Fc%2526d`. `URLSearchParams.get("uddg")` returns the decoded value `https://example.com/path?ref=a%2Bb%2Fc%26d` after one round of percent-decoding. That is the value passed to `new URL(...)` and emitted as the result URL. A regression that re-introduces `decodeURIComponent` collapses `%2B` → `+`, `%2F` → `/`, and `%26` → `&`, and the assertion `expect(result.url).toBe("https://example.com/path?ref=a%2Bb%2Fc%26d")` fails. ([04-review-r2.md §1.3](04-review-r2.md#L15-L15) blocker resolved.)
- **Plan anchors refresh.** Round 3 uses live numeric line ranges from the current [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) and [src/config.ts](../../../../src/config.ts) instead of the section-named anchors `#L2.7`, `#L3.6` etc. that round 2 used. ([04-review-r2.md "Required corrections" first bullet](04-review-r2.md#L19-L19) resolved.)
- **Config-field insertion convention documented.** The live `mcp` block at [src/config.ts](../../../../src/config.ts#L137-L145) is not alphabetical — it is grouped by topic in source order: shell timeouts (`shellTimeoutMs`, `shellTimeoutFloorMs`), the in-process timeout (`inProcessTimeoutMs`), then size caps (`maxOutputBytes`, `maxFetchChars`, `maxDownloadBytes`). Round 3 documents the rule actually used: new fields go at the end of the `mcp` object body above `.superRefine`, organised into named groups (size caps; per-tool feature caps). G33 introduces a new "web search" group whose three fields are listed alphabetically within the group: `webSearchMaxBytes`, `webSearchMaxResults`, `webSearchTimeoutMs`. G34 r1's `fetchTimeoutMs` extends the existing size-caps group (right after `maxDownloadBytes`). G35 forms a separate "secrets" group after the web-search group. This rule yields zero textual merge conflicts under any G33/G34/G35 landing order. ([04-review-r2.md "Required corrections" second bullet](04-review-r2.md#L21-L21) resolved.)
- **Risk-register entry corrected.** The r2 row claiming the `decodeURIComponent` gate mitigates body-read abort misclassification was unrelated to the risk. Round 3 replaces the mitigation with the actual guard: the mid-body timeout handler test (row 14 in §3.9 of the design) plus the contract that G34's `classifyNetworkError` returns `code: "TIMEOUT"` for aborts originating from `fetchWithTimeout`'s internal signal — see the G34 r1 reviewer's blocker 2 at [../G34/04-review-r1.md](../G34/04-review-r1.md#L9-L9), which requires G34's helper to propagate the timeout signal through the body read. G33 simply trusts that contract and asserts it via row 14. ([04-review-r2.md "Required corrections" third bullet](04-review-r2.md#L23-L23) resolved.)

## 6. Open questions deferred to design

- Exact API surface that `web_search` imports from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts), including the `classifyNetworkError` return shape G33 maps into its envelope. Resolved in [02-design-r3.md §3.5](02-design-r3.md).
- Exact wiring of the `webSearchEndpoint` option through `BuiltinServicesOptions` and the test harness reset behaviour. Resolved in [02-design-r3.md §3.3](02-design-r3.md) and [02-design-r3.md §3.9](02-design-r3.md).
