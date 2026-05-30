# G35 — Design r2

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)

**Round-1 review addressed**: [04-review-r1.md](04-review-r1.md)

**Writer**: Claude Opus 4.7 (round 2)

## 1. Recommendation

**Proposal A (round-2 form)** — replace the unanchored substring patterns with a single two-layer predicate `isSecretEnvName(name: string): boolean` co-located in [src/security/secrets.ts](../../../../src/security/secrets.ts#L1):

- **Layer 1** — word-anchored credential lexemes (`API_KEY`, `ACCESS_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, with plural forms). A name must contain at least one such lexeme as a discrete underscore-bounded token to be considered.
- **Layer 2** — config-pointer suffix exemption. A name that matched layer 1 but ends in one of `_URL`, `_URI`, `_ENDPOINT`, `_PATH`, `_DIR`, `_FILE`, `_PROMPT`, `_TEMPLATE` is a configuration pointer / UI string, not a secret, and is preserved.

`filterShellEnv` in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L431) calls the predicate.

### 1.1 Changes versus design r1

Per [04-review-r1.md](04-review-r1.md#L5-L13):

- **B1 fix**: `ENV_CONFIG_POINTER_SUFFIXES` now includes `_PROMPT` and `_TEMPLATE`. `PASSWORD_PROMPT`, `API_KEY_PROMPT`, `TOKEN_TEMPLATE` are exempted and pinned in the FP corpus (§2.4).
- **B2 fix**: the round-1 `SECRET_ENV_FORCE_PATTERNS` layer is **deleted from the design**. There is no provider-prefix bypass. All real provider credentials reach the predicate through layer 1 because their names already contain an explicit credential lexeme (see §2.2 audit). Provider-namespaced config pointers (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GITHUB_API_BASE_URL`, `GITHUB_API_BASE_URL_TEMPLATE`) become non-secret.
- **B3 fix**: corpora rewritten as flat arrays with one env-var name per row; reviewer-listed names (`SLACK_TOKEN`, `PASSWORD_PROMPT`, `RESET_PASSWORD_URL`, `MY_SECRETARY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`) are explicitly present; the round-1 boundary-marker ambiguity is removed.

Proposal A (round-2 form) is still preferred over the rejected Proposal B (per-value entropy / shape inspection) for the same reasons given in design r1: pure constant + predicate, zero allocations, no entropy state, no false positives on long `*_URL` / `*_PROXY` values.

## 2. Proposal A (round-2 form) — anchored lexemes + config-pointer suffixes

### 2.1 New exports in src/security/secrets.ts

Inserted after the existing `BLOCKED_PATH_RULES` block at [src/security/secrets.ts](../../../../src/security/secrets.ts#L67-L78), before `shannonEntropy` at [src/security/secrets.ts](../../../../src/security/secrets.ts#L79):

```ts
/**
 * Environment-variable NAME classifier used by the shell tool's
 * env scrubber in src/mcp/builtins.ts. This is the only place in
 * the tree that decides "is this env var name a credential field?".
 *
 * Two layers, evaluated in order:
 *   1. SECRET_ENV_NAME_PATTERNS — word-anchored credential lexemes
 *      (API_KEY, ACCESS_KEY, TOKEN, SECRET, PASSWORD, PASSWD,
 *      CREDENTIAL, with plurals). Each pattern requires an
 *      underscore / start-of-string boundary on the left and an
 *      underscore / end-of-string boundary on the right, so
 *      MY_SECRETARY, TOKENIZER, PASSWORDLESS_MODE do NOT match.
 *   2. ENV_CONFIG_POINTER_SUFFIXES — names that pass layer 1 but
 *      end in one of these suffixes are configuration pointers
 *      or UI strings, not secrets, and are preserved. The
 *      exemption applies regardless of any provider-namespace
 *      prefix on the name; the predicate has no provider-prefix
 *      bypass layer.
 */
const SECRET_ENV_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|_)API[_-]?KEYS?(?:$|_)/i,
  /(?:^|_)ACCESS[_-]?KEYS?(?:$|_)/i,
  /(?:^|_)TOKENS?(?:$|_)/i,
  /(?:^|_)SECRETS?(?:$|_)/i,
  /(?:^|_)PASSWORDS?(?:$|_)/i,
  /(?:^|_)PASSWD(?:$|_)/i,
  /(?:^|_)CREDENTIALS?(?:$|_)/i,
];

const ENV_CONFIG_POINTER_SUFFIXES: ReadonlyArray<string> = [
  "_URL",
  "_URI",
  "_ENDPOINT",
  "_PATH",
  "_DIR",
  "_FILE",
  "_PROMPT",
  "_TEMPLATE",
];

export function isSecretEnvName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (!SECRET_ENV_NAME_PATTERNS.some((rx) => rx.test(name))) return false;
  const upper = name.toUpperCase();
  for (const suffix of ENV_CONFIG_POINTER_SUFFIXES) {
    if (upper.endsWith(suffix)) return false;
  }
  return true;
}
```

Notes:

- `(?:^|_)…(?:$|_)` requires the credential lexeme to be a discrete underscore-bounded token. `_PASSWORD_RESET` matches `PASSWORD`; `MY_SECRETARY` does not (the character after `SECRET` is `A`, not `_` or end-of-string).
- `API[_-]?KEY` and `ACCESS[_-]?KEY` preserve the existing hyphen-form tolerance so `SOME_API-KEY` is still caught.
- Plural forms (`KEYS?`, `TOKENS?`, `SECRETS?`, `PASSWORDS?`, `CREDENTIALS?`) keep `_CREDENTIALS_`, `_TOKENS_`, etc. classified.
- `PASSWD` is singular by convention (Unix shadow-style).
- `ACCESS_KEY` is a new lexeme versus design r1; it covers `AWS_ACCESS_KEY_ID` after the round-1 force layer is removed (see §2.2).
- The config-pointer suffix list is the round-1 set (`_URL`, `_URI`, `_ENDPOINT`, `_PATH`, `_DIR`, `_FILE`) plus `_PROMPT` and `_TEMPLATE` per [04-review-r1.md](04-review-r1.md#L5).
- The suffix check uses `String.prototype.endsWith` on the upper-cased name to keep the predicate allocation-free in the common case (no regex backtracking on the suffix layer).

### 2.2 Audit: every real provider credential still classified as secret without a force-prefix layer

| Provider env-var name | Lexeme matched | Ends in pointer suffix? | Predicate result |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `_API_KEY` | no | true |
| `OPENAI_API_KEY` | `_API_KEY` | no | true |
| `GITHUB_TOKEN` | `_TOKEN` | no | true |
| `GH_TOKEN` | `_TOKEN` | no | true |
| `TELEGRAM_BOT_TOKEN` | `_TOKEN` | no | true |
| `SLACK_TOKEN` | `_TOKEN` | no | true |
| `AWS_ACCESS_KEY_ID` | `_ACCESS_KEY_` | no | true |
| `AWS_SECRET_ACCESS_KEY` | `_SECRET_` and `_ACCESS_KEY` | no | true |
| `AWS_SESSION_TOKEN` | `_TOKEN` | no | true |
| `SAIVAGE_API_TOKEN` | `_API` (no) — but `_TOKEN` yes | no | true |
| `DATABASE_PASSWORD` | `_PASSWORD` | no | true |

Every real credential remains scrubbed. The round-1 `SECRET_ENV_FORCE_PATTERNS` layer is therefore unnecessary and is removed (B2 from [04-review-r1.md](04-review-r1.md#L7)).

### 2.3 Call-site rewrite in src/mcp/builtins.ts

The block at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L432) becomes:

```ts
import { isSecretEnvName } from "../security/secrets.js";

// (the SECRET_ENV_PATTERNS constant is deleted)

/**
 * Strip credential-shaped environment variable names from the parent
 * process's env before spawning a shell child. The rule set lives in
 * src/security/secrets.ts as isSecretEnvName.
 */
export function filterShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (isSecretEnvName(key)) continue;
    result[key] = value;
  }
  return result;
}
```

### 2.4 Deterministic test corpora

Both corpora live in [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) as two new `describe` blocks. Each is a flat `ReadonlyArray<string>`; one env-var name per row, no inline commentary, no boundary markers.

**False-positive corpus** — `isSecretEnvName(name)` MUST return `false` for every entry:

```
PATH
HOME
USER
LANG
NODE_ENV
HTTPS_PROXY
HTTP_PROXY
NO_PROXY
PROJECT_ROOT
SAIVAGE_ROOT
SAIVAGE_PROJECT_ID
PYTHONPATH
LD_LIBRARY_PATH
TERM
SHELL
MY_SECRETARY
STAGETOKENISER_PATH
TOKENIZER
TOKENIZER_CACHE_DIR
PASSWORDLESS_MODE
CREDENTIALSMITH_BIN
RESET_PASSWORD_URL
PASSWORD_RESET_ENDPOINT
CREDENTIALS_FILE
API_KEY_URL
TOKEN_ISSUER_URL
SECRET_STORE_PATH
USER_PROFILE_URL
PASSWORD_PROMPT
API_KEY_PROMPT
TOKEN_TEMPLATE
GITHUB_API_BASE_URL
GITHUB_API_BASE_URL_TEMPLATE
OPENAI_BASE_URL
ANTHROPIC_BASE_URL
GH_USERNAME
TELEGRAM_BOT_NAME
```

**False-negative corpus** — `isSecretEnvName(name)` MUST return `true` for every entry:

```
API_KEY
MY_API_KEY
API_KEYS
SOME_API-KEY
TOKEN
MY_TOKEN
AUTH_TOKEN
TOKENS
SECRET
MY_SECRET
SECRETS
PASSWORD
DATABASE_PASSWORD
PASSWORDS
PASSWD
USER_CREDENTIAL
MY_CREDENTIALS
ANTHROPIC_API_KEY
OPENAI_API_KEY
GITHUB_TOKEN
GH_TOKEN
TELEGRAM_BOT_TOKEN
SLACK_TOKEN
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_SESSION_TOKEN
SAIVAGE_API_TOKEN
```

Every reviewer-named row from [04-review-r1.md](04-review-r1.md#L9-L13) is present in exactly one corpus:

| Name | Corpus | Why |
|---|---|---|
| `SLACK_TOKEN` | FN | discrete `_TOKEN` lexeme, no pointer suffix |
| `PASSWORD_PROMPT` | FP | `_PASSWORD_` lexeme but ends in `_PROMPT` |
| `RESET_PASSWORD_URL` | FP | `_PASSWORD_` lexeme but ends in `_URL` |
| `MY_SECRETARY` | FP | no discrete credential lexeme (`SECRET` is not underscore-bounded) |
| `ANTHROPIC_API_KEY` | FN | discrete `_API_KEY` lexeme, no pointer suffix |
| `OPENAI_API_KEY` | FN | discrete `_API_KEY` lexeme, no pointer suffix |
| `GITHUB_TOKEN` | FN | discrete `_TOKEN` lexeme, no pointer suffix |
| `GITHUB_API_BASE_URL` | FP | no credential lexeme (`API` alone is not in the lexeme set) |
| `GITHUB_API_BASE_URL_TEMPLATE` | FP | no credential lexeme, and ends in `_TEMPLATE` |

The two corpora are disjoint by construction (the predicate is a total function on strings; no row is asserted both true and false).

**Integration test** in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) — one new `describe("filterShellEnv")` block with two `it` assertions:

1. `filterShellEnv({ RESET_PASSWORD_URL: "https://example.test/reset" }).RESET_PASSWORD_URL === "https://example.test/reset"` (FP preserved end-to-end).
2. `filterShellEnv({ ANTHROPIC_API_KEY: "sk-test-not-real" }).ANTHROPIC_API_KEY === undefined` (FN dropped end-to-end).

No real secret values; the value strings are syntactic placeholders.

## 3. Rejected alternative — Proposal B (per-value entropy / shape inspection)

Same rejection as design r1: putting any decision on env-var **values** would require entropy state and produces its own false positives on long `*_PROXY` / `*_URL` values (which often look entropic). The G35 finding is explicitly a name-classifier bug; round-2 keeps the fix at the name layer.

## 4. What is removed (architecture-first, no shim)

- `SECRET_ENV_PATTERNS` constant at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L422) — deleted in full.
- The inline `.some((pattern) => pattern.test(key))` loop body at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L426) — replaced by the predicate call.
- The function-level JSDoc above `filterShellEnv` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L406) — rewritten to a one-paragraph pointer at `src/security/secrets.ts`.

No deprecation alias, no re-export of the old constant, no toggle, no provider-prefix force layer. The round-1 `SECRET_ENV_FORCE_PATTERNS` constant never lands.
