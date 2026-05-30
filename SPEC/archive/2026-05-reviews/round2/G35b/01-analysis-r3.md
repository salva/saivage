# G35b — Analysis r3

**Finding**: [../G35-builtins-secret-env-regex-too-broad.md](../G35-builtins-secret-env-regex-too-broad.md)

**Round 2**: [01-analysis-r2.md](01-analysis-r2.md), [02-design-r2.md](02-design-r2.md), [03-plan-r2.md](03-plan-r2.md).

**Round 2 review**: [04-review-r2.md](04-review-r2.md) — VERDICT CHANGES_REQUESTED.

**Round 1**: [01-analysis-r1.md](01-analysis-r1.md), [02-design-r1.md](02-design-r1.md), [03-plan-r1.md](03-plan-r1.md), [04-review-r1.md](04-review-r1.md).

**Writer**: Claude Opus 4.7, round 3.

## 1. Status of the proposal entering round 3

The shape selected in round 1 and refined in round 2 still holds:

- Two operator-overridable arrays under `security.envScrubber` in
  [src/config.ts](../../../../src/config.ts#L111-L117).
- Defaults exported from
  [src/security/secrets.ts](../../../../src/security/secrets.ts#L80)
  and threaded into the Zod schema via `.default(...)`.
- A single predicate factory `createSecretEnvNamePredicate` rebuilt
  once at the start of `registerBuiltinServices` and captured by
  `filterShellEnv`.
- The round-2 compiler shape — escape metachars, rewrite internal
  `_` to `[_-]`, wrap with `(?:^|[_-])` … `(?:$|[_-])` — is
  unchanged. Reviewer r2 [04-review-r2.md](04-review-r2.md#L11)
  affirmed this fixes the round-1 `SOME_API-KEY` regression.

Reviewer r2 [04-review-r2.md](04-review-r2.md) raised two blockers
and one cleanup note. Round 3 addresses each in turn; no other
decisions from round 2 are reopened.

## 2. Blocker B3 from review r2 — incomplete schema-layer
   full-replacement coverage

[04-review-r2.md](04-review-r2.md#L9) is correct. Round 2's schema
tests in [03-plan-r2.md §3.7](03-plan-r2.md#L259-L285) covered:

- defaults applied when the operator omits the field,
- the four invalid-input rejections (empty lexeme array,
  empty-string element in each array, lowercase lexeme,
  non-leading-underscore suffix),
- and the one empty `configPointerSuffixes` accept case.

That is enough to prove the schema honors omission, rejects bad
shapes, and honors an EMPTY override for the suffix array. It does
NOT prove that a NON-EMPTY operator override is parsed verbatim
rather than silently unioned with the defaults at the schema layer.
The predicate and integration layers ([03-plan-r2.md §3.6](03-plan-r2.md#L213-L257)
test 2 and [§3.8](03-plan-r2.md#L401-L433) cases 5 and 6) prove
end-to-end full replacement, but a future refactor that wires the
union at the schema layer (for example, by adding a custom Zod
`.transform(arr => [...DEFAULTS, ...arr])`) would slip past the
schema suite while still failing the integration suite, leaving the
two layers inconsistent about the contract.

Round 3 closes the gap by adding two NON-EMPTY full-replacement
assertions at the schema layer:

- **S-R-A**: `{ "credentialLexemes": ["PII"] }` resolves at parse
  time to `cfg.security.envScrubber.credentialLexemes` deep-equal
  to exactly `["PII"]`, with length 1, and explicitly NOT
  containing `"API_KEY"`, `"TOKEN"`, `"SECRET"`, or `"PASSWORD"`.
- **S-R-B**: `{ "configPointerSuffixes": ["_BUILDFILE"] }` resolves
  to exactly `["_BUILDFILE"]`, length 1, and explicitly NOT
  containing `"_URL"` or `"_PATH"`.

The existing empty-suffix accept case is also tightened to assert
deep-equal to literal `[]` (length 0) so a transform that "helpfully"
re-introduces defaults when the operator wrote `[]` cannot pass.
This is the round-3 form of "replacing `configPointerSuffixes: []`
parses to literally empty" called out in [04-review-r2.md](04-review-r2.md#L9).

These S-R-A / S-R-B assertions are layered on top of, not in place
of, the predicate-layer R-A / R-B cases ([02-design-r2.md §2.6 A](02-design-r2.md#L477-L521))
and the integration-layer cases 5 and 6 ([02-design-r2.md §2.6 C](02-design-r2.md#L595-L616)).
The contract that "operator-supplied non-empty arrays are full
replacements" is then pinned at three independent layers, so any
future regression at one layer is caught by the other two.

## 3. Blocker B4 from review r2 — invalid sentinel grep gate

[04-review-r2.md](04-review-r2.md#L11) is correct that round 2's
gate 20 [03-plan-r2.md §5 gate 20](03-plan-r2.md#L465-L470) is
malformed. The plan wrote:

```
grep -n '\\\\[_-\\\\]' src/security/secrets.ts
```

In a POSIX shell, the single-quoted argument is delivered to grep
verbatim as `\\[_-\\]`. grep BRE then interprets `[_-\]` as a
character class spanning from `_` (ASCII 0x5F) backwards-ish — POSIX
grep with BRE actually rejects this with `Invalid range end` on
many implementations because the range end (`\`) sorts below the
range start (`_`). Even if a permissive grep accepted it, the
resulting pattern would scan for a single character in
`[_, ^, ], \\]` (or similar), not for the literal four-character
sequence `[_-]` that the round-2 compiler must contain. The gate
therefore either errors out or matches the wrong thing; it does NOT
lock the round-2 fix.

Round 3 replaces gate 20 with two fixed-string sentinels that are
unambiguous in any shell and that explicitly key off the round-2
compiler text. Both use `rg -F` (or `grep -F`) so the bracket
class is treated as a literal string, not a regex character class:

- **Gate 20a — compiler-body rewrite step.** `rg -n -F 'replace(/_/g, "[_-]")' src/security/secrets.ts`
  must return at least 1 match. This locks the literal
  `replace(/_/g, "[_-]")` call that performs the underscore-to-class
  rewrite inside `createSecretEnvNamePredicate`. A future refactor
  that strips this step (re-introducing the round-1 regression)
  removes the only line that contains this exact string and the gate
  fails.
- **Gate 20b — boundary alternation.** `rg -n -F '(?:^|[_-])' src/security/secrets.ts`
  must return at least 1 match. This locks the literal
  `(?:^|[_-])` boundary group used in the compiled regex template.
  Combined with gate 20a, both halves of the B1 fix (internal
  rewrite plus boundary widening) are pinned.

Both invocations are valid shell — the argument is in single quotes
so the shell delivers it verbatim, and `-F` tells the tool to
interpret the argument as a fixed string rather than a regex, so
brackets and parentheses are not metacharacters in the pattern. No
backslash-escape gymnastics. Reviewer r2 [04-review-r2.md](04-review-r2.md#L11)
explicitly offered `rg -n -F 'replace(/_/g, "[_-]")'` as the
acceptable shape; gate 20a uses precisely that, and 20b adds a
second sentinel for the boundary half.

Gates 17, 18, 19 from round 2 [03-plan-r2.md §5 gates 17-19](03-plan-r2.md#L456-L464)
are unchanged — those greps use literal strings (e.g.
`'SOME_API-KEY'`) that are safe under BRE / ERE and need no `-F`.

## 4. Cleanup note from review r2 — config-validation.test fixture

[04-review-r2.md](04-review-r2.md#L17) flagged that
[03-plan-r2.md §3.7](03-plan-r2.md#L255-L258) claimed
[src/config-validation.test.ts](../../../../src/config-validation.test.ts)
already had a tmp-dir + `SAIVAGE_ROOT` fixture to reuse. It does
not. That file is a pure-unit test for `validateModelCoverage` with
a `makeConfig` factory; it never touches the filesystem or
`loadConfig`. The fixture pattern the new tests need lives in
[src/mcp/builtins.test.ts](../../../../src/mcp/builtins.test.ts#L37-L66)
(`mkdtempSync` + `mkdirSync` + `writeFileSync` of `.saivage/saivage.json`
+ `loadConfig(true, projectRoot)`).

Round 3 plan spells out the fixture explicitly in F15, mirroring
the builtins.test pattern instead of claiming a reuse that does not
exist. This is a documentation correction, not a design change.

## 5. Surface re-confirmed in the live tree (2026-05-26)

All line numbers cited in round 2 ([01-analysis-r2.md §2](01-analysis-r2.md#L100-L130))
are still current as of 2026-05-26; no upstream commit has touched
the affected lines.

## 6. Decisions reaffirmed

Round 1 and round 2 decisions ([01-analysis-r1.md §3](01-analysis-r1.md),
[01-analysis-r2.md §3](01-analysis-r2.md#L172-L209)) are unchanged.
Round 3 adds no new design decision; it only tightens the test
suite (B3) and the test-gate scripts (B4) plus a documentation
correction (the fixture-reuse claim).

## 7. Surfaces the redo must not touch

Same as round 1 and round 2 ([01-analysis-r2.md §4](01-analysis-r2.md#L211-L223)).
Nothing in
[src/routing/resolver.ts](../../../../src/routing/resolver.ts) or
the G25 config-validation surface is touched.

## 8. Architectural constraints (project rules, unchanged)

Same as [01-analysis-r2.md §5](01-analysis-r2.md#L225-L237). No
backward compatibility, no migration shim, no over-engineering, no
hidden union at any layer (including the schema layer per S-R-A /
S-R-B above).

## 9. Risks (refined for round 3)

Round 2's R1-R5 ([01-analysis-r2.md §6](01-analysis-r2.md#L239-L271))
are unchanged. Round 3 adds:

- **R6 — schema-layer union slipping past suite.** If a future
  refactor adds a Zod `.transform(arr => [...DEFAULTS, ...arr])` on
  either array, the integration-layer tests already catch it (cases
  5 and 6 of F16 assert specific names pass through unscrubbed),
  but the schema-layer tests in round 2 did not catch it
  independently. Round-3 S-R-A and S-R-B (§2) catch this at the
  schema layer too, giving three independent locks.
- **R7 — test-gate regression escapes a malformed grep.** Gate 20
  in round 2 silently errored out or matched the wrong literal,
  so an operator running the gate manually might see a non-zero
  exit and assume the suite was broken when in fact the gate itself
  was. Round-3 gates 20a and 20b are `rg -F` fixed-string greps
  that cannot fail for shell-quoting reasons and that key off the
  exact compiler text. R7 mitigation is therefore baked into the
  gate definition itself.

## 10. What this analysis does not decide

Same as [01-analysis-r2.md §7](01-analysis-r2.md#L273-L283). No
new questions opened.

## 11. Cross-links

- Round 2 (same finding):
  [01-analysis-r2.md](01-analysis-r2.md),
  [02-design-r2.md](02-design-r2.md),
  [03-plan-r2.md](03-plan-r2.md),
  [04-review-r2.md](04-review-r2.md).
- Round 1 (same finding):
  [01-analysis-r1.md](01-analysis-r1.md),
  [02-design-r1.md](02-design-r1.md),
  [03-plan-r1.md](03-plan-r1.md),
  [04-review-r1.md](04-review-r1.md).
- Disapproved predecessor: [../G35/02-design-r2.md](../G35/02-design-r2.md).
- Same-file siblings: G30, G31, G32, G33, G34, G36+ (other
  findings in [src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1)).
