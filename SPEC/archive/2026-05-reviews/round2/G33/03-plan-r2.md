# G33 — Plan r2

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)

**Design**: [02-design-r2.md](02-design-r2.md)

**Round 1 baseline**: [03-plan-r1.md](03-plan-r1.md); reviewer
critique [04-review-r1.md](04-review-r1.md).

**Writer**: Claude Opus 4.7 (round 2).

Round 2 deltas vs r1 are confined to the six blocking findings
and three required corrections in
[04-review-r1.md](04-review-r1.md). Sections unchanged from r1 are
referenced rather than re-stated.

## 1. Scope summary (revised)

Single PR, sequenced as one commit per step:

1. Add `node-html-parser` to `dependencies` in
   [package.json](../../../../package.json). Honest footprint:
   165 KB unpacked, transitive deps `he@1.2.0` and
   `css-select@^5.1.0` (see [02-design-r2.md §2.7](02-design-r2.md#L2.7)).
2. Add `webSearchMaxBytes` / `webSearchMaxResults` /
   `webSearchTimeoutMs` to the `mcp` block in
   [src/config.ts](../../../../src/config.ts#L137-L170)
   (alphabetical order to match the G35 merge rule).
3. Add module-level lets + `registerBuiltinServices` wiring in
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42)
   and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078).
4. Add helpers in
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L91-L102),
   in source order: file-private `isAbortError`, `signatureOf`,
   `climbToResultContainer`; exported `readBoundedTextBody`,
   `extractDdgResults` (plus exported types `DdgResult` and
   `DdgExtraction`).
5. Rewrite the `web_search` handler case at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761)
   using the round-2 version in
   [02-design-r2.md §3.6](02-design-r2.md#L3.6).
6. Update the `web_search` schema in `dataTools` at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L658-L664)
   per [02-design-r2.md §2.9](02-design-r2.md#L2.9).
7. Capture fixture
   [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html)
   with the six embedded variants enumerated in
   [02-design-r2.md §3.9](02-design-r2.md#L3.9), plus the two
   derivative fixtures
   [src/mcp/web-search.fixture.drifted.html](../../../../src/mcp/web-search.fixture.drifted.html)
   and
   [src/mcp/web-search.fixture.empty.html](../../../../src/mcp/web-search.fixture.empty.html).
8. Add the 16 test cases enumerated in
   [02-design-r2.md §3.9](02-design-r2.md#L3.9) to
   [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts);
   import `extractDdgResults` alongside the existing
   `registerBuiltinServices` import at
   [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L7).
9. Refresh
   [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
   with three new `mcp.*` rows.

The regex extractor in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L747-L753)
is removed wholesale in step 5. No compat shim, no second code
path.

## 2. File-by-file diff plan

### [package.json](../../../../package.json)

Add to `dependencies` (alphabetical order, between the existing
`micromatch`-shaped neighbours):

```jsonc
"node-html-parser": "^6.1.13"
```

Refresh the lockfile with `npm install --package-lock-only`.

After install, audit transitive deps:

```bash
npm ls node-html-parser
```

Expected (per `npm view`):
- direct dep `he@1.2.0`
- direct dep `css-select@^5.1.0` (pulls `boolbase`, `css-what`,
  `domhandler`, `domutils`, `nth-check`)

If `npm ls` reports versions outside the declared semver ranges,
abort the PR and update the design footprint note before
proceeding.

### [src/config.ts](../../../../src/config.ts#L137-L170)

Insert three fields inside the `mcp` z.object literal above
`.superRefine(...)`, ordered alphabetically:

```ts
webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
webSearchMaxResults: z.number().int().min(1).max(50).default(20),
webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
```

`.superRefine` is not touched. Merge rule for G35: same insertion
point, alphabetical order.

### [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)

Edit sites, in source order:

- **Imports** (top of file, after the existing third-party
  imports near
  [line 27](../../../../src/mcp/builtins.ts#L27)): add
  `import { parse as parseHtml, type HTMLElement } from "node-html-parser";`
  on its own line.
- **Module-level constants** (near
  [line 42](../../../../src/mcp/builtins.ts#L42)): add three
  `let` declarations under the existing `MAX_FETCH_CHARS` line:

  ```ts
  let WEB_SEARCH_MAX_BYTES = 2 * 1024 * 1024;
  let WEB_SEARCH_MAX_RESULTS = 20;
  let WEB_SEARCH_TIMEOUT_MS = 15_000;
  ```

- **Helpers** (after `stripHtml` at
  [line 91-102](../../../../src/mcp/builtins.ts#L91-L102),
  before the `interface DownloadAttempt` block): insert in this
  order:
  1. `function isAbortError(...)` (file-private)
  2. `function signatureOf(...)` (file-private)
  3. `export async function readBoundedTextBody(...)` (G33 owns
     this; G34 will reuse the export)
  4. `function climbToResultContainer(...)` (file-private)
  5. `export interface DdgResult` (named export)
  6. `export interface DdgExtraction` (named export)
  7. `export function extractDdgResults(...)` (named export)

  Literal bodies in [02-design-r2.md §3.4](02-design-r2.md#L3.4),
  [§3.5](02-design-r2.md#L3.5), and [§3.6](02-design-r2.md#L3.6).
- **Tool schema** at
  [line 657-669](../../../../src/mcp/builtins.ts#L657-L669):
  update both the outer `description` of the `web_search` entry
  and the `max_results` property `description`, per
  [02-design-r2.md §2.9](02-design-r2.md#L2.9).
- **Handler** at
  [line 737-761](../../../../src/mcp/builtins.ts#L737-L761):
  replace the entire `case "web_search":` block with the round-2
  version in
  [02-design-r2.md §3.6](02-design-r2.md#L3.6). The new block is
  longer but stays inside the same `switch`.
- **Registration wiring** at
  [line 1078](../../../../src/mcp/builtins.ts#L1078): add three
  assignments under `MAX_DOWNLOAD_BYTES = mcpConfig.maxDownloadBytes;`:

  ```ts
  WEB_SEARCH_MAX_BYTES = mcpConfig.webSearchMaxBytes;
  WEB_SEARCH_MAX_RESULTS = mcpConfig.webSearchMaxResults;
  WEB_SEARCH_TIMEOUT_MS = mcpConfig.webSearchTimeoutMs;
  ```

### [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html) (new)

One-off operator capture from
`curl 'https://duckduckgo.com/html/?q=mlflow+model+signature' -A 'Saivage/0.1 data-agent' -o src/mcp/web-search.fixture.html`,
hand-trimmed to:

- Keep ≥ 5 result blocks (anchors with `result__a` and
  `result__snippet`).
- Replace any tracking-id-like values in `uddg` redirects with
  `example.com`-style placeholders.
- Keep the `<html>`/`<body>` shell intact.

Embed the six variants enumerated in
[02-design-r2.md §3.9](02-design-r2.md#L3.9):

1. One result with attribute order `<a href="…" class="result__a">`
   (`href` before `class`).
2. One result with `class="result__a result__a--clicktrack"`.
3. One result whose snippet is
   `<div class="result__snippet">…</div>` (not an `<a>`).
4. One result whose `.result` container has no
   `.result__snippet` descendant.
5. One result whose tracker target is
   `/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fref%3Da%252Bb%252Fc%252526d`
   (nested percent escapes).
6. One result whose `href` is the literal string `not a url`
   (skipped, increments `skipped`).

Two derivative fixtures (also new):

- [src/mcp/web-search.fixture.drifted.html](../../../../src/mcp/web-search.fixture.drifted.html):
  same body, `class="result__a"` renamed to
  `class="result__title"`, `result__snippet` renamed to
  `result__body`.
- [src/mcp/web-search.fixture.empty.html](../../../../src/mcp/web-search.fixture.empty.html):
  minimal HTML shell, zero `result__a` anchors.

### [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)

- Update the existing import at
  [line 7](../../../../src/mcp/builtins.test.ts#L7):

  ```ts
  import { registerBuiltinServices, extractDdgResults, type DdgResult } from "./builtins.js";
  ```

- Append a new `describe("data: web_search", () => { ... })`
  block at the bottom of the file (before the closing brace of
  the outer suite).
- For parser-level cases (#1–#7 in
  [02-design-r2.md §3.9](02-design-r2.md#L3.9)), call
  `extractDdgResults` directly; load fixtures via
  `readFileSync(new URL("./web-search.fixture.html", import.meta.url), "utf8")`.
- For handler-level cases (#8–#16), use the in-process server
  pattern at
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L220-L240).
  Construct each test server with `createServer(...)` and
  configure responses per the test row (200/503; stalled
  headers; stalled mid-body; oversized stream; immediate close).
  Register builtins with the override pattern
  `registerBuiltinServices(runtime, { ...cfg.mcp,
  webSearchTimeoutMs: 1_000, webSearchMaxBytes: 64 * 1024 }, ...)`
  for cap-bearing cases; otherwise pass `cfg.mcp` unchanged.
- For the handler-level cases that need the handler to talk to
  the test server instead of `duckduckgo.com`, reuse the same
  override seam (`PROJECT_ROOT`-style env var or test-only
  exported constant; the design defers the exact seam choice to
  the simplest existing pattern in
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L220-L240)).

### [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)

Add three rows under the existing `mcp.maxDownloadBytes` row
documenting `webSearchMaxBytes`, `webSearchMaxResults`,
`webSearchTimeoutMs` (defaults and one-sentence rationale each).

## 3. Test gates

Local gates (must all pass before opening the PR):

1. `npm run lint`.
2. `grep -nc 'export function extractDdgResults' src/mcp/builtins.ts` → 1.
3. `grep -nc 'export async function readBoundedTextBody' src/mcp/builtins.ts` → 1.
4. `grep -nc 'function parseNonNegativeInt' src/mcp/builtins.ts` → 1 (verifies
   that G31 has landed and `parseNonNegativeInt` is in tree; if
   the grep returns 0, see §6 risk register for the inline
   fallback).
5. `grep -nc 'decodeURIComponent' src/mcp/builtins.ts` → 0 inside
   the `web_search` handler block (regression gate against the
   uddg double-decoding bug). Run the gate scoped to lines
   delimited by `case "web_search":` and the next `case`.
6. `npm run build` (tsup; surfaces any type error in the new
   helpers).
7. `npm test -- src/mcp/builtins.test.ts` — the 16 new cases plus
   the existing suite must pass.
8. `npm test` — full suite green, including G30's
   `noSyncFsScanner` regression check (G33 introduces no new
   sync-fs call sites; allow-list unchanged).
9. `npm ls node-html-parser` — output matches the audit
   expectation in §2.
10. Manual snapshot: with the harness pointed at the dev project,
    run a `web_search` against `"mlflow model signature"` from
    the data-agent and confirm:
    - success path returns ≥ 1 result with non-empty `title` +
      `url`;
    - simulated DDG outage
      (`sudo iptables -I OUTPUT -p tcp --dport 443 -d duckduckgo.com -j REJECT`,
      restore with `-D`) surfaces `NETWORK_ERROR` rather than an
      unhandled exception.

CI gates: none beyond the existing pipeline. The fixture-driven
tests never touch the network.

## 4. Deploy

Unchanged from r1
([03-plan-r1.md §4](03-plan-r1.md#L138-L168)). Build, restart
`saivage.service` on `saivage` (10.0.3.111), `diedrico`
(10.0.3.113), and `saivage-v3` (10.0.3.112); skip
`saivage-v3-getrich-v2` (10.0.3.170) — no bind-mount.

## 5. Rollback

Unchanged from r1
([03-plan-r1.md §5](03-plan-r1.md#L170-L177)).

## 6. Risk register (revised)

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| DDG markup drift between fixture capture and prod | medium | parser returns zero results | `NO_RESULTS_PARSED` envelope makes the regression loud; operator re-captures fixture and re-runs the test |
| DDG blocks the User-Agent | low | every call returns `UPSTREAM_HTTP_ERROR` (403/429) | structured `code` lets the agent surface a clear failure |
| `node-html-parser` upstream tightens its transitive deps | low | bundle bloat | pinned to `^6.1.13`, audit `npm ls node-html-parser` enforced in §3 gate 9 |
| G31 has not landed when G33 ships, breaking `parseNonNegativeInt` reference | low | type error / `INVALID_ARGUMENT` parity gap with G32 | gate §3.4 fails fast; fallback is to inline the five-line helper inside G33 and let G31 dedup on land (NOT a compat shim — G31 owns the helper, G33 just borrows the body if rebased ahead) |
| `mcp` config block conflict on merge with G35 | low | textual merge conflict | alphabetical-insertion rule documented in §2; trivial three-way merge |
| Body-read abort classified as `NETWORK_ERROR` due to library quirk | low | timeout test fails | gate §3.5 enforces zero `decodeURIComponent` calls in the handler; the test row §3.9 #14 is the primary guard |

The r1 "readBoundedTextBody ships twice" risk is removed: G33
owns the helper as an export
([02-design-r2.md §2.5](02-design-r2.md#L2.5)); G34 consumes it.

## 7. Out-of-scope follow-ups (unchanged)

See [03-plan-r1.md §7](03-plan-r1.md#L201-L213). No deltas.
