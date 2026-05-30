# G35b — Design r1

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r1.md](01-analysis-r1.md)

**Supersedes (disapproved)**: [../G35/02-design-r2.md](../G35/02-design-r2.md)

**Writer**: Claude Opus 4.7, round 1.

## 1. Recommendation

**Proposal A — config-driven full lists with defaults in the security module.**

The credential lexeme set and the config-pointer suffix exemption set
both become operator-overridable arrays under a new
`security.envScrubber` object in
[src/config.ts](../../../../src/config.ts#L111-L117). The defaults are
exported `const` arrays from
[src/security/secrets.ts](../../../../src/security/secrets.ts#L80) and
imported by the Zod schema as `.default(...)`. A new exported factory
`createSecretEnvNamePredicate({credentialLexemes, configPointerSuffixes})`
compiles the lexemes into word-anchored regexes and returns a closure
predicate. The predicate is built once per process in
`registerBuiltinServices` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082) and
captured by `filterShellEnv` at
[src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432). The
old `SECRET_ENV_PATTERNS` constant is deleted in the same commit.

## 2. Proposal A — anchored lexemes + config-pointer suffixes, both config-driven

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
 * may override the full list via .saivage/saivage.json under
 * security.envScrubber.credentialLexemes; see src/config.ts.
 *
 * The list MUST stay short and conservative — any entry here is a
 * lexeme that operators in EVERY project are expected to treat as
 * credential-bearing. Project-specific additions belong in the
 * operator config, not in this default.
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
 * Operators may override the full list via
 * security.envScrubber.configPointerSuffixes.
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
 *   1. credentialLexemes — each lexeme L is compiled to
 *      /(?:^|_)L(S?)(?:$|_)/i where S? is the plural-tolerance
 *      group (TOKEN matches TOKENS, KEY matches KEYS, etc.). Because
 *      each side requires either an underscore or a string boundary,
 *      MY_SECRETARY, TOKENIZER, PASSWORDLESS_MODE do NOT match.
 *   2. configPointerSuffixes — names that pass layer 1 but end in
 *      one of the (uppercase) suffixes are configuration pointers
 *      or UI strings and are preserved.
 *
 * Predicate construction is O(|credentialLexemes|) regex compiles;
 * call sites SHOULD build the predicate once and reuse it.
 */
export function createSecretEnvNamePredicate(
  rules: SecretEnvNameRules,
): (name: string) => boolean {
  const lexemePatterns: RegExp[] = rules.credentialLexemes.map((lex) => {
    const escaped = lex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|_)${escaped}S?(?:$|_)`, "i");
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

Notes:

- `(?:^|_)…S?(?:$|_)` requires the lexeme to be a discrete
  underscore-bounded token; the `S?` group covers the plural form
  (`TOKEN`/`TOKENS`, `API_KEY`/`API_KEYS`, `CREDENTIAL`/`CREDENTIALS`).
- The `.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` step ensures that
  operator-supplied lexemes are treated as literals (no regex
  injection). The schema also restricts lexeme characters (§2.2) so
  the only metachar that could appear after validation is `_`, which
  is regex-safe; the escape is belt-and-braces.
- The factory returns a closure that allocates nothing per call in
  the fast path (`some(...)` short-circuits on the first lexeme
  match; `endsWith` is allocation-free).
- The factory is exported so tests can construct alternative
  predicates without round-tripping through `loadConfig`.

### 2.2 New `security.envScrubber` field in src/config.ts

Added to the `security` block at
[src/config.ts](../../../../src/config.ts#L111-L117). The block
currently reads:

```ts
  security: z
    .object({
      injectionScanner: z.boolean().default(true),
      injectionModel: z.string().optional(),
      maxScanLengthBytes: z.number().default(100_000),
    })
    .default({}),
```

It becomes:

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

Schema-level guarantees:

- `credentialLexemes`: non-empty array of strings matching
  `/^[A-Z][A-Z0-9_]*$/` — uppercase, alphanumeric + underscore,
  must start with a letter. Rejects empty strings, lowercase
  entries, leading underscores, regex metachars. `min(1)` rejects
  the operator-supplied empty list (R3 from
  [01-analysis-r1.md](01-analysis-r1.md#L1)).
- `configPointerSuffixes`: array of strings matching
  `/^_[A-Z][A-Z0-9_]*$/` — must start with `_` and be uppercase.
  Empty array is allowed (it just makes the predicate stricter).

The `[...DEFAULT_...]` spread copies the `ReadonlyArray` into a
mutable array for Zod's `.default(...)` expectation; the runtime
config object is still treated as readonly elsewhere.

### 2.3 Predicate wired into src/mcp/builtins.ts

Three edits inside [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1):

1. **Import** — add at the top of the file, alongside the existing
   `../security/...` imports section, or next to the other
   intra-package imports if no such section exists:

   ```ts
   import {
     createSecretEnvNamePredicate,
     DEFAULT_CREDENTIAL_LEXEMES,
     DEFAULT_CONFIG_POINTER_SUFFIXES,
   } from "../security/secrets.js";
   ```

2. **Module-level mutable predicate** — replace the entire
   `SECRET_ENV_PATTERNS` block at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L398-L421)
   (JSDoc + constant) with:

   ```ts
   /**
    * Env-var NAME classifier used by `filterShellEnv` below. The
    * rule set lives in `.saivage/saivage.json` under
    * `security.envScrubber`; defaults are imported from
    * `src/security/secrets.ts`. The predicate is rebuilt at the
    * start of `registerBuiltinServices` from the resolved config
    * and captured here so the spawn path stays allocation-free.
    */
   let secretEnvNamePredicate: (name: string) => boolean =
     createSecretEnvNamePredicate({
       credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
       configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
     });
   ```

   This mirrors the existing mutable-default pattern used at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L39-L44)
   for `MAX_OUTPUT` and `SHELL_TIMEOUT_FLOOR_MS`.

3. **filterShellEnv body** — at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432)
   the `SECRET_ENV_PATTERNS.some(...)` call becomes
   `secretEnvNamePredicate(key)`:

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

4. **registerBuiltinServices signature + body** — at
   [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082)
   the function takes a new positional `securityConfig` slice and
   rebuilds the predicate from it. The new signature is:

   ```ts
   export function registerBuiltinServices(
     mcpRuntime: McpRuntime,
     mcpConfig: import("../config.js").SaivageConfig["mcp"],
     securityConfig: import("../config.js").SaivageConfig["security"],
     options: BuiltinServicesOptions = {},
   ): void {
     // ... existing body ...
     MAX_OUTPUT = mcpConfig.maxOutputBytes;
     MAX_FETCH_CHARS = mcpConfig.maxFetchChars;
     MAX_DOWNLOAD_BYTES = mcpConfig.maxDownloadBytes;
     SHELL_TIMEOUT_FLOOR_MS = mcpConfig.shellTimeoutFloorMs;
     secretEnvNamePredicate = createSecretEnvNamePredicate({
       credentialLexemes: securityConfig.envScrubber.credentialLexemes,
       configPointerSuffixes: securityConfig.envScrubber.configPointerSuffixes,
     });
     // ... rest unchanged ...
   }
   ```

   The new positional argument lands between `mcpConfig` and
   `options` (i.e. third). All six call sites are updated to pass
   `cfg.security` alongside `cfg.mcp` — listed in §3.

### 2.4 Behavior parity audit (no regressions vs the disapproved G35)

With the defaults from §2.1 and the predicate from §2.1, every
classification row from the disapproved
[../G35/02-design-r2.md §2.2](../G35/02-design-r2.md) still holds:

| Env-var name | Lexeme matched | Ends in pointer suffix? | Predicate result |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | `_API_KEY` | no | true |
| `OPENAI_API_KEY` | `_API_KEY` | no | true |
| `GITHUB_TOKEN` | `_TOKEN` | no | true |
| `GH_TOKEN` | `_TOKEN` | no | true |
| `TELEGRAM_BOT_TOKEN` | `_TOKEN` | no | true |
| `SLACK_TOKEN` | `_TOKEN` | no | true |
| `AWS_ACCESS_KEY_ID` | `_ACCESS_KEY_` | no | true |
| `AWS_SECRET_ACCESS_KEY` | `_SECRET_` and `_ACCESS_KEY` | no | true |
| `AWS_SESSION_TOKEN` | `_SESSION_` and `_TOKEN` | no | true |
| `SAIVAGE_API_TOKEN` | `_TOKEN` | no | true |
| `DATABASE_PASSWORD` | `_PASSWORD` | no | true |
| `MY_SECRETARY` | none (SECRET not _-bounded) | n/a | false |
| `PASSWORDLESS_MODE` | none (PASSWORD not _-bounded) | n/a | false |
| `TOKENIZER` | none (TOKEN not _-bounded) | n/a | false |
| `RESET_PASSWORD_URL` | `_PASSWORD_` | `_URL` | false |
| `PASSWORD_PROMPT` | `PASSWORD_` | `_PROMPT` | false |
| `OPENAI_BASE_URL` | none (no lexeme) | `_URL` | false |
| `GITHUB_API_BASE_URL_TEMPLATE` | none (no lexeme) | `_TEMPLATE` | false |

The G35 finding's three explicit false-positive cases
(`MY_SECRETARY`, `STAGETOKENISER_PATH`, `RESET_PASSWORD_URL`) and the
three explicit false-negative cases (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `GITHUB_TOKEN`) all classify correctly.

The lexeme set is **broader** than the disapproved design's
(`AUTH`, `BEARER`, `COOKIE`, `SESSION` are added). Side-effects of
the broader defaults:

- `AUTH_TOKEN`, `BEARER_TOKEN`, `SESSION_TOKEN` were already secret
  via the `_TOKEN` lexeme; adding the standalone `AUTH`/`BEARER`/
  `SESSION` lexemes additionally catches names like `AUTH_KEY`
  (unlikely to be a config pointer) and `SESSION_SECRET` (already
  caught by `_SECRET`).
- `COOKIE` catches names like `SESSION_COOKIE`. Pointer names like
  `COOKIE_FILE` and `COOKIE_PATH` are exempted by the suffix layer.
- `AUTH_URL`, `BEARER_URL`, `COOKIE_URL`, `SESSION_URL` are exempted
  by `_URL`.

The broader default keeps the redo aligned with the user-provided
list (TOKEN, SECRET, PASSWORD, KEY, AUTH, BEARER, COOKIE, SESSION) in
the task statement.

### 2.5 Operator override example

A project that uses an in-house token named `BUILDFILE_KEY` (a
public build artifact, not a credential) but does need an extra
domain-specific lexeme `PII` adds the following to
[.saivage/saivage.json](../../../../src/config.ts#L271-L273):

```json
{
  "security": {
    "envScrubber": {
      "credentialLexemes": [
        "API_KEY", "ACCESS_KEY", "TOKEN", "SECRET", "PASSWORD",
        "PASSWD", "CREDENTIAL", "AUTH", "BEARER", "COOKIE", "SESSION",
        "PII"
      ],
      "configPointerSuffixes": [
        "_URL", "_URI", "_ENDPOINT", "_PATH", "_DIR", "_FILE",
        "_PROMPT", "_TEMPLATE", "_BUILDFILE"
      ]
    }
  }
}
```

`BUILDFILE_KEY_BUILDFILE` (silly but legal) is now exempt; `PII_DATA`
is now scrubbed. No recompile.

### 2.6 Tests

Two test files are touched, one new corpus test added per file.

**A — corpora and config-override predicate test in
[src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1):**

1. Append import: `import {
   createSecretEnvNamePredicate, DEFAULT_CREDENTIAL_LEXEMES,
   DEFAULT_CONFIG_POINTER_SUFFIXES } from "./secrets.js";`.

2. Append a `describe("createSecretEnvNamePredicate — defaults")`
   block that materializes the predicate once
   (`const p = createSecretEnvNamePredicate({ credentialLexemes:
   DEFAULT_CREDENTIAL_LEXEMES, configPointerSuffixes:
   DEFAULT_CONFIG_POINTER_SUFFIXES });`) and runs the FP corpus and
   FN corpus from §2.4 of [../G35/02-design-r2.md](../G35/02-design-r2.md),
   each via `it.each`.

3. **NEW for G35b — append a
   `describe("createSecretEnvNamePredicate — operator overrides")`
   block** that exercises the config-driven extension axis:

   ```ts
   describe("createSecretEnvNamePredicate — operator overrides", () => {
     it("adds a project-specific credential lexeme", () => {
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

     it("adds a project-specific config-pointer suffix", () => {
       const defaultPredicate = createSecretEnvNamePredicate({
         credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
         configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
       });
       expect(defaultPredicate("ARTIFACT_TOKEN_BUILDFILE")).toBe(true);

       const extended = createSecretEnvNamePredicate({
         credentialLexemes: DEFAULT_CREDENTIAL_LEXEMES,
         configPointerSuffixes: [...DEFAULT_CONFIG_POINTER_SUFFIXES, "_BUILDFILE"],
       });
       expect(extended("ARTIFACT_TOKEN_BUILDFILE")).toBe(false);
       // Non-suffix names with the same lexeme still scrubbed:
       expect(extended("ARTIFACT_TOKEN")).toBe(true);
     });

     it("rejects predicate constructions that disable the scrub at the schema layer", () => {
       // Schema rejection happens in configSchema.parse; this test
       // covers the contract that the factory itself does NOT
       // silently accept an empty lexeme list — it returns a
       // predicate that always returns false, which the schema
       // prevents via .min(1). See src/config.test.ts for the
       // schema-level rejection.
       const empty = createSecretEnvNamePredicate({
         credentialLexemes: [],
         configPointerSuffixes: DEFAULT_CONFIG_POINTER_SUFFIXES,
       });
       expect(empty("ANTHROPIC_API_KEY")).toBe(false);
     });
   });
   ```

**B — schema validation tests in
[src/config.test.ts](../../../../src/config.test.ts#L1):**

Two new assertions appended to the existing test file (one
`describe("security.envScrubber")` block):

1. `loadConfig` returns the defaults when `.saivage/saivage.json`
   omits the `security.envScrubber` field — assert
   `config.security.envScrubber.credentialLexemes` equals
   `DEFAULT_CREDENTIAL_LEXEMES` element-wise and
   `configPointerSuffixes` equals `DEFAULT_CONFIG_POINTER_SUFFIXES`.
2. Schema rejects `credentialLexemes: []` (R3) — assert
   `configSchema.parse({ security: { envScrubber: {
   credentialLexemes: [] } } })` throws a `ZodError`.
3. Schema rejects a lowercase lexeme (R2) — assert
   `configSchema.parse({ security: { envScrubber: {
   credentialLexemes: ["api_key"] } } })` throws.
4. Schema rejects a suffix without leading `_` — assert
   `configSchema.parse({ security: { envScrubber: {
   configPointerSuffixes: ["URL"] } } })` throws.

(If `src/config.test.ts` does not exist, the assertions are appended
to [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1)
which is the existing nearest test file at the config layer.)

**C — integration test in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1):**

Append a new `describe("filterShellEnv")` block at the end with the
two integration assertions from [../G35/02-design-r2.md §2.4](../G35/02-design-r2.md):

1. `filterShellEnv({ RESET_PASSWORD_URL: "https://example.test/reset"
   }).RESET_PASSWORD_URL === "https://example.test/reset"`.
2. `filterShellEnv({ ANTHROPIC_API_KEY: "sk-test-not-real" })
   .ANTHROPIC_API_KEY === undefined`.

Plus a third G35b-specific assertion that exercises the config
plumbing end-to-end — writes a project `.saivage/saivage.json` with
`security.envScrubber.credentialLexemes` extended by `["PII"]`, calls
`loadConfig(true, projectRoot)`, calls `registerBuiltinServices` with
the resolved config, then asserts:

```ts
expect(filterShellEnv({ PII_DATA: "redacted" }).PII_DATA).toBe(undefined);
```

This is the test the task explicitly requires: mutating config adds
a project-specific lexeme and predicate output changes accordingly.

## 3. Call-site updates for the new positional `securityConfig`

Six call sites need the new `cfg.security` argument inserted:

- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145) —
  `registerBuiltinServices(mcpRuntime, config.mcp, config.security, { promptInjectionCop: ... });`
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56) —
  `registerBuiltinServices(runtime, cfg.mcp, cfg.security);`
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232) —
  `registerBuiltinServices(runtime, cfg.mcp, cfg.security, { promptInjectionCop: blockingCop });`
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252) —
  same shape as L232.
- [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287) —
  `registerBuiltinServices(runtime, cfg.mcp, cfg.security);`
- [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24) —
  `registerBuiltinServices(runtime, cfg.mcp, cfg.security);`

No call site needs to construct a `security` slice manually — every
caller already calls `loadConfig`, so `cfg.security` is always
populated with the defaults when the field is absent.

## 4. Files touched (deep links, live line numbers verified 2026-05-26)

| # | File | Region | Edit kind |
|---|---|---|---|
| F1 | [src/security/secrets.ts](../../../../src/security/secrets.ts#L77-L80) | after `BLOCKED_PATH_RULES`, before `shannonEntropy` | insert two exported default arrays, one interface, one exported factory |
| F2 | [src/config.ts](../../../../src/config.ts#L1-L11) | imports | add `DEFAULT_CREDENTIAL_LEXEMES` and `DEFAULT_CONFIG_POINTER_SUFFIXES` import |
| F3 | [src/config.ts](../../../../src/config.ts#L111-L117) | `security` Zod block | append `envScrubber` sub-object with validated arrays defaulting to the imported constants |
| F4 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1-L40) | imports | add `createSecretEnvNamePredicate`, `DEFAULT_CREDENTIAL_LEXEMES`, `DEFAULT_CONFIG_POINTER_SUFFIXES` import from `../security/secrets.js` |
| F5 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L398-L421) | `SECRET_ENV_PATTERNS` block | delete entirely; replace with `let secretEnvNamePredicate = createSecretEnvNamePredicate({ defaults })` |
| F6 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432) | `filterShellEnv` body | replace `.some(...)` with `secretEnvNamePredicate(key)` call |
| F7 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082) | `registerBuiltinServices` signature + body | add 3rd positional `securityConfig` argument; assign `secretEnvNamePredicate = createSecretEnvNamePredicate({ ... })` alongside the existing `MAX_OUTPUT = ...` assignments |
| F8 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145) | call site | pass `config.security` positionally |
| F9 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56) | call site | pass `cfg.security` positionally |
| F10 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232) | call site | pass `cfg.security` positionally |
| F11 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252) | call site | pass `cfg.security` positionally |
| F12 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287) | call site | pass `cfg.security` positionally |
| F13 | [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24) | call site | pass `cfg.security` positionally |
| F14 | [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) | append | corpora tests + operator-override tests (§2.6 A) |
| F15 | [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1) | append | four schema-validation assertions (§2.6 B) |
| F16 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) | append | `describe("filterShellEnv")` block with three assertions (§2.6 C), including the config-mutation end-to-end assertion |

No new files. No JSON-Schema artefact updates (none exists — see
[01-analysis-r1.md §2](01-analysis-r1.md#L1)). No documentation
changes.

## 5. Rejected alternative — Proposal B (additive-only overrides)

A simpler variant would keep the defaults compiled in and expose only
`security.envScrubber.extraCredentialLexemes` and
`security.envScrubber.extraConfigPointerSuffixes` that get unioned
with the defaults at predicate-build time.

Reasons rejected:

- The user directive says config beats hardcoding. Additive-only
  overrides still encode a hardcoded baseline that operators cannot
  remove from. If a future Saivage default (say, the new `COOKIE`
  lexeme) breaks a legitimate operator workflow, the operator's only
  recourse is to fork Saivage.
- The schema and factory complexity is the same either way — both
  variants compile lexemes to anchored regexes. Proposal B saves
  no code.
- Proposal A degrades gracefully to Proposal B's semantics for any
  operator who simply spreads the defaults
  (`[...DEFAULT_CREDENTIAL_LEXEMES, "MY_LEXEME"]`) — i.e. operators
  who *want* the additive behavior can express it trivially.

## 6. Rejected alternative — Proposal C (env-var override)

Reading the overrides from `process.env.SAIVAGE_SECRET_ENV_LEXEMES`
(comma-separated) is rejected because (a) per-process env-var
overrides cannot be reviewed in git, (b) the user directive
explicitly names the config file as the right home, and (c) env-var
plumbing would have to coexist with the env-scrubber itself, creating
an awkward ordering problem at process startup.

## 7. What is removed (architecture-first, no shim)

- The `SECRET_ENV_PATTERNS` constant at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L407-L421) —
  deleted in full. No alias, no re-export, no toggle.
- The JSDoc above `SECRET_ENV_PATTERNS` at
  [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L400-L406) —
  replaced by the new predicate-mutable JSDoc in §2.3.
- The two-arg `registerBuiltinServices` shape — replaced by the
  three-arg shape in §3. No deprecation alias.

No code from the disapproved [../G35/02-design-r2.md](../G35/02-design-r2.md)
ever lands in the tree: the `isSecretEnvName(name)` function name is
not introduced; the hardcoded module-level `SECRET_ENV_NAME_PATTERNS`
and `ENV_CONFIG_POINTER_SUFFIXES` constants are not introduced.

## 8. Out of scope (explicit)

- The `BLOCKED_PATH_RULES` list at
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L68-L77).
  Could in principle become config-driven under the same directive,
  but a separate finding should own that change so reviewers can
  judge it on its own evidence.
- The `PROVIDER_RULES` / `LITERAL_RULES` / `ENV_ASSIGNMENT_PATTERN`
  catalogues at
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L34-L67).
  Same reasoning.
- Any change to `injectionScanner`, `injectionModel`,
  `maxScanLengthBytes` at
  [src/config.ts](../../../../src/config.ts#L113-L115).
