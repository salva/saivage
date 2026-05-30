# G33 — Design r4

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Analysis**: [01-analysis-r4.md](01-analysis-r4.md)

**Round 3 baseline**: [02-design-r3.md](02-design-r3.md); reviewer critique [04-review-r3.md](04-review-r3.md).

**Writer**: Claude Opus 4.7 (round 4).

Round 4 keeps Proposal A and every architectural choice from r3 (G34 owns the HTTP helpers; G33 imports them; a typed `webSearchEndpoint` option provides the in-process test seam; the `uddg` value is decoded exactly once; a named-group append rule governs `mcp` config ordering). Deltas vs r3 are confined to the two blocking findings in [04-review-r3.md](04-review-r3.md#L7-L11): align the handler with the FINAL G34 r3 contract, and retarget the config insertion to the post-G34 size-caps shape. Sections unchanged from r3 are referenced rather than re-stated.

## 1. Recommendation (unchanged)

Proposal A from [02-design-r1.md §1](02-design-r1.md#L13-L33). Proposal B remains rejected for the reasons in [02-design-r1.md §2](02-design-r1.md#L35-L98).

## 2. Round-4 deltas (this section is the contract)

### 2.1 G34 r3 contract alignment (blocker 1)

Reviewer blocker: [04-review-r3.md](04-review-r3.md#L7-L7). The G34 r3 design in [../G34/02-design-r3.md](../G34/02-design-r3.md) is now the FINAL contract; G33 r4 rewrites the handler against it. Three concrete bindings:

1. `fetchWithTimeout` returns a `TimedFetch` value with shape `{ response, signal, timedOut(), dispose() }` (see [../G34/02-design-r3.md](../G34/02-design-r3.md#L57-L102)). The handler **destructures** it; it does not assign the return value to a `Response`.

2. `readBoundedTextBody(response, maxBytes, signal)` takes an explicit `AbortSignal` ([../G34/02-design-r3.md](../G34/02-design-r3.md#L137-L191)). The handler passes `timed.signal` so a timeout-driven cancel propagates into the active `reader.read()` loop. The helper **throws** on mid-body abort (per [../G34/02-design-r3.md](../G34/02-design-r3.md#L153-L174)); it does not return a partial-success envelope, so the handler must surround it with `try/catch` and route the caught error through `classifyNetworkError`.

3. `classifyNetworkError(err, url, ctx)` takes a third `{ timedOut?: boolean }` parameter ([../G34/02-design-r3.md](../G34/02-design-r3.md#L218-L271)). The handler reads `timed.timedOut()` at the moment of the catch and passes it as `{ timedOut: timed.timedOut() }`. This guarantees that a timer-driven abort surfaces as `code: "TIMEOUT"` regardless of the underlying `Error.name`, which is the row-14 contract in §3.9 below.

4. The caller owns the timer cleanup contract: every exit path from the post-fetch block runs through a `finally { timed.dispose(); }` wrapper ([../G34/02-design-r3.md](../G34/02-design-r3.md#L72-L86)). The G33 handler follows the same `try/finally` shape that G34 r3 uses for `fetch_url` at [../G34/02-design-r3.md](../G34/02-design-r3.md#L433-L497).

The r3 import line in [02-design-r3.md §2.1](02-design-r3.md#L25-L33) is broadened to also pull in the `TimedFetch` and `BoundedReadResult` types:

```ts
import {
  fetchWithTimeout,
  readBoundedTextBody,
  classifyNetworkError,
  type ClassifiedHttpError,
  type TimedFetch,
  type BoundedReadResult,
} from "./httpFetch.js";
```

inserted alongside the existing `./runtime.js` / `./types.js` imports near [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L10-L13). No HTTP helper is defined or re-exported from [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).

The r3 statement at [02-design-r3.md](02-design-r3.md#L348-L349) — "no explicit signal is needed because the helper composes its own timeout signal" — is **deleted**. Under G34 r3, the helper composes a controller-driven signal internally, but the caller still has to forward `timed.signal` into the bounded read so the cancel reaches the reader.

### 2.2 Web-search endpoint seam (unchanged from r3)

Unchanged from [02-design-r3.md §2.2](02-design-r3.md#L46-L90). Module-level `let WEB_SEARCH_ENDPOINT = "https://duckduckgo.com/html/"`; `BuiltinServicesOptions` gains `webSearchEndpoint?: string`; `registerBuiltinServices` reassigns the constant on every call; the handler builds the URL with `new URL(WEB_SEARCH_ENDPOINT)`. The `withSearchServer` test helper is unchanged from r3.

### 2.3 `uddg` nested-escape fixture (unchanged from r3)

Unchanged from [02-design-r3.md §2.3](02-design-r3.md#L92-L116). Fixture href, single `URLSearchParams.get` decode, emitted result URL, and the regression detection for a reintroduced `decodeURIComponent` all stand.

### 2.4 Plan anchors (refreshed for r4)

The live anchors from [02-design-r3.md §2.4](02-design-r3.md#L118-L132) all remain valid against the current tree. The r4 plan reuses them; no re-verification needed.

### 2.5 Config-order convention (refreshed against G34 r3)

Reviewer blocker: [04-review-r3.md](04-review-r3.md#L9-L9). After G34 r3 lands, the `mcp` block has renamed `maxFetchChars` to `maxFetchBytes` and added `fetchTimeoutMs` to the same size-caps group ([../G34/02-design-r3.md](../G34/02-design-r3.md#L334-L341)). The r3 convention table at [02-design-r3.md §2.5](02-design-r3.md#L135-L159) is replaced with the post-G34 view:

| Group              | Fields (source order, post-G34 r3)                                            |
|--------------------|-------------------------------------------------------------------------------|
| shell timeouts     | `shellTimeoutMs`, `shellTimeoutFloorMs`                                       |
| in-process timeout | `inProcessTimeoutMs`                                                          |
| size caps          | `maxOutputBytes`, `maxFetchBytes`, `maxDownloadBytes`, `fetchTimeoutMs`       |

`maxFetchChars` is no longer mentioned because G34 renames it ([../G34/02-design-r3.md](../G34/02-design-r3.md#L334-L341), refining [02-design-r2.md §3](02-design-r2.md#L222-L264) which spells the rename out). G33 r4 takes no part in the rename — it depends only on the resulting source-order shape.

Convention adopted by G33 r4 (carrying r3's rule forward):

1. New fields are appended to the end of the `mcp` object body, above `.superRefine(...)`, in named groups.
2. Each group's name is documented in this convention table; new groups go after all existing groups in source order.
3. Within a group, fields are listed alphabetically.

G33 introduces the "web search" group as a brand-new group placed after the size-caps group:

```ts
webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
webSearchMaxResults: z.number().int().min(1).max(50).default(20),
webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
```

These three fields land **after** the size-caps group, i.e. textually after `fetchTimeoutMs`. G35's secrets fields form their own group inserted after the web-search group. Zero textual merge conflicts under any G33/G34/G35 landing order, given the hard prereq that G34 lands first (see §4).

### 2.6 Risk-register entry (refreshed for the G34 r3 contract)

Reviewer required correction: [04-review-r2.md](04-review-r2.md#L23-L23), still in force, refined by [04-review-r3.md](04-review-r3.md). The row-14 mid-body-timeout guard is now articulated as two contract facts taken from G34 r3 (not from G34 r1 / r2):

- **Primary guard.** The §3.9 row 14 mid-body-timeout test asserts `code === "TIMEOUT"` against an in-process server that streams partial bytes and stalls. The handler routes the caught error through `classifyNetworkError(err, url, { timedOut: timed.timedOut() })`; G34 r3 short-circuits to TIMEOUT whenever `ctx.timedOut` is truthy ([../G34/02-design-r3.md](../G34/02-design-r3.md#L235-L242)). If the handler regresses to omitting the `{ timedOut }` flag or the `timed.signal` argument, row 14 fails.
- **Contract assertion.** G34 r3 specifies that `readBoundedTextBody` *throws* on mid-body abort rather than returning a partial-success envelope ([../G34/02-design-r3.md](../G34/02-design-r3.md#L153-L174)). G33 r4 relies on that throw to enter its body-read catch site. If G34 r3 regresses to a silent partial-success on abort, G33 row 14 fails fast.

The corrected risk-register row appears in [03-plan-r4.md §6](03-plan-r4.md).

## 3. Detailed design (Proposal A) — sections inherited from r2/r3

Unchanged from r3:

- §2.2 cap tests use min-valid config: [02-design-r2.md §2.2](02-design-r2.md#L72-L100).
- §2.3 `extractDdgResults` is an exported helper: [02-design-r2.md §2.3](02-design-r2.md#L102-L138).
- §2.4 `uddg` decoded exactly once: [02-design-r2.md §2.4](02-design-r2.md#L140-L191), fixture reconciled per [02-design-r3.md §2.3](02-design-r3.md#L92-L116).
- §2.6 `parseNonNegativeInt` belongs to G31: [02-design-r2.md §2.6](02-design-r2.md#L218-L240).
- §2.7 `node-html-parser` footprint: [02-design-r2.md §2.7](02-design-r2.md#L242-L279).
- §2.8 Fixture matrix expanded: [02-design-r2.md §2.8](02-design-r2.md#L281-L291).
- §2.9 Tool-schema description updated: [02-design-r2.md §2.9](02-design-r2.md#L293-L310).
- §3.4 Parser helpers and exports: [02-design-r3.md §3.4](02-design-r3.md) (unchanged).
- §3.7 Structured error contract: [02-design-r1.md §3.7](02-design-r1.md#L413-L432).

The r3 §3.5 statement that the file-private `readBoundedTextBody` is deleted in favour of an import remains true; the only refinement is that G33 r4 imports the G34 r3 shape documented in §2.1 above.

### 3.2 Config-schema additions (final, post-G34)

Edit the `mcp` block in [src/config.ts](../../../../src/config.ts#L137-L145) by appending a new "web search" group at the end of the object body above `.superRefine(...)`. After G34 r3 lands, the size-caps group ends with `fetchTimeoutMs`; the web-search group is inserted immediately after that field, before `.superRefine(...)`.

Resulting tail of the `mcp` object (post-G33, post-G34):

```ts
maxOutputBytes: z.number().default(100 * 1024),
maxFetchBytes: z.number().default(200_000),
maxDownloadBytes: z.number().default(250 * 1024 * 1024),
fetchTimeoutMs: z.number().default(60_000),
webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
webSearchMaxResults: z.number().int().min(1).max(50).default(20),
webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
```

`.superRefine` at [src/config.ts](../../../../src/config.ts#L146-L167) is not touched. Convention rationale: see §2.5 above.

### 3.6 Handler (replaces r3 handler body)

```ts
case "web_search": {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return {
      content: { error: "INVALID_ARGUMENT: query must be a non-empty string", code: "INVALID_ARGUMENT" },
      isError: true,
    };
  }

  let maxResults: number;
  try {
    const override = parseNonNegativeInt(args.max_results, "max_results");
    maxResults = override === undefined
      ? WEB_SEARCH_MAX_RESULTS
      : Math.min(Math.max(override, 1), WEB_SEARCH_MAX_RESULTS);
  } catch (err) {
    return {
      content: { error: `INVALID_ARGUMENT: ${(err as Error).message}`, code: "INVALID_ARGUMENT", query },
      isError: true,
    };
  }

  const searchUrl = new URL(WEB_SEARCH_ENDPOINT);
  searchUrl.searchParams.set("q", query);

  let timed: TimedFetch;
  try {
    timed = await fetchWithTimeout(
      searchUrl,
      { headers: { "User-Agent": "Saivage/0.1 data-agent" } },
      WEB_SEARCH_TIMEOUT_MS,
    );
  } catch (err) {
    const classified: ClassifiedHttpError = classifyNetworkError(err, searchUrl.toString());
    const content: Record<string, unknown> = { ...classified, query };
    if (classified.code === "TIMEOUT") content.timeout_ms = WEB_SEARCH_TIMEOUT_MS;
    return { content, isError: true };
  }

  try {
    const { response, signal, timedOut } = timed;

    if (!response.ok) {
      await discardBody(response);
      return {
        content: {
          error: `UPSTREAM_HTTP_ERROR: DuckDuckGo returned ${response.status}`,
          code: "UPSTREAM_HTTP_ERROR",
          query,
          status: response.status,
        },
        isError: true,
      };
    }

    let read: BoundedReadResult<string>;
    try {
      read = await readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES, signal);
    } catch (err) {
      const classified: ClassifiedHttpError = classifyNetworkError(err, searchUrl.toString(), { timedOut: timedOut() });
      const content: Record<string, unknown> = { ...classified, query };
      if (classified.code === "TIMEOUT") content.timeout_ms = WEB_SEARCH_TIMEOUT_MS;
      return { content, isError: true };
    }

    if (read.truncated) {
      return {
        content: {
          error: `RESPONSE_TOO_LARGE: DuckDuckGo response exceeded ${WEB_SEARCH_MAX_BYTES} bytes`,
          code: "RESPONSE_TOO_LARGE",
          query,
          max_bytes: WEB_SEARCH_MAX_BYTES,
        },
        isError: true,
      };
    }

    let extracted: DdgExtraction;
    try {
      extracted = extractDdgResults(read.body, searchUrl, maxResults);
    } catch (err) {
      return {
        content: { error: `PARSE_FAILURE: ${(err as Error).message}`, code: "PARSE_FAILURE", query },
        isError: true,
      };
    }

    if (extracted.results.length === 0) {
      return {
        content: {
          error: "NO_RESULTS_PARSED: DuckDuckGo response parsed but no result anchors matched; markup may have drifted",
          code: "NO_RESULTS_PARSED",
          query,
          status: response.status,
          bytes: read.body.length,
          markup_signature: signatureOf(read.body),
        },
        isError: true,
      };
    }

    return {
      content: {
        query,
        results: extracted.results,
        status: response.status,
        skipped: extracted.skipped,
      },
      isError: false,
    };
  } finally {
    timed.dispose();
  }
}
```

Five things to note vs r3:

- The `fetchWithTimeout` return is destructured as `{ response, signal, timedOut }` per G34 r3 ([../G34/02-design-r3.md](../G34/02-design-r3.md#L57-L102)). The handler never treats the return as a `Response`.
- The post-fetch block is wrapped in `try { ... } finally { timed.dispose(); }` so the timer is cleared on every exit — success, every early-fail branch, the body-read catch, the parse-failure catch, and the empty-results branch ([../G34/02-design-r3.md](../G34/02-design-r3.md#L72-L86)).
- `readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES, signal)` is invoked with the helper's signal so a timer-driven cancel reaches the active `reader.read()` loop ([../G34/02-design-r3.md](../G34/02-design-r3.md#L153-L174)).
- The body-read catch reads `timedOut()` at the moment of the catch and forwards it as `{ timedOut: timedOut() }` to `classifyNetworkError`, mapping mid-body aborts to `code: "TIMEOUT"` regardless of the underlying `Error.name` ([../G34/02-design-r3.md](../G34/02-design-r3.md#L235-L242)). The pre-fetch catch (where the timer cannot have fired) calls `classifyNetworkError(err, url)` without the third argument.
- The early `!response.ok` branch calls `discardBody(response)` (imported from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts)) instead of the r3 ad-hoc `try { await response.body?.cancel(); } catch {}`. This matches the G34 r3 `fetch_url` precedent ([../G34/02-design-r3.md](../G34/02-design-r3.md#L451-L463)) and keeps the body-cancel ceremony in one place. The import line in §2.1 above is amended to also include `discardBody`:

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
```

`signatureOf` remains file-private and is defined at the helper-insertion point listed in [02-design-r3.md §3.4](02-design-r3.md).

### 3.8 Public-API impact (delta vs r3)

- **Tool schema** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L666): outer description gains the new `code` enumeration; `max_results` description per [02-design-r2.md §2.9](02-design-r2.md#L293-L310). Unchanged from r3.
- **Module exports** of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts): `extractDdgResults`, `DdgResult`, `DdgExtraction` only. Unchanged from r3.
- **`BuiltinServicesOptions`** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L124-L126) gains `webSearchEndpoint?: string`. Unchanged from r3.
- **Module-level lets** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43) gain `WEB_SEARCH_MAX_BYTES`, `WEB_SEARCH_MAX_RESULTS`, `WEB_SEARCH_TIMEOUT_MS`, and `WEB_SEARCH_ENDPOINT`. Unchanged from r3.
- **Tool result (success)** gains `skipped: number`. Unchanged from r3.
- **Tool result (failure)** gains structured `code`. For HTTP-layer failures, the envelope carries `code`, `error`, optional `errno` (from `classifyNetworkError`), plus G33-local fields (`query`, `timeout_ms` when applicable). Unchanged from r3.
- **Config** gains the three fields in §3.2 above. The size-caps group also gains G34's `fetchTimeoutMs` and renames `maxFetchChars` to `maxFetchBytes`; both edits land with G34 r3, not with G33.

### 3.9 Test surface (refined for G34 r3 contract)

Test rows 1–16 carry forward from [02-design-r3.md §3.9](02-design-r3.md). Two row-level refinements vs r3:

- **Row 13 (timeout pre-headers).** No change in assertion text; the underlying mechanism is now "the pre-fetch catch site sees a `TimeoutError` thrown by `fetchWithTimeout` itself ([../G34/02-design-r3.md](../G34/02-design-r3.md#L87-L102)) and calls `classifyNetworkError(err, url)` without the `{ timedOut }` flag, which still resolves to `code: "TIMEOUT"` via the `err.name === "TimeoutError"` branch ([../G34/02-design-r3.md](../G34/02-design-r3.md#L243-L249))". The structured-envelope assertion `code === "TIMEOUT"`, `timeout_ms === 1_000` is unchanged.
- **Row 14 (timeout mid-body).** Assertion unchanged (`code === "TIMEOUT"`). The mechanism is now nailed to G34 r3: the in-process server writes headers + 1 KB then stalls; `readBoundedTextBody` throws when its `signal` aborts (per [../G34/02-design-r3.md](../G34/02-design-r3.md#L153-L174)); the handler's body-read catch calls `classifyNetworkError(err, url, { timedOut: timed.timedOut() })`; the `timedOut` short-circuit returns `code: "TIMEOUT"` ([../G34/02-design-r3.md](../G34/02-design-r3.md#L235-L242)). The row is the behavioural guard for the G34 r3 contract.

A new row 17 is added to assert the `try/finally` cleanup contract:

| #  | Layer    | Scenario                          | Setup                                                                                                  | Assert                                                                                  |
|----|----------|-----------------------------------|--------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| 17 | handler  | timer cleared on success          | `vi.useFakeTimers({ shouldAdvanceTime: true })`; happy fixture; small `webSearchTimeoutMs`             | after the call returns, `vi.getTimerCount() === 0` (no pending `fetchWithTimeout` timer) |

This row matches the G34 r3 `fetchWithTimeout` timer-cleanup test in [../G34/02-design-r3.md](../G34/02-design-r3.md#L535-L546). It guards the G33 handler against losing its `finally { timed.dispose() }` wrapper.

All other rows from [02-design-r3.md §3.9](02-design-r3.md) carry forward verbatim.

## 4. Sequencing (unchanged)

Unchanged from r3: **G30 → G31 → G34 → G33 → G35**. G33 strictly depends on G34 r3 because the import line in §2.1 above must resolve at build time and the handler relies on the `TimedFetch` shape from [../G34/02-design-r3.md](../G34/02-design-r3.md#L57-L102). G33 also depends on G34's `discardBody` export ([../G34/02-design-r3.md](../G34/02-design-r3.md#L104-L113)) per §3.6 above.

## 5. Daemon impact (unchanged from r1)

See [02-design-r1.md §5](02-design-r1.md#L527-L538).

## 6. What is intentionally not in this design

- Same exclusions as r1/r3 ([02-design-r1.md §6](02-design-r1.md#L540-L549)).
- No file-private streaming body reader, abort predicate, or timeout wrapper; all three concerns belong to G34's [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts).
- No `try { await response.body?.cancel(); } catch {}` ad-hoc body cancellation; the handler uses G34's `discardBody` ([../G34/02-design-r3.md](../G34/02-design-r3.md#L104-L113)).
- No re-classification of aborts inside the handler; classification is delegated to `classifyNetworkError(err, url, { timedOut: timed.timedOut() })`.
- No env-var test seam for the endpoint override; the typed `webSearchEndpoint` option on `BuiltinServicesOptions` is the only seam.
- No backward-compat shim for the `maxFetchChars` → `maxFetchBytes` rename; that edit ships with G34 r3 and G33 references the new name only.
