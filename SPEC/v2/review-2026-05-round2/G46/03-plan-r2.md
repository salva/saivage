# G46 — Plan (r2, Design A)

This plan supersedes [03-plan-r1.md](./03-plan-r1.md) only on the four points raised by [04-review-r1.md](./04-review-r1.md). Steps not listed here (Step 1 shared-types extension, Step 2 constants module, Step 4 UI-only types, Step 8 component extraction layout, Step 9 App.vue rewire, Step 10 monolith deletion) are unchanged from r1.

Assumes G41 ([../G41/APPROVED.md](../G41/APPROVED.md)) has landed: [web/src/api/types.ts](web/src/api/types.ts) exists with `AgentRole`, `AgentState`, `RuntimeState`, `Plan`, `PlanStage`, `ApiState`; [web/package.json](web/package.json) gains `vue-tsc` from G41 (not from G46).

## Steps changed in r2

### Step 3 (revised) — Create the round-id parser with a strict decimal scanner

Create `web/src/components/agents/round-id.ts` with the body from [02-design-r2.md](./02-design-r2.md) §"Change 1". Specifically:

1. Define the private `parseDecimalAll(s: string): number | null` helper. Reject empty input. Reject any char outside `0`-`9` (codes 48..57). Reject values above `Number.MAX_SAFE_INTEGER`.
2. Define `parseRoundId(id)` using fixed-prefix `startsWith` branches. On a recognised prefix with an invalid trailing slice, return `{ tier: 4, kind: "unknown" }` — do not fall through.
3. Guard the bare-`r` branch with `id.charCodeAt(1) !== 45` so `r-…` strings never match `rN`.
4. Define `roundIdSortKey(id)` returning `[tier, index]`, with `index = 0` for the tier-0 `pre` and tier-4 `unknown` cases (deterministic ordering of unknowns).

No regex literal anywhere in the file. No `Number.parseInt`, no `Number.parseFloat`, no `Number()` coercion.

### Step 6 (revised) — Timeline transformer test, with explicit strictness cases

Create `web/src/components/agents/timeline.test.ts` covering the r1 cases plus the strictness cases below. Mirror the test harness conventions of [web/src/composables/useAuthState.test.ts](web/src/composables/useAuthState.test.ts#L1) (`vitest` `describe`/`it`/`expect`, `vi.fn()` where needed).

Coverage targets:

| Test | Asserts |
|---|---|
| empty input | returns `[]` |
| one assistant `text` under `r1` | one `round` item, `hasAssistant: true` |
| matched `tool_call` + `tool_result` | `toolPairs[0].status === "ok"` |
| `tool_call` only under latest `r${k}` with pending | `status === "pending"` |
| `tool_result` orphan | `status === "orphan"`, `call === undefined` |
| `tool_error` | `status === "error"` |
| tool entry missing `toolUseId` | dropped, `console.warn` called once (spy via `vi.spyOn(console, "warn")`) |
| `model_issue` alone under a round | one `diagnostic` item, no `round` item |
| `r-pre` + `r-compacted-3` + `r2` mix | items sorted tier 0 → 2 → 3 |
| same-timestamp `r1` and `r-pre` | `r-pre` sorts before `r1` |

Plus a co-located `web/src/components/agents/round-id.test.ts` that pins parser strictness. **All cases must run**:

| Input | Expected `parseRoundId(id).kind` | Expected `index` |
|---|---|---|
| `"r-pre"` | `"pre"` | — |
| `"r0"` | `"round"` | `0` |
| `"r1"` | `"round"` | `1` |
| `"r42"` | `"round"` | `42` |
| `"r-msg:0"` | `"msg"` | `0` |
| `"r-msg:7"` | `"msg"` | `7` |
| `"r-compacted-3"` | `"compacted"` | `3` |
| `""` | `"unknown"` | — |
| `"r"` | `"unknown"` | — |
| `"r-"` | `"unknown"` | — |
| `"r-1"` | `"unknown"` | — |
| `"r1x"` | `"unknown"` | — |
| `"r1 "` | `"unknown"` | — |
| `" r1"` | `"unknown"` | — |
| `"r+1"` | `"unknown"` | — |
| `"r01"` | `"round"` | `1` (leading-zero accepted; matches `\d+`) |
| `"r1e3"` | `"unknown"` | — |
| `"r0x10"` | `"unknown"` | — |
| `"r-msg:"` | `"unknown"` | — |
| `"r-msg:3junk"` | `"unknown"` | — |
| `"r-msg:+3"` | `"unknown"` | — |
| `"r-msg:-3"` | `"unknown"` | — |
| `"r-msg: 3"` | `"unknown"` | — |
| `"r-compacted-"` | `"unknown"` | — |
| `"r-compacted-3x"` | `"unknown"` | — |
| `"r99999999999999999999"` | `"unknown"` (overflow) | — |
| `"R1"` (uppercase R) | `"unknown"` | — |

Then assert sort ordering: `roundIdSortKey("r-pre") < roundIdSortKey("r0") < roundIdSortKey("r1") < roundIdSortKey("r10") < roundIdSortKey("r-compacted-0") < roundIdSortKey("r-compacted-99")`. Note tier 1 (`r-msg:*`) sits between `round` and `compacted`; assert `roundIdSortKey("r-msg:0") < roundIdSortKey("r-compacted-0")` and `roundIdSortKey("r0") < roundIdSortKey("r-msg:0")`. Tier ordering is the explicit invariant the live regex sort already enforced.

### Step 7 (revised) — `useAgentConversation` exposes `bindThreadBody` instead of `threadBody`

Create `web/src/composables/useAgentConversation.ts` with the surface from [02-design-r2.md](./02-design-r2.md) §"Change 2":

1. The composable holds a module-scoped (closure-scoped) `let getThreadBodyEl: (() => HTMLElement | null) | null = null;`. **Do not** expose a `Ref<HTMLElement | null>` on the return value.
2. Export `bindThreadBody(getEl)` on the returned handle. Calling it overwrites the closure variable; passing `() => null` clears it.
3. Both `isScrolledToBottom()` and `scrollToBottom()` read via `getThreadBodyEl?.() ?? null`. When unbound, `isScrolledToBottom()` returns `true` (preserves the live behavior at [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L258-L261) where a null ref short-circuits to "treat as at bottom").
4. `SCROLL_BOTTOM_TOLERANCE_PX` comes from `agents/constants.ts`.
5. `load(agentId)` keeps the snapshot pattern: capture `wasAtBottom = isScrolledToBottom()` before assigning `conversation.value`, then `if (wasAtBottom) await nextTick().then(scrollToBottom);` (matches [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L222-L227)).

`AgentConversationPane.vue` (Step 8.3, otherwise unchanged) gains:

```ts
const threadBody = ref<HTMLElement | null>(null);
function getThreadBodyEl(): HTMLElement | null { return threadBody.value; }
defineExpose({ getThreadBodyEl });
```

…and binds the ref in the template via `<div class="thread-body agent-thread-body" ref="threadBody">…</div>`. No other component touches `threadBody`.

The coordinator (Step 8.6, otherwise unchanged) gains:

```ts
const paneRef = ref<InstanceType<typeof AgentConversationPane> | null>(null);

watch(paneRef, (pane) => {
  if (pane) agentConv.bindThreadBody(pane.getThreadBodyEl);
  else agentConv.bindThreadBody(() => null);
});
```

…and adds `ref="paneRef"` to the `<AgentConversationPane>` instantiation in the template.

### Step 11 (revised) — CSS split with explicit ≤300 cap and fallback

After the per-component CSS split from r1 Step 11, run:

```bash
wc -l web/src/components/agents/*.vue
```

For each file:

- If `≤300` lines: done.
- If `>300` and `≤330` lines: accept (slack within +10%).
- If `>330` lines: move that file's `<style scoped>` block to a sibling external sheet and replace the inline block with `<style src="./<Name>.css" scoped></style>`. Re-measure.

If after the fallback any file is still `>330` lines, **stop the implementation** and reopen the design — this indicates the responsibility-level split itself is wrong and r2 must be revised before merge. Do not paper over with deeper file splits at implementation time.

The candidate triggers, by [01-analysis-r2.md](./01-analysis-r2.md) §"(4)" budget table, in descending risk order: `ToolCallRow.vue` (265 projected) > `AgentRoundCard.vue` (250) > `ConversationSidebar.vue` (240).

### Step 12 (new) — Wire Vitest to pick up web tests

Edit [vitest.config.ts](vitest.config.ts):

```diff
-    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
+    include: [
+      "src/**/*.test.ts",
+      "tests/**/*.test.ts",
+      "web/src/**/*.test.ts",
+    ],
```

No other changes — `testTimeout`, `hookTimeout`, and `passWithNoTests` keep their existing values. No `environment: "jsdom"` is added; the new tests are pure-function, and the existing [web/src/composables/useAuthState.test.ts](web/src/composables/useAuthState.test.ts#L1) mocks `fetch` directly.

Do **not** add a `test` script or `vitest` dependency to [web/package.json](web/package.json). The web package stays free of a runtime test framework; all Vitest invocations happen from the repo root.

## Validation (revised)

From the repo root:

```bash
npm run build:web    # cd web && vite build — must succeed
npm test             # vitest run — must pass src/, tests/, and web/src/**/*.test.ts
```

The new test files report (at minimum):

- `web/src/components/agents/round-id.test.ts`: 1 describe block, one `it` per row of the strictness table from Step 6 (27 cases) + 4 sort-ordering assertions. All pass.
- `web/src/components/agents/timeline.test.ts`: 10 `it` blocks per Step 6 r1 plan, all pass.
- `web/src/composables/useAuthState.test.ts`: existing assertions, all pass (this test becomes live again as a side effect of the include glob change).

Per-component size enforcement:

```bash
wc -l web/src/components/agents/*.vue \
  web/src/components/agents/*.ts \
  web/src/composables/useAgent*.ts \
  web/src/composables/useChatSessions.ts
```

Every `.vue` file must report `≤330` lines (cap + slack). Anything over triggers the fallback in Step 11.

Manual smoke checks from [03-plan-r1.md](./03-plan-r1.md) §"Validation" (Agents tab, agent selection, session selection, agent finish closeout, `open-file` bubbling) are retained verbatim.

## Rollback

`git checkout -- web/src/App.vue web/src/api/types.ts vitest.config.ts && git clean -fd web/src/components/agents web/src/composables/useAgentRoster.ts web/src/composables/useAgentConversation.ts web/src/composables/useChatSessions.ts && git checkout HEAD -- web/src/components/AgentsView.vue` restores the pre-change state, including the `vitest.config.ts` `include` glob.

## Files touched (delta vs r1)

Added vs r1:

- `web/src/components/agents/round-id.test.ts` (new).

Edited vs r1:

- [vitest.config.ts](vitest.config.ts) — extend `include` to cover `web/src/**/*.test.ts`.
- `web/src/components/agents/round-id.ts` — strict decimal scanner instead of `Number.parseInt`.
- `web/src/composables/useAgentConversation.ts` — `bindThreadBody(getEl)` setter; no `Ref<HTMLElement | null>` on the public surface.
- `web/src/components/agents/AgentConversationPane.vue` — owns the `threadBody` ref and `defineExpose({ getThreadBodyEl })`.
- `web/src/components/agents/AgentsView.vue` (coordinator) — `paneRef` + `watch` that calls `agentConv.bindThreadBody`.

No new dependencies. No `web/package.json` script changes. No `jsdom`.
