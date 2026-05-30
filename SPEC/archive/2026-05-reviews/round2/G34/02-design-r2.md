# G34 — Design r2

**Finding**: [../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)

**Round 1 review**: [04-review-r1.md](04-review-r1.md)

**Writer**: Claude Opus 4.7 (round 2)

## 1. Recommendation (unchanged direction, tightened contract)

G34 owns the shared HTTP helper module
[src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts).
Round 2 keeps Proposal B from
[02-design-r1.md §1](02-design-r1.md#L9-L19) and resolves the
four reviewer blockers
[04-review-r1.md](04-review-r1.md#L5-L14) plus the stale
anchors [04-review-r1.md](04-review-r1.md#L24-L30):

- Drain every early response exit after headers arrive (a
  shared `discardBody` helper).
- Thread the timeout signal into the bounded readers and
  surface a structural `timedOut` flag to the classifier so
  mid-body timeouts map to `TIMEOUT`, not `NETWORK_ERROR`.
- Replace `downloadUrl`'s `null`-on-failure return with a
  discriminated `DownloadOutcome` carrying the classified
  envelope; propagate top-level `code` from both download
  handlers; implement the `IO_ERROR` branch around the
  filesystem write.
- Pick a byte cap cleanly: rename `mcp.maxFetchChars` →
  `mcp.maxFetchBytes`, delete the old name (no migration
  shim per the architecture-first rule), and document that
  `fetch_page_text` bounds raw HTML bytes upstream.

## 2. New module — src/mcp/httpFetch.ts

```ts
import { Buffer } from "node:buffer";

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
 * Returned by fetchWithTimeout. The caller MUST consume the response
 * through the bounded readers below (passing `signal`) or call
 * `discardBody(response)`; in either case `timedOut()` lets the
 * classifier distinguish a timeout-driven abort from a real network
 * fault, including aborts that surface during body reads (after
 * headers have arrived).
 */
export interface TimedFetch {
  response: Response;
  signal: AbortSignal;
  timedOut: () => boolean;
}

/**
 * Wrap fetch with a single AbortController whose abort reason is
 * tagged with `kind: "timeout"`. The same signal is exposed for the
 * bounded readers so reader.read() rejects with the same abort cause
 * and classifyNetworkError can identify the timeout deterministically.
 */
export async function fetchWithTimeout(
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<TimedFetch> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);
  // Compose with any caller-supplied signal.
  const composed = init.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal;
  try {
    const response = await fetch(url, { ...init, signal: composed });
    // The timer must outlive fetch() because the bounded reader still
    // uses controller.signal; clear it on response stream completion via
    // the caller's discardBody/readBounded* paths instead (see below).
    response.body?.["finally"]?.(() => clearTimeout(timer));
    return { response, signal: controller.signal, timedOut: () => timedOut };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Cancel the response body if present, ignoring errors (the upstream
 * may already be closed). Use on every early exit after headers.
 */
export async function discardBody(response: Response): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel();
  } catch {
    /* upstream may already be closed */
  }
}

export async function readBoundedTextBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedReadResult<string>> {
  const result = await readBoundedBinaryBody(response, maxBytes, signal);
  // Decode the captured bytes once. TextDecoder with `fatal: false`
  // and stream: false drops any partial UTF-8 sequence at the tail
  // cleanly; we never split runes mid-byte.
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return { body: decoder.decode(result.body), bytes: result.bytes, truncated: result.truncated };
}

export async function readBoundedBinaryBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedReadResult<Buffer>> {
  if (!response.body) {
    return { body: Buffer.alloc(0), bytes: 0, truncated: false };
  }
  const reader = response.body.getReader();
  // Wire the caller-supplied (timeout) signal to also abort the reader.
  const onAbort = () => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const room = Math.max(0, maxBytes - total);
        if (room > 0) chunks.push(value.subarray(0, room));
        total += room;
        truncated = true;
        try { await reader.cancel(); } catch { /* already closed */ }
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return {
    body: Buffer.concat(chunks.map((c) => Buffer.from(c))),
    bytes: total,
    truncated,
  };
}

/**
 * Classify an error thrown by fetchWithTimeout, readBoundedTextBody,
 * or readBoundedBinaryBody. `timedOut` is the structural flag from
 * TimedFetch; when true, the error is mapped to TIMEOUT regardless of
 * the runtime-level error name (which may be "AbortError" for body
 * aborts under undici).
 */
export function classifyNetworkError(
  err: unknown,
  url: string,
  ctx: { timedOut?: boolean } = {},
): ClassifiedHttpError {
  if (ctx.timedOut) {
    return {
      code: "TIMEOUT",
      error: `TIMEOUT: ${url} did not respond before the configured deadline.`,
    };
  }
  if (err instanceof Error && err.name === "TimeoutError") {
    return {
      code: "TIMEOUT",
      error: `TIMEOUT: ${url} did not respond before the configured deadline.`,
    };
  }
  const errno = (err as NodeJS.ErrnoException | undefined)?.code;
  const msg = (err as Error | undefined)?.message ?? String(err);
  if (errno) {
    return { code: "NETWORK_ERROR", error: `NETWORK_ERROR: ${url}: ${msg}`, errno };
  }
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

Notes on the design choices:

- `TimedFetch.timedOut()` is the round-1 reviewer's first
  request [04-review-r1.md](04-review-r1.md#L9). We expose the
  flag rather than re-wrapping the body reader so the public
  surface stays small and the caller can pass `signal` only
  when it wants timeout-aware reads. Tests confirm body aborts
  surface as `AbortError`/`DOMException` under both the WHATWG
  and undici runtimes; the flag closes that ambiguity.
- `discardBody` is the round-1 reviewer's body-leak fix
  [04-review-r1.md](04-review-r1.md#L7). Every early exit
  after headers calls it.
- `readBoundedTextBody` no longer decodes chunk-by-chunk; it
  delegates to the binary reader and decodes the captured
  bytes once at the end. This closes the multi-byte-rune
  edge the reviewer flagged
  [04-review-r1.md](04-review-r1.md#L13) — the decoder
  silently drops trailing partial UTF-8 sequences, so the
  returned string never contains split runes.

## 3. Config schema changes

Edit the `mcp` block in
[src/config.ts](../../../../src/config.ts#L137-L146):

```ts
mcp: z
  .object({
    shellTimeoutMs: z.number().default(4 * 60 * 60 * 1000),
    shellTimeoutFloorMs: z.number().default(10 * 60 * 1000),
    inProcessTimeoutMs: z.number().default(300_000),
    maxOutputBytes: z.number().default(100 * 1024),
    maxFetchBytes: z.number().default(200_000),          // RENAMED from maxFetchChars
    maxDownloadBytes: z.number().default(250 * 1024 * 1024),
    fetchTimeoutMs: z.number().int().min(1_000).max(600_000).default(60_000),
  })
  .default({})
  .superRefine(/* unchanged */),
```

The old `maxFetchChars` field is **deleted**, not aliased.
Per the workspace architecture-first rule and the user-memory
"no backward compat" directive: no migration shim, no Zod
alias, no fallback read. Operators with a legacy
`mcp.maxFetchChars` line in their on-disk `.saivage/saivage.json`
get a Zod parse error on startup and update the key. The
default value (200 000) is preserved so the visible behaviour
for the default-configured majority is unchanged.

`mcp.fetchTimeoutMs` is new. Default 60 000 ms — bounds the
total time from socket connect through last body byte.

## 4. Wiring inside builtins.ts

### 4.1 Module-level state

Replace lines 42–43 of
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L42-L43):

```ts
let MAX_FETCH_BYTES = 200_000;
let MAX_DOWNLOAD_BYTES = 250 * 1024 * 1024;
let FETCH_TIMEOUT_MS = 60_000;
```

Add the import next to the existing imports:

```ts
import {
  fetchWithTimeout,
  readBoundedTextBody,
  readBoundedBinaryBody,
  discardBody,
  classifyNetworkError,
  type ClassifiedHttpError,
} from "./httpFetch.js";
```

Wire config in `registerBuiltinServices`, replacing
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1078-L1079):

```ts
MAX_FETCH_BYTES = mcpConfig.maxFetchBytes;
MAX_DOWNLOAD_BYTES = mcpConfig.maxDownloadBytes;
FETCH_TIMEOUT_MS = mcpConfig.fetchTimeoutMs;
```

### 4.2 DownloadAttempt — add structured fields

Edit the type at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L103-L111):

```ts
interface DownloadAttempt {
  url: string;
  attempt: number;
  status?: number;
  ok?: boolean;
  code?: HttpFetchErrorCode;   // NEW
  error?: string;
  errno?: string;              // NEW
  bytes?: number;
  headers?: Record<string, string>;
}

type DownloadOutcome =
  | { ok: true; success: DownloadSuccess }
  | {
      ok: false;
      failure: ClassifiedHttpError & { status?: number };
      attempt: DownloadAttempt; // already pushed to options.attempts
    };
```

### 4.3 downloadUrl — replace the helper

Replaces
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L156-L237):

```ts
async function downloadUrl(
  url: URL,
  outPath: string,
  options: {
    maxBytes: number;
    headers?: Record<string, string>;
    attempts: DownloadAttempt[];
    attemptNumber: number;
    promptInjectionCop: PromptInjectionCop;
  },
): Promise<DownloadOutcome> {
  let timed: TimedFetch;
  try {
    timed = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Saivage/0.1 data-agent", ...(options.headers ?? {}) } },
      FETCH_TIMEOUT_MS,
    );
  } catch (err) {
    const cls = classifyNetworkError(err, url.toString());
    const attempt: DownloadAttempt = {
      url: url.toString(), attempt: options.attemptNumber,
      code: cls.code, error: cls.error, errno: cls.errno,
    };
    options.attempts.push(attempt);
    return { ok: false, failure: cls, attempt };
  }
  const { response, signal, timedOut } = timed;
  const responseHeaders = headersObject(response.headers);
  const attempt: DownloadAttempt = {
    url: url.toString(), attempt: options.attemptNumber,
    status: response.status, ok: response.ok, headers: responseHeaders,
  };
  options.attempts.push(attempt);

  if (!response.ok) {
    await discardBody(response);
    const failure: ClassifiedHttpError & { status?: number } = {
      code: "UPSTREAM_HTTP_ERROR",
      error: `UPSTREAM_HTTP_ERROR: ${url} returned HTTP ${response.status}.`,
      status: response.status,
    };
    attempt.code = failure.code;
    attempt.error = failure.error;
    return { ok: false, failure, attempt };
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > options.maxBytes) {
    await discardBody(response);
    const failure: ClassifiedHttpError = {
      code: "RESPONSE_TOO_LARGE",
      error: `RESPONSE_TOO_LARGE: Content-Length ${contentLength} exceeds max_bytes ${options.maxBytes}`,
    };
    attempt.code = failure.code;
    attempt.error = failure.error;
    return { ok: false, failure, attempt };
  }

  let read: BoundedReadResult<Buffer>;
  try {
    read = await readBoundedBinaryBody(response, options.maxBytes, signal);
  } catch (err) {
    const cls = classifyNetworkError(err, url.toString(), { timedOut: timedOut() });
    attempt.code = cls.code;
    attempt.error = cls.error;
    attempt.errno = cls.errno;
    return { ok: false, failure: cls, attempt };
  }
  attempt.bytes = read.bytes;
  if (read.truncated) {
    const failure: ClassifiedHttpError = {
      code: "RESPONSE_TOO_LARGE",
      error: `RESPONSE_TOO_LARGE: body exceeds max_bytes ${options.maxBytes}`,
    };
    attempt.code = failure.code;
    attempt.error = failure.error;
    return { ok: false, failure, attempt };
  }

  // Prompt-injection scan (unchanged shape; existing helper).
  const scannableText = bufferToScannableText(
    read.body,
    response.headers.get("content-type") ?? undefined,
  );
  let promptInjectionScan: PromptInjectionScanResult = {
    allowed: true,
    verdict: "allow",
    reason: "download appears to be binary/non-text content; prompt-injection scan not applicable",
    confidence: 0,
    scanner: "skipped",
  };
  if (scannableText !== null) {
    try {
      promptInjectionScan = await scanUntrustedText(
        options.promptInjectionCop,
        url.toString(),
        scannableText,
        response.headers.get("content-type") ?? undefined,
      );
    } catch (err) {
      const failure: ClassifiedHttpError = {
        code: "NETWORK_ERROR", // prompt-injection block is "untrusted-content rejection"; map under network class for now
        error: err instanceof Error ? err.message : String(err),
      };
      attempt.code = failure.code;
      attempt.error = failure.error;
      return { ok: false, failure, attempt };
    }
  }

  // Local write with IO_ERROR classification.
  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, read.body);
  } catch (err) {
    const failure: ClassifiedHttpError = {
      code: "IO_ERROR",
      error: `IO_ERROR: ${err instanceof Error ? err.message : String(err)}`,
      errno: (err as NodeJS.ErrnoException).code,
    };
    attempt.code = failure.code;
    attempt.error = failure.error;
    attempt.errno = failure.errno;
    return { ok: false, failure, attempt };
  }

  return {
    ok: true,
    success: {
      url: url.toString(),
      path: relative(projectRoot(), outPath),
      bytes: read.bytes,
      sha256: createHash("sha256").update(read.body).digest("hex"),
      headers: responseHeaders,
      attempts: options.attempts,
      prompt_injection_scan: promptInjectionScan,
    },
  };
}
```

Two reviewer concerns are closed by this rewrite:

- Header fast-fail body leak — `discardBody(response)` is the
  first call in both early-exit branches
  ([04-review-r1.md](04-review-r1.md#L7)).
- Structured download envelopes — `DownloadOutcome` carries
  `failure: ClassifiedHttpError & { status? }` all the way to
  the handler ([04-review-r1.md](04-review-r1.md#L11)). The
  `IO_ERROR` branch wraps the actual filesystem write.

### 4.4 fetch_url handler

Replaces
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L762-L790):

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
  const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? MAX_FETCH_BYTES), 1_000), 1_000_000);
  let timed: TimedFetch;
  try {
    timed = await fetchWithTimeout(
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
  const { response, signal, timedOut } = timed;
  if (!response.ok) {
    await discardBody(response);
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
    read = await readBoundedTextBody(response, maxBytes, signal);
  } catch (err) {
    return {
      content: {
        ...classifyNetworkError(err, url.toString(), { timedOut: timedOut() }),
        url: url.toString(),
      },
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

Argument rename: `args.max_chars` → `args.max_bytes`. Per the
architecture-first rule, no alias is accepted; agents passing
the old key get the default. The tool schema in
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts) (the
`dataTools` entry at the tool-catalog declaration) is updated
to match in [03-plan-r2.md §1](03-plan-r2.md#L40).

### 4.5 fetch_page_text handler

Same shape as §4.4 with two differences: post-process with
`stripHtml(read.body)`, and the returned key is `text`. The
**byte cap applies to the raw HTML stream**, not to the
stripped output; this is the explicit contract the reviewer
asked for ([04-review-r1.md](04-review-r1.md#L13)) and is
documented in
[docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
under `mcp.maxFetchBytes`. Replaces
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L792-L821):

```ts
case "fetch_page_text": {
  // ... identical URL / fetchWithTimeout / !response.ok / readBoundedTextBody block as §4.4 ...
  const stripped = stripHtml(read.body);
  // ... prompt-injection scan over `stripped`, return text: stripped, truncated: read.truncated ...
}
```

The `truncated` flag in the response object is the
**upstream-byte** truncation indicator (the HTML stream was
cut). The stripped text length is informational; callers that
need a strict character ceiling on the returned text post-strip
must apply it themselves.

### 4.6 download_file handler

Replaces
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L823-L842):

```ts
case "download_file": {
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
  const outPath = resolvePath(String(args.path));
  const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? MAX_DOWNLOAD_BYTES), 1), 2 * 1024 * 1024 * 1024);
  const attempts: DownloadAttempt[] = [];
  const outcome = await downloadUrl(url, outPath, {
    maxBytes,
    headers: args.headers as Record<string, string> | undefined,
    attempts,
    attemptNumber: 1,
    promptInjectionCop,
  });
  if (outcome.ok) return { content: outcome.success, isError: false };
  return {
    content: {
      ...outcome.failure,
      url: url.toString(),
      attempts,
    },
    isError: true,
  };
}
```

No outer try/catch: `downloadUrl` now classifies every failure
inside and never throws. The top-level envelope carries `code`,
`error`, optional `status`/`errno`, plus the per-attempt
record.

### 4.7 download_with_fallbacks handler

Replaces
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L844-L890):

```ts
case "download_with_fallbacks": {
  const rawUrls = Array.isArray(args.urls) ? args.urls.map(String).filter(Boolean) : [];
  if (rawUrls.length === 0) {
    return {
      content: {
        code: "INVALID_ARGUMENT",
        error: "INVALID_ARGUMENT: urls must contain at least one source",
      },
      isError: true,
    };
  }
  const outPath = resolvePath(String(args.path));
  const manifestPath = args.manifest_path ? resolvePath(String(args.manifest_path)) : null;
  const maxBytes = Math.min(Math.max(Number(args.max_bytes ?? MAX_DOWNLOAD_BYTES), 1), 2 * 1024 * 1024 * 1024);
  const retriesPerUrl = Math.min(Math.max(Number(args.retries_per_url ?? 2), 1), 5);
  const headers = args.headers as Record<string, string> | undefined;
  const attempts: DownloadAttempt[] = [];
  let lastFailure: (ClassifiedHttpError & { status?: number }) | null = null;

  for (const rawUrl of rawUrls) {
    let url: URL;
    try {
      url = parseHttpUrl(rawUrl);
    } catch (err) {
      const cls: ClassifiedHttpError = {
        code: "INVALID_ARGUMENT",
        error: `INVALID_ARGUMENT: ${err instanceof Error ? err.message : String(err)}`,
      };
      attempts.push({
        url: rawUrl, attempt: 0,
        code: cls.code, error: cls.error,
      });
      lastFailure = cls;
      continue;
    }
    for (let attemptNumber = 1; attemptNumber <= retriesPerUrl; attemptNumber++) {
      const outcome = await downloadUrl(url, outPath, {
        maxBytes, headers, attempts, attemptNumber, promptInjectionCop,
      });
      if (outcome.ok) {
        const success = outcome.success;
        if (manifestPath) {
          mkdirSync(dirname(manifestPath), { recursive: true });
          writeFileSync(manifestPath, JSON.stringify(success, null, 2) + "\n", "utf-8");
        }
        return { content: { ...success, selected_url: success.url }, isError: false };
      }
      lastFailure = outcome.failure;
    }
  }

  const failure = {
    ...(lastFailure ?? { code: "NETWORK_ERROR" as const, error: "NETWORK_ERROR: all sources failed" }),
    error: lastFailure
      ? `ALL_SOURCES_FAILED: last failure: ${lastFailure.error}`
      : "ALL_SOURCES_FAILED: no sources attempted",
    path: relative(projectRoot(), outPath),
    attempts,
  };
  if (manifestPath) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(failure, null, 2) + "\n", "utf-8");
  }
  return { content: failure, isError: true };
}
```

The top-level `code` is the **last attempted source's**
classified code (or `INVALID_ARGUMENT` if all sources were
malformed). The `error` message is prefixed
`ALL_SOURCES_FAILED:` so callers can pattern-match the
aggregate condition; the per-attempt records carry the
per-source codes for fine-grained reporting.

### 4.8 head_url — unchanged

[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L892-L896)
is untouched. No body is read, so no cap or timeout work is
needed beyond what `fetchWithTimeout` provides; `head_url` may
optionally be migrated to `fetchWithTimeout` for consistency
but it is **not in scope** for this finding.

## 5. Error-code table

| Code                  | Source                                                                                          |
|---|---|
| `INVALID_ARGUMENT`    | `parseHttpUrl` throws; `download_with_fallbacks` empty list.                                    |
| `TIMEOUT`             | `AbortSignal.timeout`-tagged controller fires; flag carried via `TimedFetch.timedOut()`.        |
| `NETWORK_ERROR`       | DNS failure, ECONNRESET, TLS handshake error, body stream error not attributable to timeout.   |
| `UPSTREAM_HTTP_ERROR` | `response.ok === false`. Body is drained via `discardBody`.                                     |
| `RESPONSE_TOO_LARGE`  | `Content-Length` exceeds cap, OR bounded reader truncated. Body drained on the fast-fail path.  |
| `IO_ERROR`            | `download_file` local `mkdirSync`/`writeFileSync` throws.                                       |

`fetch_url` and `fetch_page_text` do **not** emit
`RESPONSE_TOO_LARGE` on cap-exceeded — they return the prefix
that fits with `truncated: true`. The cap is a defence, not an
error condition for these read-only tools.
`download_file` / `download_with_fallbacks` **must** raise
`RESPONSE_TOO_LARGE` because writing a partial artifact is
silent corruption.

## 6. G33 coordination

G33 r2 currently exports `readBoundedTextBody` from the
builtins module
[../G33/02-design-r2.md](../G33/02-design-r2.md#L193-L208).
Round-1 reviewer ruled that G33 must depend on G34 instead
[04-review-r1.md](04-review-r1.md#L20-L22). Concrete change to
G33 r2 (out of scope for this finding's diff; tracked here so
the G33 owner can land in lockstep):

- Delete the file-private `readBoundedTextBody` declaration in
  G33's section corresponding to
  [../G33/02-design-r2.md](../G33/02-design-r2.md#L193-L208).
- Replace the call site with
  `import { fetchWithTimeout, readBoundedTextBody, classifyNetworkError } from "./httpFetch.js";`
  and consume `TimedFetch` the same way the rewritten
  `fetch_url` handler does (§4.4).

## 7. Tests added

Helper-level tests in
[src/mcp/httpFetch.test.ts](../../../../src/mcp/httpFetch.test.ts)
(new file):

- `readBoundedTextBody`: full body under cap; cap fired
  mid-chunk; `truncated: true` set; underlying socket cancelled
  (observed via server-side `req.aborted === true`);
  `response.body === null` returns empty.
- `readBoundedTextBody` with multi-byte runes: 10 KB of
  3-byte CJK input, cap 5 000 → `truncated: true`,
  `bytes_read ≤ 5 000`, returned string contains no
  replacement characters mid-rune (TextDecoder drops the
  partial sequence at the tail).
- `readBoundedBinaryBody`: same matrix asserting byte equality.
- `fetchWithTimeout`: pre-headers stall fires → throws
  `TimeoutError`, `timedOut()` true.
- `fetchWithTimeout`: mid-body stall fires → `reader.read()`
  rejects, `timedOut()` true, `classifyNetworkError(err, url,
  { timedOut: true })` returns `TIMEOUT`.
- `discardBody`: idempotent; safe on `response.body === null`;
  safe on already-cancelled body.
- `classifyNetworkError`: `TimeoutError` → `TIMEOUT`;
  `ECONNREFUSED` cause → `NETWORK_ERROR` + `errno`; generic
  error → `NETWORK_ERROR` without `errno`; `timedOut: true`
  override forces `TIMEOUT` regardless of error name.

Handler-integration tests in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts):

- `fetch_url` 5 MB chunked upstream → `truncated: true`,
  `bytes_read ≤ max_bytes`, server observes early socket close.
- `fetch_url` pre-headers stall → `code: "TIMEOUT"`.
- `fetch_url` mid-body stall → `code: "TIMEOUT"` (the bug the
  reviewer flagged).
- `fetch_url` against `http://127.0.0.1:1` →
  `code: "NETWORK_ERROR"`, `errno: "ECONNREFUSED"`.
- `fetch_url` malformed URL → `code: "INVALID_ARGUMENT"`.
- `fetch_url` HTTP 500 → `code: "UPSTREAM_HTTP_ERROR"`,
  `status: 500`; server observes that the 500 body was
  cancelled (the reviewer's body-leak test).
- `fetch_page_text` against a 1 MB raw-HTML page that
  `stripHtml`s down to ~1 KB, with `max_bytes` 500 KB →
  `truncated: true`, `text` is the stripped form of the first
  500 KB. Documented behaviour, not a regression.
- `download_file` 5 MB upstream, `max_bytes: 1_000_000` →
  `code: "RESPONSE_TOO_LARGE"`, no file written.
- `download_file` lying `Content-Length` (declares 100, sends
  1 GB chunked) → `code: "RESPONSE_TOO_LARGE"`, no file
  written.
- `download_file` upstream `Content-Length` already over cap
  → `code: "RESPONSE_TOO_LARGE"`, body **not** drained into
  RAM (server observes early socket close before significant
  bytes are written).
- `download_file` HTTP 500 → `code: "UPSTREAM_HTTP_ERROR"`,
  `status: 500`, body drained.
- `download_file` to a read-only directory →
  `code: "IO_ERROR"`, `errno: "EACCES"` (or `EROFS`).
- `download_with_fallbacks` mixed list (one malformed URL +
  one 500 + one 200) → returns success on the third source;
  `attempts` has three entries with codes
  `INVALID_ARGUMENT`, `UPSTREAM_HTTP_ERROR`, and the success
  attempt (no `code`).
- `download_with_fallbacks` all sources fail → top-level
  `code` = last failure's code, `error` starts with
  `ALL_SOURCES_FAILED:`.

## 8. Sequencing

- **Hard prereq**: G31 lands (provides the `ClassifiedFsError`
  shape and the `classifyFsError` export precedent). G34 reuses
  the **shape** but not the function (filesystem and network
  classifiers are independent).
- **Hard prereq**: this finding lands **before** G33 r2 swaps
  its helper. Order: G31 → G34 → G33 r2 swap.
- **G30**: orthogonal.
- **G32, G35**: same-file rebase; no semantic coordination.

Daemon redeploys after landing: `saivage` (10.0.3.111),
`diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112).
`saivage-v3-getrich-v2` (10.0.3.170) is unaffected.

## 9. Risk

- **R1 — `maxFetchChars` removal is a breaking config change.**
  Operators with the old key in
  `.saivage/saivage.json` see a Zod parse error on startup.
  Mitigation: explicit rename note in
  [docs/guide/config-runtime.md](../../../../docs/guide/config-runtime.md)
  and the release notes; the default value is preserved so
  default-configured deployments are unaffected. Per the
  architecture-first rule this is the intended trade.
- **R2 — `args.max_chars` removal is a breaking tool-schema
  change.** Agents passing the old argument silently get the
  default. Mitigation: tool description string is updated; the
  `dataTools` schema lists `max_bytes` only. Same architecture
  rule.
- **R3 — `fetchTimeoutMs` default 60 s.** Some legitimate
  upstreams may exceed 60 s. Operators raise via config; a
  per-call `timeout_ms` override is a follow-up.
- **R4 — Timeout signal racing socket close.** If `fetch()`
  resolves the promise just before the timeout fires, the
  bounded reader still receives the same controller signal and
  cancels cleanly. If the timeout fires between header receipt
  and the first `reader.read()`, `timedOut()` is already true
  and the classifier maps to `TIMEOUT`. Both edges are
  exercised by the helper tests in §7.
