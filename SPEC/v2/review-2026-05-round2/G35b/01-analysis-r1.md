# G35b — Analysis r1 (REDO of G35 under config-over-code principle)

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Supersedes (disapproved)**: [../G35/02-design-r2.md](../G35/02-design-r2.md), [../G35/03-plan-r2.md](../G35/03-plan-r2.md), [../G35/APPROVED.md](../G35/APPROVED.md)

**Writer**: Claude Opus 4.7, round 1.

## 1. Why a redo

The previously-approved G35 design fixed the unanchored-regex bug
([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L421)) by
introducing two hardcoded module constants inside
[src/security/secrets.ts](../../../../src/security/secrets.ts#L80) —
a credential lexeme set (`API_KEY`, `ACCESS_KEY`, `TOKEN`, `SECRET`,
`PASSWORD`, `PASSWD`, `CREDENTIAL`) and a config-pointer suffix
exemption list (`_URL`, `_URI`, `_ENDPOINT`, `_PATH`, `_DIR`, `_FILE`,
`_PROMPT`, `_TEMPLATE`).

The user directive of 2026-05-26 — *"Try to avoid hard coded values as
much as possible. What could live in a config file should live in a
config file."* — invalidates that placement. Both lists must live in
the operator-facing config file
([.saivage/saivage.json](../../../../src/config.ts#L271-L273)) so a
project can extend either list without recompiling. The bug fix
itself (anchored lexemes + suffix exemption) is unchanged; only the
**location** of the rule data moves from compiled-in constants to the
Zod config schema with sane defaults.

## 2. Surface re-confirmed in the live tree

Verified at the line numbers below (read on 2026-05-26):

- The broad-regex bug still sits at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L421).
  `SECRET_ENV_PATTERNS` lists `/API[_-]?KEY/i`, `/(?:^|_)TOKEN(?:$|_)/i`,
  `/SECRET/i`, `/PASSWORD/i`, `/PASSWD/i`, `/CREDENTIAL/i`,
  `/^ANTHROPIC_/i`, `/^OPENAI_/i`, `/^GITHUB_/i`, `/^GH_/i`,
  `/^TELEGRAM_/i`, `/^SAIVAGE_API_TOKEN$/i`,
  `/^AWS_(ACCESS|SECRET|SESSION)/i`. The unanchored entries
  (`/SECRET/i`, `/PASSWORD/i`, `/PASSWD/i`, `/CREDENTIAL/i`) drop
  `MY_SECRETARY`, `PASSWORDLESS_MODE`, `CREDENTIALSMITH_BIN`. The
  provider-prefix entries (`/^OPENAI_/i`, `/^GITHUB_/i`, …) drop
  legitimate config pointers such as `OPENAI_BASE_URL`,
  `GITHUB_API_BASE_URL_TEMPLATE`.
- The only call site is
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432)
  (`filterShellEnv`), invoked from the shell-spawn at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L451).
- The config schema lives in
  [src/config.ts](../../../../src/config.ts#L60-L194). The existing
  `security` block is at
  [src/config.ts](../../../../src/config.ts#L111-L117) and currently
  carries only `injectionScanner`, `injectionModel`,
  `maxScanLengthBytes` — i.e. the schema already has the right home
  for security toggles; we only need to add a sibling field.
- `loadConfig` (entry point for all operator overrides) is at
  [src/config.ts](../../../../src/config.ts#L260-L278); it already
  parses through the same `configSchema.parse(...)` path, so any new
  field added under `security` is picked up by every existing caller
  without further plumbing.
- `registerBuiltinServices` already accepts a typed config slice and
  copies it into module-level mutables at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082)
  (`MAX_OUTPUT = mcpConfig.maxOutputBytes`, etc.). The same mechanism
  fits the env-scrubber predicate.
- Callers of `registerBuiltinServices` are
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145),
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56),
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232),
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252),
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287),
  [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24).
  All six pass `cfg.mcp` positionally; any new positional slice must
  be threaded through these six sites.
- No standalone JSON schema file exists for `.saivage/saivage.json`
  (verified by `find … -name 'saivage*.schema.json' -o -name
  'config*.schema.json'` returning empty). The Zod schema in
  [src/config.ts](../../../../src/config.ts#L60) is the single source
  of truth; no separate JSON-Schema artefact needs updating.

## 3. Decisions framed by the user directive

The directive does not change what counts as a secret — that is still
a security judgment. It changes **who** decides:

- (a) Saivage's defaults remain a single fixed list (no operator
  override). Rejected — exactly the placement the directive
  prohibits.
- (b) Saivage ships defaults but accepts operator-supplied
  *additive* lists (`extraCredentialLexemes`, `extraConfigPointerSuffixes`)
  that union with the defaults. Partial fix — operators can extend
  but cannot remove a default that turns out to be wrong for their
  project (e.g. a domain where `AUTH` is a public field name). The
  directive prefers full operator control.
- (c) Saivage ships defaults but accepts operator-supplied *full
  replacement* lists (`credentialLexemes`, `configPointerSuffixes`),
  each defaulting to the built-in array. Full operator control
  without forcing every project to redeclare the defaults. This is
  the form §3 of [02-design-r1.md](02-design-r1.md) recommends.

A separate axis is **where** the defaults live. Two viable homes:

- (i) The defaults live as exported `const` arrays in
  [src/security/secrets.ts](../../../../src/security/secrets.ts) and
  are imported by [src/config.ts](../../../../src/config.ts) as
  `.default(...)` for the new Zod fields. The security module stays
  the canonical authority on "what does a credential name look
  like"; the config schema points at it.
- (ii) The defaults live inline inside the Zod schema. Rejected —
  duplicates the security taxonomy between the security module and
  the config schema and creates a drift risk.

The recommended design uses (c) for operator control and (i) for
default placement.

## 4. Surfaces the redo must not touch

- The blocked-source-paths list at
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L68-L77)
  (`BLOCKED_PATH_RULES`). Different rule corpus, different
  consumer (`isBlockedPath` at
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L176)),
  out of scope.
- The provider/literal/env-assignment regex catalogues at
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L34-L67)
  used by `scanForSecrets` and `redact`. Out of scope — different
  finding category (content scanning, not env-name classification).
- The `mcpConfig.shellTimeout*` and `WALL_CLOCK_HEADROOM_MS`
  arithmetic at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1080-L1083).
  Owned by G30/G31 family.
- Existing module-level mutables (`MAX_OUTPUT`,
  `SHELL_TIMEOUT_FLOOR_MS`) at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L44).
  We follow the same plumbing pattern, not refactor it.

## 5. Architectural constraints (project rules)

- No backward compatibility: the old `SECRET_ENV_PATTERNS` constant
  and any read of it must be deleted in the same commit. No
  re-export, no alias, no toggle.
- No migration shim: operators who never edit `.saivage/saivage.json`
  get exactly the new default behavior (Layer 1 anchored lexemes +
  Layer 2 suffix exemption), not the old behavior.
- No over-engineering: a single new `security.envScrubber` object
  with two `string[]` fields and two exported default arrays. No
  policy DSL, no per-process override, no env-var escape hatch.

## 6. Risks the redo introduces

- **R1 — predicate construction cost**. Compiling regexes from the
  operator-supplied lexeme list on every `filterShellEnv` call would
  burn CPU on hot shell spawns. Mitigation: build the predicate once
  inside `registerBuiltinServices` (alongside the existing
  `MAX_OUTPUT = mcpConfig.maxOutputBytes` assignments at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1077-L1083))
  and capture it in a module-level closure used by `filterShellEnv`.
- **R2 — operator typo silently widens the scrub**. A lexeme like
  `KEY` (no `API_` prefix) would match `_KEY_` anywhere and reblock
  the `*_KEY_URL` pointer names that the suffix layer was meant to
  preserve. Mitigation: the Zod schema validates each lexeme as
  `/^[A-Z][A-Z0-9_]*$/` and rejects an empty string; the suffix
  schema requires each entry to start with `_` and be all-uppercase.
  Bad config crashes startup loudly rather than silently weakening
  or strengthening the scrub.
- **R3 — operator typo silently narrows the scrub**. If an operator
  overrides `credentialLexemes` to `[]`, no env var is ever
  considered a secret and OAuth refresh tokens leak to spawned
  shells. Mitigation: Zod `.min(1)` on `credentialLexemes`; empty
  lists are rejected at load time. (Empty `configPointerSuffixes` is
  allowed — it just makes the predicate stricter.)
- **R4 — drift between Zod default and exported constant**.
  Mitigation: the Zod schema imports the exported constant; there is
  exactly one place in the tree that lists the defaults.

## 7. What this analysis does not decide

- The exact field name (`security.envScrubber` vs `security.shellEnvFilter`).
  Design r1 picks `security.envScrubber` for symmetry with the
  function name `filterShellEnv`; reviewer may push back.
- Whether to also expose a separate `denyExtraNames: string[]` for
  exact-name overrides. Not added in r1 — the lexeme list already
  covers the use case (`AUTH`, `BEARER`, `COOKIE`, `SESSION` are
  lexemes, not whole names).
- Whether the predicate factory is a public export of `secrets.ts`.
  Design r1 makes it exported so tests can build alternative
  predicates without going through `loadConfig`.

## 8. Cross-links

- Round 1: F25 (secret scanning surface).
- Same-file siblings: G30, G31, G32, G33, G34 (other findings in
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1)).
- Disapproved predecessor: [../G35/02-design-r2.md](../G35/02-design-r2.md).
