# G46 — Analysis (r4)

## Scope of revision

Round 3 ([01-analysis-r3.md](./01-analysis-r3.md), [02-design-r3.md](./02-design-r3.md), [03-plan-r3.md](./03-plan-r3.md)) was reviewed in [04-review-r3.md](./04-review-r3.md) with verdict CHANGES_REQUESTED. Exactly one blocker remains; everything else from r3 stands.

Blocker: the round-id consumer audit in [03-plan-r3.md](./03-plan-r3.md#L130-L139) does not actually catch the regex spellings it claims to forbid. The third grep arm `/\^r(-msg:)?(-compacted-)?\\d\+/` matches only a bare `/^r\d+/` shape. The live consumers use anchored forms with literal parentheses around `\d+` and a trailing `$`: `/^r(\d+)$/`, `/^r-msg:(\d+)$/`, and `/^r-compacted-(\d+)$/`. Smoke test of the r3 pattern against those three strings: zero matches. The audit therefore cannot certify "zero regex round-id consumers outside `round-id.ts`".

The substantive r3 changes — bucket classifier routed through `parseRoundId(id).kind`, malformed buckets dropped, the new `r-compacted-3x` timeline test, the strict ≤300 SFC cap with no slack — all stand unchanged. Only the validation audit needs to be widened.

## What "fixing G46" must additionally achieve in r4

The boundary invariant from [02-design-r3.md](./02-design-r3.md#L80-L88) (zero `startsWith("r-*")`, zero `=== "r-pre"` outside `round-id.ts`, zero anchored `/^r…/`-shaped regex literals, no `Number.parseInt` / `Number(<round-id slice>)` coercions) is the right invariant. It is the *check* that has to be widened — not the invariant itself.

The replacement audit must catch, at minimum, every spelling the live and r2 code uses, plus the obvious near-variants. Concretely:

1. `startsWith("r-msg:` — covers `id.startsWith("r-msg:")`.
2. `startsWith("r-compacted-` — covers `id.startsWith("r-compacted-")`.
3. `startsWith("r-pre` — defensive; covers any future `id.startsWith("r-pre")` slip.
4. `=== "r-pre"` — covers the literal equality test.
5. `/^r(` — covers `/^r(\d+)$/` and any other anchored `^r` regex with a capture group.
6. `/^r\d` — covers `/^r\d+/` and `/^r\d+$/` without capture groups.
7. `/^r-msg:` — covers `/^r-msg:(\d+)$/`, `/^r-msg:\d+/`, etc.
8. `/^r-compacted-` — covers `/^r-compacted-(\d+)$/`, `/^r-compacted-\d+/`, etc.
9. `RegExp("r` — covers dynamic `new RegExp("r…")` construction.
10. `RegExp('r` — single-quoted equivalent.

Each pattern is a literal substring, so a single `rg -F` invocation with multiple `-e` arguments is sufficient. No fragile escaping of regex-meta inside a meta-regex.

Smoke-test of the widened pattern set against the three known anchored forms:

| Forbidden source spelling | Pattern that catches it |
|---|---|
| `id.startsWith("r-compacted-")` | `startsWith("r-compacted-` |
| `id === "r-pre"` | `=== "r-pre"` |
| `/^r(\d+)$/` | `/^r(` |
| `/^r-msg:(\d+)$/` | `/^r-msg:` |
| `/^r-compacted-(\d+)$/` | `/^r-compacted-` |
| `id.startsWith("r-msg:")` | `startsWith("r-msg:` |
| `new RegExp("r-msg:" + n)` | `RegExp("r` |

All seven catch. The r3 pattern caught only the first two.

## False-positive risk

Each literal is tight enough that the only realistic source occurrences are intentional round-id parsing. `/^r(` cannot appear by accident in TypeScript outside a regex literal whose body starts with `^r(`. `startsWith("r-msg:` is unique to the agent round-id namespace. `=== "r-pre"` cannot occur outside a round-id comparison. The `round-id.ts` file is exempted by a post-filter (`grep -v` or `rg --glob '!round-id.ts'`); that single file is the only place these spellings are allowed.

No other r3 conclusion is affected. The bucket classifier port, the malformed-bucket drop, the timeline test, the ≤300 cap, the CSS-extraction fallback, the per-component projections, and the rollback all carry forward verbatim from r3.
