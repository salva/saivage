# G35b — Design r3

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)

**Supersedes (within G35b)**: [02-design-r2.md](02-design-r2.md), [02-design-r1.md](02-design-r1.md).

**Round 2 review addressed**: [04-review-r2.md](04-review-r2.md).

**Writer**: Claude Opus 4.7, round 3.

## 1. Recommendation

**Proposal A (round-3 form)** — identical shape and code to design
r2 ([02-design-r2.md §1](02-design-r2.md#L15-L41)). No code-shape
change between r2 and r3. The compiler, the schema, the predicate
wiring, the call-site updates, and the operator override examples
are all unchanged from [02-design-r2.md](02-design-r2.md). Round 3
modifies only:

- The schema test plan ([§2.6 B below](#26-tests)) — adds two
  non-empty full-replacement assertions and tightens the existing
  empty-suffix accept case (fixes B3 from
  [04-review-r2.md](04-review-r2.md#L9)).
- The test-gate scripts (in [03-plan-r3.md §5](03-plan-r3.md)) —
  replaces malformed gate 20 with two fixed-string `rg -F`
  sentinels (fixes B4 from [04-review-r2.md](04-review-r2.md#L11));
  the design itself only documents what those gates target.
- The fixture wording for the new
  [src/config-validation.test.ts](../../../../src/config-validation.test.ts)
  block — round 3 spells out the fixture pattern instead of
  claiming a reuse that does not exist (cleanup note from
  [04-review-r2.md](04-review-r2.md#L17)).

## 2. Proposal A (round-3 form)

### 2.1 New defaults and predicate factory in src/security/secrets.ts

Unchanged from [02-design-r2.md §2.1](02-design-r2.md#L43-L141).
The compiler body is:

```ts
const lexemePatterns: RegExp[] = rules.credentialLexemes.map((lex) => {
  const escaped = lex
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/_/g, "[_-]");
  return new RegExp(`(?:^|[_-])${escaped}S?(?:$|[_-])`, "i");
});
```

The two literal strings `replace(/_/g, "[_-]")` and `(?:^|[_-])`
are the round-2 fix anchors, and the test gates in
[03-plan-r3.md §5 gates 20a, 20b](03-plan-r3.md) key on them as
fixed strings.

### 2.2 New `security.envScrubber` field in src/config.ts

Unchanged from [02-design-r2.md §2.2](02-design-r2.md#L143-L189):

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

No Zod `.transform(...)` or other mutation step is added. A
non-empty operator override of either array is passed verbatim
through validation and lands on the parsed config object byte-for-byte;
this is what S-R-A and S-R-B below assert.

### 2.3 Predicate wired into src/mcp/builtins.ts

Unchanged from [02-design-r2.md §2.3](02-design-r2.md#L191-L266).

### 2.4 Behavior parity audit (default config)

Unchanged from [02-design-r2.md §2.4](02-design-r2.md#L268-L294).

### 2.5 Operator override examples

Unchanged from [02-design-r2.md §2.5](02-design-r2.md#L296-L341).

### 2.6 Tests

Two test files have the same changes as round 2; the third file
([src/config-validation.test.ts](../../../../src/config-validation.test.ts))
adds two non-empty replacement cases and tightens the empty-suffix
assertion.

**A — corpora and operator-override predicate test in
[src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1):**

Unchanged from [02-design-r2.md §2.6 A](02-design-r2.md#L416-L521).
The FN corpus still includes `SOME_API-KEY`, `ACCESS-KEY`,
`SOME-ACCESS-KEY`; the operator-override block still has the five
`it(...)` cases including the singleton-`PII` replacement case and
the empty-suffix replacement case.

**B — schema validation tests in
[src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1):**

Round 3 replaces [02-design-r2.md §2.6 B](02-design-r2.md#L523-L566)
with the expanded list below. The block uses the fixture pattern
documented in [03-plan-r3.md §3.7](03-plan-r3.md) (mkdtempSync +
write `.saivage/saivage.json` + `loadConfig(true, projectRoot)` +
cleanup), mirroring
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L66).

The new `describe("security.envScrubber")` block contains nine
`it(...)` cases:

1. "defaults to the built-in lexeme and suffix arrays" — write
   `{}` to `.saivage/saivage.json`; assert
   `cfg.security.envScrubber.credentialLexemes` deep-equals a spread
   copy of `DEFAULT_CREDENTIAL_LEXEMES` and likewise for
   `configPointerSuffixes`.
2. "rejects an empty `credentialLexemes` array" — write
   `{ credentialLexemes: [] }`; expect `loadConfig` to throw
   `ZodError`.
3. "rejects an empty-string lexeme element" (N2 pin) — write
   `{ credentialLexemes: [""] }`; expect throw.
4. "rejects a lowercase credential lexeme" — write
   `{ credentialLexemes: ["api_key"] }`; expect throw.
5. "rejects an empty-string suffix element" (N2 pin) — write
   `{ configPointerSuffixes: [""] }`; expect throw.
6. "rejects a config-pointer suffix without leading underscore" —
   write `{ configPointerSuffixes: ["URL"] }`; expect throw.
7. **"replaces `configPointerSuffixes` with a literal empty array
   (full replacement)" — round-3 tightening of the round-2 accept
   case.** Write `{ configPointerSuffixes: [] }`; assert all of:
   - `cfg.security.envScrubber.configPointerSuffixes` deep-equals
     literal `[]` (`expect(...).toEqual([])`);
   - `cfg.security.envScrubber.configPointerSuffixes.length === 0`;
   - `cfg.security.envScrubber.configPointerSuffixes` does NOT
     contain `"_URL"`, `"_PATH"`, `"_PROMPT"`, or any other default
     suffix (assert via `expect(...).not.toContain("_URL")` x4).

   These three assertions together prove that the schema treats an
   operator-supplied empty array as a full replacement, not as
   "operator wrote `[]`, fall back to defaults". The round-2
   version of this case only checked `length === 0`, which a
   permissive `.transform(arr => arr.length === 0 ? [...DEFAULTS] : arr)`
   would have failed on but a `.transform(arr => [...DEFAULTS, ...arr])`
   union would have passed. Round 3's three-part assertion fails
   both union shapes.
8. **"replaces `credentialLexemes` with a non-empty singleton
   (full replacement)" — round-3 B3 anchor S-R-A.** Write
   `{ credentialLexemes: ["PII"] }`; assert all of:
   - `cfg.security.envScrubber.credentialLexemes` deep-equals
     literal `["PII"]` (`expect(...).toEqual(["PII"])`);
   - `cfg.security.envScrubber.credentialLexemes.length === 1`;
   - `cfg.security.envScrubber.credentialLexemes[0] === "PII"`;
   - the array does NOT contain `"API_KEY"`, `"TOKEN"`, `"SECRET"`,
     or `"PASSWORD"` (assert via `expect(...).not.toContain(...)`).

   The four `not.toContain` assertions are the critical anchor — a
   union-with-defaults implementation would return a 12-element
   array containing both `"PII"` and all the defaults, and each
   `not.toContain` would fail. Pure-replacement behavior — what the
   round-2 design specifies — yields exactly `["PII"]`, and all
   four assertions pass. The other default lexemes
   (`ACCESS_KEY`, `PASSWD`, `CREDENTIAL`, `AUTH`, `BEARER`,
   `COOKIE`, `SESSION`) are not separately asserted; the four
   chosen represent the most operator-visible regressions if union
   slipped in, and the `toEqual(["PII"])` deep-equal already
   forbids any extra elements.
9. **"replaces `configPointerSuffixes` with a non-empty singleton
   (full replacement)" — round-3 B3 anchor S-R-B.** Write
   `{ configPointerSuffixes: ["_BUILDFILE"] }`; assert all of:
   - `cfg.security.envScrubber.configPointerSuffixes` deep-equals
     literal `["_BUILDFILE"]`;
   - `cfg.security.envScrubber.configPointerSuffixes.length === 1`;
   - `cfg.security.envScrubber.configPointerSuffixes[0] === "_BUILDFILE"`;
   - the array does NOT contain `"_URL"`, `"_URI"`, `"_PATH"`, or
     `"_PROMPT"`.

   Same union-detection logic as case 8 applied to the suffix
   array. `"_BUILDFILE"` is chosen to match the additive-case
   project lexeme in F14 case 3 of
   [02-design-r2.md §2.6 A](02-design-r2.md#L491-L505); the schema
   accepts it because it matches `/^_[A-Z][A-Z0-9_]*$/`.

Cases 1, 7, 8, 9 do not throw; they call `loadConfig(true, projectRoot)`
and assert on the parsed `cfg.security.envScrubber.*` shape. Cases
2-6 expect `loadConfig` to throw and use `expect(() => loadConfig(true, projectRoot)).toThrow(ZodError)`.

The contract proven at this layer: "schema validation neither
unions a non-empty operator array with defaults, nor substitutes
defaults for an empty operator array (for the suffix array, where
empty is legal)". Combined with the predicate layer (R-A / R-B in
[02-design-r2.md §2.6 A](02-design-r2.md#L477-L521)) and the
integration layer (cases 5 and 6 in
[02-design-r2.md §2.6 C](02-design-r2.md#L595-L616)), full
replacement is now pinned at three independent layers.

**C — integration tests in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1):**

Unchanged from [02-design-r2.md §2.6 C](02-design-r2.md#L568-L616).

## 3. Call-site updates for the new positional `securityConfig`

Unchanged from [02-design-r2.md §3](02-design-r2.md#L618-L633).

## 4. Files touched

Round 3 deltas are inside F15 only. F1, F2, F3, F4, F5, F6, F7,
F8, F9-F13, F14, F16 are identical to
[02-design-r2.md §4](02-design-r2.md#L635-L662). The F15 row is
restated below; the table otherwise carries over from r2.

| # | File | Region | Edit kind |
|---|---|---|---|
| F15 (round-3 form) | [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1) | append | 9 schema-validation `it`s (§2.6 B), incl. the two empty-string-element negative pins (N2), the round-3 literal-empty suffix replacement (case 7, tightened), the round-3 non-empty lexeme replacement (case 8, S-R-A), and the round-3 non-empty suffix replacement (case 9, S-R-B). Block uses a fresh `mkdtempSync` + write + `loadConfig` + cleanup fixture mirroring [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L66); see [03-plan-r3.md §3.7](03-plan-r3.md) for the verbatim skeleton. |

No new files. No JSON-Schema artefact updates. No documentation
changes.

## 5. Rejected alternative — Proposal B (additive-only overrides)

Unchanged from [02-design-r2.md §5](02-design-r2.md#L671-L678).
Round-3 cases 7, 8, 9 of F15 (above) extend the mechanical
rejection of additive-only semantics from the predicate and
integration layers down to the schema layer. An implementation
that unions operator input with defaults at any of the three
layers now fails at least one explicit assertion.

## 6. Rejected alternative — Proposal C (env-var override)

Unchanged from [02-design-r2.md §6](02-design-r2.md#L680-L682).

## 7. Where each round-2 fix is now pinned

Three independent test layers per fix, so a future refactor cannot
silently regress either fix:

- **B1 hyphen-form (`SOME_API-KEY`)** — predicate corpus (FN row),
  integration test (`filterShellEnv({ "SOME_API-KEY": ... })`),
  and test gate 17 (`grep -n 'SOME_API-KEY' ...`). Plus round-3
  gates 20a and 20b key on the compiler-text literals
  `replace(/_/g, "[_-]")` and `(?:^|[_-])`.
- **B2 full replacement (lexeme list)** — predicate override case 2
  (singleton `PII` doesn't scrub `ANTHROPIC_API_KEY`), integration
  case 5 (same assertion via `filterShellEnv`), and round-3 schema
  case 8 (`cfg.security.envScrubber.credentialLexemes === ["PII"]`
  with `not.toContain` defaults).
- **B2 full replacement (suffix list)** — predicate override case 4
  (empty suffix list scrubs `RESET_PASSWORD_URL`), integration
  case 6 (same via `filterShellEnv`), and round-3 schema case 7
  (literal `[]` shape) plus schema case 9 (singleton
  `["_BUILDFILE"]` shape).

## 8. What is removed (architecture-first, no shim)

Unchanged from [02-design-r2.md §8](02-design-r2.md#L702-L708).

## 9. Out of scope (explicit)

Unchanged from [02-design-r2.md §9](02-design-r2.md#L710-L714).
