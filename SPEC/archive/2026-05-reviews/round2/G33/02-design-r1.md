# G33 — Design r1

**Finding**: [../G33-builtins-web-search-ddg-regex.md](../G33-builtins-web-search-ddg-regex.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

**Writer**: Claude Opus 4.7 (round 1)

## 1. Recommendation

**Proposal A — DOM-parse the DDG HTML endpoint and add structured
caps and errors.** Replace the regex parser in the `web_search`
handler with a real HTML parser (`node-html-parser`), add bounded
timeout / max-bytes / max-results caps to
[src/config.ts](../../../../src/config.ts), and return G31/G32-shaped
structured errors for every failure mode including the new
`NO_RESULTS_PARSED` markup-drift signal. Add a fixture-driven unit
test pinned to a captured DDG response.

Proposal A keeps DDG as the single upstream — the same upstream
the tool already uses — and wraps the extractor in one internal
function `extractDdgResults(html)` so a future operator can swap
the upstream without re-shaping the handler. It does **not**
introduce a pluggable provider abstraction, a backend registry, or
a config switch for the upstream. Per the workspace
architecture-first / no-shim rule (see
[01-analysis-r1.md §4](01-analysis-r1.md#L1)), shipping one
provider behind one helper is the right granularity until a second
provider exists.

Proposal B (pluggable backend abstraction) is rejected — see §2.

## 2. Proposals considered

### Proposal A — Real parser + caps + structured errors (recommended)

Scope:

- Add three caps to the `SaivageConfig.mcp` block:
  `webSearchMaxResults`, `webSearchTimeoutMs`,
  `webSearchMaxBytes`.
- Wire the caps into `registerBuiltinServices` next to
  `MAX_FETCH_CHARS` and friends.
- Add `node-html-parser` as a production dependency.
- Replace the regex loop in the `web_search` handler with an
  `extractDdgResults(html)` helper that uses
  `node-html-parser`'s `parse()` and `querySelectorAll()` against
  `a.result__a` anchors, walking up to the nearest `.result`
  container to pull the matching `a.result__snippet`.
- Wrap the fetch in `AbortSignal.timeout(...)` and read the body
  as a stream that aborts once `webSearchMaxBytes` is exceeded.
- Return structured errors with `code` for every failure path.
- Add a fixture-driven test
  [src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html)
  (captured 2026-05-26 from the DDG HTML endpoint) plus tests in
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
  that assert (a) the extractor returns ≥1 result on the fixture,
  (b) corrupted fixture variants yield `NO_RESULTS_PARSED`, and
  (c) network/timeout/oversize/non-2xx paths each return the
  documented `code`.

Strengths:

- Removes the regex-over-HTML antipattern, which is the
  single highest-leverage change.
- Makes silent breakage loud via `NO_RESULTS_PARSED`.
- Symmetric with G31/G32 envelope and error-code conventions.
- One new dep (`node-html-parser` — zero transitive deps, ~50 KB).
- No backend-registry plumbing, no dead second-implementation
  code.

Weaknesses:

- DDG markup drift still requires re-capturing the fixture
  occasionally. Test forces detection (red CI) but humans must
  re-record the fixture.
- A future operator who wants a different upstream still needs
  to edit the helper; the seam is "one function", not "one
  config field". This is intentional per §1.

### Proposal B — Pluggable web-search backend with provider config (rejected)

Scope:

- Introduce a `WebSearchBackend` interface with
  `search(query, opts)` and `name`.
- Concrete backends: `DdgHtmlBackend` (port of A), placeholders
  documenting Brave / SerpAPI.
- Add `mcp.webSearch.provider: "ddg-html" | "brave" | "serpapi"`
  with API-key fields, plus a backend registry consulted at
  `registerBuiltinServices` time.
- The handler dispatches by provider name.

Strengths:

- Operator can swap providers without code change once a second
  backend ships.
- Cleaner story for "what to do when DDG locks the IP".

Why it is rejected at round 1:

- Only one concrete backend exists. The interface, registry,
  and provider switch are dead code until a second backend is
  implemented — which is exactly the over-engineering the
  project rules call out.
- The "no backward-compat" rule says we should not preserve a
  surface that no one consumes. Shipping `provider: "ddg-html"`
  with no other value to choose is precisely that surface.
- Proposal A keeps the work that would migrate to B small: one
  helper function moves into one backend file. There is no shim
  to remove later.

Defer B to a follow-up issue (G33-followup) that is opened only
when a second backend is concretely needed (API key in hand, not
speculative).

## 3. Detailed design (Proposal A)

### 3.1 New runtime dependency

Add to `dependencies` in
[package.json](../../../../package.json):

```jsonc
"node-html-parser": "^6.1.13"
```

Rationale: zero transitive deps, synchronous `parse()`, supports
`querySelector`/`querySelectorAll` against class selectors,
tolerant of malformed HTML, ESM-friendly, ~50 KB unpacked. No
other candidate (`cheerio`, `parse5`, `linkedom`, `jsdom`) is
acceptable: `cheerio` pulls 12+ transitive deps; `jsdom` is a
~5 MB DOM emulator we do not need; `parse5` requires a tree
adapter to query by class; `linkedom` is heavier and slower for
this use case.

### 3.2 Config-schema additions

Edit the `mcp` block in
[src/config.ts](../../../../src/config.ts#L137-L170) to add three
fields next to `maxFetchChars` / `maxDownloadBytes`:

```ts
mcp: z
  .object({
    shellTimeoutMs: z.number().default(4 * 60 * 60 * 1000),
    shellTimeoutFloorMs: z.number().default(10 * 60 * 1000),
    inProcessTimeoutMs: z.number().default(300_000),
    maxOutputBytes: z.number().default(100 * 1024),
    maxFetchChars: z.number().default(200_000),
    maxDownloadBytes: z.number().default(250 * 1024 * 1024),
    webSearchMaxResults: z.number().int().min(1).max(50).default(20),
    webSearchTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
    webSearchMaxBytes: z.number().int().min(64 * 1024).max(16 * 1024 * 1024).default(2 * 1024 * 1024),
  })
  .default({})
  .superRefine(/* unchanged */),
```

Field names are deliberately disjoint from G34 (which plans to
add `fetchTimeoutMs` / `fetchMaxBytes` / similar) and G35 (which
edits secrets in [src/security/secrets.ts](../../../../src/security/secrets.ts)
and may add `mcp.secrets*` fields). Sequencing notes in §4
record the conflict-resolution rule for the `mcp` block.

### 3.3 Module-level caps and wiring

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) near
the existing `let MAX_FETCH_CHARS = 200_000;` declaration at
[line 42](../../../../src/mcp/builtins.ts#L42), add:

```ts
let WEB_SEARCH_MAX_RESULTS = 20;
let WEB_SEARCH_TIMEOUT_MS = 15_000;
let WEB_SEARCH_MAX_BYTES = 2 * 1024 * 1024;
```

In `registerBuiltinServices` near the existing assignment at
[line 1078](../../../../src/mcp/builtins.ts#L1078), add:

```ts
WEB_SEARCH_MAX_RESULTS = mcpConfig.webSearchMaxResults;
WEB_SEARCH_TIMEOUT_MS = mcpConfig.webSearchTimeoutMs;
WEB_SEARCH_MAX_BYTES = mcpConfig.webSearchMaxBytes;
```

These follow the same module-let-with-register-time-rebind
pattern G30 retained and that G31/G32 build on.

### 3.4 New helpers

Insert next to `stripHtml` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L91-L102):

```ts
import { parse as parseHtml, type HTMLElement } from "node-html-parser";

interface DdgResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Extract DuckDuckGo HTML-endpoint results from a response body.
 * Throws on malformed input; returns empty array when the markup
 * parses but no candidate result nodes exist.
 */
function extractDdgResults(html: string, base: URL, max: number): { results: DdgResult[]; skipped: number } {
  const root = parseHtml(html, { lowerCaseTagName: false, comment: false, blockTextElements: { script: false, style: false } });
  const anchors = root.querySelectorAll("a.result__a");
  const results: DdgResult[] = [];
  let skipped = 0;
  for (const a of anchors) {
    if (results.length >= max) break;
    const href = a.getAttribute("href");
    if (!href) { skipped += 1; continue; }
    let url = href;
    try {
      const parsed = new URL(url, base);
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) url = decodeURIComponent(uddg);
      else url = parsed.toString();
    } catch {
      skipped += 1;
      continue;
    }
    const title = (a.text ?? "").replace(/\s+/g, " ").trim();
    // The snippet anchor lives within the same .result container.
    const container = climbToResultContainer(a);
    const snippetNode = container?.querySelector("a.result__snippet, .result__snippet");
    const snippet = snippetNode ? (snippetNode.text ?? "").replace(/\s+/g, " ").trim() : "";
    results.push({ title, url, snippet });
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

Notes:

- The selector `a.result__a` is the same anchor class the regex
  targeted; it has been stable across the DDG variants we have
  observed. `result__snippet` is matched both as an `<a>` and as
  a fallback element class to absorb the variant where the
  snippet is rendered into a `<div>`.
- Per-entry tolerance mirrors G32's policy at
  [G32 02-design-r2 §3.7](../G32/02-design-r2.md): individual
  malformed anchors increment `skipped` rather than failing the
  whole call.

### 3.5 Streaming-bounded fetch

Replace the body-read at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L744-L745)
with a streaming helper that aborts once the cap is exceeded.
This is the same pattern G34 plans to introduce for `fetch_url`;
G33 ships an internal copy under the helper name
`readBoundedTextBody(response, maxBytes)`, scoped to file-private
use inside [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).
G34 will replace both copies (its own `fetch_url` path and the
one introduced here) with a single shared helper after both
land. Until then, the duplication is bounded to one function and
is explicitly disjoint same-file edits.

```ts
async function readBoundedTextBody(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      truncated = true;
      try { await reader.cancel(); } catch { /* upstream may already be closed */ }
      break;
    }
    chunks.push(value);
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { text: merged.toString("utf8"), truncated };
}
```

### 3.6 Handler — round-1 version

Replaces the round-1 handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761):

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
    const aborted = (err as Error & { name?: string }).name === "AbortError" || controller.signal.aborted;
    return {
      content: aborted
        ? { error: `TIMEOUT: web_search exceeded ${WEB_SEARCH_TIMEOUT_MS}ms`, code: "TIMEOUT", query, timeout_ms: WEB_SEARCH_TIMEOUT_MS }
        : { error: `NETWORK_ERROR: ${(err as Error).message}`, code: "NETWORK_ERROR", query },
      isError: true,
    };
  }

  if (!response.ok) {
    clearTimeout(timeout);
    return {
      content: { error: `UPSTREAM_HTTP_ERROR: DuckDuckGo returned ${response.status}`, code: "UPSTREAM_HTTP_ERROR", query, status: response.status },
      isError: true,
    };
  }

  let body: { text: string; truncated: boolean };
  try {
    body = await readBoundedTextBody(response, WEB_SEARCH_MAX_BYTES);
  } catch (err) {
    clearTimeout(timeout);
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

  let extracted: { results: DdgResult[]; skipped: number };
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

`signatureOf(html)` is a tiny helper that returns the first 16 hex
chars of `createHash("sha256").update(html.slice(0, 1024)).digest("hex")`;
it lets operators correlate "all `NO_RESULTS_PARSED` since
yesterday share the same DDG markup hash" without dumping bodies.
The helper is co-located with the other small helpers near
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L91-L102).

`parseNonNegativeInt` already exists in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) and is
reused by G31 and G32; G33 reuses the same helper without
modification.

### 3.7 Structured error contract

| `code` | Origin | Recovery hint embedded in `error` |
|--------|--------|-----------------------------------|
| `INVALID_ARGUMENT` | empty `query`, bad `max_results` | "query must be a non-empty string" / `parseNonNegativeInt` message |
| `TIMEOUT` | fetch aborted by `AbortController` after `webSearchTimeoutMs` | "web_search exceeded Nms" |
| `NETWORK_ERROR` | non-abort fetch rejection, body read rejection | upstream errno/message |
| `UPSTREAM_HTTP_ERROR` | `!response.ok` | "DuckDuckGo returned N"; `status` field carries the code |
| `RESPONSE_TOO_LARGE` | streamed body exceeded `webSearchMaxBytes` | "exceeded N bytes"; `max_bytes` field carries the cap |
| `PARSE_FAILURE` | `parseHtml` threw | parser message |
| `NO_RESULTS_PARSED` | extractor returned `results.length === 0` | "markup may have drifted"; `markup_signature` + `bytes` carry forensic context |

The success envelope keeps the existing `{ query, results, status }`
fields plus a new `skipped: number` to mirror G32's per-entry
tolerance reporting. The list is exhaustive; no failure escapes as
a raw thrown error.

### 3.8 Public-API impact

- **Tool schema** (the `dataTools` entry at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L657-L669)):
  the description is updated to mention "structured error codes
  on failure" and to clarify that `max_results` is clamped to the
  configured ceiling. No required-field changes; `max_results`
  remains optional.
- **Tool result (success)**: gains `skipped: number`.
- **Tool result (failure)**: previously `{ error }` (one shape);
  now `{ error, code, ... }` per §3.7.
- **Config**: three new optional fields under `mcp` with defaults
  documented in [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
  (doc edit listed in [03-plan-r1.md](03-plan-r1.md)).

### 3.9 Test surface

Add to
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
a new `describe("data: web_search", …)` block. The fixture file
[src/mcp/web-search.fixture.html](../../../../src/mcp/web-search.fixture.html)
is a real DDG response captured 2026-05-26, redacted of
tracking-id-like values. The test cases:

| # | Scenario | Setup | Assert |
|---|----------|-------|--------|
| 1 | parser smoke | call `extractDdgResults` directly on the fixture | `results.length >= 5`, every result has non-empty `title` + `url` |
| 2 | uddg decoding | fixture entry with `/l/?uddg=https%3A%2F%2Fexample.com` | result `url === "https://example.com"` |
| 3 | empty query | call handler with `query: ""` | `isError: true`, `code === "INVALID_ARGUMENT"` |
| 4 | clamp `max_results` | call with `max_results: 99` | `results.length <= webSearchMaxResults` |
| 5 | markup drift | call `extractDdgResults` on a fixture with `result__a` renamed to `result__title` | `results.length === 0` (the handler converts this to `NO_RESULTS_PARSED`) |
| 6 | upstream 503 | mock `fetch` to return `Response("", { status: 503 })` | `code === "UPSTREAM_HTTP_ERROR"`, `status === 503` |
| 7 | timeout | mock `fetch` to return a body that never closes; set `webSearchTimeoutMs: 50` | `code === "TIMEOUT"` |
| 8 | oversized body | mock `fetch` to stream 4 MB of bytes; set `webSearchMaxBytes: 1024` | `code === "RESPONSE_TOO_LARGE"` |
| 9 | network failure | mock `fetch` to reject with `Error("ENOTFOUND")` | `code === "NETWORK_ERROR"` |

Mocking strategy mirrors the existing pattern at
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L220-L240):
`vi.spyOn(global, "fetch")` to inject a synthetic `Response`,
restored in `afterEach`.

## 4. Sequencing

- **Orthogonal to G30** (filesystem fs/promises migration): G30
  is approved and does not touch `web_search`, the `data` service
  block, or [src/config.ts](../../../../src/config.ts). No
  conflict.
- **Disjoint with G31**: G31 edits the `filesystem.read_file`
  case at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L274-L302)
  and adds a `classifyFsError` helper near `parseNonNegativeInt`.
  G33 edits only `web_search` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761)
  and adds helpers near `stripHtml`. No line overlap.
- **Disjoint with G32**: G32 edits the `filesystem.search_files`
  case at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L310-L600)
  and adds `globToRegExp`. No overlap with G33.
- **Disjoint with G34**: G34 owns `fetch_url` / `fetch_page_text` /
  `download_file` / `download_with_fallbacks`
  ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L920)).
  G33 owns `web_search`
  ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L737-L761))
  exclusively. The `readBoundedTextBody` duplication is the only
  shared concept; G34 lands second and replaces both copies with
  a single helper in the same PR (deduplication, not a shim).
- **Disjoint with G35**: G35 edits
  [src/security/secrets.ts](../../../../src/security/secrets.ts)
  and may add `mcp.secrets*` fields. G33's new fields
  (`webSearchMaxResults`, `webSearchTimeoutMs`,
  `webSearchMaxBytes`) are name-disjoint and live in the same
  `mcp` z.object block — merging is a textual addition with no
  semantic conflict. The plan ([03-plan-r1.md](03-plan-r1.md))
  records the merge-rule: both edits insert new fields above
  `.superRefine`, ordered alphabetically.

Recommended merge order if all five land in the same window:
G30 (already approved) → G31 → G32 → G34 → G33 → G35. G33 after
G34 lets G33 consume G34's shared `readBoundedTextBody` helper
during the dedup step.

## 5. Daemon impact

- `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3`
  (10.0.3.112): bind-mount [src/](../../../../src/) — restart of
  `saivage.service` required after deploy to pick up the new
  helper and config caps. Existing on-disk `.saivage/saivage.json`
  files without the new fields keep working because all three
  fields have defaults.
- `saivage-v3-getrich-v2` (10.0.3.170): does not bind-mount this
  repo and is unaffected.

## 6. What is intentionally **not** in this design

- No second search backend. No `WebSearchBackend` interface. No
  `mcp.webSearch.provider` config switch. See §2 for why.
- No proxy / retry / circuit-breaker logic. The agent already
  composes higher-level retry via the task report and supervisor.
  Adding it here would duplicate retry logic across the data
  tools (G34 has the same constraint).
- No headless-browser / Playwright fallback. That is an
  agent-level decision and would belong in a separate finding.
