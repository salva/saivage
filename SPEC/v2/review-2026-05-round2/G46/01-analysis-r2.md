# G46 — Analysis (r2)

## Scope of revision

Round 1 ([01-analysis-r1.md](./01-analysis-r1.md), [02-design-r1.md](./02-design-r1.md), [03-plan-r1.md](./03-plan-r1.md)) was reviewed in [04-review-r1.md](./04-review-r1.md) with verdict CHANGES_REQUESTED. The four blockers are tightly localized:

1. The proposed regex-free `round-id` parser is not strict (`Number.parseInt` accepts `r1x`, `r-msg:3junk`, `r-1`, leading whitespace, `1e3` notation, etc.).
2. Scroll-anchor / `threadBody` ownership boundary between [useAgentConversation](./02-design-r1.md) and [AgentConversationPane.vue](./02-design-r1.md) is incomplete.
3. The validation command `cd web && npm test` is false against live [web/package.json](web/package.json).
4. The `≤240`-line SFC budget for the largest leaves (`AgentConversationPane.vue`, `ToolCallRow.vue`) is asserted without a credible per-component breakdown.

The starting state of [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1-L1492) (block sizes, entangled responsibilities, local interface duplication, hardcoded UI values) is unchanged from r1 and is not re-measured here.

## (1) Strictness of the existing regex round-id parsers

The live monolith uses three anchored regexes ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L404-L411), [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L543-L549)):

- `/^r-msg:(\d+)$/`
- `/^r-compacted-(\d+)$/`
- `/^r(\d+)$/`

Properties that must be preserved by a regex-free replacement:

| Property | Source |
|---|---|
| Whole-string match (anchored both ends). | `^` and `$` |
| Decimal digits only — no `+`, `-`, `_`, whitespace, exponent, hex prefix. | `\d+` |
| At least one digit. | `\d+` (1-or-more) |
| Index value is the parsed decimal of the entire trailing slice. | capture group |
| `r-pre` recognised as a separate tier (handled by the `=== "r-pre"` branch at [L407](web/src/components/AgentsView.vue#L407), [L545](web/src/components/AgentsView.vue#L545)). | string equality |

The r1 design used `id.startsWith("r-msg:")` + `Number.parseInt(rest, 10)` + `Number.isFinite(n)`. That accepts:

| Input | Old regex | r1 parser | Correct |
|---|---|---|---|
| `r-msg:3` | accept (3) | accept (3) | yes |
| `r-msg:3junk` | reject | accept (3) | no |
| `r-msg:` | reject | reject (NaN) | yes |
| `r-msg:+3` | reject | accept (3) | no |
| `r-msg:-3` | reject | accept (-3) | no |
| `r-msg: 3` | reject | accept (3, leading whitespace stripped) | no |
| `r-msg:1e3` | reject | accept (1) | no |
| `r1x` | reject | accept (1) | no |
| `r-1` | reject (does not match `/^r(\d+)$/`) | accept via `r-msg:`? no — falls to `r…` branch and `parseInt("-1")` returns `-1`, `Number.isFinite(-1)` is `true` | no |

The replacement must accept exactly the same input set as `/^\d+$/` applied to the trailing slice.

## (2) `threadBody` ownership in r1

The r1 design places the DOM ref in the composable ([02-design-r1.md](./02-design-r1.md) §"useAgentConversation()") and the rendering in [AgentConversationPane.vue](./02-design-r1.md). The plan ([03-plan-r1.md](./03-plan-r1.md) §"Step 8.3") says "The `threadBody` ref is bound from the composable" but does not specify how the pane's `<div class="thread-body">` is wired to that ref, nor does the coordinator forward it.

In the live monolith the ref and the scroll math live in one component:

- The ref is declared in `<script setup>` at [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L134) and bound by `ref="threadBody"` at [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L647).
- `isScrolledToBottom()` and `scrollToBottom()` read it directly ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L258-L266)).
- They are called from `loadAgentConversation` ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L222-L227)) inside the poll loop owned by `startAgentPolling` ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L243-L249)).

After the split, both halves of the dependency exist:

- The poll loop and `wasAtBottom` snapshot/`nextTick` `scrollToBottom` sequence belong with the data lifecycle (composable).
- The DOM element belongs with the pane that renders the `<div class="thread-body">`.

A correct split needs an explicit, one-way binding: the pane owns the `<div>` and gives the composable access to it without leaking the pane's internals. The r1 design left that link unspecified.

## (3) Vitest wiring against live live `package.json` files

Measured state:

| File | Relevant scripts | Vitest? |
|---|---|---|
| [web/package.json](web/package.json#L6-L20) | `dev`, `build`, `preview` only | not present in `devDependencies` |
| [package.json](package.json#L12-L26) | `test: vitest run`, `test:watch`, `test:bundle` | `vitest ^4.1.5` in `devDependencies` |
| [vitest.config.ts](vitest.config.ts#L5) | `include: ["src/**/*.test.ts", "tests/**/*.test.ts"]` | excludes `web/**` |

Findings:

- The r1 plan's `cd web && npm test` would fail with "Missing script: test".
- The existing [web/src/composables/useAuthState.test.ts](web/src/composables/useAuthState.test.ts#L1) is currently dead — not matched by the root `include` glob and not executable from `web/` because `web/` lacks a test runner. r1 mistakenly described it as an existing harness.
- Adding `vitest` + a `test` script to [web/package.json](web/package.json) would create a second test-runner footprint for one screen, contradicting the project rule "avoid over-engineering" and forcing a second `vitest.config.ts` copy.
- The cleanest correction is to extend the root [vitest.config.ts](vitest.config.ts#L5) `include` to also pick up `web/src/**/*.test.ts`, and to run all tests via the existing root `npm test`. This also revives the orphaned [web/src/composables/useAuthState.test.ts](web/src/composables/useAuthState.test.ts#L1) at no marginal cost.
- The new `timeline.test.ts` and the existing `useAuthState.test.ts` only import from Vue + their local modules (no DOM); the default Vitest `environment: "node"` is sufficient. No `jsdom` dependency is needed.

## (4) Per-component size budget — re-measurement from live source

The starting allocation against the live monolith ([web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1-L1492)) by sub-responsibility:

| Sub-responsibility | Source range | Lines |
|---|---|---|
| Imports + interface decls + helper functions (move/delete in §"Local interface declarations" r1) | [L1-L120](web/src/components/AgentsView.vue#L1-L120) | 120 |
| Module-level fetch / selection state (`activeAgents`, `chatSessions`, `selectedKind`, `selectedId`, …) | [L121-L155](web/src/components/AgentsView.vue#L121-L155) | 35 |
| `loadAgentConversation` + 404 closeout | [L156-L228](web/src/components/AgentsView.vue#L156-L228) | 73 |
| `loadSession` | [L230-L242](web/src/components/AgentsView.vue#L230-L242) | 13 |
| Polling/clock/scroll helpers | [L243-L277](web/src/components/AgentsView.vue#L243-L277) | 35 |
| `onMounted`/`onUnmounted` glue + small format helpers | [L278-L390](web/src/components/AgentsView.vue#L278-L390) | 113 |
| `roundsToTimeline` (transformer) | [L412-L530](web/src/components/AgentsView.vue#L412-L530) | 119 |
| `timeline`, `filteredSessions`, `defaultModelSpec` computeds | [L539-L568](web/src/components/AgentsView.vue#L539-L568) | 30 |
| Sidebar template | [L573-L639](web/src/components/AgentsView.vue#L573-L639) | 67 |
| Agent-thread header + body + footer template | [L640-L843](web/src/components/AgentsView.vue#L640-L843) | 204 |
| Chat-session template | [L845-L867](web/src/components/AgentsView.vue#L845-L867) | 23 |
| `<style scoped>` (split by class prefix per r1 step 11) | [L868-L1492](web/src/components/AgentsView.vue#L868-L1492) | 625 |
| **Total** | — | **1,492** |

Style allocation by class-prefix grep over [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L868-L1492):

| Prefix(es) | Target file | CSS lines (approx.) |
|---|---|---|
| `.agents-view`, `.thread-panel`, `.thread-empty` | `agents/AgentsView.vue` | 35 |
| `.sidebar`, `.sidebar-*`, `.stab`, `.role-line*`, `.item-*` | `agents/ConversationSidebar.vue` | 130 |
| `.thread-header*`, `.agent-thread-*`, `.thread-body`, `.live-time`, `.live-pill*` | `agents/AgentConversationPane.vue` | 95 |
| `.agent-round*`, `.agent-diagnostic-row`, `.agent-context-*`, `.agent-compacted-*` | `agents/AgentRoundCard.vue` | 145 |
| `.agent-tool-*`, `.tool-link*`, `.tool-code`, `.chevron` | `agents/ToolCallRow.vue` | 170 |
| `.chat-msg`, `.entry-*`, `.text-entry`, `.model-chip` | `agents/ChatSessionPane.vue` | 50 |
| **Total** | — | **625** |

The dominant SFC after split is `ToolCallRow.vue` because the tool-pair surface owns the largest fraction of the original CSS (`.agent-tool-*` + `.tool-link*` + expanded-detail rules). The r1 estimate of ~130 lines understated it by ~150.

## What "fixing G46" must additionally achieve in r2

In addition to the r1 list:

1. The round-id parser must accept exactly the same string set as the live anchored regexes — no extra acceptance for trailing garbage, leading sign, leading whitespace, exponent, or hex literals.
2. The scroll-anchor coupling must have one named owner per side: the pane owns the `<div class="thread-body">` and exposes its element via a `defineExpose` surface; the composable receives an `HTMLElement` getter (or a `Ref<HTMLElement | null>`) when the pane mounts, and reads it inside its existing poll loop. The coordinator wires the two ends; no leaked refs cross unrelated components.
3. Validation runs via the root `npm test`. As part of G46 the root [vitest.config.ts](vitest.config.ts#L5) `include` is widened to cover `web/src/**/*.test.ts`. The new `timeline.test.ts` and the resurrected `useAuthState.test.ts` execute under the existing root runner.
4. The per-component line budgets are reconciled against the re-measured allocation:
   - The largest SFCs (`AgentConversationPane.vue`, `ToolCallRow.vue`, `AgentRoundCard.vue`) get explicit `<script>` / `<template>` / `<style>` sub-budgets summing to a realistic total.
   - The hard cap for any single SFC is `≤300` lines (raised from the r1 informal `≤240`), with `ToolCallRow.vue` budgeted at `≤300` because its CSS is irreducible without a second split into `ToolCallRow.vue` (template + script) + `ToolCallRow.css` external sheet — which we explicitly reject as over-engineering for one screen.
   - If `wc -l` shows any leaf exceeds its budget by more than 10%, the explicit fallback is to move that file's `<style scoped>` block to a sibling plain `.css` file imported from the SFC's `<style scoped src="…">`. No further runtime refactor.
