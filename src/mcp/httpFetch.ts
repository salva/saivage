/**
 * Saivage — Shared HTTP fetch helpers
 *
 * Wraps `fetch` with a deterministic timeout, bounded body readers
 * (streaming, no full-buffer materialisation for binaries; stream-mode
 * UTF-8 decoding for text so partial multi-byte sequences at the cap
 * are dropped, not replaced with U+FFFD), an early-cancel `discardBody`
 * for header fast-fail paths, and a `classifyNetworkError` that maps
 * thrown errors to a small discriminated error-code set.
 *
 * Every caller MUST invoke `dispose()` on the returned `TimedFetch` in
 * a `finally` block — even on the success path — to clear the
 * underlying `setTimeout` handle.
 */

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
 * Cancel the response body if present, ignoring errors (the upstream may
 * already be closed). Use on every early exit after headers.
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
 * Read up to `maxBytes` from the response body, decoding as UTF-8 with
 * stream-mode decoding so any partial multi-byte sequence at the cap
 * boundary stays buffered inside the decoder and is silently dropped
 * (no U+FFFD). On the non-truncated path the decoder is flushed normally.
 *
 * If `signal` aborts mid-body, this function throws the abort reason —
 * it does NOT return a partial-success envelope. The caller is expected
 * to classify with
 * `classifyNetworkError(err, url, { timedOut: timed.timedOut() })`.
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
        if (room > 0) {
          chunks.push(value.subarray(0, room));
          total += room;
        }
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
