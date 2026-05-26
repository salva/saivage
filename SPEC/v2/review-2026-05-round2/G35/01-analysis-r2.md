# G35 — Analysis r2

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Subsystem**: mcp (with co-edit in security)

**Severity**: low

**Transversality**: local

**Writer**: Claude Opus 4.7 (round 2, after [04-review-r1.md](04-review-r1.md#L1))

## 1. What the code does today

`registerBuiltinServices` in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L405-L432) defines a module-private constant `SECRET_ENV_PATTERNS`: an array of unanchored, case-insensitive `RegExp`s used by `filterShellEnv` at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L431) to scrub the parent process's environment before it is passed to spawned shell children at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L451). The current patterns are listed at [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L422):

- `/API[_-]?KEY/i`
- `/(?:^|_)TOKEN(?:$|_)/i`
- `/SECRET/i`
- `/PASSWORD/i`
- `/PASSWD/i`
- `/CREDENTIAL/i`
- `/^ANTHROPIC_/i`, `/^OPENAI_/i`, `/^GITHUB_/i`, `/^GH_/i`, `/^TELEGRAM_/i`, `/^SAIVAGE_API_TOKEN$/i`, `/^AWS_(ACCESS|SECRET|SESSION)/i`

Only the prefix-anchored last group and the already-anchored `TOKEN` entry use boundaries; the rest are substring matches.

## 2. Root cause

The unbounded substring patterns scrub any env-var **name** that contains the literal substring anywhere, regardless of whether the substring is a discrete lexeme and regardless of whether the variable carries the credential itself or merely a configuration pointer (URL, path, prompt label, template, etc.).

This produces four false-positive classes that the finding at [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md#L11-L15) calls out, plus a fifth that the round-1 review at [04-review-r1.md](04-review-r1.md#L5-L9) added:

1. **Substring-in-a-word**: `MY_SECRETARY`, `TOKENIZER`, `PASSWORDLESS_MODE`, `CREDENTIALSMITH_BIN` — the credential word is a fragment of a longer token, never a discrete field.
2. **Config-pointer suffixes**: `RESET_PASSWORD_URL`, `CREDENTIALS_FILE`, `PASSWORD_RESET_ENDPOINT` — the variable carries the *location* of the secret, not the secret itself.
3. **UI / prompt strings**: `PASSWORD_PROMPT`, `API_KEY_LABEL`, `TOKEN_PLACEHOLDER` — the variable carries human-facing copy or a template, not the credential. The round-1 design missed this class because the proposed `ENV_CONFIG_POINTER_SUFFIXES` list omitted `_PROMPT` and `_TEMPLATE`; the review at [04-review-r1.md](04-review-r1.md#L5) flagged `PASSWORD_PROMPT` as a concrete blocker.
4. **Provider-namespaced config**: `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GITHUB_API_BASE_URL`, `GITHUB_API_BASE_URL_TEMPLATE`, `GH_USERNAME` — variables in a provider namespace that carry config pointers or non-secret metadata. The round-1 design intentionally kept these scrubbed via a broad `SECRET_ENV_FORCE_PATTERNS` layer (`/^ANTHROPIC_/i`, `/^OPENAI_/i`, `/^GITHUB_/i`, `/^GH_/i`, `/^TELEGRAM_/i`) that bypassed the config-pointer exemption; the review at [04-review-r1.md](04-review-r1.md#L7) rejected that as preserving the original bug under a new name.
5. **Operator escalation**: because the patterns are unanchored, the standing remediation when a leak is found is to add another broad substring; the rule set tends to monotonically widen, compounding all four classes above.

## 3. Round-1 review blockers and how round 2 must respond

The round-1 review at [04-review-r1.md](04-review-r1.md#L5-L13) raised three blockers; round 2 must address each:

| Blocker | Round-1 location | Round-2 response |
|---|---|---|
| B1: `PASSWORD_PROMPT` still classified as secret. | [04-review-r1.md](04-review-r1.md#L5) | Expand the config-pointer suffix list to include every name ending the reviewer listed: `_PROMPT`, `_TEMPLATE`, plus the round-1 set `_URL`, `_URI`, `_ENDPOINT`, `_PATH`, `_DIR`, `_FILE`. Pin `PASSWORD_PROMPT`, `API_KEY_PROMPT`, `TOKEN_TEMPLATE` in the false-positive corpus. |
| B2: Broad provider-prefix layer defeats the exemption. | [04-review-r1.md](04-review-r1.md#L7) | Drop the provider-prefix force layer entirely. All real provider credentials already contain an explicit credential lexeme (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`, `GH_TOKEN`, `TELEGRAM_BOT_TOKEN`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `SAIVAGE_API_TOKEN`), so the lexeme layer alone catches them. Provider-namespaced config pointers (`OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `GITHUB_API_BASE_URL`, `GITHUB_API_BASE_URL_TEMPLATE`) become non-secret as the analysis section 2 class 4 requires. This also means the round-1 `SECRET_ENV_FORCE_PATTERNS` constant is dropped from the design — the predicate becomes two layers, not three. |
| B3: Corpora incomplete / internally ambiguous. | [04-review-r1.md](04-review-r1.md#L9) | Replace the round-1 narrative-with-side-note corpora with two flat arrays, each row a single env-var name with no inline commentary. Add the reviewer-named rows: `SLACK_TOKEN`, `PASSWORD_PROMPT`, `RESET_PASSWORD_URL`, `MY_SECRETARY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN`. Move `GITHUB_API_BASE_URL_TEMPLATE`, `GITHUB_API_BASE_URL`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` into the false-positive corpus to lock in the B2 fix. |

## 4. Why this remains an `mcp` finding with a co-edit in `security`

[src/security/secrets.ts](../../../../src/security/secrets.ts#L1-L79) already owns content-shaped secret detection (provider keys, JWTs, env-style high-entropy assignments) and blocked-path rules. The G35 surface — "is the **name** of this env var a credential field?" — is a name-shape decision that belongs next to those rules, but its only consumer is `filterShellEnv` in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L431). The remediation direction in [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md#L26-L31) asks for the allow/deny rules in one place near `secrets.ts`; that is preserved unchanged from round 1.

## 5. Blast radius of changes

`SECRET_ENV_PATTERNS` is referenced by exactly one function (`filterShellEnv`) at exactly one call site (the spawned `shell` tool). No consumer of `filterShellEnv` exists outside that module; nothing in the wider tree imports the constant. `grep -n filterShellEnv\|SECRET_ENV_PATTERNS src/mcp/builtins.ts src/mcp/builtins.test.ts` returns four hits, all inside [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L451); the test file does not exercise the predicate directly. Replacement remains strictly local.

## 6. Constraints from project rules and neighbours

- **Architecture-first, no migration shims**: the obsolete `SECRET_ENV_PATTERNS` constant is deleted, not deprecated. The round-1 `SECRET_ENV_FORCE_PATTERNS` proposal is also dropped (per B2) — there is no round-1 code on disk to remove, just a design rollback.
- **Disjoint same-file edits with G30/G31/G32/G33/G34**: those findings edit the `case` arms of the tool-handler `switch` and the `mcp` config block at [src/config.ts](../../../../src/config.ts#L137-L168). G35's edits stay inside [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L432). No `mcp` config key is added.

## 7. Required tests

Two deterministic, pure-data fixtures plus one integration assertion, unchanged in shape from round 1; the contents are rewritten per B3:

1. **False-positive corpus** in [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1): every entry asserts `isSecretEnvName(name) === false`. The full deterministic list lives in [02-design-r2.md §2.4](02-design-r2.md#L1).
2. **False-negative corpus** in [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1): every entry asserts `isSecretEnvName(name) === true`. The full deterministic list lives in [02-design-r2.md §2.4](02-design-r2.md#L1).
3. **Integration assertion** in [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1): one preserved FP, one dropped FN through `filterShellEnv`.
