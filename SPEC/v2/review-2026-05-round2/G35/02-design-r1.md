# G35 — Design r1

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

**Writer**: Claude Opus 4.7 (round 1)

## 1. Recommendation

**Proposal A** — tighten the rules with word-anchored patterns, a small fixed prefix allow-list of "is-always-secret" provider namespaces, and a fixed suffix allow-list of "is-config-pointer" name endings. Co-locate the rule set in [src/security/secrets.ts](../../../../src/security/secrets.ts#L1) behind a single predicate `isSecretEnvName(name: string): boolean` and have `filterShellEnv` in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L431) call it.

Proposal A is preferred over Proposal B (§3) because it (a) is a pure constant + predicate rewrite, no runtime surface, (b) keeps the existing zero-allocation `Object.entries` loop in `filterShellEnv`, (c) does not put any value-shape decision on env-var values (which would require entropy state and produces its own false positives on long `*_PROXY` / `*_URL` values), and (d) lets the issue's stated remediation in [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md#L26-L31) — "anchor … back them with an explicit allowlist … document in one place near `secrets.ts`" — land verbatim without inventing a new config key.

## 2. Proposal A — anchored patterns + force-strip prefixes + config-pointer suffixes

### 2.1 New exports in src/security/secrets.ts

Append to [src/security/secrets.ts](../../../../src/security/secrets.ts#L78) (after the existing `BLOCKED_PATH_RULES` block, before `shannonEntropy`):

```ts
/**
 * Environment-variable NAME classifier used by the shell tool's
 * env scrubber in src/mcp/builtins.ts. This is the only place in
 * the tree that decides "is this env var name a credential field?".
 *
 * Three layers, evaluated in order:
 *   1. SECRET_ENV_FORCE_PATTERNS — anchored prefix / exact rules
 *      that strip unconditionally (provider-namespaced vars and
 *      Saivage's own API token).
 *   2. SECRET_ENV_NAME_PATTERNS — word-anchored credential lexemes
 *      (TOKEN, SECRET, PASSWORD, …) that require an underscore /
 *      start-of-string boundary on both sides so MY_SECRETARY,
 *      STAGETOKENISER_PATH, etc. do NOT match.
 *   3. ENV_CONFIG_POINTER_SUFFIXES — names that pass layer 2 but
 *      end in one of these suffixes are configuration pointers,
 *      not secrets, and are preserved (e.g. RESET_PASSWORD_URL).
 *      Layer 1 still wins over this exemption.
 */
const SECRET_ENV_FORCE_PATTERNS: ReadonlyArray<RegExp> = [
  /^ANTHROPIC_/i,
  /^OPENAI_/i,
  /^GITHUB_/i,
  /^GH_/i,
  /^TELEGRAM_/i,
  /^AWS_(ACCESS|SECRET|SESSION)_/i,
  /^SAIVAGE_API_TOKEN$/i,
];

const SECRET_ENV_NAME_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:^|_)API[_-]?KEYS?(?:$|_)/i,
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
];

export function isSecretEnvName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  if (SECRET_ENV_FORCE_PATTERNS.some((rx) => rx.test(name))) return true;
  if (!SECRET_ENV_NAME_PATTERNS.some((rx) => rx.test(name))) return false;
  const upper = name.toUpperCase();
  for (const suffix of ENV_CONFIG_POINTER_SUFFIXES) {
    if (upper.endsWith(suffix)) return false;
  }
  return true;
}
```

Notes on each anchor:

- `(?:^|_)` and `(?:$|_)` together require the credential lexeme to be a discrete underscore-bounded token. `_PASSWORD_RESET` matches; `MY_SECRETARY` does not (after `SECRET` comes `A`, not `_`/end).
- `KEYS?`, `TOKENS?`, `SECRETS?`, `PASSWORDS?`, `CREDENTIALS?` accept the plural so `_CREDENTIALS_` and `_TOKENS_` are still scrubbed.
- `PASSWD` is left singular because Unix shadow-style names are always `PASSWD`.
- `SECRET_ENV_FORCE_PATTERNS` keeps the existing semantics that **all** `ANTHROPIC_*`, `OPENAI_*`, `GITHUB_*`, `GH_*`, `TELEGRAM_*`, `AWS_(ACCESS|SECRET|SESSION)_*` variables are stripped even when they end in a config-pointer suffix, because provider-namespaced names are unambiguous. The trailing `_` in the AWS rule fixes a pre-existing minor bug where the original `/^AWS_(ACCESS|SECRET|SESSION)/i` also matched a hypothetical `AWS_ACCESSPOINT_REGION`; this is a narrowing, not a behaviour-extension.
- `^SAIVAGE_API_TOKEN$` is kept as the only exact rule. Any other `SAIVAGE_*` name is not stripped (`SAIVAGE_ROOT`, `SAIVAGE_PROJECT_ID`, etc. must reach the child).

### 2.2 Call-site rewrite in src/mcp/builtins.ts

The block at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L432) becomes:

```ts
import { isSecretEnvName } from "../security/secrets.js";

// (the SECRET_ENV_PATTERNS constant is deleted)

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

The function-level JSDoc above `filterShellEnv` is rewritten to point at `isSecretEnvName` for the authoritative rule set and to drop the obsolete pattern list.

### 2.3 What is removed (architecture-first, no shim)

- `SECRET_ENV_PATTERNS` constant ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L422)) — deleted in full.
- The inline `.some((pattern) => pattern.test(key))` loop body — replaced by the predicate call.
- The function's pre-existing JSDoc bullet listing example patterns — rewritten to a one-line pointer ("`isSecretEnvName` in `src/security/secrets.ts` owns the rule set").

No deprecation alias, no re-export of the old constant, no toggle. Consumers (there is exactly one) update in the same commit.

### 2.4 Deterministic test fixtures

Both corpora go in [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) as two new `describe` blocks adjacent to the existing `scanForSecrets` block. They are pure-data arrays so the test is fully deterministic with no spawned process.

**False-positive corpus** — `isSecretEnvName` MUST return `false` for every entry:

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
GITHUB_API_BASE_URL_TEMPLATE
```

The last entry exercises the rule that `SECRET_ENV_FORCE_PATTERNS` is **prefix-anchored** with a trailing underscore: `GITHUB_API_BASE_URL_TEMPLATE` matches `/^GITHUB_/i` and IS stripped (force-strip wins over config-pointer suffix). That entry therefore belongs in the **false-negative** corpus below — listed here only to mark the boundary; the actual FP list above ends at `USER_PROFILE_URL`.

**False-negative corpus** — `isSecretEnvName` MUST return `true` for every entry:

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
ANTHROPIC_BASE_URL
OPENAI_API_KEY
OPENAI_BASE_URL
GITHUB_TOKEN
GITHUB_API_BASE_URL_TEMPLATE
GH_TOKEN
TELEGRAM_BOT_TOKEN
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_SESSION_TOKEN
SAIVAGE_API_TOKEN
```

`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, and `GITHUB_API_BASE_URL_TEMPLATE` are intentionally in the FN corpus: provider-namespaced variables are scrubbed by `SECRET_ENV_FORCE_PATTERNS` even though they end in a config-pointer suffix. This preserves the existing scrubber's strictness for provider namespaces.

**Integration test** in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) — a single new `describe("filterShellEnv")` block with two assertions:

1. `filterShellEnv({ RESET_PASSWORD_URL: "https://x" }).RESET_PASSWORD_URL === "https://x"` (FP preserved).
2. `filterShellEnv({ ANTHROPIC_API_KEY: "sk-test-do-not-use" }).ANTHROPIC_API_KEY === undefined` (FN dropped).

No real secret values appear in fixtures; the value strings are short literal placeholders.

## 3. Proposal B (level-up) — configurable list + value entropy heuristic — REJECTED

**Shape**: introduce `mcp.secretEnvAllowlist: string[]` and `mcp.secretEnvDenylist: string[]` in [src/config.ts](../../../../src/config.ts#L137-L168), plus a Shannon-entropy heuristic on the **value** for any env var whose name does not appear in either list. The classifier becomes:

```ts
isSecretEnvValue(name, value, config): boolean
```

Rejection grounds:

1. **New runtime surface**: adds two `mcp` config keys, which collides with the alphabetical insertion order being negotiated by G31/G32/G33/G34 in the same block at [src/config.ts](../../../../src/config.ts#L137-L168). The whole point of G35's sequencing constraint is to stay disjoint from that block.
2. **Value-shape heuristics misclassify common dev vars**: `HTTPS_PROXY`, `npm_config_*`, `XDG_*`, and CI-generated cache keys easily exceed 3.5 bits/char in their values. Either the threshold is raised (defeating detection) or operators have to allow-list each one (operational burden).
3. **Over-engineering vs. the actual finding**: the issue ([../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md#L26-L31)) explicitly asks for word-boundary anchors and a small allow-list near `secrets.ts`, not for a configurable per-project denylist.
4. **Architecture-first / avoid over-engineering**: Proposal A removes code (the unanchored patterns) and adds a single typed predicate. Proposal B adds two new config keys, a config validation rule, an entropy state pool, and operator documentation.

Proposal B is therefore documented and explicitly rejected; no implementation work flows from it.

## 4. Sequencing

- **Orthogonal to G30**: G30 is the other `src/mcp/builtins.ts` finding; it does not touch the `SECRET_ENV_PATTERNS` / `filterShellEnv` region.
- **Disjoint same-file edits with G31/G32/G33/G34**: those neighbours edit (a) the `case` bodies inside the tool-dispatch `switch` in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1) and (b) the `mcp` config block in [src/config.ts](../../../../src/config.ts#L137-L168). G35 edits only the standalone env-filter region at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L432) and a new exported predicate in [src/security/secrets.ts](../../../../src/security/secrets.ts#L1). **No `mcp` config key is added**, so the alphabetical-ordering negotiation between G31/G32/G33/G34 is unaffected.
- **Co-edit in security**: a new export in [src/security/secrets.ts](../../../../src/security/secrets.ts#L1) and a new `describe` block in [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1). No other neighbour in batch G3x touches `src/security/`.

## 5. Test gates

- `vitest run src/security/secrets.test.ts` — both new corpora pass.
- `vitest run src/mcp/builtins.test.ts` — the two-assertion `filterShellEnv` integration block passes.
- `grep -c 'SECRET_ENV_PATTERNS' src/mcp/builtins.ts` → exactly `0` (the obsolete constant is removed, not commented).
- `grep -c "from \"../security/secrets.js\"" src/mcp/builtins.ts` → at least `1` (the predicate import lands).
- `grep -n 'isSecretEnvName' src/security/secrets.ts` → at least two lines (definition + the `export function` line; the file-internal helpers are not exported).
- `npx tsc --noEmit` — clean.
