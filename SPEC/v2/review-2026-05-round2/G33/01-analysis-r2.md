# G33 — Analysis r2

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Round 1 baseline**: [01-analysis-r1.md](01-analysis-r1.md); reviewer
critique [04-review-r1.md](04-review-r1.md).

**Writer**: Claude Opus 4.7 (round 2).

Round 2 keeps the same root-cause framing as r1. The deltas vs r1
are confined to constraints that are now factually grounded against
the live source and the round-1 review:

1. The shared helper `parseNonNegativeInt` does **not** exist in
   the current tree (verified in
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L756)).
   It is added by G31's r2 plan in
   [SPEC/v2/review-2026-05-round2/G31/03-plan-r2.md](../G31/03-plan-r2.md#L81-L88).
   G33 therefore declares an explicit ordering dependency on G31
   landing first, instead of pretending the helper is already in
   place.
2. The new `node-html-parser` dependency has two transitive deps
   (`he`, `css-select`) and an unpacked size of 165 KB per the
   registry, not zero deps / 50 KB as r1 stated. The dependency is
   still acceptable but the design and plan record the honest
   footprint and a lockfile audit step.
3. The bounded body-read helper has a single owner: G33. G34
   consumes it later (see r2 §3 sequencing).

Sections not listed below are unchanged from r1 and are not
re-stated.

## 1. What the code does today (unchanged from r1)

See [01-analysis-r1.md §1](01-analysis-r1.md#L13-L40). The handler
shape, regex, and only-error-on-empty-query semantics in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761)
are confirmed against the live file. The single registration-only
test is at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L84).

The handler also already implements a single-step `uddg`
double-decoding mistake at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L748-L753):
`URLSearchParams.get("uddg")` returns the percent-decoded value,
and the handler then calls `decodeURIComponent` on that string a
second time. Targets that legitimately contain encoded escapes
(`%252B`, `%252F`, `%2526`) end up with one extra round of
unescaping; URLs with literal `%` characters that survive into the
inner string fail `decodeURIComponent` and silently fall back to
the original tracker URL. This is round-1 review blocker 4
([04-review-r1.md §1.4](04-review-r1.md#L13-L17)) and is rooted in
the existing handler, not in r1's design.

## 2. Root cause (unchanged from r1)

See [01-analysis-r1.md §2](01-analysis-r1.md#L42-L66). The three
defects (regex over HTML; empty-results = success; no
upstream-failure envelope) are unchanged.

## 3. Blast radius (unchanged from r1)

See [01-analysis-r1.md §3](01-analysis-r1.md#L68-L88). The
same-file co-touch matrix with G31 / G32 / G34 / G35 is unchanged.

## 4. Project-rule check (unchanged from r1)

See [01-analysis-r1.md §4](01-analysis-r1.md#L90-L106). Build one
good extractor; surface failure loudly; do not ship a provider
registry with one implementation.

## 5. Constraints carried into design (r2 deltas)

Carried from r1:

- G31/G32-style envelope:
  `{ content: { error, code, ...context }, isError: true }` on
  failure; `{ content: { ...payload }, isError: false }` on
  success.
- Field names disjoint from G34's planned `fetchTimeoutMs` /
  `fetchMaxBytes` and from G35's secrets additions in the same
  `mcp` block.
- No regex over HTML for structural extraction.
- Fixture test must fail loudly when the parser produces zero
  results from a known-good fixture.

New / revised in r2:

- **Abort during body read is a `TIMEOUT`, not `NETWORK_ERROR`.**
  The handler must inspect `controller.signal.aborted` in the
  body-read catch and classify accordingly. r1 only classified
  the initial `fetch` catch
  ([04-review-r1.md §1.1](04-review-r1.md#L7-L8)).
- **Cap tests use min-valid config values.** The Zod schema's
  `webSearchTimeoutMs.min(1_000)` and
  `webSearchMaxBytes.min(64 * 1024)` floors are honoured; the
  test fixture timeouts and oversized-body asserts pivot on a
  real in-process server using the existing `createServer`
  pattern in
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L220-L240),
  not on `vi.spyOn` against a body that never closes
  ([04-review-r1.md §1.2](04-review-r1.md#L9-L10)).
- **`extractDdgResults` is a named export.** Direct parser-level
  fixture tests need it; ESM cannot reach a file-private helper.
  The export discipline mirrors G31's exported `classifyFsError`
  in [SPEC/v2/review-2026-05-round2/G31/02-design-r4.md](../G31/02-design-r4.md#L41-L48).
  ([04-review-r1.md §1.3](04-review-r1.md#L11-L12)).
- **`uddg` is decoded exactly once.** The value returned by
  `URLSearchParams.get("uddg")` is already percent-decoded;
  validate it directly with `new URL(uddg)` and add a fixture
  row that exercises a target containing `%252B` / `%252F` /
  `%2526` so a regression that re-introduces double-decoding
  fails the parser smoke test
  ([04-review-r1.md §1.4](04-review-r1.md#L13-L17)).
- **`readBoundedTextBody` owner = G33.** G33 lands the helper as
  a module export from
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts);
  G34 consumes the existing export when its scope migrates
  `fetch_url` / `fetch_page_text` / `download_file` /
  `download_with_fallbacks`. The recommended merge order is
  updated accordingly: G30 → G31 → G32 → G33 → G34 → G35
  ([04-review-r1.md §1.5](04-review-r1.md#L19-L21)).
- **`parseNonNegativeInt` is owned by G31.** G33 depends on G31
  landing first, otherwise the rebase reopens the
  `INVALID_ARGUMENT` parity with G32 that the reviewer flagged in
  [04-review-r1.md §1.6](04-review-r1.md#L23-L26).
- **`node-html-parser` dependency footprint.** Per the registry:
  direct deps `he@1.2.0` and `css-select@^5.1.0`; unpacked size
  165 KB. The honest footprint is recorded in the design and the
  plan adds an `npm ls node-html-parser` audit step
  ([04-review-r1.md "Required corrections", line 31](04-review-r1.md#L31)).
- **Fixture matrix is wider.** Beyond the round-1 happy path,
  fixtures must exercise: class-attribute reordering; an anchor
  carrying multiple classes (`result__a result__a--something`);
  snippet rendered as a `<div class="result__snippet">`; a
  result with no snippet element at all (kept, snippet blank);
  malformed per-entry `href` (skipped, not fatal). This is the
  reviewer's second required correction in
  [04-review-r1.md "Required corrections", line 33](04-review-r1.md#L33).
- **Tool schema lists the new ceiling.** The `max_results`
  property description references the configured ceiling (20 by
  default, 50 maximum). This is the third required correction in
  [04-review-r1.md "Required corrections", line 35](04-review-r1.md#L35).

## 6. Open questions deferred to design

- Which exact CSS selector to use for the result anchor and
  snippet? Resolved in [02-design-r2.md §3.4](02-design-r2.md).
- How to keep the body-read abort classifier branch testable
  without making the fixture flaky? Resolved by using a real
  HTTP server that stalls its response stream — see
  [02-design-r2.md §3.5](02-design-r2.md).
