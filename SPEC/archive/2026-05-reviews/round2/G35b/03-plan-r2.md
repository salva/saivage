# G35b — Implementation plan r2

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)

**Design**: [02-design-r2.md](02-design-r2.md)

**Round 1**: [03-plan-r1.md](03-plan-r1.md), reviewed in [04-review-r1.md](04-review-r1.md).

**Writer**: Claude Opus 4.7, round 2.

## 1. Scope

Implements Proposal A (round-2 form) from
[02-design-r2.md §2](02-design-r2.md). Same file set as round 1
[03-plan-r1.md §2](03-plan-r1.md#L20-L40); deltas relative to round
1 are inside F1 (compiler body), F14 (extended FN corpus, added
replacement-semantics `it`), F15 (added two empty-string negative
pins and one accept-empty-suffix positive pin), and F16 (added the
hyphen-form `it` and two replacement-semantics integration `it`s).

## 2. Files touched

| # | File | Edit kind |
|---|---|---|
| F1 | [src/security/secrets.ts](../../../../src/security/secrets.ts#L77-L80) | Append `DEFAULT_CREDENTIAL_LEXEMES`, `DEFAULT_CONFIG_POINTER_SUFFIXES`, `SecretEnvNameRules`, `createSecretEnvNamePredicate`. The compiler body uses the round-2 formula: escape metachars, then `_` → `[_-]`, then wrap in `(?:^|[_-])${escaped}S?(?:$|[_-])`. |
| F2 | [src/config.ts](../../../../src/config.ts#L1-L11) | Add import `{ DEFAULT_CREDENTIAL_LEXEMES, DEFAULT_CONFIG_POINTER_SUFFIXES } from "./security/secrets.js"`. |
| F3 | [src/config.ts](../../../../src/config.ts#L111-L117) | Append `envScrubber` sub-object: `credentialLexemes: array(string.regex(/^[A-Z][A-Z0-9_]*$/)).min(1).default([...DEFAULT_CREDENTIAL_LEXEMES])`, `configPointerSuffixes: array(string.regex(/^_[A-Z][A-Z0-9_]*$/)).default([...DEFAULT_CONFIG_POINTER_SUFFIXES])`. Defaults are Zod-applied at parse time; the on-disk JSON is never mutated by Saivage. |
| F4 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1-L40) | Add import `{ createSecretEnvNamePredicate, DEFAULT_CREDENTIAL_LEXEMES, DEFAULT_CONFIG_POINTER_SUFFIXES } from "../security/secrets.js"`. |
| F5 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L398-L421) | Delete `SECRET_ENV_PATTERNS` block; insert `let secretEnvNamePredicate = createSecretEnvNamePredicate({ credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES, configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES })` with JSDoc noting full-replacement semantics. |
| F6 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432) | In `filterShellEnv`, replace `if (SECRET_ENV_PATTERNS.some(...)) continue;` with `if (secretEnvNamePredicate(key)) continue;`. |
| F7 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082) | Add third positional `securityConfig: SaivageConfig["security"]`; after the `SHELL_TIMEOUT_FLOOR_MS = ...` assignment, assign `secretEnvNamePredicate = createSecretEnvNamePredicate({ credentialLexemes: securityConfig.envScrubber.credentialLexemes, configPointerSuffixes: securityConfig.envScrubber.configPointerSuffixes })`. |
| F8 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145) | `registerBuiltinServices(mcpRuntime, config.mcp, config.security, { promptInjectionCop: ... })`. |
| F9 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56) | `registerBuiltinServices(runtime, cfg.mcp, cfg.security)`. |
| F10 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232) | `registerBuiltinServices(runtime, cfg.mcp, cfg.security, { promptInjectionCop: blockingCop })`. |
| F11 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252) | Same shape as F10. |
| F12 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287) | `registerBuiltinServices(runtime, cfg.mcp, cfg.security)`. |
| F13 | [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24) | `registerBuiltinServices(runtime, cfg.mcp, cfg.security)`. |
| F14 | [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) | Append imports + three `describe` blocks: defaults FP corpus, defaults FN corpus (now with `ACCESS-KEY` and `SOME-ACCESS-KEY` rows added per [02-design-r2.md §2.6 A](02-design-r2.md)), and operator-override block with 5 `it`s including the explicit full-replacement case. |
| F15 | [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1) | Append `describe("security.envScrubber")` with 7 `it`s ([02-design-r2.md §2.6 B](02-design-r2.md)): defaults, empty-array reject, empty-string lexeme element reject (N2), lowercase reject, empty-string suffix element reject (N2), no-leading-underscore suffix reject, accept-empty-suffix-array. |
| F16 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) | Append `describe("filterShellEnv")` with 6 `it`s ([02-design-r2.md §2.6 C](02-design-r2.md)): FP preserved, FN dropped, hyphen-form `SOME_API-KEY` dropped (B1), additive PII, full-replacement lexeme list (B2), full-replacement suffix list = empty (B2). |

No new files. No new schema artefacts. No changes outside the table.

## 3. Step-by-step

### 3.1 F1 — extend [src/security/secrets.ts](../../../../src/security/secrets.ts#L1)

1. Locate `const BLOCKED_PATH_RULES: ReadonlyArray<RegExp> = [` at
   [src/security/secrets.ts](../../../../src/security/secrets.ts#L68)
   and its closing `];` at line 77.
2. Immediately after that `];` and before
   `function shannonEntropy` at
   [src/security/secrets.ts](../../../../src/security/secrets.ts#L80),
   insert the four declarations from
   [02-design-r2.md §2.1](02-design-r2.md):
   - `export const DEFAULT_CREDENTIAL_LEXEMES: ReadonlyArray<string>`
     with eleven entries in the documented order (`API_KEY`,
     `ACCESS_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`,
     `CREDENTIAL`, `AUTH`, `BEARER`, `COOKIE`, `SESSION`).
   - `export const DEFAULT_CONFIG_POINTER_SUFFIXES: ReadonlyArray<string>`
     with eight entries (`_URL`, `_URI`, `_ENDPOINT`, `_PATH`,
     `_DIR`, `_FILE`, `_PROMPT`, `_TEMPLATE`).
   - `export interface SecretEnvNameRules { ... }`.
   - `export function createSecretEnvNamePredicate(rules)` whose
     body is exactly:

     ```ts
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
     ```

   The metachar escape MUST come before the `_` → `[_-]` rewrite
   (the rewrite intentionally introduces `[`, `]`, and `-`, which
   would be mis-escaped if the order were reversed). The factory
   does NOT consult the defaults and does NOT union — it uses only
   the values inside `rules`.

### 3.2 F2, F3 — extend [src/config.ts](../../../../src/config.ts#L1)

1. In the import block at the top of
   [src/config.ts](../../../../src/config.ts#L1-L11), add a new
   import line:

   ```ts
   import {
     DEFAULT_CREDENTIAL_LEXEMES,
     DEFAULT_CONFIG_POINTER_SUFFIXES,
   } from "./security/secrets.js";
   ```

2. In the `security` block at
   [src/config.ts](../../../../src/config.ts#L111-L117), append the
   `envScrubber` field after `maxScanLengthBytes` at
   [src/config.ts](../../../../src/config.ts#L115):

   ```ts
   envScrubber: z
     .object({
       credentialLexemes: z
         .array(z.string().regex(/^[A-Z][A-Z0-9_]*$/))
         .min(1)
         .default([...DEFAULT_CREDENTIAL_LEXEMES]),
       configPointerSuffixes: z
         .array(z.string().regex(/^_[A-Z][A-Z0-9_]*$/))
         .default([...DEFAULT_CONFIG_POINTER_SUFFIXES]),
     })
     .default({}),
   ```

   The trailing `})` and `.default({})` of the outer `security`
   block at line 116-117 are unchanged.

### 3.3 F4–F7 — edit [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1)

1. **F4 — Add import** at the top of
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1-L40):

   ```ts
   import {
     createSecretEnvNamePredicate,
     DEFAULT_CREDENTIAL_LEXEMES,
     DEFAULT_CONFIG_POINTER_SUFFIXES,
   } from "../security/secrets.js";
   ```

2. **F5 — Replace `SECRET_ENV_PATTERNS` block.** Delete lines
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L398-L421)
   in full. Insert in their place the JSDoc + `let` from
   [02-design-r2.md §2.3](02-design-r2.md) step 2. The JSDoc must
   include the sentence "Operator overrides are full replacements"
   so a future code reader sees the contract inline.

3. **F6 — Rewrite `filterShellEnv` body** at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432).
   Replace the `SECRET_ENV_PATTERNS.some(...)` line with
   `if (secretEnvNamePredicate(key)) continue;`. No other change to
   `filterShellEnv` or to the spawn call at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L451).

4. **F7 — Extend `registerBuiltinServices`** at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082).
   Add the third positional parameter; immediately after the
   existing `SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;`
   at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1080),
   insert:

   ```ts
   secretEnvNamePredicate = createSecretEnvNamePredicate({
     credentialLexemes: securityConfig.envScrubber.credentialLexemes,
     configPointerSuffixes: securityConfig.envScrubber.configPointerSuffixes,
   });
   ```

   The rest of the function body is unchanged.

### 3.4 F8 — update [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145)

Insert `config.security` as the third positional argument:

```ts
registerBuiltinServices(mcpRuntime, config.mcp, config.security, {
  promptInjectionCop: createPromptInjectionCop(
    config,
    router,
    config.security.injectionScanner ? routing.resolve("security").modelSpec : undefined,
  ),
});
```

### 3.5 F9–F13 — update test callers

Five call sites; thread `cfg.security` between `cfg.mcp` and the
options object (or the closing `)`). Exact targets:

- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56):
  `registerBuiltinServices(runtime, cfg.mcp, cfg.security);`.
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232):
  `registerBuiltinServices(runtime, cfg.mcp, cfg.security, { promptInjectionCop: blockingCop });`.
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252):
  same shape as L232.
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287):
  `registerBuiltinServices(runtime, cfg.mcp, cfg.security);`.
- [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24):
  `registerBuiltinServices(runtime, cfg.mcp, cfg.security);`.

No other lines in those files are touched as part of F9–F13.

### 3.6 F14 — extend [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1)

1. Extend the existing named-import line to add
   `createSecretEnvNamePredicate`, `DEFAULT_CREDENTIAL_LEXEMES`,
   `DEFAULT_CONFIG_POINTER_SUFFIXES`.

2. After the final pre-existing `describe(...)` block, append three
   `describe` blocks:

   a. `describe("createSecretEnvNamePredicate — defaults / false positives")` —
      build `const p = createSecretEnvNamePredicate({
      credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
      configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES })` once;
      run `it.each(FP_NAMES)("%s is not a secret name", (name) =>
      expect(p(name)).toBe(false))` over the FP corpus from
      [../G35/02-design-r2.md §2.4](../G35/02-design-r2.md#L160-L195)
      verbatim (37 rows).

   b. `describe("createSecretEnvNamePredicate — defaults / false negatives")` —
      same shape, `expect(...).toBe(true)`, FN corpus from
      [02-design-r2.md §2.6 A step 2](02-design-r2.md) (29 rows —
      the G35 r2 FN corpus of 27 rows plus the new `ACCESS-KEY`
      and `SOME-ACCESS-KEY` rows that pin round-2's hyphen-form
      fix at the predicate layer).

   c. `describe("createSecretEnvNamePredicate — operator overrides")` —
      copy the five `it(...)` cases from
      [02-design-r2.md §2.6 A step 3](02-design-r2.md) verbatim:
      1. "adds a project-specific credential lexeme (additive)".
      2. "replaces the lexeme list (full-replacement semantics)" —
         B2 anchor at the predicate layer; asserts that
         `credentialLexemes: ["PII"]` does NOT scrub
         `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`,
         `DATABASE_PASSWORD`.
      3. "adds a project-specific config-pointer suffix (additive)".
      4. "replaces the suffix list with an empty array (layer 2
         off)" — second B2 anchor at the predicate layer; asserts
         that `configPointerSuffixes: []` causes
         `RESET_PASSWORD_URL` and `PASSWORD_PROMPT` to be
         classified as secret, while `OPENAI_BASE_URL` and `PATH`
         remain non-secret.
      5. "empty lexeme list produces an always-false predicate" —
         documents the factory contract; the schema-level rejection
         is tested in F15.

### 3.7 F15 — extend [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1)

Append `describe("security.envScrubber")` with 7 `it(...)` cases.
Each test uses the existing tmp-dir + `SAIVAGE_ROOT` pattern
already present in the file; reuse the existing
`beforeEach`/`afterEach` skeleton (consult the file before drafting
each test's body — do not invent a new fixture style).

1. "defaults to the built-in lexeme and suffix arrays" — write
   `.saivage/saivage.json` containing `{}`; call
   `loadConfig(true, projectRoot)`; assert
   `cfg.security.envScrubber.credentialLexemes` deep-equals
   `DEFAULT_CREDENTIAL_LEXEMES` (`expect(...).toEqual(...)` against
   a spread copy is the cleanest form) and likewise for
   `configPointerSuffixes`.
2. "rejects an empty `credentialLexemes` array" — write
   `{ "security": { "envScrubber": { "credentialLexemes": [] } } }`;
   expect `loadConfig(true, projectRoot)` to throw `ZodError`.
3. **"rejects an empty-string lexeme element" (N2 pin)** — write
   `{ "security": { "envScrubber": { "credentialLexemes": [""] } } }`;
   expect throw. Proves the per-element
   `regex(/^[A-Z][A-Z0-9_]*$/)` is wired (not just `.min(1)` on
   the array).
4. "rejects a lowercase credential lexeme" — write
   `{ "security": { "envScrubber": { "credentialLexemes": ["api_key"] } } }`;
   expect throw.
5. **"rejects an empty-string suffix element" (N2 pin)** — write
   `{ "security": { "envScrubber": { "configPointerSuffixes": [""] } } }`;
   expect throw. Mirrors test 3 for the suffix array.
6. "rejects a config-pointer suffix without leading underscore" —
   write `{ "security": { "envScrubber": { "configPointerSuffixes":
   ["URL"] } } }`; expect throw.
7. **"accepts an empty `configPointerSuffixes` array"** — write
   `{ "security": { "envScrubber": { "configPointerSuffixes": [] } } }`;
   assert `loadConfig(true, projectRoot)` returns a config with
   `cfg.security.envScrubber.configPointerSuffixes` deep-equal to
   `[]`. Locks the schema decision that an empty suffix list is
   legal (paired with override case 4 in F14 and integration case
   6 in F16).

### 3.8 F16 — extend [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1)

Append `describe("filterShellEnv")` with 6 `it(...)` cases. Helper
imports already present at the top of the file: `mkdtempSync`,
`mkdirSync`, `writeFileSync`, `rmSync`, `tmpdir`, `join`,
`loadConfig`. Add `filterShellEnv` to the existing
`./builtins.js` import (if not already there) and
`DEFAULT_CREDENTIAL_LEXEMES`,
`DEFAULT_CONFIG_POINTER_SUFFIXES` to the existing
`../security/secrets.js` import.

Cases 1, 2, 4 are at the unit layer (no `loadConfig` round-trip)
because they exercise the default predicate already wired by F5.
Cases 3, 5, 6 use the
`mkdtempSync → write saivage.json → loadConfig → McpRuntime →
registerBuiltinServices → filterShellEnv → assert` pattern.

1. "preserves config-pointer names (RESET_PASSWORD_URL)" — default
   predicate; assert
   `filterShellEnv({ RESET_PASSWORD_URL: "https://example.test/reset" })
   .RESET_PASSWORD_URL === "https://example.test/reset"`.

2. "drops credential-shaped names (ANTHROPIC_API_KEY)" — default
   predicate; assert
   `filterShellEnv({ ANTHROPIC_API_KEY: "sk-test-not-real" })
   .ANTHROPIC_API_KEY === undefined`.

3. **"drops hyphen-form credential names (SOME_API-KEY)" — B1
   anchor.** Default config; use the round-trip pattern. After
   `registerBuiltinServices(runtime, cfg.mcp, cfg.security);`,
   assert:

   ```ts
   expect(filterShellEnv({ "SOME_API-KEY": "x" })["SOME_API-KEY"]).toBeUndefined();
   ```

   Pins the round-2 compiler's `_` → `[_-]` rewrite at the
   integration layer; an implementation that escapes the lexeme
   literally without the rewrite cannot pass this case.

4. "honors operator-extended lexemes (additive)" — additive PII
   case. Round-trip pattern with config:

   ```json
   { "security": { "envScrubber": {
     "credentialLexemes": [
       "API_KEY","ACCESS_KEY","TOKEN","SECRET","PASSWORD","PASSWD",
       "CREDENTIAL","AUTH","BEARER","COOKIE","SESSION","PII"
     ]
   } } }
   ```

   Assertions:
   - `filterShellEnv({ PII_DATA: "x" }).PII_DATA === undefined`.
   - `filterShellEnv({ ANTHROPIC_API_KEY: "x" }).ANTHROPIC_API_KEY === undefined`.
   - `filterShellEnv({ RESET_PASSWORD_URL: "y" }).RESET_PASSWORD_URL === "y"`.

5. **"honors operator-REPLACED lexeme list (full replacement)" —
   B2 anchor for the lexeme array.** Round-trip pattern with config:

   ```json
   { "security": { "envScrubber": {
     "credentialLexemes": ["PII"]
   } } }
   ```

   Assertions:
   - `filterShellEnv({ PII_DATA: "x" }).PII_DATA === undefined`
     (the new singleton lexeme is honored).
   - `filterShellEnv({ ANTHROPIC_API_KEY: "x" }).ANTHROPIC_API_KEY === "x"`
     (defaults are NOT silently retained; full replacement).

   An additive-only implementation cannot pass the second
   assertion because the un-removed default `API_KEY` lexeme would
   still match `ANTHROPIC_API_KEY`.

6. **"honors operator-REPLACED suffix list (empty disables layer
   2)" — B2 anchor for the suffix array.** Round-trip pattern with
   config:

   ```json
   { "security": { "envScrubber": {
     "configPointerSuffixes": []
   } } }
   ```

   Assertions:
   - `filterShellEnv({ RESET_PASSWORD_URL: "y" }).RESET_PASSWORD_URL === undefined`
     (the `_URL` exemption is gone).
   - `filterShellEnv({ ANTHROPIC_API_KEY: "x" }).ANTHROPIC_API_KEY === undefined`
     (lexeme layer untouched).
   - `filterShellEnv({ OPENAI_BASE_URL: "z" }).OPENAI_BASE_URL === "z"`
     (no lexeme match, so the name passes through).

Each round-trip case MUST restore `process.env["PROJECT_ROOT"]`
and `process.env["SAIVAGE_ROOT"]` and `rmSync(projectRoot, {
recursive: true, force: true })` in a `finally` block, mirroring
the existing pattern in the file. Tests 3, 5, 6 also each rebuild
the predicate via `registerBuiltinServices`; because the predicate
is module-level state, tests in this block run sequentially. The
final test in the block SHOULD end by restoring the default
predicate (call `registerBuiltinServices(runtime, cfg.mcp,
cfg.security)` with a fresh `loadConfig(true, defaultRoot)` whose
project root has no `saivage.json`) so unrelated tests later in
the file see the default behavior. If the file already uses an
`afterEach` that resets module state, reuse that hook instead.

## 4. Order of edits (single commit)

1. F1 — add the new exports in `secrets.ts` (new code unused at
   this point).
2. F2 + F3 — extend the Zod schema in `config.ts`.
3. F4 + F5 + F6 + F7 — switch `builtins.ts` to the new predicate
   and delete `SECRET_ENV_PATTERNS`. This breaks the existing
   callers.
4. F8 — update bootstrap caller.
5. F9 + F10 + F11 + F12 + F13 — update the five test callers; tree
   compiles again.
6. F14 — add the corpora + override predicate tests.
7. F15 — add the schema-rejection / accept-empty-suffix tests.
8. F16 — add the integration tests (defaults, hyphen-form,
   additive, full-replacement lexeme, full-replacement suffix).

This order keeps the tree compiling after step 2, breaks once at
step 3, restores at step 5, and adds the new tests last so they
don't reference symbols that haven't landed yet.

## 5. Test gates (all must be green at end of commit)

1. `npx tsc --noEmit` — clean; no reference to
   `SECRET_ENV_PATTERNS` remains.
2. `vitest run src/security/secrets.test.ts` — defaults FP corpus
   green (37 rows), defaults FN corpus green (29 rows, incl.
   `SOME_API-KEY`, `ACCESS-KEY`, `SOME-ACCESS-KEY`), five
   operator-override `it`s green.
3. `vitest run src/config-validation.test.ts` — all 7
   `security.envScrubber` `it`s green.
4. `vitest run src/mcp/builtins.test.ts` — pre-existing tests
   green; the new `describe("filterShellEnv")` block (6 `it`s)
   green.
5. `vitest run src/mcp/fsGuard.test.ts` — pre-existing tests green
   with the new positional argument shape.
6. `grep -c 'SECRET_ENV_PATTERNS' src/mcp/builtins.ts` → `0`.
7. `grep -c 'SECRET_ENV_NAME_PATTERNS\|ENV_CONFIG_POINTER_SUFFIXES'
   src/security/secrets.ts src/mcp/builtins.ts` → `0` (the
   disapproved G35 r2 constants do NOT land).
8. `grep -c 'createSecretEnvNamePredicate' src/mcp/builtins.ts` →
   at least `2` (exactly 3: import + initial assignment + body
   assignment).
9. `grep -c 'export function createSecretEnvNamePredicate'
   src/security/secrets.ts` → exactly `1`.
10. `grep -c 'export const DEFAULT_CREDENTIAL_LEXEMES'
    src/security/secrets.ts` → exactly `1`.
11. `grep -c 'export const DEFAULT_CONFIG_POINTER_SUFFIXES'
    src/security/secrets.ts` → exactly `1`.
12. `grep -c 'envScrubber' src/config.ts` → exactly `1`.
13. `grep -n '"COOKIE"\|"SESSION"\|"BEARER"\|"AUTH"'
    src/security/secrets.ts` → at least four matches.
14. `grep -n 'security.envScrubber.credentialLexemes'
    src/mcp/builtins.ts` → at least one match.
15. `grep -c 'registerBuiltinServices(.*cfg.mcp,.*cfg.security'
    src/mcp/builtins.test.ts src/mcp/fsGuard.test.ts` → at least
    `5`.
16. `grep -n 'PII_DATA' src/mcp/builtins.test.ts` → at least two
    matches (additive case + full-replacement case).
17. **`grep -n 'SOME_API-KEY' src/security/secrets.test.ts
    src/mcp/builtins.test.ts` → at least two matches (one per
    file; predicate corpus + integration anchor; B1 anchor).**
18. **`grep -n 'credentialLexemes: \[.PII.\]'
    src/mcp/builtins.test.ts` → at least one match (the
    full-replacement lexeme integration case; B2 anchor).**
19. **`grep -n 'configPointerSuffixes: \[\]'
    src/mcp/builtins.test.ts src/config-validation.test.ts` → at
    least two matches (integration case 6 + schema case 7).**
20. **`grep -n '\\\\[_-\\\\]' src/security/secrets.ts` (escape the
    bracket and backslash for the shell) → at least two matches:
    one in the JSDoc and one in the compiler body's
    `replace(/_/g, "[_-]")` step. Sentinel for the B1 compiler
    fix.**

Test gates 17–20 are new in round 2 and exist specifically to
catch a future refactor that silently removes the B1 fix
(`SOME_API-KEY` row, the `_` → `[_-]` rewrite) or the B2
anchors (singleton-`PII` lexeme override case, empty-suffix
override case).

## 6. Out of scope

- No edits to
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L34-L67)
  outside the inserted block (`PROVIDER_RULES`, `LITERAL_RULES`,
  `ENV_ASSIGNMENT_PATTERN`, `BLOCKED_PATH_RULES`, `shannonEntropy`,
  `scanForSecrets`, `redact`, `isBlockedPath`).
- No changes to
  [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L1)
  (consumes `config.security` but only the unchanged
  `injectionScanner` / `injectionModel` / `maxScanLengthBytes`
  fields).
- No documentation files. No README updates. The JSDoc rewrites
  in F1 and F5 are the only narrative changes.
- No new JSON-Schema artefact (none exists; the Zod schema is the
  single source of truth — see
  [01-analysis-r2.md §2](01-analysis-r2.md)).
- No re-introduction of the disapproved hardcoded module
  constants from
  [../G35/02-design-r2.md §2.1](../G35/02-design-r2.md). If a
  reviewer asks for the lexeme list to revert to a compiled-in
  constant, that is a directive change above this finding's pay
  grade and must be escalated.
- No changes to
  [src/routing/resolver.ts](../../../../src/routing/resolver.ts)
  or the G25 config-validation surface (reviewer note N4 in
  [04-review-r1.md](04-review-r1.md#L17)).
