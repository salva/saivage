# G46 — Design (r3)

## Scope of revision

This round 3 design supersedes [02-design-r2.md](./02-design-r2.md) only on the two points raised by [04-review-r2.md](./04-review-r2.md). The parser body (r2 §"Change 1"), the threadBody ownership boundary (r2 §"Change 2"), and the Vitest wiring (r2 §"Change 3") stand unchanged. The size-table projections from r2 §"Change 4" stand; only the cap and fallback trigger move.

References: [01-analysis-r3.md](./01-analysis-r3.md) for the two-blocker summary.

## Change 1 — Single SFC line cap at 300, with no slack

The hard cap for any `agents/*.vue` file is **300 lines**. There is no +10% allowance. The CSS-extraction fallback triggers when any single SFC reports >300 lines after the port.

Updated budget projection (unchanged numbers from r2 §"Change 4"; cap column updated):

| File | script | template | style | misc | total | cap (r3) |
|---|---|---|---|---|---|---|
| `agents/AgentsView.vue` (coordinator) | 55 | 35 | 35 | 10 | 135 | ≤300 |
| `agents/ConversationSidebar.vue` | 35 | 65 | 130 | 10 | 240 | ≤300 |
| `agents/AgentConversationPane.vue` | 70 | 55 | 95 | 10 | 230 | ≤300 |
| `agents/AgentRoundCard.vue` | 35 | 60 | 145 | 10 | 250 | ≤300 |
| `agents/ToolCallRow.vue` | 35 | 50 | 170 | 10 | 265 | ≤300 |
| `agents/ChatSessionPane.vue` | 30 | 20 | 50 | 10 | 110 | ≤300 |

`ToolCallRow.vue` projects at 265 / 300 — within the cap by 35 lines (≈13% headroom). No file is projected above the cap.

### Fallback (unchanged shape, new trigger)

If `wc -l web/src/components/agents/*.vue` after the port shows any file >300 lines:

1. Move that file's `<style scoped>` block to a sibling external sheet `web/src/components/agents/<Name>.css` (no `scoped` semantics change — Vue applies the data attribute via the `<style src>` form).
2. Replace the inline block in the SFC with:

   ```vue
   <style src="./<Name>.css" scoped></style>
   ```

3. Re-measure with `wc -l`. The file must now report ≤300 lines.

If after the extraction the file is still >300 lines, **stop the implementation** and reopen the design — the responsibility-level split is wrong and r3 must be revised before merge. The fallback is one mechanical step, not a recursive remedy.

Candidate trigger order (descending projected line count): `ToolCallRow.vue` 265 → `AgentRoundCard.vue` 250 → `ConversationSidebar.vue` 240. None is expected to trigger; if any does, `ToolCallRow.vue` is the most likely.

No second component split. Splitting `ToolCallRow.vue` into `…Button.vue` + `…Detail.vue` is rejected for the same reason as r2: fragmenting a tightly-coupled disclosure pattern for cosmetic line counting violates the avoid-over-engineering principle.

## Change 2 — All round-id consumers go through `parseRoundId`

The strict parser from r2 §"Change 1" already exists at `web/src/components/agents/round-id.ts`. The only remaining work is to make every consumer call it, not just the entry points.

### Inventory of consumers in the agents subsystem (post-port)

| Consumer | Live location | r2 port (pre-r3) | r3 wiring |
|---|---|---|---|
| Bucket classifier inside `entriesToTimeline` (compacted / non-compacted branch) | [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L435) | `id === "r-pre" \|\| id.startsWith("r-compacted-")` (carried over) | `const shape = parseRoundId(id).kind; if (shape === "pre" \|\| shape === "compacted") { … }` |
| Same-timestamp sort tiebreaker | [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L530-L535) | `roundIdSortKey(id)` | unchanged |
| Pending-round inference | [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L543-L549) | `parseRoundId(e.roundId).kind === "round"` | unchanged |
| Anywhere else round IDs are inspected | none found in the live monolith outside the three above | n/a | n/a |

The classifier branch becomes:

```ts
// inside entriesToTimeline, after the bucket Map is built
for (const [id, bucket] of buckets) {
  const earliest = bucket.reduce(/* …same as live… */);
  const shape = parseRoundId(id);

  if (shape.kind === "pre" || shape.kind === "compacted") {
    items.push({ kind: "compacted", id, timestamp: earliest, compacted: bucket });
    continue;
  }

  if (shape.kind === "unknown") {
    // Malformed round IDs are dropped silently — they never produced a
    // legitimate timeline item even under the live regex-based pipeline,
    // because the live anchored regexes rejected them at the sort step.
    // We make the drop explicit here instead of letting them flow into
    // the round/diagnostic/context branches below.
    continue;
  }

  // shape.kind is "round" or "msg" — fall through to per-round assembly
  // (reasoning / toolPairs / context / diagnostics), unchanged from r2.
  // …
}
```

The drop on `unknown` is the explicit form of behavior the live code achieved by accident: a regex-rejecting ID would never satisfy the compacted branch and would always fall through to the per-round assembly, where it would be tier-4 in the sort, and the result was an item with a malformed `id` rendered against whichever branch matched. With `parseRoundId` available, the right thing is to skip the bucket entirely.

### Why the `r-pre` check moves into the parser

`parseRoundId("r-pre")` already returns `{ tier: 0, kind: "pre" }`. The classifier therefore never compares against the string `"r-pre"` directly; it only inspects `shape.kind`. The string literal `"r-pre"` appears in exactly one place in the agents subsystem: the first branch of `parseRoundId`. Every other consumer reads `kind`.

### Boundary invariant

After this change, the agents subsystem has zero occurrences of:

- `startsWith("r-msg:")`
- `startsWith("r-compacted-")`
- `=== "r-pre"` (outside `round-id.ts`)
- `/^r(\d+)$/`, `/^r-msg:(\d+)$/`, `/^r-compacted-(\d+)$/`
- `Number.parseInt` / `Number.parseFloat` applied to a round-id slice
- `Number(<round-id slice>)` coercion

Validation can grep for these forms across `web/src/components/agents/` and `web/src/composables/useAgent*.ts` and assert zero matches outside `round-id.ts` itself. The plan adds that grep to the validation list.

## Anti-principles checklist (r3 deltas only)

| Principle | r2 status | r3 status |
|---|---|---|
| Hard cap per SFC | "≤300" stated, "≤330" enforced (contradiction) | "≤300" stated and enforced uniformly |
| No regex / no prefix shortcuts for round-id classification | parser strict, but bucket classifier still used `startsWith("r-compacted-")` | every consumer routes through `parseRoundId(id).kind` |

Other rows from [02-design-r2.md](./02-design-r2.md#L271-L280) (no hardcoded values, no fragile tool-call heuristics, architecture-first, no backward compat, avoid over-engineering) carry forward unchanged.

## Daemon impact

Web-only change. Validation path (`npm test` at the repo root, then `npm run build:web`) is unchanged from r2. No `saivage.service` restart needed beyond the standard Vite build.
