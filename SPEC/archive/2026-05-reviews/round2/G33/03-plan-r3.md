# G33 — Plan r3

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)

**Design**: [02-design-r3.md](02-design-r3.md)

**Round 2 baseline**: [03-plan-r2.md](03-plan-r2.md); reviewer critique [04-review-r2.md](04-review-r2.md).

**Writer**: Claude Opus 4.7 (round 3).

Round 3 deltas vs r2 are confined to the three blocking findings and three required corrections in [04-review-r2.md](04-review-r2.md#L7-L31). Sections unchanged from r2 are referenced rather than re-stated.

## 1. Scope summary

Single PR, sequenced as one commit per step. Hard prereq: G34 has landed and exports `fetchWithTimeout`, `readBoundedTextBody`, `classifyNetworkError`, and the `ClassifiedHttpError` / `BoundedReadResult<T>` types from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts). Soft prereq: G31 r4 has landed and exports `parseNonNegativeInt` from [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

1. Add `node-html-parser@^6.1.13` to `dependencies` in [package.json](../../../../package.json). Honest footprint: 165 KB unpacked, transitive deps `he@1.2.0` and `css-select@^5.1.0`. See [02-design-r2.md §2.7](02-design-r2.md#L242-L279).
2. Add the three `webSearch*` fields to the `mcp` block in [src/config.ts](../../../../src/config.ts#L137-L145), as a new "web search" group at the end of the object body. See [02-design-r3.md §2.5 / §3.2](02-design-r3.md).
3. Add module-level `let`s, extend `BuiltinServicesOptions`, and add registration-time wiring in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts). See [02-design-r3.md §2.2 / §3.8](02-design-r3.md).
4. Add the import line from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) at the top of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts). See [02-design-r3.md §2.1](02-design-r3.md).
5. Add the parser-side helpers, types, and exported `extractDdgResults` between [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L102) (end of `stripHtml`) and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L104) (`interface DownloadAttempt`). See [02-design-r3.md §3.4](02-design-r3.md).
6. Rewrite the `web_search` handler case at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761) using the round-3 body in [02-design-r3.md §3.6](02-design-r3.md).
7. Update the `web_search` tool schema entry at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L666) per [02-design-r2.md §2.9](02-design-r2.md#L293-L310).
8. Capture fixture [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html) with the six embedded variants, plus [src/mcp/web-search.fixture.drifted.html](../../../../src/mcp/web-search.fixture.drifted.html) and [src/mcp/web-search.fixture.empty.html](../../../../src/mcp/web-search.fixture.empty.html). Row-5 fixture reconciled per [02-design-r3.md §2.3](02-design-r3.md).
9. Add 16 test cases to [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts), import `extractDdgResults` at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L7), and add the `withSearchServer` helper next to `withTextServer` at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L12-L23). See [02-design-r3.md §3.9](02-design-r3.md).
10. Refresh [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md) with three new `mcp.webSearch*` rows.

The regex extractor at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L745-L758) and the second `decodeURIComponent` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L751-L753) are removed wholesale in step 6. No compat shim. No file-private HTTP helpers — those live in G34's [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts).

## 2. File-by-file diff plan

### [package.json](../../../../package.json)

Add to `dependencies` in alphabetical position:

```jsonc
"node-html-parser": "^6.1.13"
```

Refresh the lockfile with `npm install --package-lock-only` and audit transitives with `npm ls node-html-parser`. Expected: direct dep `he@1.2.0`, direct dep `css-select@^5.1.0` (transitives `boolbase`, `css-what`, `domhandler`, `domutils`, `nth-check`). If `npm ls` reports versions outside declared semver ranges, abort the PR and update the design footprint note.

### [src/config.ts](../../../../src/config.ts)

Append a "web search" group at the end of the `mcp` object body, immediately after the existing `maxDownloadBytes` field at [src/config.ts](../../../../src/config.ts#L143). Fields alphabetised within the group per [02-design-r3.md §2.5](02-design-r3.md):

```ts
webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
webSearchMaxResults: z.number().int().min(1).max(50).default(20),
webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
```

`.superRefine(...)` at [src/config.ts](../../../../src/config.ts#L146-L167) is not touched.

### [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)

Edits in source order:

- **New top-level import**, inserted alongside [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L10-L13):

  ```ts
  import { fetchWithTimeout, readBoundedTextBody, classifyNetworkError, type ClassifiedHttpError, type BoundedReadResult } from "./httpFetch.js";
  import { parse as parseHtml, type HTMLElement } from "node-html-parser";
  ```

- **Module-level lets**, appended after [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L43):

  ```ts
  let WEB_SEARCH_MAX_BYTES = 2 * 1024 * 1024;
  let WEB_SEARCH_MAX_RESULTS = 20;
  let WEB_SEARCH_TIMEOUT_MS = 15_000;
  let WEB_SEARCH_ENDPOINT = "https://duckduckgo.com/html/";
  ```

- **Parser helpers and types**, inserted between [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L102) (end of `stripHtml`) and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L104) (`interface DownloadAttempt`):

  1. `function climbToResultContainer(node)` — file-private.
  2. `function signatureOf(html)` — file-private (uses `createHash` already imported at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L27)).
  3. `export interface DdgResult` — named export.
  4. `export interface DdgExtraction` — named export.
  5. `export function extractDdgResults(html, base, max)` — named export with the body from [02-design-r2.md §3.4](02-design-r2.md#L399-L463) (row-5 fixture/expectation aligned per [02-design-r3.md §2.3](02-design-r3.md)).

- **`BuiltinServicesOptions`** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L124-L126) gains one optional field:

  ```ts
  interface BuiltinServicesOptions {
    promptInjectionCop?: PromptInjectionCop;
    webSearchEndpoint?: string;
  }
  ```

- **Tool schema** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L666): rewrite the outer `description` and the `max_results` property description per [02-design-r2.md §2.9](02-design-r2.md#L293-L310). The outer description gains the `code` enumeration: `INVALID_ARGUMENT`, `TIMEOUT`, `NETWORK_ERROR`, `UPSTREAM_HTTP_ERROR`, `RESPONSE_TOO_LARGE`, `NO_RESULTS_PARSED`, `PARSE_FAILURE`.

- **Handler** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761): replace the entire `case "web_search":` block with the round-3 body in [02-design-r3.md §3.6](02-design-r3.md). The new block is longer but stays inside the same `switch`.

- **Registration wiring** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1081): add four assignments after the existing `SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;` line:

  ```ts
  WEB_SEARCH_MAX_BYTES = mcpConfig.webSearchMaxBytes;
  WEB_SEARCH_MAX_RESULTS = mcpConfig.webSearchMaxResults;
  WEB_SEARCH_TIMEOUT_MS = mcpConfig.webSearchTimeoutMs;
  WEB_SEARCH_ENDPOINT = options.webSearchEndpoint ?? "https://duckduckgo.com/html/";
  ```

  Reset behaviour: every `registerBuiltinServices` call reapplies the default unless an override is provided, so tests need no `afterEach` cleanup for the endpoint.

### [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html) (new)

One-off operator capture, hand-trimmed per [02-design-r2.md §2.8 / §3.9](02-design-r2.md#L281-L291) and reconciled per [02-design-r3.md §2.3](02-design-r3.md). Embedded variants:

1. Result with attribute order `<a href="…" class="result__a">` (`href` before `class`).
2. Result with `class="result__a result__a--clicktrack"`.
3. Result whose snippet is `<div class="result__snippet">…</div>`.
4. Result whose `.result` container has no `.result__snippet` descendant.
5. Result whose href is `/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fref%3Da%252Bb%252Fc%2526d` (nested escapes; one decode by `URLSearchParams.get` yields `https://example.com/path?ref=a%2Bb%2Fc%26d`).
6. Result whose href is the literal string `not a url` (skipped, increments `skipped`).

Two derivative fixtures (also new):

- [src/mcp/web-search.fixture.drifted.html](../../../../src/mcp/web-search.fixture.drifted.html): same body, `class="result__a"` renamed to `class="result__title"`, `result__snippet` renamed to `result__body`.
- [src/mcp/web-search.fixture.empty.html](../../../../src/mcp/web-search.fixture.empty.html): minimal HTML shell, zero `result__a` anchors.

### [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)

- Update the existing import at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L7):

  ```ts
  import { registerBuiltinServices, extractDdgResults, type DdgResult } from "./builtins.js";
  ```

- Add a new test helper `withSearchServer` adjacent to `withTextServer` at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L12-L23). Signature:

  ```ts
  async function withSearchServer(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    fn: (endpoint: string) => Promise<void>,
  ): Promise<void>;
  ```

  Implementation: `createServer(handler)`, listen on `127.0.0.1:0`, derive `endpoint = \`http://127.0.0.1:${port}/html/\``, invoke `fn(endpoint)`, close in `finally`.

- Append a new `describe("data: web_search", () => { ... })` block at the bottom of the file (before the closing brace of the outer suite). Parser-level cases (#1–#7) call `extractDdgResults` directly and load fixtures via `readFileSync(new URL("./web-search.fixture.html", import.meta.url), "utf8")`. Handler-level cases (#8–#16) wrap `withSearchServer` and call:

  ```ts
  registerBuiltinServices(
    runtime,
    { ...cfg.mcp, webSearchTimeoutMs: 1_000, webSearchMaxBytes: 64 * 1024 },
    { webSearchEndpoint: endpoint },
  );
  ```

  for cap-bearing cases; otherwise omit the cap overrides. The closed-port case (#16) computes a port by listening + immediately closing, then passes the dead endpoint to `registerBuiltinServices` without ever calling `withSearchServer`.

### [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)

Add three rows under the existing `mcp.maxDownloadBytes` row documenting `webSearchMaxBytes`, `webSearchMaxResults`, `webSearchTimeoutMs` (defaults and one-sentence rationale each).

## 3. Test gates

Local gates (must all pass before opening the PR):

1. `npm run lint`.
2. `grep -nc 'export function extractDdgResults' src/mcp/builtins.ts` → 1.
3. `grep -nc 'export async function readBoundedTextBody' src/mcp/builtins.ts` → 0 (regression gate: the helper must NOT be exported from `builtins.ts`; it lives in `httpFetch.ts`).
4. `grep -nc 'export async function readBoundedTextBody' src/mcp/httpFetch.ts` → 1 (verifies G34 has landed).
5. `grep -nc 'function parseNonNegativeInt' src/mcp/builtins.ts` → 1 (verifies G31 r4 has landed).
6. `awk '/case "web_search":/,/case "fetch_url":/' src/mcp/builtins.ts | grep -c 'decodeURIComponent'` → 0 (regression gate against the double-decode bug).
7. `awk '/case "web_search":/,/case "fetch_url":/' src/mcp/builtins.ts | grep -c 'new URL(WEB_SEARCH_ENDPOINT)'` → 1 (regression gate: the handler must use the seam, not a hardcoded URL string).
8. `npm run build` (tsup).
9. `npm test -- src/mcp/builtins.test.ts` — 16 new cases plus existing suite pass.
10. `npm test` — full suite green.
11. `npm ls node-html-parser` — output matches the audit expectation in §2.
12. Manual snapshot: with the harness pointed at the dev project, run a `web_search` against `"mlflow model signature"` from the data-agent and confirm:
    - success path returns ≥ 1 result with non-empty `title` + `url`;
    - simulated DDG outage (`sudo iptables -I OUTPUT -p tcp --dport 443 -d duckduckgo.com -j REJECT`, restore with `-D`) surfaces `code: "NETWORK_ERROR"` rather than an unhandled exception.

CI gates: none beyond the existing pipeline. The fixture-driven tests never touch the public network.

## 4. Deploy

Unchanged from r1 ([03-plan-r1.md §4](03-plan-r1.md#L138-L168)). Build, restart `saivage.service` on `saivage` (10.0.3.111), `diedrico` (10.0.3.113), and `saivage-v3` (10.0.3.112); skip `saivage-v3-getrich-v2` (10.0.3.170) — no bind-mount.

## 5. Rollback

Unchanged from r1 ([03-plan-r1.md §5](03-plan-r1.md#L170-L177)).

## 6. Risk register (revised)

| Risk                                                                                       | Likelihood | Impact                                                       | Mitigation                                                                                                                                                                                                                                                                                                                       |
|--------------------------------------------------------------------------------------------|------------|--------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| DDG markup drift between fixture capture and prod                                          | medium     | parser returns zero results                                  | `NO_RESULTS_PARSED` envelope makes the regression loud; operator re-captures fixture and re-runs the test                                                                                                                                                                                                                        |
| DDG blocks the User-Agent                                                                  | low        | every call returns `UPSTREAM_HTTP_ERROR` (403/429)            | structured `code` lets the agent surface a clear failure                                                                                                                                                                                                                                                                         |
| `node-html-parser` upstream tightens its transitive deps                                   | low        | bundle bloat                                                 | pinned to `^6.1.13`; `npm ls node-html-parser` enforced in §3 gate 11                                                                                                                                                                                                                                                            |
| G31 r4 has not landed when G33 ships, breaking `parseNonNegativeInt` reference             | low        | type error; `INVALID_ARGUMENT` parity gap with G32           | gate §3 #5 fails fast and blocks the PR                                                                                                                                                                                                                                                                                          |
| G34 has not landed when G33 ships, breaking the `./httpFetch.js` import                    | low        | build failure                                                | gate §3 #4 fails fast; sequencing per [02-design-r3.md §4](02-design-r3.md) is **G30 → G31 → G34 → G33 → G35**                                                                                                                                                                                                                   |
| Mid-body abort classified as `NETWORK_ERROR` because G34 r2 did not propagate signal       | low        | row 14 fails; user-visible quiet bug if gate is bypassed     | row 14 in [02-design-r3.md §3.9](02-design-r3.md) is the primary behavioural guard; G33 trusts G34 r1 reviewer blocker 2 at [../G34/04-review-r1.md](../G34/04-review-r1.md#L9-L9) to land before G33                                                                                                                            |
| `mcp` config-block textual conflict on merge with G34 or G35                               | low        | three-way merge friction                                     | named-group append rule from [02-design-r3.md §2.5](02-design-r3.md): G34 extends size caps; G33 adds "web search"; G35 adds "secrets"; groups are spatially disjoint                                                                                                                                                            |
| `webSearchEndpoint` override leaks between tests if `beforeEach` skips `registerBuiltinServices` | low        | a later test calls the prod URL                              | `registerBuiltinServices` re-assigns `WEB_SEARCH_ENDPOINT` from `options.webSearchEndpoint ?? "https://duckduckgo.com/html/"` on every call ([02-design-r3.md §2.2](02-design-r3.md)); the existing test layout already calls it in `beforeEach`                                                                                  |

The r1 "readBoundedTextBody ships twice" risk is removed: G34 owns the helper as an export ([02-design-r3.md §2.1](02-design-r3.md)); G33 imports it.

## 7. Out-of-scope follow-ups (unchanged)

See [03-plan-r1.md §7](03-plan-r1.md#L201-L213). No deltas.
