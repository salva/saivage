# G46 — Design (r2)

## Scope of revision

This round 2 design supersedes [02-design-r1.md](./02-design-r1.md) only on the four points raised by [04-review-r1.md](./04-review-r1.md). The shared-types contract, constants module, composable surface (minus the `threadBody` reshape below), timeline transformer, leaf component tree, and proposal A vs B vs C evaluation from r1 stand unchanged and are not duplicated here.

References: [01-analysis-r2.md](./01-analysis-r2.md) for the measured starting state and the strictness table.

## Change 1 — Strict, deterministic, regex-free round-id parser

Replace the r1 `Number.parseInt`-based body of `web/src/components/agents/round-id.ts` with a tiny decimal scanner that mirrors `^\d+$` semantics without using regex:

```ts
/** Internal: returns the parsed value of a non-empty all-decimal string,
 *  or null if any character is outside 0-9 or the string is empty.
 *  No regex. No leading sign, no whitespace, no exponent, no hex prefix. */
function parseDecimalAll(s: string): number | null {
  if (s.length === 0) return null;
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 48 || c > 57) return null;        // 48..57 = '0'..'9'
    n = n * 10 + (c - 48);
    if (n > Number.MAX_SAFE_INTEGER) return null;
  }
  return n;
}

export type RoundIdShape =
  | { tier: 0; kind: "pre" }                          // r-pre
  | { tier: 1; kind: "msg"; index: number }           // r-msg:N
  | { tier: 2; kind: "round"; index: number }         // rN
  | { tier: 3; kind: "compacted"; index: number }     // r-compacted-N
  | { tier: 4; kind: "unknown" };

export function parseRoundId(id: string): RoundIdShape {
  if (id === "r-pre") return { tier: 0, kind: "pre" };

  if (id.startsWith("r-msg:")) {
    const n = parseDecimalAll(id.slice("r-msg:".length));
    if (n !== null) return { tier: 1, kind: "msg", index: n };
    return { tier: 4, kind: "unknown" };
  }

  if (id.startsWith("r-compacted-")) {
    const n = parseDecimalAll(id.slice("r-compacted-".length));
    if (n !== null) return { tier: 3, kind: "compacted", index: n };
    return { tier: 4, kind: "unknown" };
  }

  // `rN` shape: `r` followed by all-decimal. Must not match `r-…`.
  if (id.length >= 2 && id.charCodeAt(0) === 114 /* 'r' */ && id.charCodeAt(1) !== 45 /* '-' */) {
    const n = parseDecimalAll(id.slice(1));
    if (n !== null) return { tier: 2, kind: "round", index: n };
  }

  return { tier: 4, kind: "unknown" };
}

export function roundIdSortKey(id: string): [number, number] {
  const parsed = parseRoundId(id);
  if (parsed.kind === "pre" || parsed.kind === "unknown") return [parsed.tier, 0];
  return [parsed.tier, parsed.index];
}
```

Properties (all explicit in tests, see [03-plan-r2.md](./03-plan-r2.md) §Step 6):

- Exactly preserves the acceptance set of the live anchored regexes `^r-msg:(\d+)$`, `^r-compacted-(\d+)$`, `^r(\d+)$`. The strictness table in [01-analysis-r2.md](./01-analysis-r2.md) §"(1) Strictness" enumerates the inputs.
- The early-return on a recognised prefix + invalid trailing slice (e.g. `r-msg:3junk`) yields `unknown` instead of accidentally falling through to the `r…` branch and parsing `-msg:3junk` as a round index.
- The `id.charCodeAt(1) !== 45` guard prevents `r-…` strings from matching the `rN` branch.
- The `MAX_SAFE_INTEGER` ceiling rules out integer overflow on adversarial input (e.g. `r99999999999999999999`); such IDs fall to tier 4.
- No regex. Principle 1 (no regex for *user* intent) doesn't strictly apply here — round IDs are a server-internal correlation key — but removing regex from the SPA matches the surface-wide direction the rest of G46 takes.

The `timeline.ts` transformer keeps the r1 wiring: pending-round inference reads `parseRoundId(e.roundId).kind === "round"`, and `roundIdSortKey` drives the same-timestamp tiebreaker.

## Change 2 — `threadBody` ownership and scroll-anchor binding

Owner: `agents/AgentConversationPane.vue`. Surface: a `defineExpose({ getThreadBodyEl })` getter consumed by the coordinator. Consumer of the scroll math: `useAgentConversation()` via a setter the coordinator calls inside an `onMounted`.

### Pane side

```vue
<!-- agents/AgentConversationPane.vue -->
<script setup lang="ts">
import { ref } from "vue";
// …other imports

const threadBody = ref<HTMLElement | null>(null);

function getThreadBodyEl(): HTMLElement | null {
  return threadBody.value;
}

defineExpose({ getThreadBodyEl });
</script>

<template>
  <header class="thread-header">…</header>
  <div class="thread-body agent-thread-body" ref="threadBody">
    <!-- existing timeline rendering -->
  </div>
  <footer class="agent-thread-footer">…</footer>
</template>
```

The pane neither reads nor mutates scroll position. It only owns the DOM element and exposes a typed getter.

### Composable side

`useAgentConversation()` takes the getter via a setter exposed on its return value (no constructor coupling — the composable mounts before the pane's `<div>` exists):

```ts
// web/src/composables/useAgentConversation.ts
export interface AgentConversationHandle {
  conversation: Readonly<Ref<AgentConversation | null>>;
  loading: Readonly<Ref<boolean>>;
  expanded: Readonly<Ref<ReadonlySet<string>>>;
  load(agentId: string): Promise<void>;
  stop(): void;
  toggleDetails(id: string): void;
  /** One-way binding: pane reports its DOM element via this setter
   *  on its onMounted hook. Idempotent; null clears the binding. */
  bindThreadBody(getEl: () => HTMLElement | null): void;
}
```

Internally:

```ts
let getThreadBodyEl: (() => HTMLElement | null) | null = null;

function bindThreadBody(getEl: () => HTMLElement | null) {
  getThreadBodyEl = getEl;
}

function isScrolledToBottom(): boolean {
  const el = getThreadBodyEl?.();
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < SCROLL_BOTTOM_TOLERANCE_PX;
}

function scrollToBottom() {
  const el = getThreadBodyEl?.();
  if (el) el.scrollTop = el.scrollHeight;
}
```

`load()` keeps the existing snapshot/`nextTick` pattern from [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L222-L227):

```ts
const wasAtBottom = isScrolledToBottom();
// …assign conversation.value, advance loading…
if (wasAtBottom) await nextTick().then(scrollToBottom);
```

### Coordinator wiring

```vue
<!-- agents/AgentsView.vue -->
<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import AgentConversationPane from "./AgentConversationPane.vue";
// …

const agentConv = useAgentConversation();
const paneRef = ref<InstanceType<typeof AgentConversationPane> | null>(null);

watch(paneRef, (pane) => {
  if (pane) agentConv.bindThreadBody(pane.getThreadBodyEl);
  else agentConv.bindThreadBody(() => null);
});
</script>

<template>
  <AgentConversationPane
    v-if="agentConv.conversation.value && selectionKind === 'agent'"
    ref="paneRef"
    …
  />
</template>
```

Boundary summary:

| Concern | Owner |
|---|---|
| `<div class="thread-body">` DOM element | `AgentConversationPane.vue` |
| `threadBody` ref declaration | `AgentConversationPane.vue` (private), exposed read-only via `getThreadBodyEl()` |
| `SCROLL_BOTTOM_TOLERANCE_PX` constant | `agents/constants.ts` |
| `isScrolledToBottom`, `scrollToBottom` | `useAgentConversation` (private) |
| Poll loop calling them | `useAgentConversation` |
| Pane ↔ composable binding | coordinator `AgentsView.vue` via `watch(paneRef)` |

No `defineExpose` of internal state. The pane's `getThreadBodyEl` returns an `HTMLElement | null`, which is the minimum the scroll math needs.

## Change 3 — Validation wiring (Vitest at the repo root, not in `web/`)

Live state ([01-analysis-r2.md](./01-analysis-r2.md) §"(3)"):

- [web/package.json](web/package.json) has no `test` script and no `vitest` dependency.
- [vitest.config.ts](vitest.config.ts) `include` only matches `src/**/*.test.ts` and `tests/**/*.test.ts`.
- [web/src/composables/useAuthState.test.ts](web/src/composables/useAuthState.test.ts#L1) is orphaned.

Decision: extend the root [vitest.config.ts](vitest.config.ts) `include` glob; do not add a second runner inside `web/`.

```ts
// vitest.config.ts (edit)
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "tests/**/*.test.ts",
      "web/src/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 10_000,
    passWithNoTests: true,
  },
});
```

The new `web/src/components/agents/timeline.test.ts` plus the resurrected [web/src/composables/useAuthState.test.ts](web/src/composables/useAuthState.test.ts#L1) both run under `node` (no DOM): `timeline.test.ts` is a pure-function transformer test, and `useAuthState.test.ts` uses `vi.fn()` mocks of `fetch` per the existing `useAuthState` design. No `jsdom` dependency is added.

Validation commands become:

```
npm run build:web         # cd web && vite build (no vue-tsc until G41 lands; G46 inherits G41's wiring)
npm test                  # vitest run — covers src/, tests/, and web/src/**/*.test.ts
```

The r1 `cd web && npm run typecheck && npm run build` is removed from the G46 validation list, because G41 ([../G41/03-plan-r2.md](../G41/03-plan-r2.md#L100-L130)) owns introducing `vue-tsc` into `web/package.json`; G46 strictly depends on G41 having landed.

## Change 4 — Credible per-component line budget

Re-measured allocation in [01-analysis-r2.md](./01-analysis-r2.md) §"(4)" yields the following target budgets. Each row sums `<script>` + `<template>` + `<style scoped>` + (1 closing `</style>` + blank lines, allocated at ~10 lines per file).

| File | script | template | style | misc | total | r1 budget | r2 budget |
|---|---|---|---|---|---|---|---|
| `agents/AgentsView.vue` (coordinator) | 55 | 35 | 35 | 10 | 135 | ≤180 | ≤180 |
| `agents/ConversationSidebar.vue` | 35 | 65 | 130 | 10 | 240 | ≤180 | ≤260 |
| `agents/AgentConversationPane.vue` | 70 | 55 | 95 | 10 | 230 | ≤240 | ≤260 |
| `agents/AgentRoundCard.vue` | 35 | 60 | 145 | 10 | 250 | ≤160 | ≤280 |
| `agents/ToolCallRow.vue` | 35 | 50 | 170 | 10 | 265 | ≤140 | ≤300 |
| `agents/ChatSessionPane.vue` | 30 | 20 | 50 | 10 | 110 | ≤130 | ≤130 |

Reasoning:

- **`AgentConversationPane.vue` script (~70)**: the `timeline` computed (~6 lines, delegating to `entriesToTimeline`), the `defaultModelSpec` computed (~6), `elapsed` / `durationSince` / `durationUntil` time helpers (~25), `roleColor` (~12), `onMounted` for `bindThreadBody` wiring (~5), props/emits declarations (~10), `parseContent` (~6) — sums to ~70.
- **`AgentConversationPane.vue` template (~55)**: header, body wrapper, three template branches (`round`, `diagnostic`, `compacted` and `context` are emitted as `<AgentRoundCard>` and three small `<div>` blocks of ~8–12 lines each), footer.
- **`AgentRoundCard.vue` script (~35)**: `diagnosticTone`, `diagnosticLabel` helpers (~14), `formatToolPair` is delegated to `ToolCallRow`, only round-level rendering helpers remain; props/emits declarations (~10).
- **`ToolCallRow.vue` template (~50)**: this is the dense block. Live source [L725-L803](web/src/components/AgentsView.vue#L725-L803) is 79 lines but ~25 of those are template-level whitespace + the surrounding `<template v-for>`/`<button>` boilerplate that is no longer per-pair in the new file (the `v-for` lives in the parent `AgentRoundCard`). Per-row template settles at ~50.
- **`ToolCallRow.vue` style (~170)**: this is the irreducible CSS surface (`.agent-tool-row`, `.agent-tool-row[data-status=…]` × 5, `.agent-tool-summary`, `.tool-link`, `.tool-link.tool-file`, `.tool-link.tool-url`, `.tool-code`, `.chevron`, expanded-detail `.agent-tool-detail*`).

Hard cap: **`≤300` lines per SFC**, applied uniformly. `ToolCallRow.vue` is the only file budgeted within 10% of the cap.

### Explicit fallback if the cap is exceeded

If `wc -l web/src/components/agents/*.vue` shows any single file >330 lines after the port (cap + 10% slack), the implementation moves that file's `<style scoped>` block to a sibling external sheet and imports it via Vue's `<style src="…" scoped>` form:

```vue
<style src="./ToolCallRow.css" scoped></style>
```

This trims the offending SFC by exactly its style budget without restructuring components. It is a mechanical fallback; the plan ([03-plan-r2.md](./03-plan-r2.md) §Step 11) makes it conditional on the measurement, not unconditional.

No second component split. Splitting `ToolCallRow.vue` into `ToolCallRowButton.vue` + `ToolCallRowDetail.vue` would fragment a single visual unit (one row + its expanded panel are a tightly-coupled disclosure pattern); the only benefit would be cosmetic line counting. Rejected.

## Anti-principles checklist (still hold)

| Principle | Status in r2 |
|---|---|
| No regex for user intent | Round-id parser now uses an explicit byte-level scanner; no regex anywhere in the agents subsystem. |
| No hardcoded values | All UI tunables in `agents/constants.ts`. `MAX_SAFE_INTEGER` ceiling in the parser is a JS language constant, not a tuning value. |
| No fragile agent-tool-call heuristics | `messageIndex:blockIndex` fallback still deleted; missing `toolUseId` still drops the entry with `console.warn`. |
| Architecture-first / no shims | Old `web/src/components/AgentsView.vue` still deleted; `App.vue` still imports from `agents/AgentsView.vue`. |
| No backward compat | Unchanged from r1. |
| Avoid over-engineering | No new test runner inside `web/`; the root Vitest config is widened by one glob entry. The fallback CSS extraction is conditional and per-file, not preemptive. |

## Daemon impact

Web-only change. The new validation path (`npm test` at the repo root) covers both the existing `src/` tests and the new `web/src/**/*.test.ts` tests. No `saivage.service` restart needed beyond the standard Vite build.
