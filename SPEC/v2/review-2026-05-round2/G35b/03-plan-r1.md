# G35b — Implementation plan r1

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

**Design**: [02-design-r1.md](02-design-r1.md)

**Writer**: Claude Opus 4.7, round 1.

## 1. Scope

Implements Proposal A from [02-design-r1.md §2](02-design-r1.md#L1).
Three source files, three test files. One Zod schema field is added
under `security.envScrubber`; the credential lexeme list and the
config-pointer suffix list now live in
[.saivage/saivage.json](../../../../src/config.ts#L271-L273) with
defaults imported from
[src/security/secrets.ts](../../../../src/security/secrets.ts#L80).
The disapproved hardcoded module constants from
[../G35/02-design-r2.md](../G35/02-design-r2.md) are **not**
introduced.

## 2. Files touched

| # | File | Edit kind |
|---|---|---|
| F1 | [src/security/secrets.ts](../../../../src/security/secrets.ts#L77-L80) | Append `DEFAULT_CREDENTIAL_LEXEMES`, `DEFAULT_CONFIG_POINTER_SUFFIXES` (exported `ReadonlyArray<string>`), `SecretEnvNameRules` interface, and `createSecretEnvNamePredicate` factory after `BLOCKED_PATH_RULES` and before `shannonEntropy`. |
| F2 | [src/config.ts](../../../../src/config.ts#L1-L11) | Add import `{ DEFAULT_CREDENTIAL_LEXEMES, DEFAULT_CONFIG_POINTER_SUFFIXES } from "./security/secrets.js"`. |
| F3 | [src/config.ts](../../../../src/config.ts#L111-L117) | Append `envScrubber` sub-object to the `security` block with `credentialLexemes` (`array(string.regex(...)).min(1).default([...DEFAULT_CREDENTIAL_LEXEMES])`) and `configPointerSuffixes` (`array(string.regex(...)).default([...DEFAULT_CONFIG_POINTER_SUFFIXES])`). |
| F4 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1-L40) | Add import `{ createSecretEnvNamePredicate, DEFAULT_CREDENTIAL_LEXEMES, DEFAULT_CONFIG_POINTER_SUFFIXES } from "../security/secrets.js"`. |
| F5 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L398-L421) | Delete the `SECRET_ENV_PATTERNS` JSDoc + constant; insert `let secretEnvNamePredicate = createSecretEnvNamePredicate({ credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES, configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES })` in its place with a new short JSDoc pointing at `secrets.ts` and `security.envScrubber`. |
| F6 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432) | In `filterShellEnv`, replace the line `if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;` with `if (secretEnvNamePredicate(key)) continue;`. |
| F7 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082) | Add third positional parameter `securityConfig: SaivageConfig["security"]` to `registerBuiltinServices`; immediately after `SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;`, assign `secretEnvNamePredicate = createSecretEnvNamePredicate({ credentialLexemes: securityConfig.envScrubber.credentialLexemes, configPointerSuffixes: securityConfig.envScrubber.configPointerSuffixes });`. |
| F8 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145) | Update call to `registerBuiltinServices(mcpRuntime, config.mcp, config.security, { promptInjectionCop: ... })`. |
| F9 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56) | Update call to `registerBuiltinServices(runtime, cfg.mcp, cfg.security)`. |
| F10 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232) | Update call to `registerBuiltinServices(runtime, cfg.mcp, cfg.security, { promptInjectionCop: blockingCop })`. |
| F11 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252) | Same shape as F10. |
| F12 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287) | Update call to `registerBuiltinServices(runtime, cfg.mcp, cfg.security)`. |
| F13 | [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24) | Update call to `registerBuiltinServices(runtime, cfg.mcp, cfg.security)`. |
| F14 | [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) | Append imports (`createSecretEnvNamePredicate`, `DEFAULT_CREDENTIAL_LEXEMES`, `DEFAULT_CONFIG_POINTER_SUFFIXES`) and three `describe` blocks: defaults FP corpus, defaults FN corpus, operator-override mutations (§2.6 A of [02-design-r1.md](02-design-r1.md#L1)). |
| F15 | [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1) | Append a `describe("security.envScrubber")` block with the four schema assertions from §2.6 B of [02-design-r1.md](02-design-r1.md#L1). |
| F16 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) | Append a final `describe("filterShellEnv")` block with three `it(...)` assertions: FP preserved (`RESET_PASSWORD_URL`), FN dropped (`ANTHROPIC_API_KEY`), and the G35b-mandated config-mutation end-to-end assertion (project config adds `PII` lexeme, then `filterShellEnv({ PII_DATA: ... }).PII_DATA === undefined`). |

No new files. No new schema artefacts. No changes outside the table.

## 3. Step-by-step

### 3.1 F1 — extend [src/security/secrets.ts](../../../../src/security/secrets.ts#L1)

1. Locate `const BLOCKED_PATH_RULES: ReadonlyArray<RegExp> = [` at
   [src/security/secrets.ts](../../../../src/security/secrets.ts#L68)
   and its closing `];` at line 77.
2. Immediately after that `];` and before
   `function shannonEntropy` at
   [src/security/secrets.ts](../../../../src/security/secrets.ts#L80),
   insert the JSDoc + four declarations exactly as written in
   [02-design-r1.md §2.1](02-design-r1.md#L1):
   - `export const DEFAULT_CREDENTIAL_LEXEMES: ReadonlyArray<string> = [ ... ];` —
     eleven entries in the order `API_KEY`, `ACCESS_KEY`, `TOKEN`,
     `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `AUTH`, `BEARER`,
     `COOKIE`, `SESSION`.
   - `export const DEFAULT_CONFIG_POINTER_SUFFIXES: ReadonlyArray<string> = [ ... ];` —
     eight entries `_URL`, `_URI`, `_ENDPOINT`, `_PATH`, `_DIR`,
     `_FILE`, `_PROMPT`, `_TEMPLATE`.
   - `export interface SecretEnvNameRules { credentialLexemes: ReadonlyArray<string>; configPointerSuffixes: ReadonlyArray<string>; }`.
   - `export function createSecretEnvNamePredicate(rules: SecretEnvNameRules): (name: string) => boolean { ... }` —
     body is the `lexemePatterns.map(...)` regex compile + closure
     predicate from §2.1.

### 3.2 F2, F3 — extend [src/config.ts](../../../../src/config.ts#L1)

1. In the import block at the top of
   [src/config.ts](../../../../src/config.ts#L1-L11) (after the
   existing `import { … } from "./auth/defaults.js"` import block
   ending at line 10), add a new line:

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

1. **F4 — Add import.** At the top of
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1-L40), in
   the same group as any existing `../security/...` imports (or
   alongside the other intra-package imports if none), add:

   ```ts
   import {
     createSecretEnvNamePredicate,
     DEFAULT_CREDENTIAL_LEXEMES,
     DEFAULT_CONFIG_POINTER_SUFFIXES,
   } from "../security/secrets.js";
   ```

2. **F5 — Replace `SECRET_ENV_PATTERNS` block.** Delete lines
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L398-L421)
   (the JSDoc starting `/** Patterns of environment variable names …`
   plus the `const SECRET_ENV_PATTERNS: RegExp[] = [ … ];` block).
   Insert in their place:

   ```ts
   /**
    * Env-var NAME classifier used by `filterShellEnv` below. The
    * rule set lives in .saivage/saivage.json under
    * security.envScrubber; defaults come from src/security/secrets.ts.
    * Rebuilt at the start of registerBuiltinServices from the
    * resolved config and captured here so the spawn path stays
    * allocation-free.
    */
   let secretEnvNamePredicate: (name: string) => boolean =
     createSecretEnvNamePredicate({
       credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
       configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
     });
   ```

3. **F6 — Rewrite `filterShellEnv` body.** Inside `filterShellEnv` at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432),
   replace line 427:

   ```ts
   if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;
   ```

   with:

   ```ts
   if (secretEnvNamePredicate(key)) continue;
   ```

   The rest of the function body is unchanged. The spawn call at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L451)
   `env: { ...filterShellEnv(process.env), PROJECT_ROOT: projectRoot() }`
   is not modified.

4. **F7 — Extend `registerBuiltinServices`.** At
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082)
   change the signature to:

   ```ts
   export function registerBuiltinServices(
     mcpRuntime: McpRuntime,
     mcpConfig: import("../config.js").SaivageConfig["mcp"],
     securityConfig: import("../config.js").SaivageConfig["security"],
     options: BuiltinServicesOptions = {},
   ): void {
   ```

   Immediately after the existing line
   `SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;` at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1080),
   insert:

   ```ts
   secretEnvNamePredicate = createSecretEnvNamePredicate({
     credentialLexemes: securityConfig.envScrubber.credentialLexemes,
     configPointerSuffixes: securityConfig.envScrubber.configPointerSuffixes,
   });
   ```

   The rest of the function body (everything from `const innerCapMs
   = mcpConfig.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS;` onward) is
   unchanged.

### 3.4 F8 — update [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145)

Existing call:

```ts
registerBuiltinServices(mcpRuntime, config.mcp, {
  promptInjectionCop: createPromptInjectionCop(
    config,
    router,
    config.security.injectionScanner ? routing.resolve("security").modelSpec : undefined,
  ),
});
```

Becomes:

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

- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56):
  `registerBuiltinServices(runtime, cfg.mcp);` → `registerBuiltinServices(runtime, cfg.mcp, cfg.security);`.
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232):
  `registerBuiltinServices(runtime, cfg.mcp, { promptInjectionCop: blockingCop });` → `registerBuiltinServices(runtime, cfg.mcp, cfg.security, { promptInjectionCop: blockingCop });`.
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252):
  same shape as L232.
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287):
  same shape as L56.
- [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24):
  same shape as L56.

No other lines in those files are touched.

### 3.6 F14 — extend [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1)

1. In the import block at line 5 (`import { isBlockedPath, redact,
   scanForSecrets } from "./secrets.js";`), extend the named imports
   to include `createSecretEnvNamePredicate`,
   `DEFAULT_CREDENTIAL_LEXEMES`, `DEFAULT_CONFIG_POINTER_SUFFIXES`.

2. After the final pre-existing `describe(...)` block, append three
   `describe` blocks:

   a. `describe("createSecretEnvNamePredicate — defaults / false positives")` —
      build `const p = createSecretEnvNamePredicate({ credentialLexemes:
      DEFAULT_CREDENTIAL_LEXEMES, configPointerSuffixes:
      DEFAULT_CONFIG_POINTER_SUFFIXES });` once at the top of the block;
      run `it.each(NAMES)("%s is not a secret name", (name) =>
      expect(p(name)).toBe(false))` over the FP corpus from
      [../G35/02-design-r2.md §2.4](../G35/02-design-r2.md#L1) (37 rows,
      verbatim).

   b. `describe("createSecretEnvNamePredicate — defaults / false negatives")` —
      same shape, FN corpus (27 rows, verbatim), expect `toBe(true)`.

   c. `describe("createSecretEnvNamePredicate — operator overrides")` —
      three `it(...)` cases exactly as in
      [02-design-r1.md §2.6 A](02-design-r1.md#L1):
      - "adds a project-specific credential lexeme" — extends
        `credentialLexemes` with `"PII"`; asserts `PII_DATA`,
        `MY_PII`, `PII_URL`, `ANTHROPIC_API_KEY`,
        `RESET_PASSWORD_URL` classifications.
      - "adds a project-specific config-pointer suffix" — extends
        `configPointerSuffixes` with `"_BUILDFILE"`; asserts
        `ARTIFACT_TOKEN_BUILDFILE` and `ARTIFACT_TOKEN`
        classifications.
      - "empty lexeme list produces always-false predicate" —
        constructs with `credentialLexemes: []`; asserts
        `ANTHROPIC_API_KEY` classifies as `false`. (Documents the
        contract; the schema-level rejection is tested in F15.)

### 3.7 F15 — extend [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1)

Append a `describe("security.envScrubber")` block at the end of the
file with four `it(...)` cases:

1. "defaults to the built-in lexeme and suffix arrays" — writes a
   project root with `.saivage/saivage.json` containing `{}`; calls
   `loadConfig(true, projectRoot)`; asserts
   `cfg.security.envScrubber.credentialLexemes` deep-equals
   `DEFAULT_CREDENTIAL_LEXEMES` (array-of-strings comparison) and
   the same for `configPointerSuffixes`.
2. "rejects an empty `credentialLexemes` array" — writes
   `{ "security": { "envScrubber": { "credentialLexemes": [] } } }`
   and expects `loadConfig(true, projectRoot)` to throw `ZodError`.
3. "rejects a lowercase credential lexeme" — writes
   `{ "security": { "envScrubber": { "credentialLexemes": ["api_key"] } } }`
   and expects throw.
4. "rejects a config-pointer suffix without leading underscore" —
   writes `{ "security": { "envScrubber": { "configPointerSuffixes":
   ["URL"] } } }` and expects throw.

Each test uses the existing tmp-dir + `SAIVAGE_ROOT` pattern from
[src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1)
(consult the existing tests in that file before drafting the
`beforeEach`/`afterEach` skeleton; reuse the existing pattern).

### 3.8 F16 — extend [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1)

Append a `describe("filterShellEnv")` block at the end of the file
with three `it(...)` cases. The block stands alone — no shared
`beforeEach`/`afterEach`:

1. "preserves config-pointer names (RESET_PASSWORD_URL)" — asserts
   `filterShellEnv({ RESET_PASSWORD_URL: "https://example.test/reset" })
   .RESET_PASSWORD_URL === "https://example.test/reset"`.

2. "drops credential-shaped names (ANTHROPIC_API_KEY)" — asserts
   `filterShellEnv({ ANTHROPIC_API_KEY: "sk-test-not-real" })
   .ANTHROPIC_API_KEY === undefined`.

3. **"honors operator-extended lexemes via security.envScrubber"** —
   the G35b-mandated config-mutation assertion:

   ```ts
   it("honors operator-extended lexemes via security.envScrubber", () => {
     const projectRoot = mkdtempSync(join(tmpdir(), "saivage-envscrub-"));
     const prevProject = process.env["PROJECT_ROOT"];
     const prevSaivage = process.env["SAIVAGE_ROOT"];
     process.env["PROJECT_ROOT"] = projectRoot;
     process.env["SAIVAGE_ROOT"] = join(projectRoot, ".saivage");
     mkdirSync(join(projectRoot, ".saivage"), { recursive: true });
     writeFileSync(
       join(projectRoot, ".saivage", "saivage.json"),
       JSON.stringify({
         security: {
           envScrubber: {
             credentialLexemes: [
               ...DEFAULT_CREDENTIAL_LEXEMES,
               "PII",
             ],
           },
         },
       }),
       "utf-8",
     );
     const cfg = loadConfig(true, projectRoot);
     const runtime = new McpRuntime(cfg);
     try {
       registerBuiltinServices(runtime, cfg.mcp, cfg.security);
       expect(filterShellEnv({ PII_DATA: "x" }).PII_DATA).toBeUndefined();
       expect(filterShellEnv({ ANTHROPIC_API_KEY: "x" }).ANTHROPIC_API_KEY).toBeUndefined();
       expect(filterShellEnv({ RESET_PASSWORD_URL: "y" }).RESET_PASSWORD_URL).toBe("y");
     } finally {
       // restore env + cleanup tmp dir using the existing test pattern
       if (prevProject === undefined) delete process.env["PROJECT_ROOT"];
       else process.env["PROJECT_ROOT"] = prevProject;
       if (prevSaivage === undefined) delete process.env["SAIVAGE_ROOT"];
       else process.env["SAIVAGE_ROOT"] = prevSaivage;
       rmSync(projectRoot, { recursive: true, force: true });
     }
   });
   ```

   The imports `mkdtempSync`, `mkdirSync`, `writeFileSync`, `rmSync`
   are already present at the top of the file
   ([src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1));
   add `filterShellEnv`, `DEFAULT_CREDENTIAL_LEXEMES` to the existing
   imports from `./builtins.js` and `../security/secrets.js`
   respectively, plus `tmpdir` from `node:os` (already imported) and
   `loadConfig` (already imported).

## 4. Order of edits (single commit)

1. F1 — add the new exports in `secrets.ts` (new code is unused at this point).
2. F2 + F3 — extend the Zod schema in `config.ts` so `cfg.security.envScrubber` is populated for every consumer.
3. F4 + F5 + F6 + F7 — switch `builtins.ts` to the new predicate; delete `SECRET_ENV_PATTERNS`. The third positional parameter of `registerBuiltinServices` is added here; this is the step that breaks every existing caller.
4. F8 — update bootstrap caller to pass `config.security`.
5. F9 + F10 + F11 + F12 + F13 — update the five test callers; tree compiles again.
6. F14 — add the corpora + override tests against `createSecretEnvNamePredicate`.
7. F15 — add the schema-rejection tests against `loadConfig`.
8. F16 — add the integration tests against `filterShellEnv` (including the config-mutation assertion).

This order keeps the tree compiling after step 2 (new exports
unused), then breaks once at step 3, and is restored at step 5.
Tests against the new surface are added last so they don't reference
symbols that haven't landed yet.

## 5. Test gates (all must be green at end of commit)

1. `npx tsc --noEmit` — clean. No reference to `SECRET_ENV_PATTERNS`
   remains.
2. `vitest run src/security/secrets.test.ts` — defaults FP corpus
   (37 rows) green, defaults FN corpus (27 rows) green, three
   operator-override `it`s green.
3. `vitest run src/config-validation.test.ts` — four
   `security.envScrubber` assertions green.
4. `vitest run src/mcp/builtins.test.ts` — pre-existing tests still
   green; the new `describe("filterShellEnv")` block (three `it`s,
   including the config-mutation end-to-end assertion) green.
5. `vitest run src/mcp/fsGuard.test.ts` — pre-existing tests green
   with the new positional argument shape.
6. `grep -c 'SECRET_ENV_PATTERNS' src/mcp/builtins.ts` → `0`.
7. `grep -c 'SECRET_ENV_NAME_PATTERNS\|ENV_CONFIG_POINTER_SUFFIXES' src/security/secrets.ts src/mcp/builtins.ts` → `0` (the disapproved G35 r2 constants do **not** land).
8. `grep -c 'createSecretEnvNamePredicate' src/mcp/builtins.ts` → at least `2` (import + initial assignment + body assignment = exactly `3`, but `≥ 2` is the test gate).
9. `grep -c 'export function createSecretEnvNamePredicate' src/security/secrets.ts` → exactly `1`.
10. `grep -c 'export const DEFAULT_CREDENTIAL_LEXEMES' src/security/secrets.ts` → exactly `1`.
11. `grep -c 'export const DEFAULT_CONFIG_POINTER_SUFFIXES' src/security/secrets.ts` → exactly `1`.
12. `grep -c 'envScrubber' src/config.ts` → exactly `1` (the Zod field declaration).
13. `grep -n '"COOKIE"\|"SESSION"\|"BEARER"\|"AUTH"' src/security/secrets.ts` → at least four matches (the new lexemes from the task statement landed).
14. `grep -n 'security.envScrubber.credentialLexemes' src/mcp/builtins.ts` → at least one match (the predicate is wired to the config field).
15. `grep -c 'registerBuiltinServices(.*cfg.mcp,.*cfg.security' src/mcp/builtins.test.ts src/mcp/fsGuard.test.ts` → at least `5` (the five test callers updated).
16. `grep -n 'PII_DATA' src/mcp/builtins.test.ts` → at least one match (the config-mutation end-to-end assertion landed).

## 6. Out of scope

- No edits to [src/security/secrets.ts](../../../../src/security/secrets.ts#L34-L67)
  outside the inserted block (`PROVIDER_RULES`, `LITERAL_RULES`,
  `ENV_ASSIGNMENT_PATTERN`, `BLOCKED_PATH_RULES`, `shannonEntropy`,
  `scanForSecrets`, `redact`, `isBlockedPath` are untouched).
- No changes to [src/security/prompt-injection-cop.ts](../../../../src/security/prompt-injection-cop.ts#L1)
  (consumes `config.security` but only the `injectionScanner` /
  `injectionModel` / `maxScanLengthBytes` fields, which are
  unchanged).
- No documentation files. No README updates. The JSDoc rewrites in
  F1 and F5 are the only narrative changes.
- No new JSON-Schema artefact (none exists; the Zod schema is the
  single source of truth — see [01-analysis-r1.md §2](01-analysis-r1.md#L1)).
- No re-introduction of the disapproved hardcoded module constants
  from [../G35/02-design-r2.md §2.1](../G35/02-design-r2.md). If a
  reviewer asks for the lexeme list to revert to a compiled-in
  constant, that is a directive change above this finding's pay
  grade and must be escalated.
