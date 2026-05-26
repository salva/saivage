# G46 — Plan (r3, Design A)

This plan supersedes [03-plan-r2.md](./03-plan-r2.md) only on the two points raised by [04-review-r2.md](./04-review-r2.md). Steps not listed here (Step 1 shared-types extension, Step 2 constants module, Step 3 strict round-id parser, Step 4 UI-only types, Step 6 round-id + timeline tests except for the one new case below, Step 7 `bindThreadBody`, Step 8 component extraction, Step 9 App.vue rewire, Step 10 monolith deletion, Step 12 vitest include glob) are unchanged from r2.

Assumes G41 ([../G41/APPROVED.md](../G41/APPROVED.md)) has landed: [web/src/api/types.ts](web/src/api/types.ts) exists with `AgentRole`, `AgentState`, `RuntimeState`, `Plan`, `PlanStage`, `ApiState`; [web/package.json](web/package.json) gains `vue-tsc` from G41 (not from G46).

## Steps changed in r3

### Step 8.4 (revised, was Step 8 sub-bullet) — Timeline transformer ports the bucket classifier through `parseRoundId`

In `web/src/components/agents/timeline.ts` (the extracted `entriesToTimeline` from live `roundsToTimeline`), replace the live prefix-based classifier branch ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L435)) with a `parseRoundId` switch. The exact shape:

```ts
import { parseRoundId } from "./round-id";

// inside entriesToTimeline, after the bucket Map is built:
for (const [id, bucket] of buckets) {
  const earliest = bucket.reduce(
    (acc, e) => (acc === "" || e.timestamp < acc ? e.timestamp : acc),
    "",
  );
  const shape = parseRoundId(id);

  if (shape.kind === "pre" || shape.kind === "compacted") {
    items.push({ kind: "compacted", id, timestamp: earliest, compacted: bucket });
    continue;
  }

  if (shape.kind === "unknown") {
    continue;                          // drop malformed bucket entirely
  }

  // shape.kind === "round" || shape.kind === "msg":
  // per-round assembly (reasoning / toolPairs / context / diagnostics)
  // copied verbatim from live L437-L520, unchanged.
  // …
}
```

Concrete substitution rules to apply mechanically during the port from live `roundsToTimeline` to `entriesToTimeline`:

| Live spelling | r3 spelling |
|---|---|
| `if (id === "r-pre" \|\| id.startsWith("r-compacted-"))` | `if (shape.kind === "pre" \|\| shape.kind === "compacted")` |
| sort `[at, av] = roundSortKey(a.id)` / `[bt, bv] = roundSortKey(b.id)` | `[at, av] = roundIdSortKey(a.id)` / `[bt, bv] = roundIdSortKey(b.id)` (already in r2) |
| pending inference `const m = /^r(\d+)$/.exec(e.roundId); if (m) { const k = Number(m[1]); … }` | `const s = parseRoundId(e.roundId); if (s.kind === "round") { const k = s.index; … }` (already in r2) |
| no live equivalent — new behavior | add `if (shape.kind === "unknown") continue;` to drop malformed buckets |

Boundary invariant: after this step, run

```bash
grep -nE 'startsWith\("r-(msg:|compacted-|pre)"|=== "r-pre"|/\^r(-msg:)?(-compacted-)?\\d\+/' \
  web/src/components/agents/ \
  web/src/composables/useAgent*.ts
```

Expected output: zero matches outside `web/src/components/agents/round-id.ts`. The check is added to the validation list below.

### Step 6 (delta) — One new timeline test case

Append one row to the `timeline.test.ts` coverage table from [03-plan-r2.md](./03-plan-r2.md#L43-L52):

| Test | Asserts |
|---|---|
| bucket id `"r-compacted-3x"` with one assistant text entry | `entriesToTimeline` returns `[]` (no `compacted` item, no `round` item — malformed bucket dropped) |

Implementation sketch:

```ts
it("drops buckets whose round id is malformed", () => {
  const entries: ConversationEntry[] = [
    {
      roundId: "r-compacted-3x",
      kind: "text",
      role: "assistant",
      timestamp: "2026-05-01T00:00:00Z",
      content: "x",
      messageIndex: 0,
      blockIndex: 0,
    },
  ];
  expect(entriesToTimeline(entries, null)).toEqual([]);
});
```

The round-id strictness table from [03-plan-r2.md](./03-plan-r2.md#L54-L83) already pins `parseRoundId("r-compacted-3x").kind === "unknown"`; this new test pins the downstream consequence.

### Step 11 (revised) — CSS split with strict ≤300 cap, no slack

After the per-component CSS split from r1 Step 11, run:

```bash
wc -l web/src/components/agents/*.vue
```

For each file:

- If ≤300 lines: done.
- If >300 lines: move that file's `<style scoped>` block to `web/src/components/agents/<Name>.css` and replace the inline block with:

  ```vue
  <style src="./<Name>.css" scoped></style>
  ```

  Re-measure. The file must now report ≤300 lines.

If after the fallback any single file is still >300 lines, **stop the implementation** and reopen the design — the responsibility-level split itself is wrong and r3 must be revised before merge. Do not paper over with deeper file splits at implementation time.

The candidate triggers, by [01-analysis-r3.md](./01-analysis-r3.md) §"(1)" budget table, in descending risk order: `ToolCallRow.vue` (265 projected) > `AgentRoundCard.vue` (250) > `ConversationSidebar.vue` (240). None is projected to exceed the cap; the rule is a safety net.

No slack. No `≤330`.

## Validation (revised)

From the repo root:

```bash
npm run build:web    # cd web && vite build — must succeed
npm test             # vitest run — must pass src/, tests/, and web/src/**/*.test.ts
```

Per-component size enforcement:

```bash
wc -l web/src/components/agents/*.vue
```

Every `.vue` file must report **≤300 lines**. Anything over triggers the fallback in Step 11 above; after the fallback every file must still report ≤300 lines.

Round-id consumer audit:

```bash
grep -nE 'startsWith\("r-(msg:|compacted-|pre)"|=== "r-pre"|/\^r(-msg:)?(-compacted-)?\\d\+/' \
  web/src/components/agents/ \
  web/src/composables/useAgent*.ts \
  | grep -v 'web/src/components/agents/round-id.ts'
```

Must report zero matches. If any match appears, the consumer in question must be ported to `parseRoundId(id).kind` (or `roundIdSortKey(id)`) before merge.

Test report (at minimum):

- `web/src/components/agents/round-id.test.ts`: 27 strictness cases + 4 sort-ordering assertions. All pass.
- `web/src/components/agents/timeline.test.ts`: 10 r2 cases + 1 new "malformed bucket dropped" case = 11 cases. All pass.
- `web/src/composables/useAuthState.test.ts`: existing assertions, all pass (resurrected by the r2 include-glob change).

Manual smoke checks from [03-plan-r1.md](./03-plan-r1.md) §"Validation" (Agents tab, agent selection, session selection, agent finish closeout, `open-file` bubbling) are retained verbatim.

## Rollback

`git checkout -- web/src/App.vue web/src/api/types.ts vitest.config.ts && git clean -fd web/src/components/agents web/src/composables/useAgentRoster.ts web/src/composables/useAgentConversation.ts web/src/composables/useChatSessions.ts && git checkout HEAD -- web/src/components/AgentsView.vue` restores the pre-change state, including the `vitest.config.ts` `include` glob.

## Files touched (delta vs r2)

Edited vs r2:

- `web/src/components/agents/timeline.ts` — bucket classifier ports through `parseRoundId(id).kind` instead of `startsWith("r-compacted-")`; malformed buckets (`kind === "unknown"`) are dropped.
- `web/src/components/agents/timeline.test.ts` — one new case: bucket id `r-compacted-3x` yields `[]`.

No other r3 file edits. No new dependencies. No `web/package.json` script changes. No `jsdom`. The cap change is documentation- and validation-only; the budget projections are unchanged and the fallback shape is unchanged.
