# G46 — Design (r4)

## Scope of revision

This round 4 design supersedes [02-design-r3.md](./02-design-r3.md) only on the round-id consumer audit pattern raised by [04-review-r3.md](./04-review-r3.md). The bucket classifier port (r3 §"Change 2"), the malformed-bucket drop, the ≤300 SFC cap with no slack (r3 §"Change 1"), the CSS-extraction fallback, and all r2 contributions (parser body, threadBody ownership, Vitest wiring, size table) stand unchanged.

References: [01-analysis-r4.md](./01-analysis-r4.md) for the single-blocker summary and the false-positive analysis.

## Change 1 — Widen the round-id consumer audit pattern

The boundary invariant from [02-design-r3.md](./02-design-r3.md#L80-L88) is unchanged:

After the port, the agents subsystem has zero occurrences of:

- `startsWith("r-msg:")`
- `startsWith("r-compacted-")`
- `startsWith("r-pre")` (defensive; not used in live or r2 code, but reserved)
- `=== "r-pre"` (outside `round-id.ts`)
- `/^r(\d+)$/`, `/^r-msg:(\d+)$/`, `/^r-compacted-(\d+)$/`, and any other regex literal whose body anchors on `^r`
- `new RegExp("r…")` / `new RegExp('r…')` dynamic round-id matchers
- `Number.parseInt` / `Number.parseFloat` applied to a round-id slice
- `Number(<round-id slice>)` coercion

What changes is how the audit is *implemented*. The r3 grep pattern `'startsWith\("r-(msg:|compacted-|pre)"|=== "r-pre"|/\^r(-msg:)?(-compacted-)?\\d\+/'` mis-encoded the regex arm: the third alternative looks for a regex body shaped exactly like `/^r\d+/`, with no parentheses and no trailing `$`. The live code uses `/^r(\d+)$/` (parens around `\d+`, anchored `$`). The pattern misses all three live regex forms.

### Replacement: literal-pattern audit

The widened audit uses `rg -F` with multiple `-e` arguments — one literal substring per arm. No meta-regex escaping. Each literal is unique to round-id parsing and cannot occur incidentally in agent-subsystem source.

| # | Literal pattern | Catches |
|---|---|---|
| 1 | `startsWith("r-msg:` | `id.startsWith("r-msg:")` |
| 2 | `startsWith("r-compacted-` | `id.startsWith("r-compacted-")` |
| 3 | `startsWith("r-pre` | `id.startsWith("r-pre")` (defensive) |
| 4 | `=== "r-pre"` | literal equality test against `r-pre` |
| 5 | `/^r(` | `/^r(\d+)$/` and any other `^r`-anchored capture-group regex |
| 6 | `/^r\d` | `/^r\d+/`, `/^r\d+$/`, etc. (no capture group) |
| 7 | `/^r-msg:` | `/^r-msg:(\d+)$/`, `/^r-msg:\d+/`, etc. |
| 8 | `/^r-compacted-` | `/^r-compacted-(\d+)$/`, `/^r-compacted-\d+/`, etc. |
| 9 | `RegExp("r` | `new RegExp("r-msg:" + n)` and similar dynamic constructors |
| 10 | `RegExp('r` | single-quoted equivalent |

Patterns 5–8 are deliberately split by namespace prefix so they cover both the capture-group form (`/^r(\d+)$/`, caught by `/^r(`) and the bare-`\d+` form (`/^r\d+/`, caught by `/^r\d`). Pattern 5 also catches the unlikely but legal `/^r(?:…)/` non-capturing variant, which the bare-`\d` pattern would miss.

The single allowed file `web/src/components/agents/round-id.ts` is excluded via `--glob '!round-id.ts'`. That file is the only place in the agents subsystem where these spellings are permitted; everywhere else the call site must read `parseRoundId(id).kind` or `roundIdSortKey(id)`.

### Why a literal-pattern set, not a single tighter regex

A single meta-regex covering all anchored forms (`/\^r(?:\\\(|\\d|-msg:|-compacted-)/`) is possible, but:

- It requires double-escaping inside a shell-quoted `-E` argument, which is exactly how the r3 pattern broke — the third arm escaped `\d` as `\\d\+` and `\(` was omitted entirely.
- Adding a new forbidden spelling later (e.g. `/^r-pre/`) requires re-balancing the alternation rather than appending one `-e` argument.
- Reading the pattern in code review is harder than reading a flat list of literals.

`rg -F -e <literal> -e <literal> …` sidesteps all of that. Each literal is a plain substring; the implementation is trivially auditable.

## Change 2 — No other design change

The "boundary invariant" wording, the bucket classifier code shape, the malformed-bucket drop, the CSS-extraction fallback, the per-component size projections, the cap value (300 lines), the anti-principles checklist, and the daemon impact note all carry over from r3 verbatim. Only the audit *implementation* moves; the *requirement* is unchanged.

## Anti-principles checklist (r4 deltas only)

| Principle | r3 status | r4 status |
|---|---|---|
| Round-id consumer audit catches all forbidden spellings | catches `startsWith` and `=== "r-pre"`; misses anchored regex literals | catches all 10 literal patterns including every anchored `/^r…/` form |

Other rows carry forward unchanged from [02-design-r3.md](./02-design-r3.md#L93-L98).

## Daemon impact

Web-only change. No `saivage.service` restart. Validation path is unchanged: `npm run build:web` then `npm test` from the repo root, then the widened audit (`rg -F` invocation in [03-plan-r4.md](./03-plan-r4.md)).
