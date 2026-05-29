/**
 * Saivage — Secret-scanning + blocked-path heuristics.
 *
 * Source of truth: SPEC/v2/skills-memory/01-DESIGN.md §C.3 "Security".
 * Heuristics:
 *   - provider shapes (sk-…, ghp_…, ya29.…, AKIA…, JWT triple)
 *   - env-style assignments with Shannon entropy > 3.5 bits/char
 *   - literal markers (auth-profiles.json, BEGIN … PRIVATE KEY, …)
 *
 * No real secrets in fixtures. Public side effects: this module is also
 * used at read-time by `redactForRead` in `src/knowledge/loader.ts`.
 */

export interface SecretMatch {
  field: string;
  start: number;
  end: number;
  kind: string;
}

export interface ScanResult {
  matches: SecretMatch[];
}

export interface RedactResult {
  text: string;
  redacted_spans: number;
}

/**
 * Provider-shape regex catalogue. Each rule has a `kind` label for audit
 * messages (we never echo the matched substring per design ground-rule 3).
 */
const PROVIDER_RULES: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  // OpenAI-style API keys: sk-… with ≥ 20 chars after the prefix.
  { kind: "openai_key", pattern: /sk-[A-Za-z0-9_-]{20,}/g },
  // GitHub PAT / OAuth tokens.
  { kind: "github_token", pattern: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  // Google OAuth refresh tokens.
  { kind: "google_oauth", pattern: /ya29\.[A-Za-z0-9_-]{20,}/g },
  // AWS Access Key ID.
  { kind: "aws_access_key_id", pattern: /AKIA[0-9A-Z]{16}/g },
  // JWT triples (header.payload.signature) where each segment is base64url ≥ 8 chars.
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
];

/**
 * Literal markers — case-insensitive substring matches. Each entry MUST
 * be paired with a span calculator since the substring may appear inside
 * a longer secret line (e.g. `aws_secret_access_key=…`).
 */
const LITERAL_RULES: ReadonlyArray<{ kind: string; needle: RegExp }> = [
  { kind: "auth_profiles", needle: /auth-profiles\.json/gi },
  { kind: "private_key_pem", needle: /-----BEGIN (RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g },
  { kind: "aws_secret_marker", needle: /aws_secret_access_key/gi },
  { kind: "client_secret_marker", needle: /client_secret/gi },
];

/**
 * Env-style assignment: NAME=value (value ≥ 20 chars, high entropy).
 * Field name must be ALLCAPS_WITH_UNDERSCORES, value must not contain
 * whitespace, and Shannon entropy must exceed 3.5 bits/char.
 */
const ENV_ASSIGNMENT_PATTERN = /(?<![A-Za-z0-9_])([A-Z][A-Z0-9_]{4,})=([^\s'"`]{20,})/g;
const ENV_ENTROPY_THRESHOLD = 3.5;

/** Blocked source paths — §C.3. Matched even if the file is missing. */
const BLOCKED_PATH_RULES: ReadonlyArray<RegExp> = [
  /\.saivage\/auth-profiles\.json$/,
  /\.saivage\/[^/]*credentials[^/]*\.json$/i,
  /\.saivage\/[^/]*provider[^/]*\.json$/i,
  /(^|\/)\.env(\.[^/]+)?$/,
  /(^|\/)secrets\/\.env(\.[^/]+)?$/,
  /(^|\/)secrets\/[^/]+$/,
  /\/\.bash_history$/,
  /\/\.zsh_history$/,
];

/**
 * Default credential lexemes used by the env-name scrubber. Each entry
 * is matched (case-insensitively) inside a name with `_`/`-` boundary
 * separators and an optional trailing plural `S`. The list lives here
 * as a default that operators may fully replace via
 * `security.envScrubber.credentialLexemes` in `.saivage/saivage.json`
 * (full-replacement semantics; no merge with hidden defaults).
 */
export const DEFAULT_CREDENTIAL_LEXEMES: ReadonlyArray<string> = [
  "API_KEY",
  "ACCESS_KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "AUTH",
  "BEARER",
  "COOKIE",
  "SESSION",
];

/**
 * Default config-pointer suffixes — names that match a credential
 * lexeme but end in one of these (uppercase) suffixes are treated as
 * URL/path/prompt/template pointers and preserved. Full-replacement
 * semantics; an empty operator-supplied list disables layer 2 entirely.
 */
export const DEFAULT_CONFIG_POINTER_SUFFIXES: ReadonlyArray<string> = [
  "_URL",
  "_URI",
  "_ENDPOINT",
  "_PATH",
  "_DIR",
  "_FILE",
  "_PROMPT",
  "_TEMPLATE",
];

export interface SecretEnvNameRules {
  credentialLexemes: ReadonlyArray<string>;
  configPointerSuffixes: ReadonlyArray<string>;
}

/**
 * Build a `(name: string) => boolean` predicate that classifies env
 * variable NAMES as secret. Two layers, evaluated in order:
 *
 *   1. credentialLexemes — each lexeme L is compiled to
 *      /(?:^|[_-])L'S?(?:$|[_-])/i where L' is L with every regex
 *      metachar escaped and then every internal `_` rewritten to
 *      `[_-]`. The boundary alternations and the internal `[_-]`
 *      together treat `_` and `-` as interchangeable separator
 *      characters, so a configured `API_KEY` matches `API_KEY`,
 *      `API-KEY`, `MY_API_KEY`, `SOME_API-KEY`, and `API_KEYS`, but
 *      does NOT match `APIKEY`, `MYAPIKEY`, or `APIKEYNAME`. The
 *      trailing `S?` covers plural forms.
 *
 *   2. configPointerSuffixes — names that pass layer 1 but end in
 *      one of the (uppercase) suffixes are configuration pointers
 *      or UI strings and are preserved. An empty suffix list
 *      disables layer 2 (every layer-1 match is a secret).
 *
 * Operator overrides are FULL REPLACEMENTS — supplied lists fully
 * replace the defaults; nothing is unioned in. Predicate construction
 * is O(|credentialLexemes|) regex compiles; callers SHOULD build the
 * predicate once and reuse it.
 */
export function createSecretEnvNamePredicate(
  rules: SecretEnvNameRules,
): (name: string) => boolean {
  const lexemePatterns: RegExp[] = rules.credentialLexemes.map((lex) => {
    const escaped = lex
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/_/g, "[_-]");
    return new RegExp(`(?:^|[_-])${escaped}S?(?:$|[_-])`, "i");
  });
  const suffixes: ReadonlyArray<string> = rules.configPointerSuffixes;

  return function isSecretEnvName(name: string): boolean {
    if (typeof name !== "string" || name.length === 0) return false;
    if (!lexemePatterns.some((rx) => rx.test(name))) return false;
    const upper = name.toUpperCase();
    for (const suffix of suffixes) {
      if (upper.endsWith(suffix)) return false;
    }
    return true;
  };
}

/** Shannon entropy in bits/char. */
function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  const n = text.length;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Scan a single field for all heuristics. Returns the list of matches
 * with start/end offsets relative to `text`.
 */
export function scanForSecrets(text: string, field: string = "body"): ScanResult {
  if (typeof text !== "string" || text.length === 0) return { matches: [] };
  const matches: SecretMatch[] = [];

  for (const rule of PROVIDER_RULES) {
    rule.pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.pattern.exec(text)) !== null) {
      matches.push({ field, start: m.index, end: m.index + m[0].length, kind: rule.kind });
    }
  }

  for (const rule of LITERAL_RULES) {
    rule.needle.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.needle.exec(text)) !== null) {
      matches.push({ field, start: m.index, end: m.index + m[0].length, kind: rule.kind });
    }
  }

  ENV_ASSIGNMENT_PATTERN.lastIndex = 0;
  let envMatch: RegExpExecArray | null;
  while ((envMatch = ENV_ASSIGNMENT_PATTERN.exec(text)) !== null) {
    const value = envMatch[2];
    if (shannonEntropy(value) >= ENV_ENTROPY_THRESHOLD) {
      matches.push({
        field,
        start: envMatch.index,
        end: envMatch.index + envMatch[0].length,
        kind: "env_assignment",
      });
    }
  }

  // De-duplicate overlapping matches (keep widest).
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: SecretMatch[] = [];
  for (const m of matches) {
    const last = merged[merged.length - 1];
    if (last && m.start < last.end) {
      if (m.end > last.end) last.end = m.end;
      continue;
    }
    merged.push({ ...m });
  }
  return { matches: merged };
}

/**
 * Replace each match in `matches` with `[REDACTED]`. Returns the new
 * text and the number of redactions applied (`redacted_spans` for the
 * caller's response payload).
 */
export function redact(text: string, matches: ReadonlyArray<SecretMatch>): RedactResult {
  if (matches.length === 0) return { text, redacted_spans: 0 };
  const sorted = [...matches].sort((a, b) => a.start - b.start);
  const out: string[] = [];
  let cursor = 0;
  let count = 0;
  for (const m of sorted) {
    if (m.start < cursor) {
      if (m.end > cursor) cursor = m.end; // extend coverage on overlap
      continue;
    }
    out.push(text.slice(cursor, m.start));
    out.push("[REDACTED]");
    cursor = m.end;
    count += 1;
  }
  out.push(text.slice(cursor));
  return { text: out.join(""), redacted_spans: count };
}

/**
 * Check whether `path` is in the blocked-source-paths list. Compares
 * normalized POSIX-style paths; accepts both project-relative and
 * absolute inputs. Returns `true` even if the file does not exist
 * (refusal is purely path-based; design §C.3).
 */
export function isBlockedPath(path: string): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  const normalized = path.replace(/\\/g, "/");
  return BLOCKED_PATH_RULES.some((re) => re.test(normalized));
}
