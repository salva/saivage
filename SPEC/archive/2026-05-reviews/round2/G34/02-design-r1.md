# G34 — Design r1

**Finding**: [../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

**Writer**: Claude Opus 4.7 (round 1)

## 1. Recommendation

**Proposal B — Factor a shared bounded-fetch helper module and
use it from all five fetching builtins (plus G33).** Create
[src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts)
exporting `readBoundedTextBody`, `readBoundedBinaryBody`,
`fetchWithTimeout`, `classifyNetworkError`, and the
`HttpFetchErrorCode` type. Rewrite `fetch_url`,
`fetch_page_text`, `download_file`, `download_with_fallbacks`
and the internal `downloadUrl` to use them. Have
[../G33/02-design-r2.md](../G33/02-design-r2.md) import the
shared helper instead of re-declaring its file-private copy.

G34 owns the helper (4 call sites in this finding vs. 1 in
G33; G34 also defines the binary variant and the
`AbortSignal.timeout` wrapper that G33 only needs trivially).
G33 r2 is updated to import from
[src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts).

Proposal A (inline streaming inside each handler with no shared
module) is rejected; see §2.

## 2. Proposals considered

### Proposal A — Inline streaming per handler (rejected)

Scope: add an `AbortSignal.timeout(…)` and a manual
`response.body.getReader()` loop directly inside each of the
five handler cases at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L880);
add the structured error envelope inline. No new module.

Strengths:

- Smallest diff in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts).
- Independent of G33.

Why rejected:

- G33 already needs the *same* streaming reader and is shipping
  a file-private copy under the same name
  ([../G33/02-design-r1.md §3.5](../G33/02-design-r1.md#L228-L262)).
  Two copies of the same loop in one file at landing time, then
  three when the binary variant lands, is the duplication the
  workspace architecture-first rule asks us to avoid up front.
- The error classifier is the same code six times (`fetch_url`,
  `fetch_page_text`, `download_file`,
  `download_with_fallbacks`, the inner `downloadUrl`, plus
  G33's `web_search`). Inlining six copies and refactoring
  later is exactly the "no migration shim" anti-pattern: at
  least one of those copies will drift.
- The `Response#body` stream has subtle reader-cancellation
  semantics (must `cancel()` on cap-overflow to free the
  socket; must guard against `null` body on 204 responses);
  getting it right once in one module is cheaper than reviewing
  it six times.

### Proposal B — Shared helper module (recommended)

Scope: one new module
[src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts), one
new unit-test file
[src/mcp/httpFetch.test.ts](../../../../src/mcp/httpFetch.test.ts),
edits to four handler cases plus the `downloadUrl` helper in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts), three
new fields in the `mcp` config block in
[src/config.ts](../../../../src/config.ts#L137-L170), and a
one-line import swap in G33 r2.

Strengths:

- One implementation of streaming-bounded read; one
  implementation of `AbortSignal.timeout` wrapping; one
  implementation of network-error classification.
- The exported helper is a legitimate utility, not a one-shot
  shim. It is the network-side sibling of G31's exported
  `classifyFsError`.
- Removes G33's file-private duplicate at landing time.

Weaknesses:

- Adds a same-file co-edit dependency with G33 r2 (one import
  line). Mitigated by the sequencing in §4 — G34 lands first,
  G33 r2 cherry-picks the import.
- New module surface (1 module, 4 exports + 1 type) added to
  `src/mcp/`. Justified because all four exports have ≥2 call
  sites at landing time.

## 3. Detailed design (Proposal B)

### 3.1 New module — src/mcp/httpFetch.ts

```ts
import type { Buffer } from "node:buffer";

export type HttpFetchErrorCode =
  | "INVALID_ARGUMENT"
  | "TIMEOUT"
  | "NETWORK_ERROR"
  | "UPSTREAM_HTTP_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "IO_ERROR";

export interface ClassifiedHttpError {
  code: HttpFetchErrorCode;
  error: string;
  errno?: string;
}

export interface BoundedReadResult<T> {
  body: T;
  bytes: number;
  truncated: boolean;
}

/**
 * Wrap fetch with an AbortSignal.timeout. The returned Response
 * is unread; the caller must use readBoundedTextBody /
 * readBoundedBinaryBody to consume it under a byte cap. Throws
 * the classified DOMException on timeout; throws TypeError or
 * platform Error on network failure (DNS, ECONNRESET, TLS).
 */
export async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  // Compose with any caller-supplied signal.
  const composed = init.signal
    ? AbortSignal.any([signal, init.signal])
    : signal;
  return fetch(url, { ...init, signal: composed });
}

/**
 * Read the response body into a UTF-8 string, aborting the
 * underlying stream once `maxBytes` is exceeded. Returns
 * `truncated: true` when the cap fired; the returned `body` is
 * always the bytes that fit. Returns empty string on a null
 * body (e.g. HTTP 204).
 */
export async function readBoundedTextBody(
  response: Response,
  maxBytes: number,
): Promise<BoundedReadResult<string>> {
  if (!response.body) return { body: "", bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      // Keep only the prefix that fits.
      const room = Math.max(0, maxBytes - total);
      if (room > 0) chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* upstream may already be closed */
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { body: merged.toString("utf8"), bytes: total, truncated };
}

/**
 * Read the response body into a Buffer with the same
 * cap-and-abort semantics. Used by download_* tools.
 */
export async function readBoundedBinaryBody(
  response: Response,
  maxBytes: number,
): Promise<BoundedReadResult<Buffer>> {
  if (!response.body) return { body: Buffer.alloc(0), bytes: 0, truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.byteLength > maxBytes) {
      truncated = true;
      try {
        await reader.cancel();
      } catch {
        /* upstream may already be closed */
      }
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { body: merged, bytes: total, truncated };
}

/**
 * Classify a thrown error from fetchWithTimeout or a bounded
 * reader into the structured envelope. Mirrors G31's
 * classifyFsError shape.
 */
export function classifyNetworkError(
  err: unknown,
  url: string,
): ClassifiedHttpError {
  // AbortSignal.timeout throws DOMException with name "TimeoutError".
  if (err instanceof Error && err.name === "TimeoutError") {
    return {
      code: "TIMEOUT",
      error: `TIMEOUT: ${url} did not respond before the configured deadline.`,
    };
  }
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  const msg = (err as Error | undefined)?.message ?? String(err);
  if (errno) {
    return {
      code: "NETWORK_ERROR",
      error: `NETWORK_ERROR: ${url}: ${msg}`,
      errno,
    };
  }
  // undici TypeError ("fetch failed") with cause; unwrap once.
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  if (cause && typeof cause === "object") {
    const causeErrno = (cause as NodeJS.ErrnoException).code;
    const causeMsg = (cause as Error).message ?? "";
    if (causeErrno) {
      return {
        code: "NETWORK_ERROR",
        error: `NETWORK_ERROR: ${url}: ${causeMsg || msg}`,
        errno: causeErrno,
      };
    }
  }
  return { code: "NETWORK_ERROR", error: `NETWORK_ERROR: ${url}: ${msg}` };
}
```

### 3.2 Config schema additions

Extend the `mcp` block in
[src/config.ts](../../../../src/config.ts#L137-L170) with one
new field (the two existing fields are already correctly
defaulted; we add only a *timeout* because there is no per-fetch
timeout today):

```ts
mcp: z
  .object({
    shellTimeoutMs: z.number().default(4 * 60 * 60 * 1000),
    shellTimeoutFloorMs: z.number().default(10 * 60 * 1000),
    inProcessTimeoutMs: z.number().default(300_000),
    maxOutputBytes: z.number().default(100 * 1024),
    maxFetchChars: z.number().default(200_000),
    maxDownloadBytes: z.number().default(250 * 1024 * 1024),
    fetchTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
    // ... G33 adds webSearchMaxResults / webSearchTimeoutMs /
    // webSearchMaxBytes alongside (orthogonal field set).
  })
  .default({})
  .superRefine(/* unchanged */),
```

`maxFetchChars` and `maxDownloadBytes` already exist and are
reused by G34 as the **byte** caps for `readBoundedTextBody`
and `readBoundedBinaryBody`. Naming note: `maxFetchChars` was
historically a character cap, but in practice it is consulted
on a UTF-8 string sliced by character count and the upstream is
treated 1 byte ≈ 1 char. We re-interpret it as a *byte* cap on
the stream and document this in
[docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md).
The default of 200 000 is preserved and the visible behaviour
(truncation at ~200 000 characters of mostly-ASCII content) is
preserved within ±multi-byte-rune tolerance.

If pure parity with the historical character semantics is
required by reviewer at round 2, we revert to slicing the
returned string by code-units after the streaming read, while
keeping the byte cap at `maxFetchChars * 4` to bound RAM. The
default-path test asserts whichever semantics ship.

### 3.3 Module-level caps and wiring

In [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) near
the existing `let MAX_FETCH_CHARS` block at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43),
add:

```ts
let FETCH_TIMEOUT_MS = 60_000;
```

In `registerBuiltinServices` near
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078-L1079),
add:

```ts
FETCH_TIMEOUT_MS = mcpConfig.fetchTimeoutMs;
```

### 3.4 fetch_url handler — round-1 version

Replaces the handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L783):

```ts
case "fetch_url": {
  let url: URL;
  try {
    url = parseHttpUrl(String(args.url));
  } catch (err) {
    return {
      content: {
        code: "INVALID_ARGUMENT",
        error: `INVALID_ARGUMENT: ${err instanceof Error ? err.message : String(err)}`,
        url: String(args.url),
      },
      isError: true,
    };
  }
  const maxBytes = Math.min(Math.max(Number(args.max_chars ?? MAX_FETCH_CHARS), 1_000), 1_000_000);
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Saivage/0.1 data-agent" } },
      FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    return {
      content: { ...classifyNetworkError(err, url.toString()), url: url.toString() },
      isError: true,
    };
  }
  if (!response.ok) {
    return {
      content: {
        code: "UPSTREAM_HTTP_ERROR",
        error: `UPSTREAM_HTTP_ERROR: ${url} returned HTTP ${response.status}.`,
        url: url.toString(),
        status: response.status,
        headers: headersObject(response.headers),
      },
      isError: true,
    };
  }
  let read: BoundedReadResult<string>;
  try {
    read = await readBoundedTextBody(response, maxBytes);
  } catch (err) {
    return {
      content: { ...classifyNetworkError(err, url.toString()), url: url.toString() },
      isError: true,
    };
  }
  let promptInjectionScan: PromptInjectionScanResult;
  try {
    promptInjectionScan = await scanUntrustedText(
      promptInjectionCop,
      url.toString(),
      read.body,
      response.headers.get("content-type") ?? undefined,
    );
  } catch (err) {
    return {
      content: {
        code: "IO_ERROR",
        error: err instanceof Error ? err.message : String(err),
        url: url.toString(),
      },
      isError: true,
    };
  }
  return {
    content: {
      url: url.toString(),
      status: response.status,
      ok: response.ok,
      headers: headersObject(response.headers),
      content: read.body,
      bytes_read: read.bytes,
      truncated: read.truncated,
      prompt_injection_scan: promptInjectionScan,
    },
    isError: false,
  };
}
```

### 3.5 fetch_page_text handler — round-1 version

Identical shape to §3.4 except the body is post-processed with
`stripHtml(read.body)` and the cap is interpreted as bytes for
the upstream read; the returned `text` is the stripped, sliced
string. Replaces
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L795-L823).

### 3.6 downloadUrl helper — round-1 version

Replaces the helper at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L138-L235).
Key changes:

```ts
async function downloadUrl(
  url: URL,
  outPath: string,
  options: { maxBytes: number; headers?: Record<string, string>; attempts: DownloadAttempt[]; attemptNumber: number; promptInjectionCop: PromptInjectionCop; },
): Promise<DownloadSuccess | null> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Saivage/0.1 data-agent", ...(options.headers ?? {}) } },
      FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    const cls = classifyNetworkError(err, url.toString());
    options.attempts.push({ url: url.toString(), attempt: options.attemptNumber, error: cls.error });
    return null;
  }
  const responseHeaders = headersObject(response.headers);
  const attempt: DownloadAttempt = {
    url: url.toString(), attempt: options.attemptNumber,
    status: response.status, ok: response.ok, headers: responseHeaders,
  };
  options.attempts.push(attempt);

  if (!response.ok) {
    attempt.error = `UPSTREAM_HTTP_ERROR: HTTP ${response.status}`;
    return null;
  }

  // Honour Content-Length only as a fast-fail; the bounded reader
  // is the authoritative guard.
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > options.maxBytes) {
    attempt.error = `RESPONSE_TOO_LARGE: Content-Length ${contentLength} exceeds max_bytes ${options.maxBytes}`;
    return null;
  }

  let read: BoundedReadResult<Buffer>;
  try {
    read = await readBoundedBinaryBody(response, options.maxBytes);
  } catch (err) {
    const cls = classifyNetworkError(err, url.toString());
    attempt.error = cls.error;
    return null;
  }
  attempt.bytes = read.bytes;
  if (read.truncated) {
    attempt.error = `RESPONSE_TOO_LARGE: body exceeds max_bytes ${options.maxBytes}`;
    return null;
  }

  // ... existing prompt-injection scan + file write, unchanged.
}
```

### 3.7 Error-code table

| Code                  | Origin                                                          |
|---|---|
| `INVALID_ARGUMENT`    | `parseHttpUrl` throws (non-http(s) scheme; malformed URL).      |
| `TIMEOUT`             | `AbortSignal.timeout(FETCH_TIMEOUT_MS)` fires before headers.   |
| `NETWORK_ERROR`       | DNS failure, ECONNRESET, TLS handshake error, stream read error.|
| `UPSTREAM_HTTP_ERROR` | `response.ok === false` (any 4xx/5xx).                          |
| `RESPONSE_TOO_LARGE`  | `Content-Length` exceeds cap, or bounded reader truncated body. |
| `IO_ERROR`            | Local disk write failure inside `download_file` (delegates to G31's classifier where the failure path is filesystem). |

`fetch_url` and `fetch_page_text` return `RESPONSE_TOO_LARGE`
only when the configured cap is exceeded *and* the caller
explicitly opted into strict mode via `args.max_chars`. The
default behaviour for these two tools is the historical
"return what fits, set `truncated: true`" — the cap is a
defence, not an error. `download_file` and
`download_with_fallbacks`, by contrast, **must** fail with
`RESPONSE_TOO_LARGE` because writing a truncated artifact to
disk is silent corruption.

### 3.8 G33 import swap

In [../G33/02-design-r2.md](../G33/02-design-r2.md) (to be
written), the file-private `readBoundedTextBody` from
[../G33/02-design-r1.md §3.5](../G33/02-design-r1.md#L228-L262)
is deleted; the handler imports `readBoundedTextBody` and
`fetchWithTimeout` from
[src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts) and
uses `WEB_SEARCH_TIMEOUT_MS` / `WEB_SEARCH_MAX_BYTES` as the
arguments. The G33 r1 helper definition becomes a single import
line. G33's `web_search` error envelope continues to use the
G33-specific codes (`NO_RESULTS_PARSED` etc.) for its own
parser-failure modes.

### 3.9 Tests added to src/mcp/httpFetch.test.ts

A new test file owns the helper-level tests; same-file
churn in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
is limited to the handler-level integration tests.

- `readBoundedTextBody`: returns full body under cap; returns
  exact-cap prefix when chunk straddles cap; sets
  `truncated: true`; calls `reader.cancel()` exactly once;
  returns empty string on `response.body === null`.
- `readBoundedBinaryBody`: same matrix, asserting `Buffer`
  byte-equality.
- `fetchWithTimeout`: timer fires → `TimeoutError`; caller
  signal abort composes correctly.
- `classifyNetworkError`: `TimeoutError` → `TIMEOUT`;
  `ENOTFOUND` cause → `NETWORK_ERROR` with `errno`; generic
  error → `NETWORK_ERROR` no `errno`.

Handler-level integration tests added to
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)
using a local in-process HTTP server (the existing pattern in
that file):

- `fetch_url` against an upstream that streams 5 MB → returns
  `truncated: true` with `bytes_read ≤ max_chars`; the server's
  request log shows the socket was closed before 5 MB.
- `fetch_url` against an upstream that delays past
  `FETCH_TIMEOUT_MS` → returns `code: "TIMEOUT"`.
- `fetch_url` against `http://127.0.0.1:1` (closed port) →
  returns `code: "NETWORK_ERROR"` with `errno: "ECONNREFUSED"`.
- `fetch_url` with malformed URL → returns
  `code: "INVALID_ARGUMENT"`.
- `fetch_url` against an upstream that returns 500 → returns
  `code: "UPSTREAM_HTTP_ERROR"` and `status: 500`.
- `download_file` against an upstream that streams 5 MB with
  `max_bytes: 1_000_000` → returns
  `code: "RESPONSE_TOO_LARGE"`; no partial file is written.
- `download_file` against an upstream that lies about
  `Content-Length` (declares 100, sends 1 GB chunked) → returns
  `code: "RESPONSE_TOO_LARGE"`; no partial file is written.

## 4. Sequencing

- **Hard prereq**: G31 lands (provides the exported-classifier
  precedent and frees the `classifyFsError` helper that
  `download_file` calls in the local-disk error branch).
- **Soft prereq**: G30 lands (no functional dependency; only
  same-file diff hygiene). G34 can be authored against either
  the pre- or post-G30 file; the rebase is mechanical.
- **G33 dependency**: G33 r1 ships its file-private
  `readBoundedTextBody`; G33 r2 swaps to the shared import
  from G34. Order: G31 → G34 → G33 r2 cherry-picks the import.
- **G32, G35**: spatially disjoint same-file edits; standard
  rebase. G34 does not touch `search_files` or
  `download_with_fallbacks` retry logic beyond passing the new
  helper through.

Daemon redeploys after G34 lands:
`saivage` (10.0.3.111), `diedrico` (10.0.3.113),
`saivage-v3` (10.0.3.112). `saivage-v3-getrich-v2` (10.0.3.170)
is unaffected.

## 5. Risk

- **R1 — `maxFetchChars` semantics shift.** Reinterpreting
  the cap as bytes is a behaviour change for upstream pages
  that contain large amounts of multi-byte UTF-8 (e.g.
  CJK-heavy). Mitigation: the byte cap is identical to the
  character cap for ASCII (the dominant case); the
  documentation update in
  [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
  calls this out; reviewer can override at round 2 by
  requesting code-unit slicing post-read.
- **R2 — Default `fetchTimeoutMs` of 60 s.** Some legitimate
  upstreams (slow APT mirrors, sluggish CSV indexes used by
  `download_with_fallbacks`) may legitimately exceed 60 s.
  Mitigation: operators can raise via config; per-call
  override is a follow-up if it proves needed.
- **R3 — Hostile upstream that holds the socket open without
  sending body bytes.** `AbortSignal.timeout` fires on the
  overall fetch including header-read, so the helper is safe;
  but the body-read loop has no per-chunk timeout. Mitigation:
  the same `AbortSignal.timeout` already bounds the full
  exchange because `fetch` only resolves when headers arrive,
  and `reader.read()` is bounded by the same signal under
  undici. Document this and add a regression test in r2 if
  reviewer asks.
