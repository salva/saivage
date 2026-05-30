# G46 — Analysis (r3)

## Scope of revision

Round 2 ([01-analysis-r2.md](./01-analysis-r2.md), [02-design-r2.md](./02-design-r2.md), [03-plan-r2.md](./03-plan-r2.md)) was reviewed in [04-review-r2.md](./04-review-r2.md) with verdict CHANGES_REQUESTED. Only two blockers remain; everything else carried over from r1 stands.

The two blockers are localized:

1. SFC line-cap contradiction. [02-design-r2.md](./02-design-r2.md#L257) sets a hard cap of 300 lines per SFC, but [03-plan-r2.md](./03-plan-r2.md#L116-L118) accepts anything up to 330 lines (cap + 10% slack) before triggering the CSS-extraction fallback, and the validation criterion at [03-plan-r2.md](./03-plan-r2.md#L165) only enforces "≤330". The two numbers cannot both be the cap.
2. Strict round-id parsing is not fully wired into compacted-bucket classification. The live transformer classifies compacted clusters with a prefix check at [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L435) (`id === "r-pre" || id.startsWith("r-compacted-")`), and the r2 port preserves that branch. Even with `parseRoundId` available, malformed IDs such as `r-compacted-3x` or `r-compacted-0x10` still classify as compacted because the bucket classifier uses `startsWith`, not the parser.

The measurements from r2 §"(4)" (per-component breakdown: `AgentsView` 135, `ConversationSidebar` 240, `AgentConversationPane` 230, `AgentRoundCard` 250, `ToolCallRow` 265, `ChatSessionPane` 110) are unchanged. The strictness table and parser body from r2 §"(1)" are unchanged. The threadBody ownership boundary from r2 §"(2)" and the vitest wiring from r2 §"(3)" are unchanged.

## (1) Resolving the cap contradiction

Two consistent options exist:

- Option A: keep the cap at 300, remove the +10% slack, accept that `ToolCallRow.vue` at 265 projected lines is within budget, and require the CSS-extraction fallback to trigger when any SFC exceeds **300** lines (not 330). Projection: `ToolCallRow.vue` 265 ≤ 300 — no fallback needed in the happy path; the rule fires only if the port lands above projection by more than 35 lines.
- Option B: keep the +10% slack, rename the cap consistently to 330 throughout. Projection: `ToolCallRow.vue` 265 ≤ 330 — same comfort margin, but every doc reference (design table header, anti-principles list, validation criterion) must read 330.

Option A is selected. Rationale:

- The original review-r1 requirement was "per-component budget of 300 lines or less". Honoring it means 300 is the cap, full stop, with the CSS fallback as the safety net rather than a slack window.
- The 265-line projection for `ToolCallRow.vue` already includes its full irreducible CSS surface (170 lines). The remaining headroom (35 lines) is real slack — a 13% buffer between the projection and the cap. A second slack of +10% on top would be double-counting.
- The fallback (`<style src="./ToolCallRow.css" scoped>`) is mechanical and cheap. Triggering it at 300 instead of 330 costs nothing extra at implementation time and removes the contradiction.
- Option B would require renaming "300" → "330" in five places and would normalize a slack that no one asked for. Option A flips one number ("330" → "300") in the same five places and is the smaller change.

The fallback rule becomes: any single `agents/*.vue` file that comes in at >300 lines after the port has its `<style scoped>` block extracted into a sibling `.css` file via `<style src="./<Name>.css" scoped></style>`. If after the extraction any file is still >300 lines, the design itself is wrong and r2/r3 must be reopened before merge.

`ToolCallRow.vue` is the only file projected within 35 lines of the cap. If the port lands at 300–320 with the inline style, the fallback fires for that one file; the resulting `.vue` becomes ~95 lines (template + script + the `<style src>` one-liner), and `ToolCallRow.css` carries the 170-line CSS surface. Other leaves (`AgentRoundCard.vue` 250 projected, `ConversationSidebar.vue` 240 projected) sit ~50 lines below the cap and are unlikely to trigger.

## (2) Where the prefix check still leaks

The live transformer ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L412-L530)) consumes round IDs in three places:

| Consumer | Location | r2 wiring | Leak |
|---|---|---|---|
| Bucket classifier (compacted/non-compacted) | [L435](web/src/components/AgentsView.vue#L435) | unchanged from live: `id === "r-pre" \|\| id.startsWith("r-compacted-")` | accepts `r-compacted-3x`, `r-compacted-0x10`, etc. |
| Same-timestamp sort tiebreaker | [L530-L535](web/src/components/AgentsView.vue#L530-L535) | r2 routes through `roundIdSortKey` → `parseRoundId` | clean |
| Pending-round inference (matches `/^r(\d+)$/` in the live code) | [L543-L549](web/src/components/AgentsView.vue#L543-L549) | r2 routes through `parseRoundId(e.roundId).kind === "round"` | clean |

The bucket classifier was overlooked. A malformed compacted ID can therefore land in the `compacted` branch and produce a `{ kind: "compacted", id, … }` timeline item that downstream `AgentRoundCard.vue` will render as if it were a legitimate compacted cluster. The same hazard applies to the implicit `r-pre` check — there the equality test `id === "r-pre"` is already strict, so only the `startsWith("r-compacted-")` arm needs to be replaced.

Replacement rule: every consumer of `roundId` must go through `parseRoundId(id).kind` (or `roundIdSortKey`). The `startsWith` / `===` / regex spellings are removed wherever the value being inspected is "what shape is this round ID".

A timeline test pins the invariant: a bucket whose ID is `r-compacted-3x` must not produce a `compacted` timeline item. The malformed ID must either fall to the `else` branch (rendered as an empty/diagnostic-only bucket → no `round` item, no `compacted` item) or, more precisely, be dropped entirely. The existing r2 plan already requires the timeline to assert this for the per-string parser; the same assertion now extends to the bucket classifier output.

## What "fixing G46" must additionally achieve in r3

1. The hard cap is **300** lines per SFC, with no slack. The CSS-extraction fallback triggers at >300, not >330. Validation reports `≤300` for every `agents/*.vue` file. The anti-principles checklist row that mentions the cap reads 300.
2. Every round-id consumer in the agents subsystem — bucket classifier, pending-round inference, sort tiebreaker, anywhere else — calls `parseRoundId(id).kind` (or `roundIdSortKey(id)`). No `startsWith("r-compacted-")`, no `startsWith("r-msg:")`, no `/^r(\d+)$/`, no `id === "r-pre"` outside `parseRoundId` itself. The `r-pre` equality test moves *into* `parseRoundId` and stays out of every caller.
3. The timeline test gains one case: a bucket whose `roundId` is `r-compacted-3x` produces zero `compacted` timeline items.
