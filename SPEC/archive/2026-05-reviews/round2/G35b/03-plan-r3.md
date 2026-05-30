# G35b — Implementation plan r3

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)

**Design**: [02-design-r3.md](02-design-r3.md)

**Round 2**: [03-plan-r2.md](03-plan-r2.md), reviewed in [04-review-r2.md](04-review-r2.md).

**Writer**: Claude Opus 4.7, round 3.

## 1. Scope

Implements Proposal A (round-3 form) from
[02-design-r3.md §2](02-design-r3.md). Same file set as round 2
[03-plan-r2.md §2](03-plan-r2.md#L22-L40). Deltas relative to round
2 are confined to two surfaces:

- **F15 body** — two new schema-layer full-replacement `it`s
  (S-R-A, S-R-B) plus a tightened literal-empty suffix assertion,
  and an explicit `mkdtempSync`-based fixture skeleton because the
  round-2 plan's "reuse the existing tmp-dir fixture" claim was
  inaccurate (cleanup note from
  [04-review-r2.md](04-review-r2.md#L17)).
- **Test gate 20** — replaced with two `rg -F` fixed-string
  sentinels (gates 20a and 20b) because the round-2 gate 20 string
  was malformed (B4 from [04-review-r2.md](04-review-r2.md#L11)).

No source code (F1-F13, F14, F16) changes between r2 and r3.

## 2. Files touched

Same table as [03-plan-r2.md §2](03-plan-r2.md#L22-L40), with only
F15's edit-kind row updated to reflect the new tests. F15 now
contains 9 `it`s (was 7 in r2).

| # | File | Edit kind |
|---|---|---|
| F1 | [src/security/secrets.ts](../../../../src/security/secrets.ts#L77-L80) | unchanged from [03-plan-r2.md F1](03-plan-r2.md#L26) |
| F2 | [src/config.ts](../../../../src/config.ts#L1-L11) | unchanged from [03-plan-r2.md F2](03-plan-r2.md#L27) |
| F3 | [src/config.ts](../../../../src/config.ts#L111-L117) | unchanged from [03-plan-r2.md F3](03-plan-r2.md#L28) |
| F4 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1-L40) | unchanged from [03-plan-r2.md F4](03-plan-r2.md#L29) |
| F5 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L398-L421) | unchanged from [03-plan-r2.md F5](03-plan-r2.md#L30) |
| F6 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L423-L432) | unchanged from [03-plan-r2.md F6](03-plan-r2.md#L31) |
| F7 | [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1071-L1082) | unchanged from [03-plan-r2.md F7](03-plan-r2.md#L32) |
| F8 | [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145) | unchanged from [03-plan-r2.md F8](03-plan-r2.md#L33) |
| F9 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L56) | unchanged from [03-plan-r2.md F9](03-plan-r2.md#L34) |
| F10 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L232) | unchanged from [03-plan-r2.md F10](03-plan-r2.md#L35) |
| F11 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L252) | unchanged from [03-plan-r2.md F11](03-plan-r2.md#L36) |
| F12 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L287) | unchanged from [03-plan-r2.md F12](03-plan-r2.md#L37) |
| F13 | [src/mcp/fsGuard.test.ts](../../../../src/mcp/fsGuard.test.ts#L24) | unchanged from [03-plan-r2.md F13](03-plan-r2.md#L38) |
| F14 | [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1) | unchanged from [03-plan-r2.md F14](03-plan-r2.md#L39) |
| F15 (round-3 form) | [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1) | Append a self-contained `describe("security.envScrubber")` block with its OWN tmp-dir fixture (the file does not currently have one — see [03-plan-r2.md §3.7](03-plan-r2.md#L255-L258) was inaccurate). 9 `it`s: defaults, empty-array reject, empty-string lexeme reject (N2), lowercase reject, empty-string suffix reject (N2), no-leading-underscore suffix reject, literal-empty suffix replacement (tightened), non-empty lexeme singleton replacement (S-R-A, B3), non-empty suffix singleton replacement (S-R-B, B3). |
| F16 | [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1) | unchanged from [03-plan-r2.md F16](03-plan-r2.md#L40) |

No new files. No new schema artefacts. No changes outside the
table.

## 3. Step-by-step

Steps 3.1 through 3.5 (F1 through F13) are identical to
[03-plan-r2.md §3.1-3.5](03-plan-r2.md#L44-L211). Step 3.6 (F14)
and step 3.8 (F16) are identical to
[03-plan-r2.md §3.6](03-plan-r2.md#L213-L257) and
[03-plan-r2.md §3.8](03-plan-r2.md#L401-L443). Only step 3.7 (F15)
is rewritten below.

### 3.1 F1 — extend [src/security/secrets.ts](../../../../src/security/secrets.ts#L1)

See [03-plan-r2.md §3.1](03-plan-r2.md#L44-L87). Unchanged.

### 3.2 F2, F3 — extend [src/config.ts](../../../../src/config.ts#L1)

See [03-plan-r2.md §3.2](03-plan-r2.md#L89-L121). Unchanged.

### 3.3 F4-F7 — edit [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1)

See [03-plan-r2.md §3.3](03-plan-r2.md#L123-L168). Unchanged.

### 3.4 F8 — update [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145)

See [03-plan-r2.md §3.4](03-plan-r2.md#L170-L182). Unchanged.

### 3.5 F9-F13 — update test callers

See [03-plan-r2.md §3.5](03-plan-r2.md#L184-L211). Unchanged.

### 3.6 F14 — extend [src/security/secrets.test.ts](../../../../src/security/secrets.test.ts#L1)

See [03-plan-r2.md §3.6](03-plan-r2.md#L213-L257). Unchanged.

### 3.7 F15 — extend [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1)

Round 2's claim that this file already had a tmp-dir +
`SAIVAGE_ROOT` fixture to reuse [03-plan-r2.md §3.7](03-plan-r2.md#L255-L258)
is incorrect — the live file is a pure-unit test for
`validateModelCoverage` and never touches the filesystem. Round 3
spells out the new fixture explicitly, mirroring the pattern in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L66).

#### 3.7.1 Imports

Extend the existing imports at the top of
[src/config-validation.test.ts](../../../../src/config-validation.test.ts#L1-L7)
to add (in addition to whatever is already there for the existing
`validateModelCoverage` tests):

```ts
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZodError } from "zod";
import { loadConfig } from "./config.js";
import {
  DEFAULT_CREDENTIAL_LEXEMES,
  DEFAULT_CONFIG_POINTER_SUFFIXES,
} from "./security/secrets.js";
```

The `beforeEach`/`afterEach` already present in the file (if any)
is for the existing `validateModelCoverage` block and is not
reused. The new `describe("security.envScrubber")` block declares
its own hooks.

#### 3.7.2 Fixture skeleton (block-local)

Append at the END of the file:

```ts
describe("security.envScrubber", () => {
  let projectRoot: string;
  let previousProjectRoot: string | undefined;
  let previousSaivageRoot: string | undefined;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), "saivage-envscrubber-"));
    previousProjectRoot = process.env["PROJECT_ROOT"];
    previousSaivageRoot = process.env["SAIVAGE_ROOT"];
    process.env["PROJECT_ROOT"] = projectRoot;
    process.env["SAIVAGE_ROOT"] = join(projectRoot, ".saivage");
    mkdirSync(join(projectRoot, ".saivage"), { recursive: true });
  });

  afterEach(() => {
    if (previousProjectRoot === undefined) delete process.env["PROJECT_ROOT"];
    else process.env["PROJECT_ROOT"] = previousProjectRoot;
    if (previousSaivageRoot === undefined) delete process.env["SAIVAGE_ROOT"];
    else process.env["SAIVAGE_ROOT"] = previousSaivageRoot;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeConfig(payload: unknown): void {
    writeFileSync(
      join(projectRoot, ".saivage", "saivage.json"),
      JSON.stringify(payload),
      "utf-8",
    );
  }

  // ... it() cases below ...
});
```

This skeleton is taken verbatim from the structure used in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L66),
with `vitest` `beforeEach`/`afterEach` instead of the async
`runtime.shutdown()` because no MCP runtime is started here.
`beforeEach`/`afterEach` are imported from `"vitest"` alongside the
existing `describe`/`it`/`expect` import.

#### 3.7.3 The nine `it(...)` cases

Add `beforeEach` and `afterEach` to the existing `vitest` import.
Then inside the block, in order:

**1. "defaults to the built-in lexeme and suffix arrays"**

```ts
it("defaults to the built-in lexeme and suffix arrays", () => {
  writeConfig({});
  const cfg = loadConfig(true, projectRoot);
  expect(cfg.security.envScrubber.credentialLexemes)
    .toEqual([...DEFAULT_CREDENTIAL_LEXEMES]);
  expect(cfg.security.envScrubber.configPointerSuffixes)
    .toEqual([...DEFAULT_CONFIG_POINTER_SUFFIXES]);
});
```

**2. "rejects an empty credentialLexemes array"**

```ts
it("rejects an empty credentialLexemes array", () => {
  writeConfig({ security: { envScrubber: { credentialLexemes: [] } } });
  expect(() => loadConfig(true, projectRoot)).toThrow(ZodError);
});
```

**3. "rejects an empty-string lexeme element"** (N2)

```ts
it("rejects an empty-string lexeme element", () => {
  writeConfig({ security: { envScrubber: { credentialLexemes: [""] } } });
  expect(() => loadConfig(true, projectRoot)).toThrow(ZodError);
});
```

**4. "rejects a lowercase credential lexeme"**

```ts
it("rejects a lowercase credential lexeme", () => {
  writeConfig({ security: { envScrubber: { credentialLexemes: ["api_key"] } } });
  expect(() => loadConfig(true, projectRoot)).toThrow(ZodError);
});
```

**5. "rejects an empty-string suffix element"** (N2)

```ts
it("rejects an empty-string suffix element", () => {
  writeConfig({ security: { envScrubber: { configPointerSuffixes: [""] } } });
  expect(() => loadConfig(true, projectRoot)).toThrow(ZodError);
});
```

**6. "rejects a config-pointer suffix without leading underscore"**

```ts
it("rejects a config-pointer suffix without leading underscore", () => {
  writeConfig({ security: { envScrubber: { configPointerSuffixes: ["URL"] } } });
  expect(() => loadConfig(true, projectRoot)).toThrow(ZodError);
});
```

**7. "replaces configPointerSuffixes with a literal empty array (full replacement)"** — round-3 tightening

```ts
it("replaces configPointerSuffixes with a literal empty array (full replacement)", () => {
  writeConfig({ security: { envScrubber: { configPointerSuffixes: [] } } });
  const cfg = loadConfig(true, projectRoot);
  const got = cfg.security.envScrubber.configPointerSuffixes;
  expect(got).toEqual([]);
  expect(got.length).toBe(0);
  // Defaults must NOT be silently re-injected:
  expect(got).not.toContain("_URL");
  expect(got).not.toContain("_PATH");
  expect(got).not.toContain("_PROMPT");
  expect(got).not.toContain("_TEMPLATE");
});
```

The four `not.toContain` lines fail any implementation that
substitutes the defaults when the operator supplies `[]`. The
`toEqual([])` line is the strongest single assertion (it forbids
any element at all), and the `length === 0` line documents intent.

**8. "replaces credentialLexemes with a non-empty singleton (full replacement)"** — round-3 anchor S-R-A

```ts
it("replaces credentialLexemes with a non-empty singleton (full replacement)", () => {
  writeConfig({ security: { envScrubber: { credentialLexemes: ["PII"] } } });
  const cfg = loadConfig(true, projectRoot);
  const got = cfg.security.envScrubber.credentialLexemes;
  expect(got).toEqual(["PII"]);
  expect(got.length).toBe(1);
  expect(got[0]).toBe("PII");
  // Defaults must NOT be unioned in:
  expect(got).not.toContain("API_KEY");
  expect(got).not.toContain("TOKEN");
  expect(got).not.toContain("SECRET");
  expect(got).not.toContain("PASSWORD");
});
```

A union-with-defaults implementation would return a 12-element
array, and each of the four `not.toContain` calls would fail. The
`toEqual(["PII"])` line catches any extra element regardless of
identity.

**9. "replaces configPointerSuffixes with a non-empty singleton (full replacement)"** — round-3 anchor S-R-B

```ts
it("replaces configPointerSuffixes with a non-empty singleton (full replacement)", () => {
  writeConfig({ security: { envScrubber: { configPointerSuffixes: ["_BUILDFILE"] } } });
  const cfg = loadConfig(true, projectRoot);
  const got = cfg.security.envScrubber.configPointerSuffixes;
  expect(got).toEqual(["_BUILDFILE"]);
  expect(got.length).toBe(1);
  expect(got[0]).toBe("_BUILDFILE");
  expect(got).not.toContain("_URL");
  expect(got).not.toContain("_URI");
  expect(got).not.toContain("_PATH");
  expect(got).not.toContain("_PROMPT");
});
```

`"_BUILDFILE"` is the same project-suffix shape used by the
predicate-layer additive case in
[02-design-r2.md §2.6 A step 3 case 3](02-design-r2.md#L491-L505),
and the schema accepts it because it matches
`/^_[A-Z][A-Z0-9_]*$/`.

#### 3.7.4 Notes on the fixture

- The `loadConfig(true, projectRoot)` two-argument form must match
  how the rest of the test suite calls it. If the live signature is
  different (single argument; reads `SAIVAGE_ROOT`), the implementer
  MUST follow whichever shape
  [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L66)
  uses today (it is the authoritative reference, not this plan).
- The `previousProjectRoot` and `previousSaivageRoot` save/restore
  pattern protects parallel test runners; vitest's default
  isolation already covers this, but the existing builtins.test
  pattern restores them explicitly, so the new block does the same
  for consistency.
- All nine cases are independent — none depend on module-level
  state, none mutate the predicate. They can run in any order; the
  block does NOT need an `afterEach` that resets a predicate
  (unlike F16's integration block, which does).

### 3.8 F16 — extend [src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L1)

See [03-plan-r2.md §3.8](03-plan-r2.md#L401-L443). Unchanged.

## 4. Order of edits (single commit)

Same as [03-plan-r2.md §4](03-plan-r2.md#L445-L462). The F15 step
(7th) now adds 9 `it`s instead of 7, but the ordering is identical.

## 5. Test gates (all must be green at end of commit)

Gates 1-19 are identical to
[03-plan-r2.md §5 gates 1-19](03-plan-r2.md#L466-L494). Gate 20 is
REPLACED with two new gates 20a and 20b. Two additional gates 21
and 22 lock the round-3 schema-layer full-replacement assertions.

1. `npx tsc --noEmit` — clean; no reference to
   `SECRET_ENV_PATTERNS` remains.
2. `vitest run src/security/secrets.test.ts` — defaults FP corpus
   green (37 rows), defaults FN corpus green (29 rows, incl.
   `SOME_API-KEY`, `ACCESS-KEY`, `SOME-ACCESS-KEY`), five
   operator-override `it`s green.
3. `vitest run src/config-validation.test.ts` — all 9
   `security.envScrubber` `it`s green (round-3 form), AND the
   pre-existing `validateModelCoverage` block remains green.
4. `vitest run src/mcp/builtins.test.ts` — pre-existing tests
   green; the new `describe("filterShellEnv")` block (6 `it`s)
   green.
5. `vitest run src/mcp/fsGuard.test.ts` — pre-existing tests green
   with the new positional argument shape.
6. `grep -c 'SECRET_ENV_PATTERNS' src/mcp/builtins.ts` returns `0`.
7. `grep -c 'SECRET_ENV_NAME_PATTERNS\|ENV_CONFIG_POINTER_SUFFIXES' src/security/secrets.ts src/mcp/builtins.ts`
   returns `0` (the disapproved G35 r2 constants do NOT land).
8. `grep -c 'createSecretEnvNamePredicate' src/mcp/builtins.ts`
   returns at least `2` (exactly 3: import + initial assignment +
   body assignment).
9. `grep -c 'export function createSecretEnvNamePredicate' src/security/secrets.ts`
   returns exactly `1`.
10. `grep -c 'export const DEFAULT_CREDENTIAL_LEXEMES' src/security/secrets.ts`
    returns exactly `1`.
11. `grep -c 'export const DEFAULT_CONFIG_POINTER_SUFFIXES' src/security/secrets.ts`
    returns exactly `1`.
12. `grep -c 'envScrubber' src/config.ts` returns exactly `1`.
13. `grep -n '"COOKIE"\|"SESSION"\|"BEARER"\|"AUTH"' src/security/secrets.ts`
    returns at least four matches.
14. `grep -n 'security.envScrubber.credentialLexemes' src/mcp/builtins.ts`
    returns at least one match.
15. `grep -c 'registerBuiltinServices(.*cfg.mcp,.*cfg.security' src/mcp/builtins.test.ts src/mcp/fsGuard.test.ts`
    returns at least `5`.
16. `grep -n 'PII_DATA' src/mcp/builtins.test.ts` returns at least
    two matches (additive case + full-replacement case).
17. `grep -n 'SOME_API-KEY' src/security/secrets.test.ts src/mcp/builtins.test.ts`
    returns at least two matches (one per file; predicate corpus +
    integration anchor; B1 anchor).
18. `grep -n 'credentialLexemes: \[.PII.\]' src/mcp/builtins.test.ts`
    returns at least one match (the full-replacement lexeme
    integration case; B2 anchor at the integration layer).
19. `grep -n 'configPointerSuffixes: \[\]' src/mcp/builtins.test.ts src/config-validation.test.ts`
    returns at least two matches (integration case 6 + schema
    cases 7 and below).
20. **(round-3 replacement) 20a — compiler-body internal rewrite
    sentinel.** Run:

    ```sh
    rg -n -F 'replace(/_/g, "[_-]")' src/security/secrets.ts
    ```

    Must return at least 1 match. The `-F` flag tells ripgrep to
    treat the pattern as a fixed literal, so the bracket-class
    `[_-]` is matched as the literal four-character sequence
    `[`, `_`, `-`, `]` rather than parsed as a regex character
    class. The single-quoted shell argument is delivered verbatim
    to ripgrep. This gate locks the round-2 compiler's
    `_` → `[_-]` rewrite step, which is exactly the line the B1
    fix introduced. A future refactor that removes the rewrite
    (re-introducing the round-1 `SOME_API-KEY` regression) deletes
    the only line containing this literal and the gate fails.

    Equivalent grep form for environments without ripgrep:

    ```sh
    grep -n -F 'replace(/_/g, "[_-]")' src/security/secrets.ts
    ```

21. **(round-3 replacement) 20b — boundary-alternation sentinel.**
    Run:

    ```sh
    rg -n -F '(?:^|[_-])' src/security/secrets.ts
    ```

    Must return at least 1 match. Again `-F` makes the pattern a
    fixed string, so the parentheses and bracket-class are matched
    literally. This gate locks the round-2 compiler's boundary
    template `(?:^|[_-])${escaped}S?(?:$|[_-])`, specifically the
    left-side alternation that the B1 fix widened from `(?:^|_)`
    to `(?:^|[_-])`. Removing the `-` from this alternation
    deletes the only literal `(?:^|[_-])` in the file and the gate
    fails.

    Equivalent grep form:

    ```sh
    grep -n -F '(?:^|[_-])' src/security/secrets.ts
    ```

22. **(round-3 new) Schema-layer non-empty replacement sentinel
    for the lexeme array (S-R-A anchor).** Run:

    ```sh
    rg -n -F 'credentialLexemes: ["PII"]' src/config-validation.test.ts
    ```

    Must return at least 1 match. This pins F15 case 8 (the
    singleton-`PII` non-empty replacement test). A future refactor
    that drops the test fails this gate. The `-F` again makes the
    bracket and quote characters literal, and the single-quoted
    shell argument delivers them verbatim.

    Equivalent grep form:

    ```sh
    grep -n -F 'credentialLexemes: ["PII"]' src/config-validation.test.ts
    ```

23. **(round-3 new) Schema-layer non-empty replacement sentinel
    for the suffix array (S-R-B anchor).** Run:

    ```sh
    rg -n -F 'configPointerSuffixes: ["_BUILDFILE"]' src/config-validation.test.ts
    ```

    Must return at least 1 match. Pins F15 case 9. Same `-F`
    treatment as gate 22.

Gates 20a, 20b, 22, 23 are all valid POSIX shell with no
backslash-escape gymnastics and with `-F` removing all metacharacter
interpretation inside the pattern. Each one keys off a literal
string that exists in exactly one production location, so a false
match is not possible.

Gates 17, 18, 19, 22, 23 (the round-2 string-search gates and the
two new schema sentinels) all use single-quoted shell arguments
delivered verbatim to the search tool; brackets inside those
arguments are NOT special to the shell, so no extra escaping is
needed. Gates 20a and 20b additionally use `-F` for fixed-string
matching, which is the precise reviewer-r2 prescription
[04-review-r2.md](04-review-r2.md#L11).

## 6. Out of scope

Unchanged from [03-plan-r2.md §6](03-plan-r2.md#L515-L535). No
edits outside the table; no documentation files; no JSON-Schema
artefact; no re-introduction of the disapproved hardcoded
constants; no changes to
[src/routing/resolver.ts](../../../../src/routing/resolver.ts) or
the G25 config-validation surface (beyond appending the new
`describe("security.envScrubber")` block to its test file).
