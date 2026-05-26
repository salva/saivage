# G42 - Review r2

## Findings

No blocking findings.

## Verification of r1 required changes

1. The built-in frontmatter contract is now fail-loud for `target_agents`. Round 1 required removing the silent-global path for omitted `target_agents` ([SPEC/v2/review-2026-05-round2/G42/04-review-r1.md](SPEC/v2/review-2026-05-round2/G42/04-review-r1.md#L5)). R2 updates the analysis to call out that the frontmatter schema must make `target_agents` required with no default ([SPEC/v2/review-2026-05-round2/G42/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G42/01-analysis-r2.md#L5-L7)), updates the design so `target_agents` is a required built-in frontmatter key ([SPEC/v2/review-2026-05-round2/G42/02-design-r2.md](SPEC/v2/review-2026-05-round2/G42/02-design-r2.md#L6-L9)), shows the Zod field with no default ([SPEC/v2/review-2026-05-round2/G42/02-design-r2.md](SPEC/v2/review-2026-05-round2/G42/02-design-r2.md#L77)), and explicitly requires global built-ins to spell `target_agents: []` intentionally ([SPEC/v2/review-2026-05-round2/G42/02-design-r2.md](SPEC/v2/review-2026-05-round2/G42/02-design-r2.md#L94-L99)). The plan matches that contract and adds the missing-key negative test ([SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md#L40-L45), [SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md#L96-L101)).

2. The conditional G43 fallback is removed. Round 1 flagged the fallback as contradictory ([SPEC/v2/review-2026-05-round2/G42/04-review-r1.md](SPEC/v2/review-2026-05-round2/G42/04-review-r1.md#L11)). R2 now states the fallback is removed and G43 is a hard prerequisite ([SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md#L11-L12)), repeats the complete order as G43 first and then G42 ([SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md#L20-L28)), and closes the old partial-state path with `No partial-state fallback` plus `G42 waits` if G43 is blocked ([SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md#L30-L33)). The cross-finding section also pins `G43 -> G42, no exceptions` ([SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md#L215-L219)).

3. The stale docs cleanup scope is expanded to a real rewrite/delete requirement. Round 1 required more than swapping a stale file pointer ([SPEC/v2/review-2026-05-round2/G42/04-review-r1.md](SPEC/v2/review-2026-05-round2/G42/04-review-r1.md#L17)). R2 updates the analysis to say [docs/internals/skill-loader.md](docs/internals/skill-loader.md#L1) is wholly wrong and must be replaced, not patched, and gives [docs/guide/skills.md](docs/guide/skills.md#L1) the same rewrite-or-delete treatment ([SPEC/v2/review-2026-05-round2/G42/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G42/01-analysis-r2.md#L206-L224)). The plan also elevates Step 7 from a pointer swap to a rewrite of the stale sections ([SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md#L13-L15)), then enumerates the obsolete claims to remove from both docs, including `src/skills/loader.ts`, `SkillMatchContext`, `index.json`, object-shaped triggers, top-N selection, and the old self-extension lifecycle ([SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G42/03-plan-r2.md#L116-L141)).

## Required change count

0

## Verified required changes

3 / 3 addressed

VERDICT: APPROVED