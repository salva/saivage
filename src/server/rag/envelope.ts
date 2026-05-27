/**
 * F02 B04 — Envelope helpers for the `rag` MCP handler.
 *
 * The handler returns plain objects: `{ ok: true, ... }` on success or
 * `{ ok: false, code, message, details? }` on failure. Callers downstream
 * (`runtime.callTool`) flatten these into structured JSON content blocks.
 */

export interface RagOkEnvelope<T = unknown> {
  ok: true;
  content: T;
}

export interface RagErrEnvelope {
  ok: false;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type RagEnvelope<T = unknown> = RagOkEnvelope<T> | RagErrEnvelope;

export function ragOk<T>(content: T): RagOkEnvelope<T> {
  return { ok: true, content };
}

export function ragErr(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): RagErrEnvelope {
  return details === undefined
    ? { ok: false, code, message }
    : { ok: false, code, message, details };
}
