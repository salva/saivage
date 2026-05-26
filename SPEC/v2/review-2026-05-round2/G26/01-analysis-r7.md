# G26 — Analysis (round 7, writer Claude Opus 4.7)

Issue source: [../G26-resolver-legacy-source-tier.md](../G26-resolver-legacy-source-tier.md).
Round 6 reviewer critique: [04-review-r6.md](04-review-r6.md).
Supersedes [01-analysis-r6.md](01-analysis-r6.md).

## Changes from round 6

Round 6 landed the fatal-abort preprocess fix and the
single-issue assertion. The round-6 reviewer
([04-review-r6.md](04-review-r6.md#L7)) accepted both, the
architectural direction, and the anchors. One blocker remained
plus one cleanup note:

1. The schema-rejection test still asserted
   `issue.message.toContain(LEGACY_KEY)`
   ([03-plan-r6.md](03-plan-r6.md#L246-L250),
   [02-design-r6.md](02-design-r6.md#L233-L235)). The contract
   the design promises is a single, fully pinned operator-facing
   surface; a future implementation could keep the legacy key in
   the message while degrading the remediation text and this
   assertion would still pass.
2. The round-6 design's explanation of the non-fatal preprocess
   behavior overclaimed
   ([02-design-r6.md](02-design-r6.md#L142-L149)): it said the
   inner `z.object` would emit "the usual `invalid_type` issue on
   the object itself plus required-field issues on
   `project_name`, `objectives`, and `skills`". The observed
   installed behavior is just the custom preprocess issue plus
   the three required-field issues. The extra root-invalid
   wording is unnecessary and made the evidence less crisp.

Round 7 lands exactly two targeted edits relative to round 6:

1. The schema-rejection test asserts the full operator-facing
   message with `toBe`, against a runtime-built `EXACT_MESSAGE`
   that is interpolated from the same template the design's
   `ctx.addIssue` uses. The template is the round-6 design
   message verbatim: `${LEGACY_PROJECT_KEY} is a removed legacy
   v1 routing field. Delete it from .saivage/config.json and use
   ProjectConfig.routing.roles instead.`
   ([02-design-r6.md](02-design-r6.md#L101)). Same assertion is
   applied to the empty-legacy-stub fixture so both legacy shapes
   prove the identical single-issue surface.
2. The round-7 design rewords the non-fatal-path evidence to drop
   the "invalid_type issue on the object itself plus" clause. The
   observed surface — one custom issue from the preprocess plus
   three required-field issues from the inner schema — is the
   only thing the round-7 design claims.

Every other round-6 decision carries forward unchanged: the
fatal-abort mechanism, the runtime-built legacy key in schema and
test, the resolver collapse, the seeder edit, the hard ordering
constraint, sequencing against G23 / G24 / G25, and the
out-of-scope list.

This is the seventh round on G26 and no architectural decision is
being reopened. Both edits live inside text that round 6 already
shipped.

## Zod fatal-abort verification (unchanged from r6)

See [01-analysis-r6.md](01-analysis-r6.md#zod-fatal-abort-verification).
Both runtime facts — `checkCtx.addIssue` calling `status.abort()`
when `arg.fatal` is set
([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3174-L3181)),
and the preprocess branch returning `INVALID` before the inner
schema when `status.value === "aborted"`
([node_modules/zod/v3/types.js](../../../../node_modules/zod/v3/types.js#L3210-L3215))
— hold verbatim. Installed Zod version still
[package.json](../../../../package.json#L39) `"zod": "^3.25.76"`.

## What the resolver actually does today (unchanged)

See [01-analysis-r5.md](01-analysis-r5.md#what-the-resolver-actually-does-today).
No code change has landed since round 5, so every cited anchor
remains live.

## Why it is a legacy input that must be removed (unchanged)

See [01-analysis-r5.md](01-analysis-r5.md#why-it-is-a-legacy-input-that-must-be-removed-and-rejected).

## Root cause (unchanged)

See [01-analysis-r5.md](01-analysis-r5.md#root-cause).

## What the fix has to touch (unchanged from r6)

See [01-analysis-r6.md](01-analysis-r6.md#what-the-fix-has-to-touch-unchanged-from-r5).
Round 7 changes only the body of the schema-rejection test (one
extra assertion plus an `EXACT_MESSAGE` constant); the set of
touched files is identical to round 6.

## Verified anchors (unchanged from r6)

See [01-analysis-r6.md](01-analysis-r6.md#verified-anchors-pre-flight-gate).
All anchors are unchanged. No code has landed between rounds.

## Daemon impact (unchanged)

See [01-analysis-r5.md](01-analysis-r5.md#daemon-impact-concrete-on-disk-inventory)
and the round-6 summary in
[01-analysis-r6.md](01-analysis-r6.md#daemon-impact-unchanged-from-r5).
Round 7 does not change which configs load or what the daemon
emits on rejection. The only difference between round 6 and
round 7 is what the test asserts about that operator-visible
message.

## Scope decision (unchanged)

Narrow rejection via `z.preprocess` with `fatal: true`. See
[01-analysis-r5.md](01-analysis-r5.md#scope-decision-narrow-rejection-via-preprocess-not-passthrough)
and [01-analysis-r6.md](01-analysis-r6.md#zod-fatal-abort-verification).

## Out-of-scope for G26 (unchanged)

See [01-analysis-r5.md](01-analysis-r5.md#out-of-scope-for-g26).
