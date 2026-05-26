# G35b — Design r2

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r2.md](01-analysis-r2.md)

**Supersedes (within G35b)**: [02-design-r1.md](02-design-r1.md)

**Round 1 review addressed**: [04-review-r1.md](04-review-r1.md)

**Disapproved predecessor (G35)**: [../G35/02-design-r2.md](../G35/02-design-r2.md)

**Writer**: Claude Opus 4.7, round 2.

## 1. Recommendation

**Proposal A (round-2 form)** — same shape as design r1: a new
`security.envScrubber` Zod block in
[src/config.ts](../../../../src/config.ts#L111-L117) with two
operator-overridable arrays, defaults imported from
[src/security/secrets.ts](../../../../src/security/secrets.ts#L80),
predicate built once inside `registerBuiltinServices` and captured by
`filterShellEnv`. Two changes versus design r1:

- The compiler in `createSecretEnvNamePredicate` now treats `_` and
  `-` as interchangeable separators both at the boundary AND inside
  multi-word lexemes (fixes blocker B1 — `SOME_API-KEY` regression,
  see [01-analysis-r2.md §1.1](01-analysis-r2.md)).
- The test suite adds replacement-semantics assertions (fixes
  blocker B2, see [01-analysis-r2.md §1.2](01-analysis-r2.md)) and
  per-element empty-string negative pins (fixes note N2,
  [01-analysis-r2.md §1.4](01-analysis-r2.md)). The predicate
  factory itself does not union with defaults.

The disapproved hardcoded module constants
`SECRET_ENV_NAME_PATTERNS` and `ENV_CONFIG_POINTER_SUFFIXES` from
[../G35/02-design-r2.md §2.1](../G35/02-design-r2.md#L67) are still
not introduced. The `SECRET_ENV_PATTERNS` block at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L421) is
still deleted in the same commit.

## 2. Proposal A (round-2 form)

### 2.1 New defaults and predicate factory in src/security/secrets.ts

Inserted after `BLOCKED_PATH_RULES` at
[src/security/secrets.ts](../../../../src/security/secrets.ts#L68-L77),
before `function shannonEntropy` at
[src/security/secrets.ts](../../../../src/security/secrets.ts#L80):

```ts
/**
 * Default credential-lexeme set used by the shell-env scrubber. Each
 * entry is an underscore-bounded token that, when found as a discrete
 * token inside an env-var name, marks the name as secret. Operators
 * may OVERRIDE the full list via .saivage/saivage.json under
 * security.envScrubber.credentialLexemes; the override is a FULL
 * REPLACEMENT, not an additive extension. Defaults are read by the
 * Zod schema in src/config.ts via `.default(...)`; the on-disk JSON
 * is never mutated by Saivage at runtime.
 *
 * The list MUST stay short and conservative — any entry here is a
 * lexeme that operators in EVERY project are expected to treat as
 * credential-bearing. Project-specific additions belong in the
 * operator config as the full list (typically `[...defaults, "MY"]`
 * to extend, or a new singleton list to replace).
 */
export const DEFAULT_CREDENTIAL_LEXEMES: ReadonlyArray<string> = [
  "API_KEY",
  "ACCESS_KEY",
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "AUTH",
  "BEARER",
  "COOKIE",
  "SESSION",
];

/**
 * Default config-pointer suffix exemption set. A name that matched
 * a credential lexeme but ends in one of these suffixes is a
 * configuration pointer or UI string, not a secret, and is preserved.
 * Operators may OVERRIDE the full list via
 * security.envScrubber.configPointerSuffixes; an empty operator list
 * is allowed and disables the exemption layer entirely.
 */
export const DEFAULT_CONFIG_POINTER_SUFFIXES: ReadonlyArray<string> = [
  "_URL",
  "_URI",
  "_ENDPOINT",
  "_PATH",
  "_DIR",
  "_FILE",
  "_PROMPT",
  "_TEMPLATE",
];

export interface SecretEnvNameRules {
  credentialLexemes: ReadonlyArray<string>;
  configPointerSuffixes: ReadonlyArray<string>;
}

/**
 * Build a `(name: string) => boolean` predicate that classifies env
 * variable NAMES as secret. Two layers, evaluated in order:
 *
 *   1. credentialLexemes — each lexeme L is compiled to
 *      /(?:^|[_-])L'S?(?:$|[_-])/i where L' is L with every internal
 *      underscore replaced by [_-] and every regex metachar escaped.
 *      The boundary alternations and the internal [_-] together
 *      treat `_` and `-` as interchangeable separator characters,
 *      so a configured `API_KEY` matches `API_KEY`, `API-KEY`,
 *      `MY_API_KEY`, `SOME_API-KEY`, and `API_KEYS`, but does NOT
 *      match `APIKEY`, `MYAPIKEY`, or `APIKEYNAME`. The trailing
 *      `S?` covers plural forms (`TOKEN`/`TOKENS`, `API_KEY`/
 *      `API_KEYS`, `CREDENTIAL`/`CREDENTIALS`).
 *
 *   2. configPointerSuffixes — names that pass layer 1 but end in
 *      one of the (uppercase) suffixes are configuration pointers
 *      or UI strings and are preserved. An empty suffix list
 *      disables layer 2 (every layer-1 match is a secret).
 *
 * Predicate construction is O(|credentialLexemes|) regex compiles;
 * call sites SHOULD build the predicate once and reuse it.
 */
export function createSecretEnvNamePredicate(
  rules: SecretEnvNameRules,
): (name: string) => boolean {
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
}
```

Notes on the compiler:

- The metachar escape step is run BEFORE the `_` → `[_-]` rewrite so
  that `[`, `]`, and `\` in a (malformed but schema-rejected) lexeme
  can never inject regex syntax. The schema (§2.2) already restricts
  operator-supplied lexemes to `^[A-Z][A-Z0-9_]*$`, so after
  validation the only character classes possible in a lexeme are
  ASCII letters, digits, and `_`. The escape is belt-and-braces.
- The `_` → `[_-]` rewrite is the round-2 fix for blocker B1. With
  it, the configured default `API_KEY` matches `SOME_API-KEY`
  exactly as the disapproved G35 r2 design required.
- The boundary alternations `(?:^|[_-])` and `(?:$|[_-])` also
  accept `-` as a left/right separator, so a name like `MY-TOKEN`
  (legal env-var-NAME shape on POSIX is `[A-Za-z_][A-Za-z0-9_]*`,
  so this is uncommon in practice but cheap to be robust about) is
  classified as a `TOKEN` match.
- The lexeme letters themselves are matched case-insensitively (the
  `i` flag); the suffix exemption uses `String.prototype.endsWith`
  on the upper-cased name to keep the suffix layer allocation-free.
- The factory returns a closure that allocates nothing per call in
  the fast path; `some(...)` short-circuits on the first lexeme
  match.

### 2.2 New `security.envScrubber` field in src/config.ts

Same shape as design r1. The `security` block at
[src/config.ts](../../../../src/config.ts#L111-L117) becomes:

```ts
  security: z
    .object({
      injectionScanner: z.boolean().default(true),
      injectionModel: z.string().optional(),
      maxScanLengthBytes: z.number().default(100_000),
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
    })
    .default({}),
```

A new import is added at the top of
[src/config.ts](../../../../src/config.ts#L1-L11):

```ts
import {
  DEFAULT_CREDENTIAL_LEXEMES,
  DEFAULT_CONFIG_POINTER_SUFFIXES,
} from "./security/secrets.js";
```

Schema-level guarantees (locked at parse time by `loadConfig`):

- `credentialLexemes`: non-empty array of strings matching
  `/^[A-Z][A-Z0-9_]*$/` — uppercase, alphanumeric + underscore,
  must start with a letter, length ≥ 1 character per element.
  Rejects empty strings, lowercase entries, leading underscores,
  regex metachars. `min(1)` rejects an operator-supplied empty
  array.
- `configPointerSuffixes`: array of strings matching
  `/^_[A-Z][A-Z0-9_]*$/` — must start with `_`, then an uppercase
  letter, then alphanumeric + underscore. Empty arrays are
  allowed: an empty suffix list disables layer 2 entirely.

The `[...DEFAULT_...]` spread copies the `ReadonlyArray` into a
mutable array for Zod's `.default(...)` expectation; the runtime
config object is otherwise treated as readonly. Where a default is
applied, it materializes ONLY on the parsed config object —
[.saivage/saivage.json](../../../../src/config.ts#L271-L273) is
never written to. Operators who want to see the defaults in their
config file must spell them out by hand, exactly as for any other
schema-defaulted field.

### 2.3 Predicate wired into src/mcp/builtins.ts

Identical to design r1 — see [02-design-r1.md §2.3](02-design-r1.md#L218-L296)
for the verbatim diffs. The four edits are:

1. **Import** at the top of
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1-L40):

   ```ts
   import {
     createSecretEnvNamePredicate,
     DEFAULT_CREDENTIAL_LEXEMES,
     DEFAULT_CONFIG_POINTER_SUFFIXES,
   } from "../security/secrets.js";
   ```

2. **Module-level mutable predicate** replacing the
   `SECRET_ENV_PATTERNS` block at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L398-L421):

   ```ts
   /**
    * Env-var NAME classifier used by `filterShellEnv` below. The
    * rule set is configurable via .saivage/saivage.json under
    * security.envScrubber; defaults are imported from
    * src/security/secrets.ts. The predicate is rebuilt at the start
    * of `registerBuiltinServices` from the resolved config and
    * captured here so the spawn path stays allocation-free.
    *
    * Operator overrides are full replacements: if the operator sets
    * `credentialLexemes`, only that list is used (no union with the
    * defaults). The factory contract is documented in
    * createSecretEnvNamePredicate.
    */
   let secretEnvNamePredicate: (name: string) => boolean =
     createSecretEnvNamePredicate({
       credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
       configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
     });
   ```

3. **filterShellEnv body** at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432):

   ```ts
   export function filterShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
     const result: NodeJS.ProcessEnv = {};
     for (const [key, value] of Object.entries(env)) {
       if (value === undefined) continue;
       if (secretEnvNamePredicate(key)) continue;
       result[key] = value;
     }
     return result;
   }
   ```

4. **registerBuiltinServices signature + body** at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082)
   takes a third positional `securityConfig: SaivageConfig["security"]`:

   ```ts
   export function registerBuiltinServices(
     mcpRuntime: McpRuntime,
     mcpConfig: import("../config.js").SaivageConfig["mcp"],
     securityConfig: import("../config.js").SaivageConfig["security"],
     options: BuiltinServicesOptions = {},
   ): void {
     // ... existing assignments unchanged ...
     SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;
     secretEnvNamePredicate = createSecretEnvNamePredicate({
       credentialLexemes: securityConfig.envScrubber.credentialLexemes,
       configPointerSuffixes: securityConfig.envScrubber.configPointerSuffixes,
     });
     // ... rest of body unchanged ...
   }
   ```

   The six call sites are updated to pass `cfg.security`; the list
   is at §3.

### 2.4 Behavior parity audit (default config, vs the disapproved G35)

With the defaults from §2.1 and the round-2 compiler, every
classification row from the disapproved
[../G35/02-design-r2.md §2.2](../G35/02-design-r2.md#L92) still
holds, and the previously-regressed `SOME_API-KEY` row is restored:

| Env-var name | Lexeme matched | Ends in pointer suffix? | Predicate result |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `API_KEY` (via `[_-]` internal) | no | true |
| `OPENAI_API_KEY` | `API_KEY` | no | true |
| `GITHUB_TOKEN` | `TOKEN` | no | true |
| `GH_TOKEN` | `TOKEN` | no | true |
| `TELEGRAM_BOT_TOKEN` | `TOKEN` | no | true |
| `SLACK_TOKEN` | `TOKEN` | no | true |
| `AWS_ACCESS_KEY_ID` | `ACCESS_KEY` (via `[_-]` internal) | no | true |
| `AWS_SECRET_ACCESS_KEY` | `SECRET` and `ACCESS_KEY` | no | true |
| `AWS_SESSION_TOKEN` | `SESSION` and `TOKEN` | no | true |
| `SAIVAGE_API_TOKEN` | `TOKEN` | no | true |
| `DATABASE_PASSWORD` | `PASSWORD` | no | true |
| `SOME_API-KEY` | `API_KEY` (boundary `-`, internal `[_-]`) | no | true |
| `ACCESS-KEY` | `ACCESS_KEY` (boundary `^`/`$`, internal `[_-]`) | no | true |
| `MY_SECRETARY` | none (`SECRET` then `A`, not separator) | n/a | false |
| `PASSWORDLESS_MODE` | none | n/a | false |
| `TOKENIZER` | none | n/a | false |
| `CREDENTIALSMITH_BIN` | none | n/a | false |
| `STAGETOKENISER_PATH` | none | n/a | false |
| `RESET_PASSWORD_URL` | `PASSWORD` | `_URL` | false |
| `PASSWORD_PROMPT` | `PASSWORD` | `_PROMPT` | false |
| `OPENAI_BASE_URL` | none | `_URL` (irrelevant — layer 1 already false) | false |
| `GITHUB_API_BASE_URL_TEMPLATE` | none | `_TEMPLATE` | false |

All six explicit cases from the G35 finding (three FP, three FN)
classify correctly, and the new `SOME_API-KEY` / `ACCESS-KEY` rows
mandated by reviewer B1 also classify as secret.

### 2.5 Operator override examples

The schema accepts three useful override shapes; round 2 pins
behavior for all three at the test layer (see §2.6).

**Additive — keep all defaults, add a project lexeme:**

```json
{ "security": { "envScrubber": {
  "credentialLexemes": [
    "API_KEY", "ACCESS_KEY", "TOKEN", "SECRET", "PASSWORD",
    "PASSWD", "CREDENTIAL", "AUTH", "BEARER", "COOKIE", "SESSION",
    "PII"
  ]
} } }
```

`PII_DATA` is now scrubbed; all default behavior preserved.

**Replacement — operator deliberately drops some defaults:**

```json
{ "security": { "envScrubber": {
  "credentialLexemes": ["PII"]
} } }
```

`PII_DATA` is scrubbed; `ANTHROPIC_API_KEY` is PRESERVED unmodified
(the operator has explicitly decided not to scrub provider tokens
in this project, e.g. a CI agent that needs to forward them
intact). This is the case that proves full-replacement semantics
and that an additive-only implementation cannot satisfy.

**Suffix exemption disabled — every layer-1 match is a secret:**

```json
{ "security": { "envScrubber": {
  "configPointerSuffixes": []
} } }
```

`ANTHROPIC_API_KEY` stays scrubbed; `RESET_PASSWORD_URL` is now
ALSO scrubbed (the `_URL` exemption is gone). This is the other
replacement-semantics anchor case.

### 2.6 Tests

Three test files are touched. The structure mirrors design r1
[02-design-r1.md §2.6](02-design-r1.md#L312-L443); round 2 adds the
fixes for B2 and N2, plus an explicit FN row for the hyphen-form
key.

**A — corpora and operator-override predicate test in
[src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1):**

1. Extend the existing import line to add
   `createSecretEnvNamePredicate`, `DEFAULT_CREDENTIAL_LEXEMES`,
   `DEFAULT_CONFIG_POINTER_SUFFIXES`.

2. Append a `describe("createSecretEnvNamePredicate — defaults")`
   block that builds the predicate once with the default rules and
   runs the FP corpus and FN corpus from
   [../G35/02-design-r2.md §2.4](../G35/02-design-r2.md#L160-L222),
   each via `it.each`. The FN corpus from G35 r2 already contains
   `SOME_API-KEY`; round 2 additionally pins `ACCESS-KEY` and
   `SOME-ACCESS-KEY` as FN rows to lock the round-2 compiler against
   future regression. Final FN corpus (additions in **bold** at the
   row level — but rendered as plain text below; no formatting):

   ```
   API_KEY
   MY_API_KEY
   API_KEYS
   SOME_API-KEY
   ACCESS-KEY
   SOME-ACCESS-KEY
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
   OPENAI_API_KEY
   GITHUB_TOKEN
   GH_TOKEN
   TELEGRAM_BOT_TOKEN
   SLACK_TOKEN
   AWS_ACCESS_KEY_ID
   AWS_SECRET_ACCESS_KEY
   AWS_SESSION_TOKEN
   SAIVAGE_API_TOKEN
   ```

   The FP corpus from G35 r2 is copied verbatim (no additions in
   round 2; reviewer B1 only flagged FN coverage).

3. Append `describe("createSecretEnvNamePredicate — operator overrides")`
   with five `it(...)` cases:

   ```ts
   it("adds a project-specific credential lexeme (additive)", () => {
     const defaultPredicate = createSecretEnvNamePredicate({
       credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
       configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
     });
     expect(defaultPredicate("PII_DATA")).toBe(false);
     expect(defaultPredicate("MY_PII")).toBe(false);

     const extended = createSecretEnvNamePredicate({
       credentialLexemes: [...DEFAULT_CREDENTIAL_LEXEMES, "PII"],
       configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
     });
     expect(extended("PII_DATA")).toBe(true);
     expect(extended("MY_PII")).toBe(true);
     expect(extended("PII_URL")).toBe(false); // exempt via _URL
     // Pre-existing classifications unchanged:
     expect(extended("ANTHROPIC_API_KEY")).toBe(true);
     expect(extended("RESET_PASSWORD_URL")).toBe(false);
   });

   it("replaces the lexeme list (full-replacement semantics)", () => {
     // Operator deliberately drops all defaults and keeps only PII.
     const replaced = createSecretEnvNamePredicate({
       credentialLexemes: ["PII"],
       configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
     });
     // The new lexeme is honored:
     expect(replaced("PII_DATA")).toBe(true);
     // Defaults are NOT silently unioned in — provider tokens
     // pass through unscrubbed because the operator opted out:
     expect(replaced("ANTHROPIC_API_KEY")).toBe(false);
     expect(replaced("OPENAI_API_KEY")).toBe(false);
     expect(replaced("GITHUB_TOKEN")).toBe(false);
     expect(replaced("DATABASE_PASSWORD")).toBe(false);
   });

   it("adds a project-specific config-pointer suffix (additive)", () => {
     const defaultPredicate = createSecretEnvNamePredicate({
       credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
       configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
     });
     expect(defaultPredicate("ARTIFACT_TOKEN_BUILDFILE")).toBe(true);

     const extended = createSecretEnvNamePredicate({
       credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
       configPointerSuffixes: [
         ...DEFAULT_CONFIG_POINTER_SUFFIXES,
         "_BUILDFILE",
       ],
     });
     expect(extended("ARTIFACT_TOKEN_BUILDFILE")).toBe(false);
     // Non-suffix names with the same lexeme still scrubbed:
     expect(extended("ARTIFACT_TOKEN")).toBe(true);
   });

   it("replaces the suffix list with an empty array (layer 2 off)", () => {
     // Operator deliberately disables every suffix exemption.
     const replaced = createSecretEnvNamePredicate({
       credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
       configPointerSuffixes: [],
     });
     // Layer 1 still catches credentials:
     expect(replaced("ANTHROPIC_API_KEY")).toBe(true);
     // Layer 2 is OFF, so config pointers that previously escaped
     // are now scrubbed:
     expect(replaced("RESET_PASSWORD_URL")).toBe(true);
     expect(replaced("PASSWORD_PROMPT")).toBe(true);
     // Names that never matched layer 1 are still preserved:
     expect(replaced("OPENAI_BASE_URL")).toBe(false);
     expect(replaced("PATH")).toBe(false);
   });

   it("empty lexeme list produces an always-false predicate", () => {
     // Contract documentation only — the schema (.min(1)) prevents
     // this construction via loadConfig; see config-validation.test.
     const empty = createSecretEnvNamePredicate({
       credentialLexemes: [],
       configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
     });
     expect(empty("ANTHROPIC_API_KEY")).toBe(false);
   });
   ```

**B — schema validation tests in
[src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1):**

Append one `describe("security.envScrubber")` block with the
following `it(...)` cases:

1. "defaults to the built-in lexeme and suffix arrays" — `{}` in
   `.saivage/saivage.json`; `loadConfig(true, projectRoot)` returns
   `cfg.security.envScrubber.credentialLexemes` deep-equal to
   `DEFAULT_CREDENTIAL_LEXEMES` and likewise for
   `configPointerSuffixes`.
2. "rejects an empty `credentialLexemes` array" —
   `{ credentialLexemes: [] }` throws `ZodError`.
3. "rejects an empty-string lexeme element" —
   `{ credentialLexemes: [""] }` throws `ZodError` (N2 pin —
   ensures the per-element `regex(/^[A-Z][A-Z0-9_]*$/)` is wired,
   not just `.min(1)` on the array).
4. "rejects a lowercase credential lexeme" —
   `{ credentialLexemes: ["api_key"] }` throws.
5. "rejects an empty-string suffix element" —
   `{ configPointerSuffixes: [""] }` throws (N2 pin for the
   suffix array; mirrors case 3).
6. "rejects a config-pointer suffix without leading underscore" —
   `{ configPointerSuffixes: ["URL"] }` throws.
7. "accepts an empty `configPointerSuffixes` array" —
   `{ configPointerSuffixes: [] }` parses cleanly and produces a
   resolved config with `configPointerSuffixes: []`. (Pairs with
   override case 4 in §2.6 A and end-to-end case 4 in §2.6 C; locks
   the schema decision that the suffix list is allowed to be empty
   under full-replacement semantics.)

**C — integration tests in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1):**

Append one `describe("filterShellEnv")` block. Each `it(...)` uses
the existing tmp-dir + `loadConfig + registerBuiltinServices`
pattern from the test file. The block contains:

1. "preserves config-pointer names (RESET_PASSWORD_URL)" — default
   config; `filterShellEnv({ RESET_PASSWORD_URL: "..." })` returns
   the value unchanged.
2. "drops credential-shaped names (ANTHROPIC_API_KEY)" — default
   config; `filterShellEnv({ ANTHROPIC_API_KEY: "..." })` strips
   the key.
3. "honors hyphen-form credential names (SOME_API-KEY)" — default
   config; `filterShellEnv({ "SOME_API-KEY": "..." })` strips the
   key. (B1 anchor at the integration layer.)
4. "honors operator-extended lexemes via security.envScrubber
   (additive)" — project config with
   `credentialLexemes: [...DEFAULT_CREDENTIAL_LEXEMES, "PII"]`;
   loads config, calls `registerBuiltinServices(runtime, cfg.mcp,
   cfg.security)`, then asserts `PII_DATA` is dropped,
   `ANTHROPIC_API_KEY` is dropped, `RESET_PASSWORD_URL` is
   preserved. (Same as design r1's single mutation test, kept as
   the additive anchor.)
5. **"honors operator-REPLACED lexeme list (full replacement)"** —
   project config with `credentialLexemes: ["PII"]` ONLY; loads
   config, registers builtins, then asserts:
   - `filterShellEnv({ PII_DATA: "x" }).PII_DATA === undefined`
     (the new lexeme is honored), AND
   - `filterShellEnv({ ANTHROPIC_API_KEY: "x" }).ANTHROPIC_API_KEY === "x"`
     (the default `API_KEY` lexeme is NOT silently retained).

   This is the B2 anchor — an additive-only implementation cannot
   pass the second assertion because the un-removed default
   `API_KEY` lexeme would still match `ANTHROPIC_API_KEY`. The
   assertion forces full-replacement semantics at the integration
   layer.
6. **"honors operator-REPLACED suffix list (empty disables layer 2)"** —
   project config with `configPointerSuffixes: []` (and defaults
   for `credentialLexemes`); loads config, registers builtins,
   then asserts:
   - `filterShellEnv({ RESET_PASSWORD_URL: "y" }).RESET_PASSWORD_URL === undefined`
     (no more `_URL` exemption), AND
   - `filterShellEnv({ ANTHROPIC_API_KEY: "x" }).ANTHROPIC_API_KEY === undefined`
     (lexeme layer intact), AND
   - `filterShellEnv({ OPENAI_BASE_URL: "z" }).OPENAI_BASE_URL === "z"`
     (no lexeme match, so still preserved).

   This is the second B2 anchor — proves the suffix array is also a
   full-replacement field and that an empty array is honored.

Tests 5 and 6 between them prove that BOTH config arrays are
fed directly into the predicate without union, which is the
contract B2 requires.

## 3. Call-site updates for the new positional `securityConfig`

Identical to design r1. Six call sites:

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145).
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56).
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232).
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252).
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287).
- [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24).

Every caller passes `cfg.security` positionally between `cfg.mcp`
and the options object.

## 4. Files touched (deep links, line numbers verified 2026-05-26)

Same set as design r1 [02-design-r1.md §4](02-design-r1.md#L568-L580),
unchanged. The only deltas relative to round 1 are inside the
content of F1 (compiler body), F14 (one extra FN row, one new
replacement-semantics `it`), F15 (two extra negative pins for
empty-string elements and one accept-empty-suffix pin), and F16
(two extra integration `it`s for hyphen-form and replacement
semantics).

| # | File | Region | Edit kind |
|---|---|---|---|
| F1 | [src/security/secrets.ts](../../../../src/security/secrets.ts#L77-L80) | after `BLOCKED_PATH_RULES`, before `shannonEntropy` | insert two exported default arrays, one interface, one exported factory (round-2 compiler body — `_` → `[_-]` and boundary `[_-]`) |
| F2 | [src/config.ts](../../../../src/config.ts#L1-L11) | imports | add `DEFAULT_CREDENTIAL_LEXEMES`, `DEFAULT_CONFIG_POINTER_SUFFIXES` |
| F3 | [src/config.ts](../../../../src/config.ts#L111-L117) | `security` Zod block | append `envScrubber` sub-object with validated arrays defaulting to the imported constants via `.default(...)` |
| F4 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1-L40) | imports | add `createSecretEnvNamePredicate`, `DEFAULT_CREDENTIAL_LEXEMES`, `DEFAULT_CONFIG_POINTER_SUFFIXES` |
| F5 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L398-L421) | `SECRET_ENV_PATTERNS` block | delete entirely; replace with `let secretEnvNamePredicate = createSecretEnvNamePredicate(...)` |
| F6 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432) | `filterShellEnv` body | replace `.some(...)` with `secretEnvNamePredicate(key)` |
| F7 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082) | `registerBuiltinServices` signature + body | add 3rd positional `securityConfig`; rebuild predicate |
| F8 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145) | call site | pass `config.security` positionally |
| F9 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56) | call site | pass `cfg.security` positionally |
| F10 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232) | call site | pass `cfg.security` positionally |
| F11 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252) | call site | pass `cfg.security` positionally |
| F12 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287) | call site | pass `cfg.security` positionally |
| F13 | [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24) | call site | pass `cfg.security` positionally |
| F14 | [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) | append | corpora tests (FN corpus extended with `ACCESS-KEY`, `SOME-ACCESS-KEY`) + 5 operator-override `it`s incl. the two replacement cases (§2.6 A) |
| F15 | [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1) | append | 7 schema-validation `it`s (§2.6 B), incl. the two empty-string-element negative pins (N2) and the accept-empty-suffix positive pin |
| F16 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) | append | `describe("filterShellEnv")` with 6 `it`s (§2.6 C), incl. the hyphen-form (B1), additive, lexeme-replacement (B2), and suffix-replacement (B2) integration anchors |

No new files. No JSON-Schema artefact updates. No documentation
changes.

## 5. Rejected alternative — Proposal B (additive-only overrides)

Same rationale as design r1
[02-design-r1.md §5](02-design-r1.md#L544-L564). Additive-only
overrides still encode a hardcoded baseline that operators cannot
remove from, and reviewer r1 explicitly required the test layer to
prove full-replacement semantics. Round 2 keeps Proposal B
rejected, and tests R-A and R-B (§2.6 C cases 5 and 6) now
mechanically PROVE that an additive-only implementation would fail.

## 6. Rejected alternative — Proposal C (env-var override)

Unchanged from design r1.

## 7. Where the round-1 hyphen-form guarantee is now pinned

Three independent test layers, so a future refactor cannot
silently regress the round-2 fix:

- **Predicate corpus** in
  [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1)
  — `SOME_API-KEY`, `ACCESS-KEY`, `SOME-ACCESS-KEY` pinned as FN
  rows (§2.6 A step 2).
- **Integration test** in
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1)
  — `filterShellEnv({ "SOME_API-KEY": ... })` drops the key
  (§2.6 C case 3).
- **Behavior-parity audit table** in this design at §2.4 includes
  the `SOME_API-KEY` and `ACCESS-KEY` rows as documentation, so a
  reviewer or future author can read the contract directly from the
  spec.

## 8. What is removed (architecture-first, no shim)

Same as design r1 [02-design-r1.md §7](02-design-r1.md#L600). The
`SECRET_ENV_PATTERNS` constant, its JSDoc, and the two-arg
`registerBuiltinServices` shape are all deleted in the same commit;
no alias, no re-export, no toggle.

## 9. Out of scope (explicit)

Same as design r1 [02-design-r1.md §8](02-design-r1.md#L611). The
`BLOCKED_PATH_RULES`, `PROVIDER_RULES`, `LITERAL_RULES`,
`ENV_ASSIGNMENT_PATTERN`, and routing-resolver surfaces are not
touched.
