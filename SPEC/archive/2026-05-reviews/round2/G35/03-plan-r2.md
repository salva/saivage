# G35 — Implementation plan r2

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)

**Design**: [02-design-r2.md](02-design-r2.md)

**Round-1 review addressed**: [04-review-r1.md](04-review-r1.md)

**Writer**: Claude Opus 4.7 (round 2)

## 1. Scope

Implements Proposal A (round-2 form) from [02-design-r2.md §2](02-design-r2.md#L1). Two source files and two test files are edited; no config-schema changes; no new module. The round-1 plan's third predicate layer (`SECRET_ENV_FORCE_PATTERNS`) is **not** implemented (B2 fix from [04-review-r1.md](04-review-r1.md#L7)).

## 2. Files touched

| # | File | Edit kind |
|---|---|---|
| F1 | [src/security/secrets.ts](../../../../src/security/secrets.ts#L1) | Append two file-private constants (`SECRET_ENV_NAME_PATTERNS`, `ENV_CONFIG_POINTER_SUFFIXES`) and one exported predicate (`isSecretEnvName`) after the existing `BLOCKED_PATH_RULES` block, before `shannonEntropy`. |
| F2 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L432) | Delete `SECRET_ENV_PATTERNS` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L422)); rewrite `filterShellEnv` body to call `isSecretEnvName`; add the import; rewrite the JSDoc above `filterShellEnv` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L406)) to a one-paragraph pointer at `secrets.ts`. |
| F3 | [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) | Append one `describe("isSecretEnvName — false positives")` block iterating the FP corpus from [02-design-r2.md §2.4](02-design-r2.md#L1) and one `describe("isSecretEnvName — false negatives")` block iterating the FN corpus. |
| F4 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) | Append one `describe("filterShellEnv")` block with the two integration assertions from [02-design-r2.md §2.4](02-design-r2.md#L1). |

No edits to [src/config.ts](../../../../src/config.ts#L137-L168). No new files. No round-1 `SECRET_ENV_FORCE_PATTERNS` constant.

## 3. Step-by-step

1. **F1 — extend src/security/secrets.ts**. Locate `const BLOCKED_PATH_RULES: ReadonlyArray<RegExp> = [` at [src/security/secrets.ts](../../../../src/security/secrets.ts#L67-L76) and its closing `];`. Insert, immediately after that `];` and before the `shannonEntropy` function at [src/security/secrets.ts](../../../../src/security/secrets.ts#L79), the JSDoc + three declarations exactly as written in [02-design-r2.md §2.1](02-design-r2.md#L1):
   - `const SECRET_ENV_NAME_PATTERNS: ReadonlyArray<RegExp> = [ ... ];` — seven regexes, file-private (no `export`).
   - `const ENV_CONFIG_POINTER_SUFFIXES: ReadonlyArray<string> = [ ... ];` — eight uppercase suffix strings (`_URL`, `_URI`, `_ENDPOINT`, `_PATH`, `_DIR`, `_FILE`, `_PROMPT`, `_TEMPLATE`), file-private.
   - `export function isSecretEnvName(name: string): boolean { ... }` — the only `export` added.

2. **F2 — rewrite the env-filter region in src/mcp/builtins.ts**. The region is [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L432). Operations, in order:
   - In the import section at the top of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1), add `import { isSecretEnvName } from "../security/secrets.js";`. Place it next to any other `../security/...` imports if present; otherwise next to the other intra-package imports.
   - Delete the entire `const SECRET_ENV_PATTERNS: RegExp[] = [ ... ];` block at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L422). No replacement constant in this file.
   - Rewrite the JSDoc at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L406) to the three-line pointer form from [02-design-r2.md §2.3](02-design-r2.md#L1): "Strip credential-shaped environment variable names from the parent process's env before spawning a shell child. The rule set lives in `src/security/secrets.ts` as `isSecretEnvName`."
   - Inside `filterShellEnv` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L431)), replace the line `if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;` with `if (isSecretEnvName(key)) continue;`. No other lines in the function body change.
   - The `spawn` call at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L451) is untouched.

3. **F3 — add corpora tests**. In [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1), append two new `describe` blocks after the last existing `describe(...)`:
   - Add `import { isSecretEnvName } from "./secrets.js";` to the existing import block at the top (alongside the existing `scanForSecrets` / `redact` imports).
   - `describe("isSecretEnvName — false positives", () => { const NAMES: ReadonlyArray<string> = [ ...FP corpus from 02-design-r2.md §2.4... ]; it.each(NAMES)("%s is not a secret name", (name) => expect(isSecretEnvName(name)).toBe(false)); });` — 37 rows, copied verbatim, one per line, in the order given.
   - `describe("isSecretEnvName — false negatives", () => { const NAMES: ReadonlyArray<string> = [ ...FN corpus from 02-design-r2.md §2.4... ]; it.each(NAMES)("%s is a secret name", (name) => expect(isSecretEnvName(name)).toBe(true)); });` — 27 rows, copied verbatim, one per line, in the order given.
   - The two arrays are typed `ReadonlyArray<string>` exactly; no extra entries, no reordering, no inline comments inside the arrays.

4. **F4 — add integration assertion**. In [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1), append a new `describe("filterShellEnv")` block at the end:
   - Ensure `filterShellEnv` is imported from `./builtins.js` (add to the existing import line if needed).
   - Two `it(...)` assertions, exactly as in [02-design-r2.md §2.4](02-design-r2.md#L1): FP preserved (`RESET_PASSWORD_URL` survives) and FN dropped (`ANTHROPIC_API_KEY` is removed). The literal values `"https://example.test/reset"` and `"sk-test-not-real"` are syntactic placeholders.
   - No spawning, no temp dir setup; the block is independent of any pre-existing `beforeEach` / `afterEach`.

## 4. Order of edits (single commit)

1. F1 — add the new exports in `secrets.ts`.
2. F3 — add the corpora tests against the new exports.
3. F2 — rewrite `builtins.ts` to consume the new export and delete the obsolete constant.
4. F4 — add the integration assertion in `builtins.test.ts`.

This order keeps the tree compiling after every step: F1 introduces an unused export, F3 references it, F2 swaps the call site, F4 exercises it. If F2 lands before F1, `tsc` breaks on the missing import.

## 5. Test gates (all must be green at end of commit)

1. `vitest run src/security/secrets.test.ts` — every row in both corpora (37 FP + 27 FN) passes its assertion.
2. `vitest run src/mcp/builtins.test.ts` — pre-existing tests still pass; the new two-assertion `filterShellEnv` block passes.
3. `npx tsc --noEmit` — clean (no missing-import errors, no dangling references to `SECRET_ENV_PATTERNS`).
4. `grep -c 'SECRET_ENV_PATTERNS' src/mcp/builtins.ts` → `0` exactly.
5. `grep -c 'SECRET_ENV_FORCE_PATTERNS' src/security/secrets.ts src/mcp/builtins.ts` → `0` exactly (the round-1 force layer must not land).
6. `grep -c 'isSecretEnvName' src/mcp/builtins.ts` → at least `2` (one import line + one call site).
7. `grep -c 'export function isSecretEnvName' src/security/secrets.ts` → exactly `1`.
8. `grep -nE 'SECRET_ENV_NAME_PATTERNS|ENV_CONFIG_POINTER_SUFFIXES' src/security/secrets.ts` → at least two lines; neither prefixed with `export ` (the constants are file-private).
9. `grep -n '_PROMPT\|_TEMPLATE' src/security/secrets.ts` → at least one hit for each (proves the B1 suffixes landed).
10. `grep -n "'PASSWORD_PROMPT'\\|\"PASSWORD_PROMPT\"" src/security/secrets.test.ts` → at least one hit (proves the B1 corpus row landed).
11. `grep -n "'SLACK_TOKEN'\\|\"SLACK_TOKEN\"" src/security/secrets.test.ts` → at least one hit (proves the B3 corpus row landed).

## 6. Out of scope

- No edits to [src/config.ts](../../../../src/config.ts#L137-L168) (Proposal B remains rejected — see [02-design-r2.md §3](02-design-r2.md#L1)).
- No edits to the rest of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1) outside the env-filter region (the tool-handler `switch` is owned by G30/G31/G32/G33/G34).
- No edits to the content-shape rules in [src/security/secrets.ts](../../../../src/security/secrets.ts#L1) (`PROVIDER_RULES`, `LITERAL_RULES`, `ENV_ASSIGNMENT_PATTERN`, `BLOCKED_PATH_RULES`, `shannonEntropy`, `scanForSecrets`, `redact`, `isBlockedPath`).
- No documentation files updated. The `SECRET_ENV_PATTERNS` constant has no public docs page; the JSDoc rewrite in F2 is the only narrative change.
- No re-introduction of any provider-prefix force layer. If a future finding requires scrubbing a provider-namespaced non-credential name (e.g. a hypothetical `OPENAI_ORG_ID`), it must add an explicit credential lexeme or extend the lexeme list — not a prefix bypass.
