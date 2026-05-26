/**
 * Saivage — Shared LLM JSON extraction & validation helper.
 *
 * Replaces the eight ad-hoc `text.match(/\{[\s\S]*\}/)` sites scattered across
 * worker / inspector / manager / cop / supervisor with a single contract:
 *
 *  1. Walk the message, building a list of candidate JSON substrings (raw
 *     strings, in source order). Sources:
 *       a) the trimmed whole message, only if it starts with `{`
 *       b) the body of each ```json … ``` (or ``` … ```) fenced block
 *       c) every maximal balanced top-level `{ … }` brace span
 *  2. `parseLlmJson` returns the most-recent candidate that parses, or `null`.
 *  3. `parseLlmJsonAs(text, schema)` picks the last parseable candidate and
 *     schema-checks it; failures surface as a tagged ParseResult so callers
 *     can route to deterministic failure reports instead of silently lying.
 */

import { z, type ZodTypeAny } from "zod";

export type ParseFailureReason = "no_json" | "invalid_json" | "schema_mismatch";

export type ParseResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: ParseFailureReason;
      detail: string;
      raw: string | null;
    };

/**
 * Return raw candidate JSON substrings in source order. No parsing performed
 * inside the extractor — callers run `JSON.parse` themselves.
 */
export function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];

  // Source 1: whole-trimmed message, only if it starts with `{`.
  const trimmed = text.trim();
  let trimmedAdded = false;
  if (trimmed.startsWith("{")) {
    candidates.push(trimmed);
    trimmedAdded = true;
  }

  // Source 2: fenced blocks. ``` (optionally with `json` tag) … ```.
  const fenceRe = /```(?:json)?\s*\n([\s\S]*?)\n```/g;
  let fenceMatch: RegExpExecArray | null;
  while ((fenceMatch = fenceRe.exec(text)) !== null) {
    const body = fenceMatch[1];
    if (trimmedAdded && candidates[0] === body) continue;
    candidates.push(body);
  }

  // Source 3: every maximal balanced top-level `{ … }` span. Single
  // left-to-right scan that ignores braces inside JSON string literals.
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          candidates.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return candidates;
}

/** Return the last candidate that survives `JSON.parse`, or null. */
export function parseLlmJson(text: string): unknown | null {
  const candidates = extractJsonCandidates(text);
  let last: unknown | null = null;
  let found = false;
  for (const raw of candidates) {
    try {
      last = JSON.parse(raw);
      found = true;
    } catch {
      // skip
    }
  }
  return found ? last : null;
}

/**
 * Pick the last parseable candidate and schema-check it. Failures are tagged:
 *
 *   - `no_json`         — no candidate substrings at all (prose-only input).
 *   - `invalid_json`    — candidates exist but none parse.
 *   - `schema_mismatch` — last parseable candidate fails the schema. The
 *                          parser does NOT retry earlier candidates.
 */
export function parseLlmJsonAs<S extends ZodTypeAny>(
  text: string,
  schema: S,
): ParseResult<z.infer<S>> {
  const candidates = extractJsonCandidates(text);
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: "no_json",
      detail: "model emitted no candidate JSON substring",
      raw: null,
    };
  }

  let lastParsedValue: unknown = undefined;
  let lastParsedRaw: string | null = null;
  let firstParseError: string | null = null;
  let anyParsed = false;
  for (const raw of candidates) {
    try {
      lastParsedValue = JSON.parse(raw);
      lastParsedRaw = raw;
      anyParsed = true;
    } catch (err) {
      if (firstParseError === null) {
        firstParseError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (!anyParsed) {
    return {
      ok: false,
      reason: "invalid_json",
      detail: (firstParseError ?? "JSON.parse failed").slice(0, 300),
      raw: candidates[0].slice(0, 300),
    };
  }

  const result = schema.safeParse(lastParsedValue);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ")
    .slice(0, 300);
  return {
    ok: false,
    reason: "schema_mismatch",
    detail,
    raw: lastParsedRaw ? lastParsedRaw.slice(0, 300) : null,
  };
}
