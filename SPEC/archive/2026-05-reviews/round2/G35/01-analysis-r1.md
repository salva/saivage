# G35 — Analysis r1

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Subsystem**: mcp (with co-edit in security)

**Severity**: low

**Transversality**: local

**Writer**: Claude Opus 4.7 (round 1)

## 1. What the code does today

`registerBuiltinServices` in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L405-L432) defines a module-private constant `SECRET_ENV_PATTERNS`: an array of unanchored, case-insensitive `RegExp`s used by `filterShellEnv` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L431) to scrub the parent process's environment before it is passed to spawned shell children at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L451). The current patterns are:

- `/API[_-]?KEY/i`
- `/(?:^|_)TOKEN(?:$|_)/i`
- `/SECRET/i`
- `/PASSWORD/i`
- `/PASSWD/i`
- `/CREDENTIAL/i`
- `/^ANTHROPIC_/i`, `/^OPENAI_/i`, `/^GITHUB_/i`, `/^GH_/i`, `/^TELEGRAM_/i`, `/^SAIVAGE_API_TOKEN$/i`, `/^AWS_(ACCESS|SECRET|SESSION)/i`.

Only the prefix-anchored last group and the already-anchored `TOKEN` entry use boundaries; `/SECRET/i`, `/PASSWORD/i`, `/PASSWD/i`, `/CREDENTIAL/i`, and `/API[_-]?KEY/i` are substring matches.

## 2. Root cause

The four substring patterns above scrub any environment variable whose **name** contains the literal substring anywhere, regardless of whether the substring is a standalone word and regardless of whether the variable is actually a credential (vs. a configuration pointer such as a URL, a path, or a feature flag).

The breadth produces three classes of false positives that the issue explicitly calls out at [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md#L11-L15) plus a fourth class that surfaces in practice:

1. **Substring-in-a-word**: `MY_SECRETARY`, `STAGETOKENISER_PATH`, `WEB_PASSWORDLESS_OK` — the secret word is a fragment of a longer token, never a standalone field.
2. **Config-pointer suffixes**: `RESET_PASSWORD_URL`, `PASSWORD_RESET_ENDPOINT`, `CREDENTIALS_FILE` — the variable carries the *location* of the secret, not the secret itself. Stripping it breaks tools that legitimately need the pointer.
3. **Plural / unrelated lexemes**: `PASSWORDLESS_MODE`, `TOKENIZER`, `CREDENTIALSMITH_BIN` — the substring matches but no credential is named.
4. **Operator escalation**: because the patterns are unanchored, the standing remediation when a leak is found is to add another broad substring; the rule set tends to monotonically widen, compounding all three classes above.

## 3. Why this is a `mcp` finding, not a `security` finding

`src/security/secrets.ts` already owns content-shaped secret detection (provider keys, JWTs, env-style high-entropy assignments) at [src/security/secrets.ts](../../../../src/security/secrets.ts#L34-L57). The G35 surface is different: it answers the question *"is the **name** of this env var a credential field?"* and is only consumed by `filterShellEnv` in `src/mcp/builtins.ts`. The constants and predicate belong colocated with the existing content-shape rules in `src/security/secrets.ts` so the answer to "what is a secret env var name" lives in one place, but the call site stays in `mcp/builtins.ts`.

The issue's own "rough remediation direction" at [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md#L26-L31) explicitly asks to document the allow/deny rules in one place near `secrets.ts`.

## 4. Blast radius of changes

`SECRET_ENV_PATTERNS` is referenced by exactly one function (`filterShellEnv`) at exactly one call site (the spawned `shell` tool). No consumer of `filterShellEnv` exists outside that module; nothing in the wider tree imports the constant. Verification: `grep -n filterShellEnv\|SECRET_ENV_PATTERNS src/mcp/builtins.ts src/mcp/builtins.test.ts` returns four hits, all inside [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L451); the test file does not exercise the predicate directly. Replacement is therefore strictly local.

## 5. Constraints from project rules and neighbours

- **Architecture-first, no migration shims**: the obsolete `SECRET_ENV_PATTERNS` constant is **deleted**, not deprecated.
- **Disjoint same-file edits with G31/G32/G33/G34**: those four findings edit the `case` arms inside the tool-handler `switch` in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1) and the `mcp` config block at [src/config.ts](../../../../src/config.ts#L137-L168). G35's edits are confined to the standalone `SECRET_ENV_PATTERNS`/`filterShellEnv` region at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L405-L432). No `mcp` config key is added, so the alphabetical insertion order being negotiated by G31/G32/G33/G34 is not touched.
- **Orthogonal to G30**: G30 is the other `src/mcp/builtins.ts` finding (per [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md#L36)) but does not touch the env-filter region.

## 6. Required tests

The current test file [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) does not directly exercise `filterShellEnv`. Two deterministic fixtures are required, both pure-data so they run without spawning shells:

1. **False-positive corpus** — names that must NOT be classified as secret. Each entry is a single env-var name string; the test asserts `isSecretEnvName(name) === false` for every entry.
2. **False-negative corpus** — names that MUST be classified as secret. Each entry asserts `isSecretEnvName(name) === true`.

Both corpora live alongside [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) as new `describe` blocks, plus one integration assertion in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) that confirms `filterShellEnv` delegates to the predicate end-to-end (one FP env var preserved, one FN env var dropped).
