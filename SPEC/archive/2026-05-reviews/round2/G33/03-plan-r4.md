# G33 — Plan r4

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Analysis**: [01-analysis-r4.md](01-analysis-r4.md)

**Design**: [02-design-r4.md](02-design-r4.md)

**Round 3 baseline**: [03-plan-r3.md](03-plan-r3.md); reviewer critique [04-review-r3.md](04-review-r3.md).

**Writer**: Claude Opus 4.7 (round 4).

Round 4 deltas vs r3 are confined to the two blocking findings in [04-review-r3.md](04-review-r3.md#L7-L11): align with the FINAL G34 r3 contract and retarget the config insertion to the post-G34 size-caps shape. Sections unchanged from r3 are referenced rather than re-stated.

## 1. Scope summary

Single PR, sequenced as one commit per step. Hard prereq: **G34 r3 has landed** and [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) exports `fetchWithTimeout`, `readBoundedTextBody`, `classifyNetworkError`, `discardBody`, and the `TimedFetch` / `ClassifiedHttpError` / `BoundedReadResult<T>` types per [../G34/02-design-r3.md](../G34/02-design-r3.md#L57-L271). After G34 r3 lands, the `mcp` config block has renamed `maxFetchChars` to `maxFetchBytes` and added `fetchTimeoutMs`; the size-caps group ends with `fetchTimeoutMs` ([../G34/02-design-r3.md](../G34/02-design-r3.md#L334-L341)). Soft prereq: G31 r4 has landed and exports `parseNonNegativeInt` from [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

1. Add `node-html-parser@^6.1.13` to `dependencies` in [package.json](../../../../package.json). Footprint and audit per [02-design-r2.md §2.7](02-design-r2.md#L242-L279). Unchanged from r3.
2. Add the three `webSearch*` fields to the `mcp` block in [src/config.ts](../../../../src/config.ts), as a new "web search" group at the end of the object body — **after** the size-caps group's last field, which post-G34 is `fetchTimeoutMs`. See [02-design-r4.md §2.5 / §3.2](02-design-r4.md).
3. Add module-level `let`s, extend `BuiltinServicesOptions`, and add registration-time wiring in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts). Unchanged from r3 ([02-design-r3.md §2.2 / §3.8](02-design-r3.md)).
4. Add the import line from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) at the top of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts). Refined for r4: also imports `discardBody`, `type TimedFetch`, `type BoundedReadResult`. See [02-design-r4.md §2.1 / §3.6](02-design-r4.md).
5. Add the parser-side helpers, types, and exported `extractDdgResults` between [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L102) (end of `stripHtml`) and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L104) (`interface DownloadAttempt`). Unchanged from r3 ([02-design-r3.md §3.4](02-design-r3.md)).
6. Rewrite the `web_search` handler case at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761) using the round-4 body in [02-design-r4.md §3.6](02-design-r4.md). Differs from r3: destructures `TimedFetch`, wraps the post-fetch block in `try/finally { timed.dispose() }`, threads `timed.signal` into `readBoundedTextBody`, and forwards `{ timedOut: timed.timedOut() }` into `classifyNetworkError` from the body-read catch.
7. Update the `web_search` tool schema entry at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L666) per [02-design-r2.md §2.9](02-design-r2.md#L293-L310). Unchanged from r3.
8. Capture fixture [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html) with the six embedded variants, plus [src/mcp/web-search.fixture.drifted.html](../../../../src/mcp/web-search.fixture.drifted.html) and [src/mcp/web-search.fixture.empty.html](../../../../src/mcp/web-search.fixture.empty.html). Row-5 fixture reconciled per [02-design-r3.md §2.3](02-design-r3.md). Unchanged from r3.
9. Add 17 test cases to [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts) (16 from r3 plus the new row 17 timer-cleanup case), import `extractDdgResults` at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L7), and add the `withSearchServer` helper next to `withTextServer` at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L12-L23). See [02-design-r4.md §3.9](02-design-r4.md).
10. Refresh [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md) with three new `mcp.webSearch*` rows, placed after the size-caps rows. Unchanged from r3 (but note that G34 r3 separately adds rows for `maxFetchBytes` and `fetchTimeoutMs`, which G33 leaves to G34).

The regex extractor at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L745-L758) and the second `decodeURIComponent` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L751-L753) are removed wholesale in step 6. No compat shim. No file-private HTTP helpers — those live in G34's [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts). No backward-compat shim for the `maxFetchChars` → `maxFetchBytes` rename — G33 references the new name only.

## 2. File-by-file diff plan

### [package.json](../../../../package.json)

Unchanged from r3 ([03-plan-r3.md §2](03-plan-r3.md)). Add `"node-html-parser": "^6.1.13"` to `dependencies`; refresh lockfile; audit transitives.

### [src/config.ts](../../../../src/config.ts)

Append a "web search" group at the end of the `mcp` object body, immediately **after** the size-caps group's last field. After G34 r3 lands, that last field is `fetchTimeoutMs` ([../G34/02-design-r3.md](../G34/02-design-r3.md#L334-L341)). Concretely, after G34 r3 the `mcp` object looks like:

```ts
mcp: z
  .object({
    shellTimeoutMs: z.number().default(4 * 60 * 60 * 1000),
    shellTimeoutFloorMs: z.number().default(10 * 60 * 1000),
    inProcessTimeoutMs: z.number().default(300_000),
    maxOutputBytes: z.number().default(100 * 1024),
    maxFetchBytes: z.number().default(200_000),        // ← renamed by G34
    maxDownloadBytes: z.number().default(250 * 1024 * 1024),
    fetchTimeoutMs: z.number().default(60_000),        // ← added by G34
  })
  .default({})
  .superRefine(/* unchanged */),
```

G33 appends three fields after `fetchTimeoutMs` and before `.default({})`:

```ts
webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
webSearchMaxResults: z.number().int().min(1).max(50).default(20),
webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
```

`.superRefine(...)` at [src/config.ts](../../../../src/config.ts#L146-L167) is not touched.

If the implementer encounters a tree where G34 has not yet landed (size-caps tail is still `maxFetchChars`, `maxDownloadBytes`), gate §3 #4 fails fast and the PR must wait.

### [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)

Edits in source order:

- **New top-level import**, inserted alongside [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L10-L13). Differs from r3: now imports `discardBody`, `type TimedFetch`, and `type BoundedReadResult`:

  ```ts
  import {
    fetchWithTimeout,
    readBoundedTextBody,
    classifyNetworkError,
    discardBody,
    type ClassifiedHttpError,
    type TimedFetch,
    type BoundedReadResult,
  } from "./httpFetch.js";
  import { parse as parseHtml, type HTMLElement } from "node-html-parser";
  ```

- **Module-level lets**, appended after [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L43). Unchanged from r3:

  ```ts
  let WEB_SEARCH_MAX_BYTES = 2 * 1024 * 1024;
  let WEB_SEARCH_MAX_RESULTS = 20;
  let WEB_SEARCH_TIMEOUT_MS = 15_000;
  let WEB_SEARCH_ENDPOINT = "https://duckduckgo.com/html/";
  ```

- **Parser helpers and types**, inserted between [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L102) and [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L104). Unchanged from r3 ([03-plan-r3.md §2](03-plan-r3.md)).

- **`BuiltinServicesOptions`** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L124-L126) gains `webSearchEndpoint?: string`. Unchanged from r3.

- **Tool schema** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L666). Unchanged from r3.

- **Handler** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761): replace the entire `case "web_search":` block with the round-4 body in [02-design-r4.md §3.6](02-design-r4.md). The handler now:

  1. Destructures `TimedFetch` as `{ response, signal, timedOut }`.
  2. Wraps the entire post-fetch block in `try { ... } finally { timed.dispose(); }`.
  3. Threads `signal` into `readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES, signal)`.
  4. Forwards `{ timedOut: timedOut() }` into `classifyNetworkError` from the body-read catch.
  5. Uses `await discardBody(response)` on the `!response.ok` branch instead of an ad-hoc body cancel.

- **Registration wiring** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1081). Unchanged from r3 (four assignments after the existing `SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;` line):

  ```ts
  WEB_SEARCH_MAX_BYTES = mcpConfig.webSearchMaxBytes;
  WEB_SEARCH_MAX_RESULTS = mcpConfig.webSearchMaxResults;
  WEB_SEARCH_TIMEOUT_MS = mcpConfig.webSearchTimeoutMs;
  WEB_SEARCH_ENDPOINT = options.webSearchEndpoint ?? "https://duckduckgo.com/html/";
  ```

### Fixtures (unchanged from r3)

[src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html), [src/mcp/web-search.fixture.drifted.html](../../../../src/mcp/web-search.fixture.drifted.html), [src/mcp/web-search.fixture.empty.html](../../../../src/mcp/web-search.fixture.empty.html) per [03-plan-r3.md §2](03-plan-r3.md).

### [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)

Unchanged from r3 except for the row-17 addition:

- Update import at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L7) to also import `extractDdgResults` and `type DdgResult`.
- Add `withSearchServer` helper next to `withTextServer` at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L12-L23). Signature and body per [03-plan-r3.md §2](03-plan-r3.md).
- Append a new `describe("data: web_search", () => { ... })` block at the bottom of the file. Parser-level cases (#1–#7) call `extractDdgResults` directly. Handler-level cases (#8–#16) wrap `withSearchServer` and pass `{ webSearchEndpoint: endpoint }` through `registerBuiltinServices`. Closed-port case (#16) uses a listen-then-close port without `withSearchServer`. **New row 17** (timer cleanup on success): `vi.useFakeTimers({ shouldAdvanceTime: true })`; happy fixture; small `webSearchTimeoutMs`; after the handler returns, assert `vi.getTimerCount() === 0`. See [02-design-r4.md §3.9](02-design-r4.md).

### [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)

Add three rows for `webSearchMaxBytes`, `webSearchMaxResults`, `webSearchTimeoutMs`. Place them after the size-caps rows (which post-G34 end with `fetchTimeoutMs`). Unchanged from r3 in content.

## 3. Test gates

Local gates (must all pass before opening the PR):

1. `npm run lint`.
2. `grep -nc 'export function extractDdgResults' src/mcp/builtins.ts` → 1.
3. `grep -nc 'export async function readBoundedTextBody' src/mcp/builtins.ts` → 0 (regression gate: the helper must NOT be exported from `builtins.ts`; it lives in `httpFetch.ts`).
4. `grep -nc 'export async function readBoundedTextBody' src/mcp/httpFetch.ts` → 1 (verifies G34 has landed).
5. `grep -nc 'maxFetchBytes' src/config.ts` → 1 and `grep -nc 'maxFetchChars' src/config.ts` → 0 (verifies G34 r3 has renamed the field — without this, the convention table in [02-design-r4.md §2.5](02-design-r4.md) is invalid and G33 must wait).
6. `grep -nc 'fetchTimeoutMs' src/config.ts` → ≥ 1 (verifies G34 r3 has added the field; G33's web-search group must land after it).
7. `grep -nc 'function parseNonNegativeInt' src/mcp/builtins.ts` → 1 (verifies G31 r4 has landed).
8. `awk '/case "web_search":/,/case "fetch_url":/' src/mcp/builtins.ts | grep -c 'decodeURIComponent'` → 0 (regression gate against the double-decode bug).
9. `awk '/case "web_search":/,/case "fetch_url":/' src/mcp/builtins.ts | grep -c 'new URL(WEB_SEARCH_ENDPOINT)'` → 1 (regression gate: the handler must use the seam, not a hardcoded URL string).
10. `awk '/case "web_search":/,/case "fetch_url":/' src/mcp/builtins.ts | grep -c 'timed.dispose'` → 1 (regression gate: the handler's `finally` block must call `timed.dispose()`).
11. `awk '/case "web_search":/,/case "fetch_url":/' src/mcp/builtins.ts | grep -c 'timedOut: timedOut()'` → 1 (regression gate: the body-read catch must forward the `timedOut` flag into `classifyNetworkError`).
12. `awk '/case "web_search":/,/case "fetch_url":/' src/mcp/builtins.ts | grep -c 'readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES, signal)'` → 1 (regression gate: the bounded read must receive the helper's signal).
13. `npm run build` (tsup).
14. `npm test -- src/mcp/builtins.test.ts` — 17 new cases plus existing suite pass.
15. `npm test` — full suite green.
16. `npm ls node-html-parser` — output matches the audit expectation in §2.
17. Manual snapshot: with the harness pointed at the dev project, run a `web_search` against `"mlflow model signature"` from the data-agent and confirm:
    - success path returns ≥ 1 result with non-empty `title` + `url`;
    - simulated DDG outage (`sudo iptables -I OUTPUT -p tcp --dport 443 -d duckduckgo.com -j REJECT`, restore with `-D`) surfaces `code: "NETWORK_ERROR"` rather than an unhandled exception.

Gates 5, 6, 10, 11, 12 are new in r4 and exist specifically to keep the G33 PR locked to the FINAL G34 r3 contract.

CI gates: none beyond the existing pipeline. The fixture-driven tests never touch the public network.

## 4. Deploy

Unchanged from r1 ([03-plan-r1.md §4](03-plan-r1.md#L138-L168)). Build, restart `saivage.service` on `saivage` (10.0.3.111), `diedrico` (10.0.3.113), and `saivage-v3` (10.0.3.112); skip `saivage-v3-getrich-v2` (10.0.3.170) — no bind-mount.

## 5. Rollback

Unchanged from r1 ([03-plan-r1.md §5](03-plan-r1.md#L170-L177)).

## 6. Risk register (revised for the G34 r3 contract)

| Risk                                                                                       | Likelihood | Impact                                                       | Mitigation                                                                                                                                                                                                                                                                                                       |
|--------------------------------------------------------------------------------------------|------------|--------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| DDG markup drift between fixture capture and prod                                          | medium     | parser returns zero results                                  | `NO_RESULTS_PARSED` envelope makes the regression loud; operator re-captures fixture and re-runs the test                                                                                                                                                                                                        |
| DDG blocks the User-Agent                                                                  | low        | every call returns `UPSTREAM_HTTP_ERROR` (403/429)            | structured `code` lets the agent surface a clear failure                                                                                                                                                                                                                                                         |
| `node-html-parser` upstream tightens its transitive deps                                   | low        | bundle bloat                                                 | pinned to `^6.1.13`; `npm ls node-html-parser` enforced in §3 gate 16                                                                                                                                                                                                                                            |
| G31 r4 has not landed when G33 ships, breaking `parseNonNegativeInt` reference             | low        | type error; `INVALID_ARGUMENT` parity gap with G32           | gate §3 #7 fails fast and blocks the PR                                                                                                                                                                                                                                                                          |
| G34 r3 has not landed when G33 ships, breaking the `./httpFetch.js` import or the config-block insertion target | low        | build failure or wrong insertion position                                | gates §3 #4, #5, #6 fail fast; sequencing per [02-design-r4.md §4](02-design-r4.md) is **G30 → G31 → G34 → G33 → G35**                                                                                                                                                                                          |
| Mid-body abort classified as `NETWORK_ERROR` because the handler drops `timed.signal` or `{ timedOut }`       | low        | row 14 fails; quiet user-visible bug if gate is bypassed     | gates §3 #11 and #12 enforce the call shape statically; row 14 in [02-design-r4.md §3.9](02-design-r4.md) is the behavioural guard against runtime drift                                                                                                                                                         |
| Timer leak: handler returns without `timed.dispose()` on some branch                       | low        | accumulating active timers under load                       | gate §3 #10 enforces presence of the `finally` clause; row 17 in [02-design-r4.md §3.9](02-design-r4.md) asserts `vi.getTimerCount() === 0` after a happy-path call                                                                                                                                              |
| `mcp` config-block textual conflict on merge with G34 or G35                               | low        | three-way merge friction                                     | named-group append rule from [02-design-r4.md §2.5](02-design-r4.md): G34 owns the size-caps group (renames `maxFetchChars` → `maxFetchBytes` and adds `fetchTimeoutMs`); G33 adds "web search"; G35 adds "secrets"; groups are spatially disjoint and G33 lands strictly after G34                              |
| `webSearchEndpoint` override leaks between tests if `beforeEach` skips `registerBuiltinServices` | low        | a later test calls the prod URL                              | `registerBuiltinServices` re-assigns `WEB_SEARCH_ENDPOINT = options.webSearchEndpoint ?? "https://duckduckgo.com/html/"` on every call ([02-design-r3.md §2.2](02-design-r3.md)); the existing test layout already calls it in `beforeEach`                                                                       |

The r3 risk "G34 r2 did not propagate signal" is folded into the broader "G34 r3 has not landed" row; G34 r3 specifies the throwing-on-abort contract directly ([../G34/02-design-r3.md](../G34/02-design-r3.md#L153-L174)), so the only failure mode is "G34 has not landed yet", which gates §3 #4–#6 catch.

## 7. Out-of-scope follow-ups (unchanged)

See [03-plan-r1.md §7](03-plan-r1.md#L201-L213). No deltas.
