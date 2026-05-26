# G33 — Design r3

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)

**Round 2 baseline**: [02-design-r2.md](02-design-r2.md); reviewer critique [04-review-r2.md](04-review-r2.md).

**Writer**: Claude Opus 4.7 (round 3).

Round 3 keeps Proposal A. The deltas vs r2 are confined to the three blocking findings and three required corrections in [04-review-r2.md](04-review-r2.md#L7-L31). Sections unchanged from r2 (and their unchanged predecessors from r1) are referenced, not re-stated.

## 1. Recommendation (unchanged)

Proposal A from [02-design-r1.md §1](02-design-r1.md#L13-L33). Proposal B remains rejected for the reasons in [02-design-r1.md §2](02-design-r1.md#L35-L98).

## 2. Round-3 deltas (this section is the contract)

### 2.1 Helper ownership: G34 owns, G33 imports

Reviewer blocker: [04-review-r2.md §1.1](04-review-r2.md#L11-L11). G34 r1 design [../G34/02-design-r1.md](../G34/02-design-r1.md#L73-L83) creates [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) and exports `readBoundedTextBody`, `readBoundedBinaryBody`, `fetchWithTimeout`, `classifyNetworkError`, and the `HttpFetchErrorCode` / `ClassifiedHttpError` / `BoundedReadResult<T>` types. The G34 r1 reviewer endorses G34 as owner at [../G34/04-review-r1.md](../G34/04-review-r1.md#L13-L13).

Round 3 yields ownership to G34. The G33 r2 §2.5 decision ([02-design-r2.md](02-design-r2.md#L193-L216)) is reversed. [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) imports the helpers it needs and exports none of them.

Concretely, [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) gains exactly one new top-level import line:

```ts
import { fetchWithTimeout, readBoundedTextBody, classifyNetworkError, type ClassifiedHttpError } from "./httpFetch.js";
```

inserted alongside the existing `./runtime.js` / `./types.js` imports near [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L10-L13).

The `web_search` handler delegates timeout/network classification to `classifyNetworkError(err, searchUrl.toString())`. The handler's only mapping responsibility is:

- pass through the structured error from `classifyNetworkError` (`code`, `error`, optional `errno`) into the envelope alongside the G33-local fields (`query`, `timeout_ms` when code is `TIMEOUT`);
- emit G33-only codes (`NO_RESULTS_PARSED`, `PARSE_FAILURE`, `RESPONSE_TOO_LARGE`, `INVALID_ARGUMENT`, `UPSTREAM_HTTP_ERROR`) for the failure modes that have no equivalent in [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts).

Per the G34 r1 reviewer's required change in [../G34/04-review-r1.md](../G34/04-review-r1.md#L9-L9), G34 r2 must propagate the timeout signal through the bounded reader so a mid-body abort surfaces as `code: "TIMEOUT"` rather than `NETWORK_ERROR`. G33 r3 relies on that contract; it does **not** re-classify aborts inside its own catch sites and it does **not** define a local `isAbortError` predicate. If G34 r2 ships without that propagation, the G33 r3 test row 14 in §3.9 fails fast, surfacing the contract violation as a G34 regression rather than a G33 quiet bug.

Revised merge order: **G30 → G31 → G34 → G33 → G35.** G33 strictly depends on G34 because the new import path resolves at build time; the test gates in [03-plan-r3.md §3](03-plan-r3.md) verify the import target exists.

### 2.2 Web-search endpoint seam

Reviewer blocker: [04-review-r2.md §1.2](04-review-r2.md#L13-L13). The r2 prose pointed at `withTextServer` at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L12-L23), but `withTextServer` only returns a URL for tools that already accept a URL argument; `web_search` constructs `https://duckduckgo.com/html/` directly at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L741) and has no per-call URL parameter.

Fix: introduce a module-level mutable endpoint plus a typed option on `registerBuiltinServices`. Top of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) gains one new `let`:

```ts
let WEB_SEARCH_ENDPOINT = "https://duckduckgo.com/html/";
```

inserted alongside the existing module-level lets at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43).

`BuiltinServicesOptions` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L124-L126) gains one optional field:

```ts
interface BuiltinServicesOptions {
  promptInjectionCop?: PromptInjectionCop;
  webSearchEndpoint?: string;
}
```

`registerBuiltinServices` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082) restores the production default and applies the override on every call:

```ts
WEB_SEARCH_ENDPOINT = options.webSearchEndpoint ?? "https://duckduckgo.com/html/";
```

inserted under `SHELL_TIMEOUT_FLOOR_MS = ...` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1080) (same paragraph as the other registration-time wiring). Because each test calls `registerBuiltinServices` from its own `beforeEach`, the override resets to the production URL automatically when a test omits the option — no `afterEach` cleanup is required.

The `web_search` handler builds the URL from the module-level constant:

```ts
const searchUrl = new URL(WEB_SEARCH_ENDPOINT);
searchUrl.searchParams.set("q", query);
```

This is a tiny, typed seam local to the only file that needs it. It does not leak the test override into env vars and it does not create a parallel `process.env` ceremony.

The handler-level tests (rows 10–16 in §3.9 below) construct the in-process server via `createServer` (the existing pattern at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L12-L23)), capture the listening port from `server.address()`, derive `http://127.0.0.1:PORT/html/`, and call:

```ts
registerBuiltinServices(
  runtime,
  { ...cfg.mcp, webSearchTimeoutMs: 1_000, webSearchMaxBytes: 64 * 1024 },
  { webSearchEndpoint: `http://127.0.0.1:${port}/html/` },
);
```

A small test helper `withSearchServer(handler, fn)` is added to [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts) next to `withTextServer` to encapsulate the listen/close lifecycle and the endpoint-string derivation. Reset behaviour: each test's `beforeEach` rebuilds `runtime` and re-registers builtins, so `WEB_SEARCH_ENDPOINT` is reapplied per test.

### 2.3 `uddg` nested-escape fixture reconciled

Reviewer blocker: [04-review-r2.md §1.3](04-review-r2.md#L15-L15). The r2 fixture inconsistency around the encoding layer on `&` is fixed by aligning prose, fixture HTML, and test row to a single intended target.

The fixture href is:

```
/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fref%3Da%252Bb%252Fc%2526d
```

`new URL("/l/?uddg=...", base).searchParams.get("uddg")` returns exactly the once-percent-decoded value:

```
https://example.com/path?ref=a%2Bb%2Fc%26d
```

`new URL(uddg)` parses successfully. The result URL emitted by `extractDdgResults` is:

```
https://example.com/path?ref=a%2Bb%2Fc%26d
```

The parser-level test row asserts string equality against this exact value. A regression that re-introduces `decodeURIComponent(uddg)` would emit `https://example.com/path?ref=a+b/c&d` (collapsing `%2B` → `+`, `%2F` → `/`, `%26` → `&`) and the assertion would fail.

The fixture, the test row, and §2.4 prose all converge on the same target. No `%252526d` form anywhere.

### 2.4 Plan anchors refreshed against live source

Reviewer required correction: [04-review-r2.md "Required corrections" bullet 1](04-review-r2.md#L19-L19). Live line numbers (verified against the current [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts)):

- Imports paragraph: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L10-L13).
- Existing module-level lets to extend: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43).
- `stripHtml` (insertion point for new helpers): [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L91-L102).
- `interface DownloadAttempt` (helper-insertion upper bound): [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L104).
- `BuiltinServicesOptions`: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L124-L126).
- `dataTools` array start: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L656).
- `web_search` tool schema entry: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L666).
- `web_search` handler case: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761).
- `registerBuiltinServices` function: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082).
- Existing cap-wiring block: [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1081).

[03-plan-r3.md](03-plan-r3.md) uses these numeric anchors directly.

### 2.5 Config-order convention

Reviewer required correction: [04-review-r2.md "Required corrections" bullet 2](04-review-r2.md#L21-L21). The live `mcp` block at [src/config.ts](../../../../src/config.ts#L137-L145) is not alphabetical; it is grouped by topic in source order:

| Group              | Fields (source order)                                |
|--------------------|------------------------------------------------------|
| shell timeouts     | `shellTimeoutMs`, `shellTimeoutFloorMs`              |
| in-process timeout | `inProcessTimeoutMs`                                 |
| size caps          | `maxOutputBytes`, `maxFetchChars`, `maxDownloadBytes` |

Convention adopted by G33 r3 (and to be honoured by G34/G35):

1. New fields are appended to the end of the `mcp` object body, above `.superRefine(...)`, in named groups.
2. Each group's name is documented in this convention table; new groups go after all existing groups in source order.
3. Within a group, fields are listed alphabetically.

G33 introduces a new "web search" group at the end of the object, with three alphabetised fields:

```ts
webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
webSearchMaxResults: z.number().int().min(1).max(50).default(20),
webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
```

G34 r1's `fetchTimeoutMs` (introduced at [../G34/02-design-r1.md](../G34/02-design-r1.md#L284-L294)) extends the existing "size caps" group; it lands between `maxDownloadBytes` and the new "web search" group regardless of merge order. G35's secrets fields form their own group inserted after "web search". This rule yields zero textual merge conflicts under any G33/G34/G35 landing order.

### 2.6 Risk-register entry corrected

Reviewer required correction: [04-review-r2.md "Required corrections" bullet 3](04-review-r2.md#L23-L23). The r2 row that mitigated body-read abort misclassification with the `decodeURIComponent`-count gate at [02-design-r2.md / 03-plan-r2.md §6](03-plan-r2.md#L302) was wrong on its face. Round 3 replaces the mitigation with the two real guards:

- **Primary guard:** the §3.9 row 14 mid-body timeout test asserts `code === "TIMEOUT"` against an in-process server that streams partial bytes and stalls. If G34's `classifyNetworkError` regresses on abort propagation, this test fails.
- **Contract assertion:** G33's handler delegates abort classification entirely to `classifyNetworkError`; per G34 r1 reviewer's blocker 2 ([../G34/04-review-r1.md](../G34/04-review-r1.md#L9-L9)), G34 r2 is required to propagate the timeout signal through the bounded reader so that aborts surface as `code: "TIMEOUT"`. G33's gate in [03-plan-r3.md §3](03-plan-r3.md) verifies the imported helpers exist; the test row is the behavioural guard.

The corrected row appears in [03-plan-r3.md §6](03-plan-r3.md).

## 3. Detailed design (Proposal A) — sections inherited from r1/r2

The unchanged sections from r2 stand without modification:

- §2.2 Cap tests use min-valid config: [02-design-r2.md §2.2](02-design-r2.md#L72-L100). Still in force; only the endpoint plumbing changes per §2.2 above.
- §2.3 `extractDdgResults` is an exported helper: [02-design-r2.md §2.3](02-design-r2.md#L102-L138).
- §2.4 `uddg` decoded exactly once: [02-design-r2.md §2.4](02-design-r2.md#L140-L191). Fixture wording superseded by §2.3 above.
- §2.6 `parseNonNegativeInt` belongs to G31: [02-design-r2.md §2.6](02-design-r2.md#L218-L240).
- §2.7 `node-html-parser` footprint: [02-design-r2.md §2.7](02-design-r2.md#L242-L279).
- §2.8 Fixture matrix expanded: [02-design-r2.md §2.8](02-design-r2.md#L281-L291).
- §2.9 Tool-schema description updated: [02-design-r2.md §2.9](02-design-r2.md#L293-L310).
- §3.7 Structured error contract: [02-design-r1.md §3.7](02-design-r1.md#L413-L432).

§2.1 of r2 (body-read aborts → TIMEOUT) is superseded by §2.1 / §2.6 above: G33 no longer carries an `isAbortError` predicate or a `readBoundedTextBody` body; it delegates to G34's `classifyNetworkError`.

§2.5 of r2 (G33 owns `readBoundedTextBody`) is reversed; see §2.1 above.

### 3.2 Config-schema additions (final)

Edit the `mcp` block in [src/config.ts](../../../../src/config.ts#L137-L145) by appending a new "web search" group at the end of the object body above `.superRefine(...)`, after the existing `maxDownloadBytes` field at [src/config.ts](../../../../src/config.ts#L143):

```ts
webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
webSearchMaxResults: z.number().int().min(1).max(50).default(20),
webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
```

`.superRefine` at [src/config.ts](../../../../src/config.ts#L146-L167) is not touched. Convention rationale: see §2.5 above.

### 3.4 Parser side (unchanged structure from r2; fixture/expectation aligned per §2.3 above)

The `extractDdgResults` body, `climbToResultContainer` helper, and `DdgResult` / `DdgExtraction` type exports remain as specified in [02-design-r2.md §3.4](02-design-r2.md#L399-L463). The only change is the row-5 fixture/expectation alignment in §2.3 above.

Insertion point in source order at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts), between `stripHtml` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L102) and `interface DownloadAttempt` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L104):

1. `function climbToResultContainer(node)` — file-private.
2. `function signatureOf(html)` — file-private (uses `createHash` already imported at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L27)).
3. `export interface DdgResult` — named export.
4. `export interface DdgExtraction` — named export.
5. `export function extractDdgResults(html, base, max)` — named export.

The file-private `isAbortError` predicate from [02-design-r2.md §3.6](02-design-r2.md#L575-L580) is deleted; abort classification is delegated to G34's `classifyNetworkError` per §2.1 above.

### 3.5 Streaming-bounded fetch (deleted; imported from G34)

The r2 `export async function readBoundedTextBody(...)` body at [02-design-r2.md §3.5](02-design-r2.md#L466-L519) is deleted. G33 imports `readBoundedTextBody` from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) (G34-owned per §2.1 above) and uses the signature documented in G34 r1 design [../G34/02-design-r1.md](../G34/02-design-r1.md#L151-L178). After G34 r2 propagates the timeout signal per the G34 r1 reviewer's blocker 2 ([../G34/04-review-r1.md](../G34/04-review-r1.md#L9-L9)), the signature G33 relies on is:

```ts
export async function readBoundedTextBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedReadResult<string>>;
```

returning `{ body, bytes, truncated }`. G33 invokes it as:

```ts
const read = await readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES, controller.signal);
```

and inspects `read.truncated` for the `RESPONSE_TOO_LARGE` branch.

### 3.6 Handler (replaces r1 and r2 handler bodies)

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

  let response: Response;
  try {
    response = await fetchWithTimeout(
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

  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* already done */ }
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
    read = await readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES);
  } catch (err) {
    const classified: ClassifiedHttpError = classifyNetworkError(err, searchUrl.toString());
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
}
```

Two things to note vs r2:

- No `AbortController` / `setTimeout` / `clearTimeout` plumbing in the handler. `fetchWithTimeout` from [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) owns the deadline.
- No second invocation of `readBoundedTextBody` with an explicit signal; the helper composes its own timeout signal with any caller-supplied signal (per G34 r1 [../G34/02-design-r1.md](../G34/02-design-r1.md#L131-L141)). When G34 r2 propagates the timeout signal into the body read per [../G34/04-review-r1.md](../G34/04-review-r1.md#L9-L9), a mid-body abort produces a thrown `TimeoutError` and `classifyNetworkError` returns `code: "TIMEOUT"` — the row-14 assertion in §3.9 below.

`signatureOf` remains file-private and is defined at the helper-insertion point listed in §3.4 above.

### 3.8 Public-API impact (delta vs r2)

- **Tool schema** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L666): outer description gains the new `code` enumeration; `max_results` description per [02-design-r2.md §2.9](02-design-r2.md#L293-L310).
- **Module exports** of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts): `extractDdgResults`, `DdgResult`, `DdgExtraction` only. `readBoundedTextBody` is **not** exported — it lives in [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) (G34-owned).
- **`BuiltinServicesOptions`** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L124-L126) gains `webSearchEndpoint?: string`.
- **Module-level lets** at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43) gain `WEB_SEARCH_MAX_BYTES`, `WEB_SEARCH_MAX_RESULTS`, `WEB_SEARCH_TIMEOUT_MS`, and `WEB_SEARCH_ENDPOINT`.
- **Tool result (success)** gains `skipped: number`.
- **Tool result (failure)** gains structured `code`. For HTTP-layer failures, the envelope carries `code`, `error`, optional `errno` (from `classifyNetworkError`), plus G33-local fields (`query`, `timeout_ms` when applicable).
- **Config** gains the three fields in §3.2.

### 3.9 Test surface (replaces r2 §3.9)

Fixtures (unchanged from r2, with row-5 reconciled per §2.3 above):

- [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html) — captured DDG response with the six embedded variants.
- [src/mcp/web-search.fixture.drifted.html](../../../../src/mcp/web-search.fixture.drifted.html) — `class="result__a"` renamed to `class="result__title"`.
- [src/mcp/web-search.fixture.empty.html](../../../../src/mcp/web-search.fixture.empty.html) — minimal HTML shell.

The handler-level cases use the new `withSearchServer(handler, fn)` helper added to [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts) next to `withTextServer` at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L12-L23). Each case:

1. Constructs an `http.createServer(handler)` configured for the row's behaviour.
2. Listens on `127.0.0.1:0`; captures `server.address().port`.
3. Calls `registerBuiltinServices(runtime, { ...cfg.mcp, ...overrides }, { webSearchEndpoint: \`http://127.0.0.1:${port}/html/\` })`.
4. Invokes `runtime.callTool("data", "web_search", { query, max_results })`.
5. Asserts the structured envelope.
6. Closes the server in a `finally` block.

The server's request handler decides per-row whether to write headers, stream chunks, stall, or close immediately. No `vi.spyOn`, no global `fetch` stub.

| #  | Layer    | Scenario                          | Setup                                                                                                  | Assert                                                                                  |
|----|----------|-----------------------------------|--------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------|
| 1  | parser   | smoke                             | `extractDdgResults(happyFixture, baseUrl, 20)`                                                         | `results.length >= 5`; every result has non-empty `title` + `url`; `skipped === 1`      |
| 2  | parser   | nested escape preserved           | row whose href is `/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fref%3Da%252Bb%252Fc%2526d`              | extracted URL `=== "https://example.com/path?ref=a%2Bb%2Fc%26d"`                        |
| 3  | parser   | class attribute reordered         | anchor with `href="…" class="result__a"` (`href` before `class`)                                       | matched as a normal result                                                              |
| 4  | parser   | multi-class anchor                | anchor with `class="result__a result__a--clicktrack"`                                                  | matched as a normal result                                                              |
| 5  | parser   | snippet as `<div>`                | entry whose snippet element is `<div class="result__snippet">…</div>`                                  | snippet text extracted, non-empty                                                       |
| 6  | parser   | missing snippet, row kept         | entry whose `.result` container has no `result__snippet` descendant                                    | row present; `snippet === ""`; not in `skipped`                                         |
| 7  | parser   | drift fixture                     | `extractDdgResults(driftedFixture, baseUrl, 20)`                                                       | `results.length === 0`                                                                  |
| 8  | handler  | empty query                       | call with `query: ""`                                                                                  | `isError: true`, `code === "INVALID_ARGUMENT"`                                          |
| 9  | handler  | invalid `max_results`             | call with `max_results: -3`                                                                            | `isError: true`, `code === "INVALID_ARGUMENT"` (depends on G31's `parseNonNegativeInt`) |
| 10 | handler  | clamp `max_results`               | server returns happy fixture; call with `max_results: 99` and configured ceiling 20                    | `results.length <= 20`                                                                  |
| 11 | handler  | upstream 503                      | server responds `503` with empty body                                                                  | `code === "UPSTREAM_HTTP_ERROR"`, `status === 503`                                      |
| 12 | handler  | upstream 200 with drifted markup  | server returns drifted fixture                                                                         | `code === "NO_RESULTS_PARSED"`, `bytes` and `markup_signature` present                  |
| 13 | handler  | timeout pre-headers               | server accepts connection but never writes headers; `webSearchTimeoutMs: 1_000`                        | `code === "TIMEOUT"`, `timeout_ms === 1_000`                                            |
| 14 | handler  | timeout mid-body                  | server writes headers + 1 KB body, holds the socket open; `webSearchTimeoutMs: 1_000`                  | `code === "TIMEOUT"` (relies on G34 r2 signal propagation per §2.1 above)               |
| 15 | handler  | oversized body                    | server streams 96 KB; `webSearchMaxBytes: 64 * 1024`                                                   | `code === "RESPONSE_TOO_LARGE"`, `max_bytes === 64 * 1024`                              |
| 16 | handler  | network failure                   | server is started then closed before the call; endpoint points at the closed port                       | `code === "NETWORK_ERROR"`                                                              |

Parser-level rows load fixtures via `readFileSync(new URL("./web-search.fixture.html", import.meta.url), "utf8")` and call `extractDdgResults` directly — no runtime needed.

## 4. Sequencing (replaces r2 §4)

- **G30**: orthogonal.
- **G31**: G33 depends on G31 r4's `parseNonNegativeInt`. Order: G31 → G33.
- **G32**: disjoint.
- **G34**: G33 depends on G34 r2 because the new module [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) must exist before the import line in §2.1 above resolves. Order: G34 → G33. The G34 r1 reviewer's required correction in [../G34/04-review-r1.md](../G34/04-review-r1.md#L13-L13) endorses this direction.
- **G35**: disjoint. Both G33 and G35 insert new `mcp` fields per the convention in §2.5 above. G33's "web search" group lands before G35's "secrets" group when both have shipped.

Revised merge order: **G30 → G31 → G34 → G33 → G35.**

## 5. Daemon impact (unchanged from r1)

See [02-design-r1.md §5](02-design-r1.md#L527-L538).

## 6. What is intentionally not in this design

- Same exclusions as r1 ([02-design-r1.md §6](02-design-r1.md#L540-L549)).
- No file-private streaming body reader. No file-private abort predicate. No file-private timeout wrapper. All three concerns belong to G34's [src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts).
- No env-var test seam for the endpoint override. The typed `webSearchEndpoint` option on `BuiltinServicesOptions` is the only seam.
