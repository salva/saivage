# G35b — Analysis r2

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Round 1**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md)

**Round 1 review**: [04-review-r1.md](04-review-r1.md) — VERDICT CHANGES_REQUESTED.

**Supersedes (disapproved)**: [../G35/02-design-r2.md](../G35/02-design-r2.md), [../G35/03-plan-r2.md](../G35/03-plan-r2.md), [../G35/APPROVED.md](../G35/APPROVED.md)

**Writer**: Claude Opus 4.7, round 2.

## 1. What round 1 got right and what review r1 blocked

Round 1 chose the correct shape: full operator-controlled lists under
a new `security.envScrubber` block in the Zod schema, defaults
imported from [src/security/secrets.ts](../../../../src/security/secrets.ts#L80),
a single predicate factory `createSecretEnvNamePredicate` rebuilt
once at the start of `registerBuiltinServices` and captured by
`filterShellEnv`. The reviewer affirmed the plumbing shape and the
`SECRET_ENV_PATTERNS` deletion. Two implementation choices were
blocked, and three notes asked for tighter wording or a missing
negative pin.

### 1.1 Blocker B1 — hyphen-separator regression in the compiler

Round 1 design [02-design-r1.md §2.1](02-design-r1.md#L101-L113)
compiled each lexeme by escaping every regex metachar and wrapping
the result in `(?:^|_)${escaped}S?(?:$|_)`. For the default lexeme
`API_KEY`, that produces `/(?:^|_)API_KEYS?(?:$|_)/i`, which does
NOT match `SOME_API-KEY`: the character between `API` and `KEY` in
the input is `-`, but the pattern demands `_`.

The disapproved [../G35/02-design-r2.md §2.1](../G35/02-design-r2.md#L91)
explicitly preserved this hyphen tolerance with hand-written regexes
`/(?:^|_)API[_-]?KEYS?(?:$|_)/i` and `/(?:^|_)ACCESS[_-]?KEYS?(?:$|_)/i`,
and its FN corpus [../G35/02-design-r2.md §2.4](../G35/02-design-r2.md#L193)
pins `SOME_API-KEY` as a row that MUST classify as secret. Reviewer
B1 [04-review-r1.md](04-review-r1.md#L7) is therefore correct: round
1's compiler is a silent regression of an earlier safety guarantee,
and the round-1 plan's instruction to copy the G35 r2 FN corpus into
the new test would have failed its own corpus.

The compiler MUST treat `-` as equivalent to `_` in two places:
**around** the lexeme (left/right boundary) and **inside** the
lexeme (any underscore embedded in a multi-word lexeme). The first
is what G35 r2's boundary group `(?:^|_)` … `(?:$|_)` provides; the
second is what G35 r2's `[_-]?` group provides between `API` and
`KEY`. Round 2's compiler must therefore:

- escape every regex metachar in the operator-supplied lexeme (still
  needed for defense-in-depth even though the schema already
  restricts the character set);
- replace each `_` inside the escaped lexeme with `[_-]`, so a
  configured `API_KEY` matches both `API_KEY` and `API-KEY` as a
  whole token;
- widen the boundary alternations to `(?:^|[_-])` and `(?:$|[_-])`,
  so the whole-token requirement still holds when the surrounding
  separator is a hyphen.

The resulting pattern for lexeme `API_KEY` is
`/(?:^|[_-])API[_-]KEYS?(?:$|[_-])/i`. Checks against the relevant
corpus rows:

| Input | Lexeme regex | Result |
|---|---|---|
| `SOME_API-KEY` | `/(?:^|[_-])API[_-]KEYS?(?:$|[_-])/i` | match at `_API-KEY$` — true |
| `ANTHROPIC_API_KEY` | same | match at `_API_KEY$` — true |
| `OPENAI_API_KEY` | same | match at `_API_KEY$` — true |
| `MY_SECRETARY` | `/(?:^|[_-])SECRETS?(?:$|[_-])/i` | `_SECRET` then `A`, not `_`/`-`/end — false |
| `TOKENIZER` | `/(?:^|[_-])TOKENS?(?:$|[_-])/i` | `TOKEN` then `I`, not `_`/`-`/end — false |
| `PASSWORDLESS_MODE` | `/(?:^|[_-])PASSWORDS?(?:$|[_-])/i` | `PASSWORD` then `L`, not `_`/`-`/end — false |
| `CREDENTIALSMITH_BIN` | `/(?:^|[_-])CREDENTIALS?(?:$|[_-])/i` | `CREDENTIALS` then `M`, not `_`/`-`/end — false |
| `STAGETOKENISER_PATH` | `/(?:^|[_-])TOKENS?(?:$|[_-])/i` | `TOKEN` preceded by `E`, not `_`/`-`/start — false |
| `RESET_PASSWORD_URL` | `/(?:^|[_-])PASSWORDS?(?:$|[_-])/i` | match at `_PASSWORD_` (suffix layer then exempts `_URL`) — passes layer 1, blocked at layer 2 |

The change is local to the regex string built inside
`createSecretEnvNamePredicate`; no schema or call-site change is
required for B1. The FN corpus copied from G35 r2 is extended in
round 2 to also pin an explicit hyphen-form `ACCESS-KEY` row, so the
guarantee is locked at the test layer and cannot be silently dropped
by a future refactor (see [02-design-r2.md §2.7](02-design-r2.md)).

### 1.2 Blocker B2 — additive-only mutation test is insufficient

Round 1's end-to-end test [03-plan-r1.md §3.8](03-plan-r1.md#L311-L341)
wrote `credentialLexemes: [...DEFAULT_CREDENTIAL_LEXEMES, "PII"]`
and asserted `PII_DATA` was scrubbed. The design rationale
[02-design-r1.md §5](02-design-r1.md#L544-L564) explicitly rejected
additive-only overrides because operators must be able to *remove* a
bad default. The test, as written, would still pass on an
implementation that silently unioned operator input with the
defaults — i.e. it does not actually exercise the rejected proposal
B's negation.

Round 2 adds two replacement assertions that an additive-only
implementation provably cannot satisfy:

- **R-A**: configured `credentialLexemes: ["PII"]` (a singleton
  list, no spread) scrubs `PII_DATA` and PRESERVES `ANTHROPIC_API_KEY`
  unmodified. An additive implementation would still drop
  `ANTHROPIC_API_KEY` via the un-removed default `API_KEY` lexeme;
  full-replacement semantics keeps it.
- **R-B**: configured `configPointerSuffixes: []` (an empty list,
  schema-allowed for suffixes) causes `RESET_PASSWORD_URL` to be
  scrubbed (because the `_URL` exemption is gone) while
  `ANTHROPIC_API_KEY` stays scrubbed (lexeme layer untouched). An
  additive implementation would keep `_URL` in the effective suffix
  set and would NOT scrub `RESET_PASSWORD_URL`.

These two assertions live in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1)
as part of the end-to-end `describe("filterShellEnv")` block; they
exercise `loadConfig → registerBuiltinServices → filterShellEnv` in
the same shape as the existing additive case, just with different
config payloads. See [02-design-r2.md §2.6](02-design-r2.md) and
[03-plan-r2.md §3.8](03-plan-r2.md).

### 1.3 Note N1 — default placement wording

Reviewer note [04-review-r1.md](04-review-r1.md#L11) is correct:
the defaults are Zod-backed `.default(...)` values imported from
[src/security/secrets.ts](../../../../src/security/secrets.ts#L80),
NOT entries materialized into every operator's
.saivage/saivage.json file. The round-1 narrative occasionally said
the lists "live in" the config file; round 2 reframes this as: the
operator's config file is the single place to OVERRIDE the lists,
and the Zod schema fills in the defaults from the security module
when the operator omits the field. The on-disk JSON is only mutated
by an operator, never by Saivage at runtime.

### 1.4 Note N2 — empty-string element pin missing

Reviewer note [04-review-r1.md](04-review-r1.md#L13) is correct:
the round-1 schema uses `regex(/^[A-Z][A-Z0-9_]*$/)` and
`regex(/^_[A-Z][A-Z0-9_]*$/)` per element, which independently
reject empty-string elements, but the test plan only checked
array-level emptiness, lowercase, and a leading-`_` suffix shape.
Round 2 adds two explicit per-element empty-string negative pins
(one for each array) so a future implementation that downgrades
the per-element regex to `.min(0)` cannot pass the suite while
silently accepting `credentialLexemes: [""]`. See
[02-design-r2.md §2.6](02-design-r2.md) and
[03-plan-r2.md §3.7](03-plan-r2.md).

### 1.5 Notes N3 / N4 — out of scope, unchanged

The reviewer also affirmed that no regression is visible for the
symmetric `allowed_accounts` fix and that G35b correctly stays out
of [src/routing/resolver.ts](../../../../src/routing/resolver.ts).
Round 2 keeps that separation explicit; nothing about
[src/routing/resolver.ts](../../../../src/routing/resolver.ts) or
the G25 config-validation surface is touched.

## 2. Surface re-confirmed in the live tree (2026-05-26)

The line numbers cited in round 1 (and re-checked here) are still
current; no upstream commit has moved them since round 1 landed.

- The broad-regex bug still sits at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L421).
- The only call site is `filterShellEnv` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432),
  invoked from the shell spawn at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L451).
- The `security` Zod block is at
  [src/config.ts](../../../../src/config.ts#L111-L117).
- `loadConfig` is at
  [src/config.ts](../../../../src/config.ts#L260-L278).
- `registerBuiltinServices` is at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082).
- The six call sites of `registerBuiltinServices` are
  [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145),
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56),
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232),
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252),
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287),
  [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24).
- No standalone JSON-Schema artefact exists; the Zod schema in
  [src/config.ts](../../../../src/config.ts#L60) is the single
  source of truth.

## 3. Decisions reaffirmed and refined

The directive ("config beats hardcoding") and the architecture-first
guideline ("no backward compatibility, no migration shims") still
select **full-replacement operator-controlled lists with defaults
in the security module, imported into the Zod schema as
`.default(...)`**, exactly as round 1 chose. Round 2 refines two
aspects of that choice in response to review r1:

- **D1 (was implicit, now explicit)**: the compiler treats `_` and
  `-` as interchangeable separator characters both at the boundary
  and inside multi-word lexemes. This is the only formulation that
  preserves G35 r2's `SOME_API-KEY` guarantee while keeping operator
  lexemes spelled with `_` (which is what the schema's `regex` for
  per-element shape allows; `-` is not permitted inside a lexeme so
  the operator cannot specify a "hyphen-only" variant).
- **D2 (was implicit, now explicit)**: the schema fields use Zod's
  `.default(...)` to fill in the defaults at parse time when the
  operator omits the field. The defaults arrays live exclusively in
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L80)
  and are imported by [src/config.ts](../../../../src/config.ts#L1)
  for use in `.default(...)`. No code path UNIONS the operator
  input with the defaults. If the operator supplies an array, that
  array is used verbatim (modulo per-element schema validation).
  This is the "full replacement" semantic that R-A and R-B (§1.2)
  verify at the test layer.

## 4. Surfaces the redo must not touch

Same as round 1:

- The blocked-source-paths list at
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L68-L77).
- The provider/literal/env-assignment regex catalogues at
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L34-L67).
- The `mcpConfig.shellTimeout*` and `WALL_CLOCK_HEADROOM_MS`
  arithmetic at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1080-L1083).
- Existing module-level mutables (`MAX_OUTPUT`,
  `SHELL_TIMEOUT_FLOOR_MS`) at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L44).
- [src/routing/resolver.ts](../../../../src/routing/resolver.ts) and
  the G25 config-validation surface (reviewer note N4).

## 5. Architectural constraints (project rules, unchanged)

- No backward compatibility: `SECRET_ENV_PATTERNS` and any read of
  it are deleted in the same commit. No re-export, no alias, no
  toggle.
- No migration shim: operators who never edit `.saivage/saivage.json`
  get the new defaults via Zod `.default(...)`, not the old behavior.
- No over-engineering: a single new `security.envScrubber` object
  with two `string[]` fields and two exported default arrays. No
  policy DSL, no per-process override, no env-var escape hatch.
- No union with hidden defaults at predicate-build time. If the
  operator specifies `credentialLexemes`, only that list is used.

## 6. Risks the redo introduces (refined for round 2)

- **R1 — predicate construction cost.** Unchanged from round 1:
  predicate is built once inside `registerBuiltinServices`.
- **R2 — operator typo silently widens the scrub.** Unchanged: Zod
  `regex(/^[A-Z][A-Z0-9_]*$/)` per lexeme element rejects bad
  shapes (including empty strings — see N2 fix at §1.4) at load.
- **R3 — operator typo silently narrows the scrub.** Unchanged:
  Zod `.min(1)` on `credentialLexemes` rejects an empty list. Note
  that under full-replacement semantics, `credentialLexemes: ["PII"]`
  alone is a LEGAL (though risky) configuration: the operator has
  explicitly chosen not to scrub provider tokens. This is the
  intended behavior per the directive ("config beats hardcoding")
  and is now pinned by test R-A (§1.2). An operator who wants to
  add a lexeme without losing the defaults must spell them out
  (`[...DEFAULTS, "PII"]`); this is the additive case (test
  case 3 of the override block).
- **R4 — drift between Zod default and exported constant.**
  Unchanged: the Zod schema imports the exported constant; one
  source of truth in
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L80).
- **R5 (new) — operator narrows then forgets.** An operator who
  writes `credentialLexemes: ["MY_LEXEME"]` to add a project lexeme,
  without spreading the defaults, loses scrubbing for
  `ANTHROPIC_API_KEY`. Mitigation: the schema does NOT silently
  union; the test corpus pins both R-A (replacement preserves
  intent) and an additive case (spreading defaults works). The
  default JSDoc on `DEFAULT_CREDENTIAL_LEXEMES` reminds operators
  that an override is a full replacement, and the default JSDoc on
  the Zod field cross-links to the security module so an operator
  editing
  [.saivage/saivage.json](../../../../src/config.ts#L271-L273) sees
  the canonical list in code review.

## 7. What this analysis does not decide

- The exact field name (`security.envScrubber` vs
  `security.shellEnvFilter`). Round 1 picked `security.envScrubber`
  and reviewer r1 did not push back; round 2 keeps it.
- Whether to also expose a separate `denyExtraNames: string[]` for
  exact-name overrides. Not added.
- Whether the predicate factory is a public export of `secrets.ts`.
  Round 1 made it exported and reviewer r1 did not push back; round
  2 keeps it.

## 8. Cross-links

- Round 1 (same finding): [01-analysis-r1.md](01-analysis-r1.md),
  [02-design-r1.md](02-design-r1.md),
  [03-plan-r1.md](03-plan-r1.md),
  [04-review-r1.md](04-review-r1.md).
- Disapproved predecessor: [../G35/02-design-r2.md](../G35/02-design-r2.md).
- Same-file siblings: G30, G31, G32, G33, G34 (other findings in
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1)).
- Round 1 review notes N3/N4 (resolver / allowed_accounts) — out of
  scope here; not touched.
