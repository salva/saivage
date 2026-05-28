/**
 * Saivage — Knowledge store error taxonomy and write-guard helpers.
 *
 * Source of truth: SPEC/v2/skills-memory/01-DESIGN.md §C.3.
 *
 * After F01(B04) the canonical storage is the SQLite sidecar (see
 * `sidecar.ts` / `sidecar-queries.ts`). The legacy JSON-tree write
 * primitives (record-per-file, JSONL audit, rebuildIndex) are gone.
 * This file now hosts only:
 *
 *   • the `KnowledgeStoreError` taxonomy used by every layer,
 *   • the pure write-time guards (`assertReason`, `assertNoSecrets`,
 *     `assertNotBlockedPath`, `detectSecrets`).
 *
 * The lifecycle layer (`lifecycle.ts`) composes these guards with the
 * sidecar mutation primitives.
 */

import { isBlockedPath, redact, scanForSecrets, type SecretMatch } from "../security/secrets.js";
import { LifecycleStatusSchema, type AuditOp } from "./types.js";

/** All error codes returned by the knowledge layer (design §C.3 taxonomy). */
export type KnowledgeErrorCode =
  | "UNAUTHORIZED_ROLE"
  | "UNAUTHORIZED_SCOPE"
  | "UNAUTHORIZED_TOPIC"
  | "NOT_FOUND"
  | "EMPTY_REASON"
  | "INVALID_SCOPE_REF"
  | "INVALID_SUPERSEDE_TARGET"
  | "TOPIC_COLLISION"
  | "NAME_COLLISION"
  | "INVALID_SUPERSEDE_SCOPE"
  | "SECRET_DETECTED"
  | "BLOCKED_PATH"
  | "NO_RUNTIME_LOCK"
  | "OVERSIZED_SURVIVOR"
  | "INVALID_BUILTIN_NAME"
  | "KNOWLEDGE_MIGRATION_REQUIRED"
  | "KNOWLEDGE_RAG_UNAVAILABLE";

export class KnowledgeStoreError extends Error {
  constructor(
    public readonly code: KnowledgeErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "KnowledgeStoreError";
  }
}

/**
 * Scan free-text content fields for secrets. Caller decides which
 * fields to feed (record body, reason, flattened topic/keys).
 */
export function detectSecrets(fields: Record<string, string | undefined | null>): {
  matches: SecretMatch[];
  redacted: Record<string, string>;
} {
  const matches: SecretMatch[] = [];
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value !== "string" || value.length === 0) continue;
    const result = scanForSecrets(value, name);
    if (result.matches.length > 0) {
      matches.push(...result.matches);
      redacted[name] = redact(value, result.matches).text;
    }
  }
  return { matches, redacted };
}

export function assertNoSecrets(fields: Record<string, string | undefined | null>): void {
  const { matches } = detectSecrets(fields);
  if (matches.length > 0) {
    throw new KnowledgeStoreError(
      "SECRET_DETECTED",
      "secret detected in: " + [...new Set(matches.map((m) => m.field))].join(", "),
      { kinds: [...new Set(matches.map((m) => m.kind))] },
    );
  }
}

export function assertNotBlockedPath(path: string | undefined | null, field = "body"): void {
  if (typeof path !== "string" || path.length === 0) return;
  if (isBlockedPath(path)) {
    throw new KnowledgeStoreError("BLOCKED_PATH", field + " is blocked: " + path);
  }
}

/** Convenience: validate a `reason` field. */
export function assertReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new KnowledgeStoreError("EMPTY_REASON", "reason is required");
  }
  return reason;
}

// Re-exports for callers that want to construct audit entries.
export { LifecycleStatusSchema };
export type { AuditOp };
