# G46 - Review (r3)

## Findings

1. The grep audit still does not pin the forbidden regex consumers.

   Round 3 fixes the design intent: the bucket classifier is routed through `parseRoundId(id).kind`, the sort tiebreaker uses `roundIdSortKey`, pending-round inference uses `parseRoundId(e.roundId)`, and the malformed `r-compacted-3x` bucket test is added in [03-plan-r3.md](./03-plan-r3.md#L24-L47) and [03-plan-r3.md](./03-plan-r3.md#L65-L86). But the validation audit in [03-plan-r3.md](./03-plan-r3.md#L130-L139) does not actually catch the regex spellings it claims to forbid.

   The third grep alternative is `/\^r(-msg:)?(-compacted-)?\\d\+/`, which looks for a regex body like `/^r\d+/`. The live consumers use `/^r(\d+)$/`, `/^r-msg:(\d+)$/`, and `/^r-compacted-(\d+)$/`, with literal parentheses around `\d+` and the trailing `$`. I smoke-tested the r3 pattern against representative forbidden strings: it matched `startsWith("r-compacted-")`, `startsWith("r-msg:")`, and `=== "r-pre"`, but missed all three anchored regex forms. That fails the requested grep audit requirement: zero `startsWith`, regex, and `=== "r-pre"` round-id consumers outside `round-id.ts`.

   Required fix: strengthen the audit pattern, or split it into separate checks, so it matches the actual anchored regex literals. For example, the regex arm needs to cover `/^r(\d+)$/`, `/^r-msg:(\d+)$/`, and `/^r-compacted-(\d+)$/`, not only a bare `/^r\d+/` shape.

## Checks That Pass

- The SFC cap contradiction from r2 is resolved. The design projects every `agents/*.vue` file at <=300 lines in [02-design-r3.md](./02-design-r3.md#L17-L22), the fallback now triggers above 300 in [03-plan-r3.md](./03-plan-r3.md#L88-L111), and validation requires every Vue file to report <=300 in [03-plan-r3.md](./03-plan-r3.md#L128-L129). There is no remaining 330-line slack rule.
- The live `startsWith("r-compacted-")` branch is explicitly replaced by `shape.kind === "pre" || shape.kind === "compacted"` in [03-plan-r3.md](./03-plan-r3.md#L24-L47).
- All three named round-id consumers are covered by parser/sort-key wiring in the plan: bucket classifier, pending-round inference, and same-timestamp sort tiebreaker.
- The r3 docs themselves are under the requested flat 300-line review-artifact cap: analysis 52 lines, design 116 lines, plan 160 lines.

## Required Revision

Fix the round-id consumer audit so it actually catches anchored regex literals outside `round-id.ts`. The implementation design can otherwise stand.

VERDICT: CHANGES_REQUESTED
