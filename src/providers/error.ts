/**
 * Saivage \u2014 F13: Typed provider errors with boundary classification.
 *
 * Each provider adapter wraps SDK / fetch failures into a `ProviderError`
 * before they bubble up; the router and BaseAgent consume the `kind`
 * discriminant instead of running regex over English error strings.
 */

export type ProviderErrorKind =
  | "context_overflow"
  | "orphaned_tool_result"
  | "throttling"
  | "non_retryable"
  | "transient";

export interface ProviderErrorInit {
  kind: ProviderErrorKind;
  message: string;
  status?: number;
  retryAfterMs?: number;
  providerName?: string;
  cause?: unknown;
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly providerName?: string;

  constructor(init: ProviderErrorInit) {
    super(init.message);
    this.name = "ProviderError";
    this.kind = init.kind;
    if (init.status !== undefined) this.status = init.status;
    if (init.retryAfterMs !== undefined) this.retryAfterMs = init.retryAfterMs;
    if (init.providerName !== undefined) this.providerName = init.providerName;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }
}

/** Parse `retry-after` HTTP header (seconds or HTTP-date). */
export function parseRetryAfter(header: string | undefined | null): number | undefined {
  if (!header) return undefined;
  const trimmed = String(header).trim();
  if (!trimmed) return undefined;
  // Seconds form
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const secs = parseFloat(trimmed);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  }
  // HTTP-date form
  const ts = Date.parse(trimmed);
  if (Number.isFinite(ts)) {
    const diff = ts - Date.now();
    if (diff > 0) return diff;
  }
  return undefined;
}

interface ErrLike {
  message?: unknown;
  status?: unknown;
  code?: unknown;
  type?: unknown;
  error?: { error?: { type?: unknown; message?: unknown } } | unknown;
  headers?: Record<string, string | undefined> | unknown;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const h = headers as Record<string, unknown>;
  const v = h[name] ?? h[name.toLowerCase()];
  return typeof v === "string" ? v : undefined;
}

const CONTEXT_RE = /context.length.exceeded|context.{0,20}(window|length)|prompt is too long|maximum context length|input.{0,30}too long|exceeds?.{0,20}(context|token|limit)|too many tokens/i;
const ORPHAN_RE = /no tool.{0,20}(call|use).{0,20}found|orphaned tool|tool_use_id.{0,20}not found|unexpected tool.{0,5}result/i;

function readRetryAfterMs(headers: unknown): number | undefined {
  const ra = readHeader(headers, "retry-after");
  const parsed = parseRetryAfter(ra);
  if (parsed !== undefined) return parsed;
  const raMs = readHeader(headers, "retry-after-ms");
  if (raMs && /^\d+$/.test(raMs.trim())) return parseInt(raMs.trim(), 10);
  const reset = readHeader(headers, "anthropic-ratelimit-requests-reset");
  if (reset) {
    const ts = Date.parse(reset);
    if (Number.isFinite(ts)) {
      const diff = ts - Date.now();
      if (diff > 0) return diff;
    }
  }
  return undefined;
}

function statusBasedKind(status: number | undefined, message: string): ProviderErrorKind {
  if (status === undefined) return "transient";
  if (status === 413) return "context_overflow";
  if (status === 429) return "throttling";
  if (status >= 500 && status < 600) return "transient";
  if (status === 408) return "transient";
  if (status >= 400 && status < 500) {
    if (CONTEXT_RE.test(message)) return "context_overflow";
    return "non_retryable";
  }
  return "transient";
}

function classifyApiErrorType(t: unknown): ProviderErrorKind | undefined {
  if (typeof t !== "string") return undefined;
  switch (t) {
    case "context_length_exceeded":
      return "context_overflow";
    case "invalid_request_error":
    case "authentication_error":
    case "permission_error":
    case "not_found_error":
    case "content_filter":
      return "non_retryable";
    case "rate_limit_error":
    case "overloaded_error":
      return "throttling";
    case "tokens":
      return "context_overflow";
    default:
      return undefined;
  }
}

const CODEX_STATUS_RE = /Codex API (\d{3}):/;

export function classifyProviderError(err: unknown, providerName: string): ProviderError {
  if (err instanceof ProviderError) return err;

  const errLike = (err ?? {}) as ErrLike;
  const message = err instanceof Error ? err.message : String(err);
  const headers = errLike.headers;
  const retryAfterMs = readRetryAfterMs(headers);

  // SDK-style APIError shape (Anthropic / OpenAI both expose `status`, optional `error.error.type`, optional `code`/`type`).
  const status = typeof errLike.status === "number" ? errLike.status : undefined;

  // Anthropic nested error.error.type
  const nested = (errLike.error as { error?: { type?: unknown } } | undefined)?.error;
  const apiType = nested && typeof nested === "object" ? (nested as { type?: unknown }).type : undefined;
  const codeOrType =
    typeof errLike.code === "string"
      ? errLike.code
      : typeof errLike.type === "string"
        ? errLike.type
        : undefined;

  // Context overflow has highest priority \u2014 messages frequently embed the marker
  if (CONTEXT_RE.test(message)) {
    return new ProviderError({ kind: "context_overflow", message, status, retryAfterMs, providerName, cause: err });
  }
  if (ORPHAN_RE.test(message)) {
    return new ProviderError({ kind: "orphaned_tool_result", message, status, retryAfterMs, providerName, cause: err });
  }

  const byType = classifyApiErrorType(apiType) ?? classifyApiErrorType(codeOrType);
  if (byType) {
    return new ProviderError({ kind: byType, message, status, retryAfterMs, providerName, cause: err });
  }

  // Codex API <status>: ... raw Error pattern from openai-codex.ts
  const codexMatch = CODEX_STATUS_RE.exec(message);
  if (codexMatch && codexMatch[1]) {
    const codexStatus = parseInt(codexMatch[1], 10);
    const kind = statusBasedKind(codexStatus, message);
    return new ProviderError({ kind, message, status: codexStatus, retryAfterMs, providerName, cause: err });
  }

  if (status !== undefined) {
    return new ProviderError({ kind: statusBasedKind(status, message), message, status, retryAfterMs, providerName, cause: err });
  }

  return new ProviderError({ kind: "transient", message, retryAfterMs, providerName, cause: err });
}
