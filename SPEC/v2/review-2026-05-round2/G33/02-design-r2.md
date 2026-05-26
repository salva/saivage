# G33 — Design r2

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)

**Round 1 baseline**: [02-design-r1.md](02-design-r1.md); reviewer
critique [04-review-r1.md](04-review-r1.md).

**Writer**: Claude Opus 4.7 (round 2).

Round 2 keeps Proposal A. The design deltas vs r1 are driven by
the six blocking findings and three required corrections in
[04-review-r1.md](04-review-r1.md). Sections unchanged from r1 are
referenced, not re-stated.

## 1. Recommendation (unchanged)

**Proposal A** from
[02-design-r1.md §1](02-design-r1.md#L13-L33). Proposal B remains
rejected for the reasons in
[02-design-r1.md §2](02-design-r1.md#L35-L98).

## 2. Round-2 deltas (this section is the contract)

### 2.1 Body-read aborts map to `TIMEOUT`

Reviewer blocker:
[04-review-r1.md §1.1](04-review-r1.md#L7-L8). The handler in
[02-design-r1.md §3.6](02-design-r1.md#L329-L365) only classified
aborts caught in the initial `fetch` rejection. Once `fetch`
resolves and the controller fires while `readBoundedTextBody` is
streaming, the body-read rejection used to fall into the
`NETWORK_ERROR` branch, contradicting the timeout test row in
[02-design-r1.md §3.9 (case 7)](02-design-r1.md#L473).

Fix: both catch sites consult the same predicate:

```ts
function isAbortError(err: unknown, controller: AbortController): boolean {
  if (controller.signal.aborted) return true;
  const e = err as { name?: string; code?: string } | null;
  return e?.name === "AbortError" || e?.code === "ERR_ABORTED";
}
```

The body-read catch becomes:

```ts
try {
  body = await readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES, controller.signal);
} catch (err) {
  clearTimeout(timeout);
  if (isAbortError(err, controller)) {
    return {
      content: { error: `TIMEOUT: web_search exceeded ${WEB_SEARCH_TIMEOUT_MS}ms`, code: "TIMEOUT", query, timeout_ms: WEB_SEARCH_TIMEOUT_MS },
      isError: true,
    };
  }
  return {
    content: { error: `NETWORK_ERROR: ${(err as Error).message}`, code: "NETWORK_ERROR", query },
    isError: true,
  };
}
```

`readBoundedTextBody` is extended to honour the abort signal:
when the signal aborts mid-stream the reader is cancelled and the
helper throws an `AbortError` whose name is `"AbortError"`. See
§3.5 for the helper signature.

### 2.2 Cap tests use min-valid config

Reviewer blocker:
[04-review-r1.md §1.2](04-review-r1.md#L9-L10). The Zod schema
floors are `webSearchTimeoutMs.min(1_000)` and
`webSearchMaxBytes.min(64 * 1024)` per
[02-design-r1.md §3.2](02-design-r1.md#L152-L154). Round 1's test
matrix in [02-design-r1.md §3.9](02-design-r1.md#L473-L474) used
`50` ms and `1024` bytes and so would fail schema validation.

Fix: every cap test loads the real config via `loadConfig` and
then calls `registerBuiltinServices(runtime, { ...cfg.mcp,
webSearchTimeoutMs: 1_000, webSearchMaxBytes: 64 * 1024 }, ...)`
— the runtime registration accepts a typed `mcp` object directly
and the schema is unchanged. The test then drives the registered
handler against an in-process HTTP server (the existing pattern
in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L220-L240))
that:

- For the timeout row: writes the response headers, writes a few
  bytes of partial HTML, then keeps the socket open without
  finishing the body. The 1-second cap expires while the reader
  is mid-stream, exercising the §2.1 branch.
- For the oversize row: streams 96 KB of HTML in 8 KB chunks,
  exceeding the 64 KB cap mid-stream and triggering
  `RESPONSE_TOO_LARGE`.

No `vi.spyOn` or fake-timer plumbing is needed; the schema floor
and the test fixture both stay grounded in real bytes.

### 2.3 `extractDdgResults` is an exported helper

Reviewer blocker:
[04-review-r1.md §1.3](04-review-r1.md#L11-L12). The parser tests
need direct reach. ESM cannot reach a file-private helper.

Fix: export the parser surface from
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) using the
same testing-boundary discipline G31 uses for its exported
classifier
([SPEC/v2/review-2026-05-round2/G31/02-design-r4.md](../G31/02-design-r4.md#L41-L48)):

```ts
export interface DdgResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DdgExtraction {
  results: DdgResult[];
  skipped: number;
}

export function extractDdgResults(html: string, base: URL, max: number): DdgExtraction { /* … */ }
```

`climbToResultContainer`, `signatureOf`, and the abort predicate
stay file-private — they have no test surface beyond the public
extractor and the public handler. `readBoundedTextBody` is also
exported (§2.5) because G34 will consume it.

The Vitest import line at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1)
gains `extractDdgResults, type DdgResult` alongside the existing
`registerBuiltinServices` import at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L7).

### 2.4 `uddg` decoded exactly once

Reviewer blocker:
[04-review-r1.md §1.4](04-review-r1.md#L13-L17). The current
handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L748-L753)
calls `URLSearchParams.get("uddg")` and then `decodeURIComponent`,
which decodes the percent-decoded value a second time. Round 1
copied that same pattern.

Fix: trust `URLSearchParams.get` (already returns the decoded
target string), validate by parsing it as an absolute URL, and
fall back to the raw anchor href when no `uddg` is present:

```ts
const parsed = new URL(href, base);
const uddg = parsed.searchParams.get("uddg");
let resolvedUrl: string;
if (uddg !== null) {
  let candidate: URL;
  try {
    candidate = new URL(uddg);  // already decoded; no second decode
  } catch {
    skipped += 1;
    continue;
  }
  if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
    skipped += 1;
    continue;
  }
  resolvedUrl = candidate.toString();
} else {
  resolvedUrl = parsed.toString();
}
```

The fixture matrix (§3.9 row 2) is updated to use a target whose
query contains `%252B`, `%252F`, and `%2526`. The expected
extracted URL preserves the inner percent encoding exactly:
`https://example.com/path?ref=a%2Bb%2Fc%26d`. A regression that
re-introduces a second `decodeURIComponent` call collapses
`%252B` to `%2B` (or throws on malformed sequences) and fails
this assertion.

### 2.5 Helper ownership: G33 owns `readBoundedTextBody`

Reviewer blocker:
[04-review-r1.md §1.5](04-review-r1.md#L19-L21). r1 contradicted
itself: §3.5 said G34 dedups after G33 ships
([02-design-r1.md §3.5](02-design-r1.md#L504-L505)), but §4
recommended G34 land first
([02-design-r1.md §4](02-design-r1.md#L517-L519)).

Decision: **G33 owns the helper and exports it from
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).** G34
consumes the existing export when its scope migrates `fetch_url`
and friends. Rationale:

- The helper's first concrete consumer is the `web_search`
  handler in this PR. Building it inside the file that needs it,
  and exporting it from there, matches G31's pattern of placing
  `classifyFsError` next to its first call site.
- The plan keeps the merge order single-valued: **G30 → G31 → G32
  → G33 → G34 → G35** (revised from r1). G34 then has a green
  helper to call.
- No shared `src/mcp/http.ts` is introduced. Speculative
  abstraction is exactly what the project rule forbids; one
  consumer + one exported helper from the same file is the
  smallest seam.

Signature (final):

```ts
export async function readBoundedTextBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }>;
```

When `signal.aborted` becomes true mid-read, the helper cancels
the reader and throws an `AbortError`. When the byte budget is
exceeded, the helper cancels the reader and returns
`{ text, truncated: true }`.

### 2.6 `parseNonNegativeInt` belongs to G31

Reviewer blocker:
[04-review-r1.md §1.6](04-review-r1.md#L23-L26). r1 claimed the
helper "already exists" in
[02-design-r1.md §3.6](02-design-r1.md#L418-L421). It does not —
the live handler still uses `Number(args.max_results ?? 8)` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L739).

Decision: G33 declares an explicit ordering dependency on G31's
r2 plan in
[SPEC/v2/review-2026-05-round2/G31/03-plan-r2.md](../G31/03-plan-r2.md#L81-L88),
which adds `parseNonNegativeInt` to
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) near the
existing helpers. G33's handler imports nothing — it calls the
helper as a same-file function. The G33 plan in
[03-plan-r2.md §3 gates](03-plan-r2.md#L3) asserts the helper
exists before G33 ships and fails fast if rebased ahead of G31.

If a future operator must ship G33 before G31, the fallback is
to inline the same five-line `parseNonNegativeInt` body into
G33's diff and let G31 delete the duplicate on land. This
fallback is documented in
[03-plan-r2.md §6 (risks)](03-plan-r2.md), but it is not the
recommended path.

### 2.7 Dependency footprint corrected

Reviewer required correction (first):
[04-review-r1.md "Required corrections", line 31](04-review-r1.md#L31).
The honest footprint of `node-html-parser@^6.1.13`:

- Direct transitive dependencies: `he@1.2.0`, `css-select@^5.1.0`.
- Unpacked size: 165 KB (165,463 bytes) per `npm view
  node-html-parser@6.1.13 dist.unpackedSize`.
- `he` is itself zero-dep and ~58 KB; `css-select` brings
  `boolbase`, `css-what`, `domhandler`, `domutils`, `nth-check`
  (verified via `npm view css-select@5.1.0 dependencies`).

Rationale for accepting it:

- Synchronous `parse()` with class-selector support is exactly
  what the extractor needs; rolling our own would re-introduce
  the regex-over-HTML antipattern.
- The competing libraries (`cheerio`, `linkedom`, `jsdom`,
  `parse5`) are heavier or pull more transitive deps. `cheerio`
  pulls 12+ transitive packages; `jsdom` is multi-megabyte;
  `parse5` requires a separate tree adapter.
- The 165 KB of compiled JS lives inside a CLI process that
  already ships TS + Vue tooling. There is no production-size
  budget violation.

The plan in [03-plan-r2.md §3](03-plan-r2.md) adds an
`npm ls node-html-parser` post-install audit gate, and the
package.json change in [03-plan-r2.md §2](03-plan-r2.md) records
the audit command in the PR notes.

### 2.8 Fixture matrix expanded

Reviewer required correction (second):
[04-review-r1.md "Required corrections", line 33](04-review-r1.md#L33).
The r1 fixture matrix only proved the happy path and the
renamed-class drift path
([02-design-r1.md §3.9](02-design-r1.md#L467-L471)). The r2
matrix appears in §3.9 below and now includes class-attribute
reordering, multi-class anchors, snippet rendered as `<div>`,
missing-snippet rows kept with empty snippets, and malformed
`href` entries that increment `skipped` without failing the
call.

### 2.9 Tool-schema description updated together with the handler

Reviewer required correction (third):
[04-review-r1.md "Required corrections", line 35](04-review-r1.md#L35).
The live schema at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L658-L664)
documents `max_results` as "default 8, max 20". The new defaults
are 20 and configurable up to 50 per §3.2.

Fix: the `max_results` property description becomes:
*"Maximum number of results to return. Default and ceiling are
controlled by `mcp.webSearchMaxResults` (default 20, max 50). Any
larger value is clamped to the ceiling."*

The outer tool description also gains the `code` enumeration as
r1 already prescribed.

## 3. Detailed design (Proposal A) — sections inherited from r1

The unchanged sections of r1 stand without modification:

- §3.1 New runtime dependency:
  [02-design-r1.md §3.1](02-design-r1.md#L119-L139) is replaced
  in spirit by §2.7 above (same dep, honest footprint).
- §3.2 Config-schema additions:
  [02-design-r1.md §3.2](02-design-r1.md#L141-L172) unchanged. The
  Zod fragment is reproduced for convenience in §3.2 below.
- §3.3 Module-level caps and wiring:
  [02-design-r1.md §3.3](02-design-r1.md#L174-L196) unchanged.
- §3.4 New helpers, parser side:
  [02-design-r1.md §3.4](02-design-r1.md#L198-L260) is replaced
  by §3.4 below (the exported `extractDdgResults` and the single-
  decode `uddg` path).
- §3.5 Streaming-bounded fetch:
  [02-design-r1.md §3.5](02-design-r1.md#L262-L307) is replaced
  by §3.5 below (export, abort signal honoured).
- §3.6 Handler:
  [02-design-r1.md §3.6](02-design-r1.md#L309-L411) is replaced
  by §3.6 below (TIMEOUT classification in body-read catch,
  `parseNonNegativeInt` called as G31's same-file helper).
- §3.7 Structured error contract:
  [02-design-r1.md §3.7](02-design-r1.md#L413-L432) unchanged.
- §3.8 Public-API impact:
  [02-design-r1.md §3.8](02-design-r1.md#L434-L454) is updated by
  §2.9 above (schema description) and §3.8 below.
- §3.9 Test surface:
  [02-design-r1.md §3.9](02-design-r1.md#L456-L482) is replaced
  by §3.9 below.

### 3.2 Config-schema additions (reproduced for clarity)

Edit the `mcp` block in
[src/config.ts](../../../../src/config.ts#L137-L170) to add three
fields above `.superRefine(...)`:

```ts
webSearchMaxResults: z.number().int().min(1).max(50).default(20),
webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
```

Order is alphabetical to match the merge-rule shared with G35
(§5 sequencing). `.superRefine` is not touched.

### 3.4 Parser side (replaces r1 §3.4)

Inserted next to `stripHtml` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L91-L102):

```ts
import { parse as parseHtml, type HTMLElement } from "node-html-parser";

export interface DdgResult {
  title: string;
  url: string;
  snippet: string;
}

export interface DdgExtraction {
  results: DdgResult[];
  skipped: number;
}

/**
 * Extract DuckDuckGo HTML-endpoint results from a response body.
 * `base` is the request URL (used to resolve relative anchor
 * hrefs). `max` is the caller's effective ceiling. Throws only
 * when `parseHtml` itself rejects the input; markup with zero
 * candidate anchors returns an empty result list (the handler
 * upgrades that to `NO_RESULTS_PARSED`).
 */
export function extractDdgResults(html: string, base: URL, max: number): DdgExtraction {
  const root = parseHtml(html, { lowerCaseTagName: false, comment: false, blockTextElements: { script: false, style: false } });
  // a.result__a accepts the anchor whether the class attribute
  // is exactly "result__a", "result__a result__a--something",
  // or rendered with attributes reordered around `class=`.
  const anchors = root.querySelectorAll("a.result__a");
  const results: DdgResult[] = [];
  let skipped = 0;
  for (const a of anchors) {
    if (results.length >= max) break;
    const href = a.getAttribute("href");
    if (!href) { skipped += 1; continue; }
    let resolvedUrl: string;
    try {
      const parsedHref = new URL(href, base);
      const uddg = parsedHref.searchParams.get("uddg");  // already decoded
      if (uddg !== null) {
        const candidate = new URL(uddg);  // no second decodeURIComponent call
        if (candidate.protocol !== "http:" && candidate.protocol !== "https:") {
          skipped += 1;
          continue;
        }
        resolvedUrl = candidate.toString();
      } else {
        resolvedUrl = parsedHref.toString();
      }
    } catch {
      skipped += 1;
      continue;
    }
    const title = (a.text ?? "").replace(/\s+/g, " ").trim();
    const container = climbToResultContainer(a);
    // Snippet may live inside the same .result container either
    // as a.result__snippet (DDG's default) or as
    // <div class="result__snippet"> (observed variant). Missing
    // snippet does not skip the row — it returns an empty snippet
    // string so callers can decide whether to retry or accept.
    const snippetNode = container?.querySelector("a.result__snippet, .result__snippet");
    const snippet = snippetNode ? (snippetNode.text ?? "").replace(/\s+/g, " ").trim() : "";
    results.push({ title, url: resolvedUrl, snippet });
  }
  return { results, skipped };
}

function climbToResultContainer(node: HTMLElement): HTMLElement | null {
  let cur: HTMLElement | null = node;
  for (let i = 0; cur && i < 6; i += 1) {
    if (cur.classList?.contains("result")) return cur;
    cur = (cur.parentNode as HTMLElement | null) ?? null;
  }
  return null;
}
```

### 3.5 Streaming-bounded fetch (replaces r1 §3.5)

Exported helper, abort-aware:

```ts
export async function readBoundedTextBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  const onAbort = async () => {
    try { await reader.cancel(); } catch { /* already done */ }
  };
  if (signal) {
    if (signal.aborted) {
      await onAbort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        try { await reader.cancel(); } catch { /* already done */ }
        break;
      }
      chunks.push(value);
    }
  } catch (err) {
    if (signal?.aborted) {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    throw err;
  } finally {
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: merged.toString("utf8"), truncated };
}
```

### 3.6 Handler (replaces r1 §3.6)

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

  const searchUrl = new URL("https://duckduckgo.com/html/");
  searchUrl.searchParams.set("q", query);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("web_search timeout")), WEB_SEARCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(searchUrl, {
      headers: { "User-Agent": "Saivage/0.1 data-agent" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (isAbortError(err, controller)) {
      return {
        content: { error: `TIMEOUT: web_search exceeded ${WEB_SEARCH_TIMEOUT_MS}ms`, code: "TIMEOUT", query, timeout_ms: WEB_SEARCH_TIMEOUT_MS },
        isError: true,
      };
    }
    return {
      content: { error: `NETWORK_ERROR: ${(err as Error).message}`, code: "NETWORK_ERROR", query },
      isError: true,
    };
  }

  if (!response.ok) {
    clearTimeout(timeout);
    try { await response.body?.cancel(); } catch { /* ignore */ }
    return {
      content: { error: `UPSTREAM_HTTP_ERROR: DuckDuckGo returned ${response.status}`, code: "UPSTREAM_HTTP_ERROR", query, status: response.status },
      isError: true,
    };
  }

  let body: { text: string; truncated: boolean };
  try {
    body = await readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES, controller.signal);
  } catch (err) {
    clearTimeout(timeout);
    if (isAbortError(err, controller)) {
      return {
        content: { error: `TIMEOUT: web_search exceeded ${WEB_SEARCH_TIMEOUT_MS}ms`, code: "TIMEOUT", query, timeout_ms: WEB_SEARCH_TIMEOUT_MS },
        isError: true,
      };
    }
    return {
      content: { error: `NETWORK_ERROR: ${(err as Error).message}`, code: "NETWORK_ERROR", query },
      isError: true,
    };
  } finally {
    clearTimeout(timeout);
  }

  if (body.truncated) {
    return {
      content: { error: `RESPONSE_TOO_LARGE: DuckDuckGo response exceeded ${WEB_SEARCH_MAX_BYTES} bytes`, code: "RESPONSE_TOO_LARGE", query, max_bytes: WEB_SEARCH_MAX_BYTES },
      isError: true,
    };
  }

  let extracted: DdgExtraction;
  try {
    extracted = extractDdgResults(body.text, searchUrl, maxResults);
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
        bytes: body.text.length,
        markup_signature: signatureOf(body.text),
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

`isAbortError` and `signatureOf` are file-private helpers placed
next to `stripHtml`:

```ts
function isAbortError(err: unknown, controller: AbortController): boolean {
  if (controller.signal.aborted) return true;
  const e = err as { name?: string; code?: string } | null;
  return e?.name === "AbortError" || e?.code === "ERR_ABORTED";
}

function signatureOf(html: string): string {
  return createHash("sha256").update(html.slice(0, 1024)).digest("hex").slice(0, 16);
}
```

`createHash` is already imported at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L27); no new
import is needed for the signature helper.

### 3.8 Public-API impact (delta vs r1)

- **Tool schema** at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L669):
  the outer `description` lists the new `code` values as in r1;
  the `max_results` property description is rewritten per §2.9.
- **Module exports** of
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts):
  `extractDdgResults`, `DdgResult`, `DdgExtraction`, and
  `readBoundedTextBody` are added as named exports. No other
  symbols change visibility.
- **Tool result (success)** gains `skipped: number` as r1
  prescribed.
- **Tool result (failure)** gains structured `code` plus context
  fields as r1 prescribed.
- **Config** gains the three fields in §3.2; defaults cover
  existing `.saivage/saivage.json` files.

### 3.9 Test surface (replaces r1 §3.9)

Fixtures live next to the test file:

- [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html)
  — captured DDG response, ≥ 5 result blocks, tracker IDs scrubbed
  to `example.com` placeholders. Includes:
  - one anchor with the class attribute reordered after `href`;
  - one anchor with `class="result__a result__a--clicktrack"`
    (multi-class);
  - one entry whose snippet is rendered as
    `<div class="result__snippet">…</div>`;
  - one entry with no snippet element inside its `.result`
    container (snippet expected blank, row kept);
  - one entry whose `href` is `/l/?uddg=https%3A%2F%2Fexample.com%2Fpath%3Fref%3Da%252Bb%252Fc%252526d`
    (nested escapes — the extracted URL must be exactly
    `https://example.com/path?ref=a%2Bb%2Fc%2526d`);
  - one entry whose `href` is the literal string `not a url`
    (skipped, increments `skipped`).
- [src/mcp/web-search.fixture.drifted.html](../../../../src/mcp/web-search.fixture.drifted.html)
  — same body with `class="result__a"` renamed to
  `class="result__title"` (zero anchors match).
- [src/mcp/web-search.fixture.empty.html](../../../../src/mcp/web-search.fixture.empty.html)
  — minimal HTML shell, no anchors.

Test cases (added inside a new
`describe("data: web_search", …)` block at the bottom of
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts);
the handler-level cases use the in-process `createServer` pattern
already in the file at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L220-L240)):

| # | Layer | Scenario | Setup | Assert |
|---|-------|----------|-------|--------|
| 1 | parser | smoke | `extractDdgResults(fixture, baseUrl, 20)` | `results.length >= 5`; every result has non-empty `title` + `url`; `skipped === 1` (the malformed-href entry) |
| 2 | parser | nested escape preserved | row whose target is `https://example.com/path?ref=a%252Bb%252Fc%252526d` | extracted URL `=== "https://example.com/path?ref=a%2Bb%2Fc%2526d"` (one round of decode only) |
| 3 | parser | class attribute reordered | anchor with `href="…" class="result__a"` (attributes flipped) | matched as a normal result |
| 4 | parser | multi-class anchor | anchor with `class="result__a result__a--clicktrack"` | matched as a normal result |
| 5 | parser | snippet as `<div>` | entry whose snippet element is `<div class="result__snippet">…</div>` | snippet text extracted, non-empty |
| 6 | parser | missing snippet, row kept | entry whose `.result` container has no `result__snippet` descendant | row present; `snippet === ""`; not in `skipped` |
| 7 | parser | drift fixture | `extractDdgResults(driftedFixture, …)` | `results.length === 0` |
| 8 | handler | empty query | call handler with `query: ""` | `isError: true`, `code === "INVALID_ARGUMENT"` |
| 9 | handler | invalid `max_results` | call with `max_results: -3` | `isError: true`, `code === "INVALID_ARGUMENT"` (relies on G31's `parseNonNegativeInt`) |
| 10 | handler | clamp `max_results` | server returns happy fixture; call with `max_results: 99` and configured ceiling 20 | `results.length <= 20` |
| 11 | handler | upstream 503 | server responds `503` with empty body | `code === "UPSTREAM_HTTP_ERROR"`, `status === 503` |
| 12 | handler | upstream 200 with drifted markup | server returns drifted fixture | `code === "NO_RESULTS_PARSED"`, `bytes` and `markup_signature` present |
| 13 | handler | timeout pre-headers | server stalls before writing headers; `webSearchTimeoutMs: 1_000` | `code === "TIMEOUT"`, `timeout_ms === 1_000` |
| 14 | handler | timeout mid-body | server writes headers + 1 KB body, holds the socket open; `webSearchTimeoutMs: 1_000` | `code === "TIMEOUT"` (exercises §2.1) |
| 15 | handler | oversized body | server streams 96 KB; `webSearchMaxBytes: 64 * 1024` | `code === "RESPONSE_TOO_LARGE"`, `max_bytes === 64 * 1024` |
| 16 | handler | network failure | server is started then closed before call; URL points at the closed port | `code === "NETWORK_ERROR"` |

Cap-bearing tests pass a typed `mcp` override to
`registerBuiltinServices` so the loaded base config keeps its
defaults: `registerBuiltinServices(runtime, { ...cfg.mcp,
webSearchTimeoutMs: 1_000, webSearchMaxBytes: 64 * 1024 }, …)`.
The DDG hostname is replaced for handler tests by overriding the
`searchUrl` host through a small test seam — the simplest seam is
to point the handler at the in-process server via an
environment-derived override pattern that already exists for
other builtins (the existing tests use `withTextServer` to mint a
local `http://127.0.0.1:PORT` URL; the same pattern is reused
here). The override is the test-only escape hatch already in use
at [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L220-L240).

## 4. Sequencing (replaces r1 §4)

- **Orthogonal to G30**: unchanged.
- **Disjoint with G31** (same as r1) **except** G33 depends on
  G31 landing first because G33 calls `parseNonNegativeInt`. If
  G31 slips, the fallback is the inline-five-lines path in
  [03-plan-r2.md §6](03-plan-r2.md).
- **Disjoint with G32**: unchanged.
- **Disjoint with G34**: G34 owns
  `fetch_url` / `fetch_page_text` / `download_file` /
  `download_with_fallbacks`
  ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L920))
  and consumes the `readBoundedTextBody` export added by G33.
  No file-private copy of the helper is created by G34; the
  dedup step is renamed to "adopt G33's export".
- **Disjoint with G35**: unchanged. Both G33 and G35 insert new
  `mcp` fields alphabetically above `.superRefine`.

Revised merge order: **G30 → G31 → G32 → G33 → G34 → G35**.

## 5. Daemon impact (unchanged from r1)

See [02-design-r1.md §5](02-design-r1.md#L527-L538).

## 6. What is intentionally not in this design

- Same exclusions as r1
  ([02-design-r1.md §6](02-design-r1.md#L540-L549)). No second
  search backend. No retries. No headless-browser fallback.
- No shared `src/mcp/http.ts` module. The exported helper from
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) is the
  smallest possible seam until a third consumer needs it.
