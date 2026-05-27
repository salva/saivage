/**
 * F01 B06 — RAG secret-exclusion guard.
 *
 * This module is the single decision point used by the RAG ingest pipeline
 * to (a) skip secret-bearing files by path and (b) skip individual chunks
 * whose content matches a secret-shape heuristic. It delegates to the
 * canonical scanner in `src/security/secrets.ts` (kept as the source of
 * truth for app-wide secret detection) and supplements it with the
 * additional path globs and provider patterns mandated by the RAG plan
 * §B06 (Slack tokens; SSH/AWS/PEM file globs).
 *
 * Two narrow surfaces:
 *   - `shouldSkipPath(path)` — true when the file MUST NOT be ingested.
 *   - `scanChunk(text)` — true when the chunk MUST NOT be embedded.
 *
 * The guard is intentionally one-way: when in doubt, skip. The cost of a
 * false positive is a missed document; the cost of a false negative is a
 * secret in the vector store.
 */
import picomatch from "picomatch";
import { isBlockedPath, scanForSecrets } from "../../security/secrets.js";

/**
 * Extra path globs not covered by the canonical `isBlockedPath` regex
 * set. picomatch uses POSIX-style globs; callers normalise to "/" first.
 */
const EXTRA_BLOCKED_GLOBS: ReadonlyArray<string> = [
  "**/.saivage/auth-profiles.*.json",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/.ssh/**",
  "**/.aws/credentials",
  "**/.aws/credentials.*",
  "**/.netrc",
  "**/secrets/**",
];

const extraMatcher = picomatch(EXTRA_BLOCKED_GLOBS as string[], { dot: true });

/** Additional provider-shape patterns not yet in the canonical scanner. */
const EXTRA_PROVIDER_PATTERNS: ReadonlyArray<RegExp> = [
  // Slack tokens: xoxa-/xoxb-/xoxp-/xoxr-/xoxs-… followed by alphanumeric runs.
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // Anthropic API keys (the canonical openai_key rule matches these too via
  // the sk- prefix, but spell it out for audit clarity).
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  // AWS secret access key — a 40-char base64-ish run preceded by
  // `aws_secret_access_key` in the same line. The canonical literal rule
  // flags the marker; this catches the value itself.
  /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?/gi,
];

/**
 * Returns true when `path` is a known secret-bearing file and therefore
 * MUST NOT be opened for ingestion. Accepts project-relative and absolute
 * inputs; Windows-style backslashes are normalised to "/".
 */
export function shouldSkipPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (isBlockedPath(path)) return true;
  const normalized = path.replace(/\\/g, "/");
  return extraMatcher(normalized);
}

/**
 * Returns true when the chunk text contains material matching any
 * provider-shape, literal, env-style assignment, or RAG-supplemental
 * heuristic. Chunks that return true MUST NOT be embedded.
 */
export function scanChunk(text: string): boolean {
  if (typeof text !== "string" || text.length === 0) return false;
  if (scanForSecrets(text, "chunk").matches.length > 0) return true;
  for (const rx of EXTRA_PROVIDER_PATTERNS) {
    rx.lastIndex = 0;
    if (rx.test(text)) return true;
  }
  return false;
}
