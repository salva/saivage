# G34 — Design r3

**Finding**: [../G34-builtins-fetch-url-no-streaming-cap.md](../G34-builtins-fetch-url-no-streaming-cap.md)

**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)

**Round 2 review**: [04-review-r2.md](04-review-r2.md)

**Writer**: Claude Opus 4.7 (round 3)

## 1. Recommendation (direction unchanged, helper hardened)

The round-2 architecture is kept verbatim: G34 owns the
shared HTTP helper module
[src/mcp/httpFetch.ts](../../../../src/mcp/httpFetch.ts);
G33 depends on it; `downloadUrl` returns a discriminated
`DownloadOutcome`; the config and tool-arg byte caps are
deliberately breaking renames. Round 3 closes the three
defects in the helper itself per
[01-analysis-r3.md §2](01-analysis-r3.md#L33-L137):

- Explicit `dispose()` on `TimedFetch`; every caller uses
  `try/finally` so the timer is cleared on success, error,
  abort, and post-body paths.
- Bounded reader checks `signal?.aborted` before treating
  `done: true` as EOF; a timeout-driven cancel throws and
  reaches `classifyNetworkError(..., { timedOut: true })`.
- Stream-mode `TextDecoder` for the captured-bytes →
  string conversion; truncated path never flushes, so partial
  UTF-8 sequences at the cap boundary are silently dropped
  instead of replaced with U+FFFD.

All other round-2 sections (`discardBody`, config rename,
download outcome, error-code table, sequencing, risks) carry
forward unchanged unless explicitly delta'd below.

## 2. Helper module — src/mcp/httpFetch.ts (revised)

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
 * Result of fetchWithTimeout. Callers MUST invoke `dispose()` in a
 * finally block to clear the underlying setTimeout — including the
 * success path. `timedOut()` reports whether the timer fired before
 * the caller disposed; it is the structural input to
 * classifyNetworkError when a read throws.
 */
export interface TimedFetch {
  response: Response;
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

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
  const dispose = (): void => {
    clearTimeout(timer);
  };
  const composed = init.signal
    ? AbortSignal.any([controller.signal, init.signal])
    : controller.signal;
  try {
    const response = await fetch(url, { ...init, signal: composed });
    return {
      response,
      signal: controller.signal,
      timedOut: () => timedOut,
      dispose,
    };
  } catch (err) {
    dispose();
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

/**
 * Read up to `maxBytes` from the response body, decoding as UTF-8.
 * Stream-mode decoding is used so that, on the truncated path, any
 * partial UTF-8 sequence at the cap boundary stays buffered inside
 * the decoder and is silently dropped (no U+FFFD inserted). On the
 * non-truncated path the decoder is flushed normally.
 *
 * If `signal` aborts mid-body, this function throws the abort reason
 * (it does NOT return a partial-success envelope). The caller is
 * expected to classify with `classifyNetworkError(err, url, {
 * timedOut: timed.timedOut() })`.
 */
export async function readBoundedTextBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<BoundedReadResult<string>> {
  if (!response.body) {
    return { body: "", bytes: 0, truncated: false };
  }
  const reader = response.body.getReader();
  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      // A post-abort wake-up may resolve with done:true; treat the
      // aborted signal as an exception, not as EOF.
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("aborted", "AbortError");
      }
      if (done) break;
      if (!value) continue;
      if (total + value.byteLength > maxBytes) {
        const room = Math.max(0, maxBytes - total);
        if (room > 0) {
          out += decoder.decode(value.subarray(0, room), { stream: true });
          total += room;
        }
        truncated = true;
        try { await reader.cancel(); } catch { /* already closed */ }
        break;
      }
      out += decoder.decode(value, { stream: true });
      total += value.byteLength;
    }
    // Only flush the decoder on the non-truncated path. Flushing on
    // the truncated path would convert the buffered partial UTF-8
    // sequence into U+FFFD, which is the bug closed by round 3.
    if (!truncated) {
      out += decoder.decode();
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  return { body: out, bytes: total, truncated };
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
  const onAbort = (): void => {
    reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("aborted", "AbortError");
      }
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

### 2.1 Why these three changes, specifically

- **`dispose()` is exposed, not hidden behind the body
  stream.** The round-2 attempt to hang cleanup off
  `response.body["finally"]` was unsound (the WHATWG
  `ReadableStream` has no `.finally`) and incomplete (early
  exits never went through the body stream at all). The
  explicit `dispose()` puts cleanup at the same scope as the
  fetch itself; every consumer wraps `fetchWithTimeout` in
  `try/finally`. `clearTimeout` is idempotent so calling
  `dispose()` more than once is harmless.

- **`signal.aborted` is checked before `done`.** Under both
  WHATWG and undici semantics, `reader.cancel()` resolves the
  next pending `reader.read()` with `{ done: true }`. The
  abort listener cancels the reader, so the loop's
  next iteration sees `done: true`. Without the
  `signal.aborted` check the helper would return the prefix as
  if it were a clean EOF. With the check, the helper throws,
  the caller catches, and
  `classifyNetworkError(..., { timedOut: timedOut() })` maps
  to `TIMEOUT`. This works for any abort cause, not only
  timeouts: a future caller-supplied cancellation will also
  surface as the abort reason rather than silent truncation.

- **Stream-mode `TextDecoder` with conditional flush.** WHATWG
  Encoding §10.1 specifies that `decode()` called with
  `stream: false` (the default) emits one U+FFFD per
  incomplete trailing sequence. By passing `stream: true` for
  every chunk and only calling `decode()` (flush) on the
  non-truncated branch, partial UTF-8 sequences at the cap
  boundary stay buffered inside the decoder and are dropped
  when the decoder goes out of scope. On the non-truncated
  branch the final flush is a no-op for well-formed input or
  correctly surfaces U+FFFD for genuinely malformed upstream
  input (which is the upstream's bug, not ours). The decoder
  is also no longer a delegate over `readBoundedBinaryBody`:
  text and binary readers are siblings with the same shape so
  the text path can stream-decode chunk-by-chunk and never
  materialises the full byte buffer in memory at decode time.

## 3. Config schema changes

Unchanged from round 2:
[02-design-r2.md §3](02-design-r2.md#L222-L264). `maxFetchChars`
becomes `maxFetchBytes` (default 200 000); `fetchTimeoutMs`
is new (default 60 000). No migration shim.

## 4. Wiring inside builtins.ts

The structural plan from round 2 stands; every handler that
takes a `TimedFetch` must be wrapped in `try/finally` so
`timed.dispose()` runs on every exit. Sections 4.1, 4.2, 4.5,
4.8 of [02-design-r2.md](02-design-r2.md) carry forward
unchanged. Sections 4.3, 4.4, 4.6, 4.7 are revised below.

### 4.3 downloadUrl — `dispose()` wired into every exit

Replaces
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L162-L237):

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
  try {
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
          code: "NETWORK_ERROR",
          error: err instanceof Error ? err.message : String(err),
        };
        attempt.code = failure.code;
        attempt.error = failure.error;
        return { ok: false, failure, attempt };
      }
    }

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
  } finally {
    timed.dispose();
  }
}
```

The outer `try/finally` around `timed` guarantees `dispose()`
runs on every exit: success, every early-fail branch, the
read-throws branch, the prompt-injection-throws branch, and
the local IO-error branch. The inner `try/catch` blocks are
unchanged from round 2 except for being nested inside the
`finally`.

### 4.4 fetch_url handler — `dispose()` wired in

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
  try {
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
  } finally {
    timed.dispose();
  }
}
```

The body-read catch is the **only** path that surfaces
`TIMEOUT` for a mid-body stall, and it now relies on the
helper throwing (per
[01-analysis-r3.md §2.2](01-analysis-r3.md#L62-L96)) rather
than detecting a partial result. The `dataTools` `inputSchema`
entry for `fetch_url` (search for the tool registration block
in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts))
must rename `max_chars` → `max_bytes`. This was the loose end
flagged in [04-review-r2.md](04-review-r2.md#L33); the exact
edit is enumerated in
[03-plan-r3.md §1 — Step 7](03-plan-r3.md#L1).

### 4.5 fetch_page_text handler — same try/finally pattern

Identical shape to §4.4 with `stripHtml(read.body)` and
returned key `text`. The byte cap continues to bound the raw
HTML stream, per
[02-design-r2.md §4.5](02-design-r2.md#L488-L506). The
handler must wrap the entire post-fetch logic in
`try { ... } finally { timed.dispose(); }`. The
`dataTools` schema entry for `fetch_page_text` similarly
renames `max_chars` → `max_bytes`.

### 4.6 download_file — unchanged handler shape

The handler at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L825-L843)
already calls `downloadUrl` and never sees a `TimedFetch`
directly; the `dispose()` lives inside `downloadUrl` (§4.3),
so this case body is the round-2 form unchanged
([02-design-r2.md §4.6](02-design-r2.md#L510-L546)).

### 4.7 download_with_fallbacks — unchanged handler shape

Same rationale as §4.6: the only `fetchWithTimeout` caller is
`downloadUrl`, which owns `dispose()`. The round-2 form
applies verbatim
([02-design-r2.md §4.7](02-design-r2.md#L550-L613)).

### 4.8 head_url — unchanged

Out of scope, as in
[02-design-r2.md §4.8](02-design-r2.md#L617-L624).

## 5. Error-code table

Unchanged from round 2:
[02-design-r2.md §5](02-design-r2.md#L628-L645).

## 6. G33 coordination

Unchanged from round 2:
[02-design-r2.md §6](02-design-r2.md#L649-L663). G33 r2 must
swap its file-private `readBoundedTextBody` for the
`httpFetch.ts` import after G34 lands.

## 7. Tests added (revised)

The helper-level matrix from
[02-design-r2.md §7](02-design-r2.md#L667-L730) carries
forward, augmented by the five round-3 gates from
[01-analysis-r3.md §5](01-analysis-r3.md#L150-L176):

Helper-level tests in
[src/mcp/httpFetch.test.ts](../../../../src/mcp/httpFetch.test.ts):

- All round-2 helper tests (unchanged).
- **`fetchWithTimeout` timer cleanup — success**:
  `vi.useFakeTimers({ shouldAdvanceTime: true })`; fetch a
  1 KB upstream; assert `vi.getTimerCount() === 0` after the
  caller invokes `dispose()` in `finally`.
- **`fetchWithTimeout` timer cleanup — pre-headers error**:
  `fetch http://127.0.0.1:1` (ECONNREFUSED) throws; assert
  `vi.getTimerCount() === 0` after the catch.
- **`fetchWithTimeout` timer cleanup — mid-body error**:
  upstream sends headers then RST-closes; `readBoundedTextBody`
  throws; assert `vi.getTimerCount() === 0` after caller's
  `dispose()` finally.
- **Mid-body abort throws TIMEOUT**: upstream stalls past
  `fetchTimeoutMs`; `readBoundedTextBody` throws an
  `AbortError`/`TimeoutError`; `classifyNetworkError(err, url,
  { timedOut: true })` returns `{ code: "TIMEOUT", ... }`.
  Critically, the helper does **not** return a partial-success
  envelope (`{ body: "...", truncated: ... }`).
- **UTF-8 multi-byte rune straddles cap**: a stream of 1 000
  bytes that is `Buffer.from("日".repeat(334))` (3 × 334 =
  1 002 bytes, last rune split at the cap) with `maxBytes:
  1 000`; assert `truncated: true`, `bytes_read ≤ 1 000`,
  returned string contains zero `\uFFFD`, returned string
  length is exactly `Math.floor(1 000 / 3) = 333`.
- **UTF-8 untruncated well-formed input**: same content with
  `maxBytes: 2 000` (fits entirely); assert
  `truncated: false`, returned string contains zero `\uFFFD`,
  returned string length is 334.

Handler-integration tests in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts):

- All round-2 handler tests (unchanged).
- **`fetch_url` mid-body timeout — public envelope**: same
  stalling-upstream pattern as the round-2 mid-body test; the
  round-2 test only checked `timedOut() === true` inside the
  helper. Round 3 also asserts the **handler result**:
  `result.isError === true`, `result.content.code ===
  "TIMEOUT"`, `result.content.content === undefined`. This
  guards the silent-partial-success regression at the public
  surface.

## 8. Sequencing

Unchanged from round 2:
[02-design-r2.md §8](02-design-r2.md#L732-L744).

## 9. Risk

Round-2 risks R1–R3 carry forward
([02-design-r2.md §9](02-design-r2.md#L746-L774)). R4 is
superseded:

- **R4 (revised) — Abort race between `fetch()` resolving and
  the timer firing.** If the timer fires between header
  receipt and the first `reader.read()`, the reader's
  `abort` listener cancels and the loop's
  `signal?.aborted` check throws — `timedOut()` is already
  `true`, the classifier maps to `TIMEOUT`. If the timer
  fires after `fetch()` resolves but before `dispose()` runs,
  the controller is aborted on a response whose body the
  caller has not yet started reading; the bounded reader's
  abort listener (registered before the first `read()`)
  still catches it and throws on the first `signal.aborted`
  check. Both edges are pinned by the helper tests in §7.
- **R5 (new) — `vi.getTimerCount()` and fake timers in the
  helper tests.** The tests use `vi.useFakeTimers({
  shouldAdvanceTime: true })` so the real `fetch` against the
  in-process `http.createServer` still works. Confirm before
  merging that the project's vitest config does not globally
  pin `fakeTimers.toFake` away from `setTimeout`/
  `clearTimeout` (it does not as of
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts)).
