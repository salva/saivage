# G35 — Implementation plan r1

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

**Design**: [02-design-r1.md](02-design-r1.md)

**Writer**: Claude Opus 4.7 (round 1)

## 1. Scope

Implements Proposal A from [02-design-r1.md §2](02-design-r1.md#L19). Two source files are edited, one source file is edited as a one-line import and one-line call-site change, and two test files gain new `describe` blocks. No config-schema changes. No new module.

## 2. Files touched

| # | File | Edit kind |
|---|---|---|
| F1 | [src/security/secrets.ts](../../../../src/security/secrets.ts#L1) | Append three constants and one exported predicate after the existing `BLOCKED_PATH_RULES` block. |
| F2 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L432) | Delete `SECRET_ENV_PATTERNS`; rewrite `filterShellEnv` body to call `isSecretEnvName`; add the import line; rewrite the JSDoc above `filterShellEnv` to point at `secrets.ts`. |
| F3 | [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) | Add one `describe("isSecretEnvName — false positives")` block iterating over the FP corpus from [02-design-r1.md §2.4](02-design-r1.md#L93) and one `describe("isSecretEnvName — false negatives")` block iterating over the FN corpus from [02-design-r1.md §2.4](02-design-r1.md#L126). |
| F4 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) | Add one `describe("filterShellEnv")` block with the two integration assertions from [02-design-r1.md §2.4](02-design-r1.md#L154). |

No edits to [src/config.ts](../../../../src/config.ts#L137-L168). No new files.

## 3. Step-by-step

1. **F1 — extend src/security/secrets.ts**. Locate the line `const BLOCKED_PATH_RULES: ReadonlyArray<RegExp> = [` at [src/security/secrets.ts](../../../../src/security/secrets.ts#L67-L76) and find the matching closing `];`. Insert the new constants and predicate from [02-design-r1.md §2.1](02-design-r1.md#L23) **after** that closing `];` and **before** the `shannonEntropy` function at [src/security/secrets.ts](../../../../src/security/secrets.ts#L79). The three constants are file-private (`const`, no `export`); only `isSecretEnvName` is `export`ed.

2. **F2 — rewrite the env-filter region in src/mcp/builtins.ts**. The region is [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L432). Operations, in order:
   - At the top of the file's import section, add `import { isSecretEnvName } from "../security/secrets.js";` next to the other `../security/...` imports if any, otherwise next to the other intra-package imports.
   - Delete lines [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L422) (the entire `const SECRET_ENV_PATTERNS: RegExp[] = [ ... ];` block).
   - Rewrite the JSDoc at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L406) to a one-paragraph pointer (no pattern list): "Strip credential-shaped environment variable names from the parent process's env before spawning a shell child. The rule set lives in `src/security/secrets.ts` as `isSecretEnvName`."
   - Inside `filterShellEnv` ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L431)), replace the line `if (SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))) continue;` with `if (isSecretEnvName(key)) continue;`. No other lines in the function change.
   - The `spawn` call at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L451) is untouched.

3. **F3 — add corpora tests**. In [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1), append two new `describe` blocks at the end of the file (after the last `describe(...)` already present). Each block declares its corpus as a `const arr: ReadonlyArray<string> = [...]` literal (copied verbatim from the FP / FN lists in [02-design-r1.md §2.4](02-design-r1.md#L93-L157)), then a single `it.each(arr)(name => expect(isSecretEnvName(name)).toBe(false))` (for FP) or `.toBe(true)` (for FN). Import `isSecretEnvName` from `./secrets.js`.

4. **F4 — add integration assertion**. In [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1), append a new `describe("filterShellEnv")` block at the end of the file:
   - Import `filterShellEnv` from `./builtins.js`.
   - Two `it(...)` assertions, exactly as in [02-design-r1.md §2.4](02-design-r1.md#L155-L157). The literal value `"sk-test-do-not-use"` is a syntactic placeholder; no real key is used.
   - No spawning, no temp dir setup. The block is independent of the existing `beforeEach`/`afterEach` hooks.

## 4. Order of edits (single commit)

1. F1 (add the new exports in `secrets.ts`).
2. F3 (add the corpora tests against the new exports).
3. F2 (rewrite `builtins.ts` to consume the new export).
4. F4 (add the integration assertion).

The order keeps the tree compiling after every step: F1 introduces an unused export (still compiles), F3 references it (still compiles), F2 removes the old constant and starts consuming the new one, F4 exercises the call site. If `F2` lands before `F1`, `tsc` breaks on the missing import.

## 5. Test gates (must all be green at end of commit)

1. `vitest run src/security/secrets.test.ts` — every entry in the FP and FN corpora passes its assertion.
2. `vitest run src/mcp/builtins.test.ts` — pre-existing tests still pass and the new two-assertion block passes.
3. `npx tsc --noEmit` — clean (no missing-import errors, no dangling references to `SECRET_ENV_PATTERNS`).
4. `grep -c 'SECRET_ENV_PATTERNS' src/mcp/builtins.ts` → `0` exactly. Anything else means the deletion in step 2 was incomplete.
5. `grep -c 'isSecretEnvName' src/mcp/builtins.ts` → at least `2` (one import line + one call site).
6. `grep -c 'export function isSecretEnvName' src/security/secrets.ts` → exactly `1`.
7. `grep -nE 'SECRET_ENV_FORCE_PATTERNS|SECRET_ENV_NAME_PATTERNS|ENV_CONFIG_POINTER_SUFFIXES' src/security/secrets.ts` → at least three lines; none of them prefixed with `export ` (the constants are file-private).

## 6. Out of scope

- No edits to [src/config.ts](../../../../src/config.ts#L137-L168) (Proposal B is rejected at [02-design-r1.md §3](02-design-r1.md#L165)).
- No edits to the rest of [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1) outside the env-filter region (the tool-handler `switch` is owned by G30/G31/G32/G33/G34).
- No edits to [src/security/secrets.ts](../../../../src/security/secrets.ts#L1) content-shape rules (`PROVIDER_RULES`, `LITERAL_RULES`, `ENV_ASSIGNMENT_PATTERN`, `BLOCKED_PATH_RULES`, `shannonEntropy`, `scanForSecrets`, `redact`, `isBlockedPath`).
- No documentation files updated. The `SECRET_ENV_PATTERNS` constant has no public docs page; the JSDoc rewrite in F2 is the only narrative change.
