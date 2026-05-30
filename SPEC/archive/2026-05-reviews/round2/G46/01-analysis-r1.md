# G46 — Analysis (r1)

## Issue under review

[../G46-agents-view-monolith.md](../G46-agents-view-monolith.md): `web/src/components/AgentsView.vue` is a 1,492-line SFC that owns four logically distinct surfaces (active agent list, chat history sidebar, conversation/round rendering, tool pair rendering) glued together with shared `<script setup>` state and one shared `<style scoped>` block.

## Measured starting state

Block breakdown of [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1-L1492):

| Block | Lines | Range |
|---|---|---|
| `<script setup>` | 570 | [L1-L570](web/src/components/AgentsView.vue#L1-L570) |
| `<template>` | 297 | [L571-L867](web/src/components/AgentsView.vue#L571-L867) |
| `<style scoped>` | 625 | [L868-L1492](web/src/components/AgentsView.vue#L868-L1492) |
| **Total** | **1,492** | |

Relative to siblings (lines):

| File | Lines |
|---|---|
| [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1) | 1,492 |
| [web/src/components/FilesView.vue](web/src/components/FilesView.vue#L1) | 782 |
| [web/src/components/PlanView.vue](web/src/components/PlanView.vue#L1) | 777 |
| [web/src/components/ChatWindow.vue](web/src/components/ChatWindow.vue#L1) | 675 |
| [web/src/components/StatusPanel.vue](web/src/components/StatusPanel.vue#L1) | 510 |
| [web/src/components/DebugView.vue](web/src/components/DebugView.vue#L1) | 409 |
| [web/src/components/JsonHighlight.vue](web/src/components/JsonHighlight.vue#L1) | 134 |
| [web/src/components/FormattedContent.vue](web/src/components/FormattedContent.vue#L1) | 111 |

AgentsView is 1.9× the next-largest SFC and 2.2× ChatWindow.

## Responsibilities entangled in one SFC

A read of [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1-L570) identifies four logically separable axes plus three structurally separable widgets:

1. **Roster polling** — `activeAgents`, `pollTimer`, `fetchData` at [L130-L147](web/src/components/AgentsView.vue#L130-L147). 5-second poll of `/api/state`, filters out `agent_type === "chat"` ([L141-L142](web/src/components/AgentsView.vue#L141-L142)). Owns no rendering except the sidebar list.
2. **Chat session listing** — `chatSessions`, same `fetchData` poll plus `filteredSessions` computed at [L568](web/src/components/AgentsView.vue#L568). Distinct endpoint (`/api/chats`), distinct empty-state semantics.
3. **Active-agent conversation** — `selectedAgent`, `loadAgentConversation`, the 404-closeout path, `agentPollTimer`, the per-agent re-poll, scroll-bottom anchoring ([L156-L228](web/src/components/AgentsView.vue#L156-L228), [L243-L266](web/src/components/AgentsView.vue#L243-L266)). The most stateful surface in the file.
4. **Chat-session conversation** — `selectedSession`, `loadSession` ([L230-L242](web/src/components/AgentsView.vue#L230-L242)). Distinct from (3) in protocol (one-shot fetch, no polling, no scroll anchoring), but in this SFC shares `loading`, `selectedId`, `selectionKind` with (3) by convention.

Within (3) three independent presentational concerns share `<style scoped>`:

5. **Round bucketing** — `roundsToTimeline` at [L412-L530](web/src/components/AgentsView.vue#L412-L530). Pure function over `ConversationEntry[] → TimelineItem[]`; runs inside the `timeline` `computed` at [L539-L557](web/src/components/AgentsView.vue#L539-L557). Currently inlined alongside DOM-coupled code.
6. **Round rendering** — `<section class="agent-round">` block at [L703-L778](web/src/components/AgentsView.vue#L703-L778). Renders reasoning entries, tool list, diagnostics, context per `Round`.
7. **Tool-pair rendering** — nested `<template v-for="pair in item.round.toolPairs">` at [L725-L777](web/src/components/AgentsView.vue#L725-L777). Owns the chevron toggle, `formatPair` calls, click handlers for inline parts, expanded-details panel. 52 template lines per tool row, replicated implicitly per round.

## Local interface declarations

[web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L11-L120) declares 9 ad-hoc TypeScript interfaces that mirror server contracts owned by [src/agents/base.ts](src/agents/base.ts#L41-L75) and [src/types.ts](src/types.ts#L308-L330):

| Local declaration | Lines | Canonical server source |
|---|---|---|
| `AgentState` | [L12-L18](web/src/components/AgentsView.vue#L12-L18) | [src/types.ts](src/types.ts#L242-L249) — already covered by G41's `web/src/api/types.ts` |
| `ChatSession` | [L20-L26](web/src/components/AgentsView.vue#L20-L26) | inline literal in [src/server/server.ts](src/server/server.ts#L289-L294) (no Zod schema; only the per-session aggregate over `ChatLogSchema`) |
| `ChatMessage` | [L28-L38](web/src/components/AgentsView.vue#L28-L38) | [src/types.ts](src/types.ts#L308-L320) `ChatMessageSchema` |
| `ChatLog` | [L40-L46](web/src/components/AgentsView.vue#L40-L46) | [src/types.ts](src/types.ts#L322-L329) `ChatLogSchema` |
| `ConversationEntry` | [L48-L70](web/src/components/AgentsView.vue#L48-L70) | [src/agents/base.ts](src/agents/base.ts#L41-L63) — verbatim duplicate |
| `ActivityStatus` | [L72-L81](web/src/components/AgentsView.vue#L72-L81) | [src/agents/base.ts](src/agents/base.ts#L66-L75) — verbatim duplicate |
| `AgentConversation` | [L83-L91](web/src/components/AgentsView.vue#L83-L91) | response envelope of [src/server/server.ts](src/server/server.ts#L183-L196); not a standalone Zod type |
| `Round` | [L93-L103](web/src/components/AgentsView.vue#L93-L103) | UI-derived; no server analogue |
| `ToolPair` | [L105-L111](web/src/components/AgentsView.vue#L105-L111) | UI-derived |
| `TimelineItem` | [L113-L120](web/src/components/AgentsView.vue#L113-L120) | UI-derived |

`AgentState` here also widens `agent_type` to `string` and `status` to `string`, conflicting with G41's narrowed `AgentRole` / `RuntimeState.status` literal unions. Once G41 lands, the local copy regresses the typecheck on every read of `agent.agent_type`.

## Hardcoded UI values and heuristics

Inline magic numbers and tunables identified:

| Value | Site | Meaning |
|---|---|---|
| `5000` | [L267](web/src/components/AgentsView.vue#L267) | roster + chat-session poll interval (ms) |
| `3000` | [L246](web/src/components/AgentsView.vue#L246) | per-agent conversation poll interval (ms) |
| `1000` | [L268](web/src/components/AgentsView.vue#L268) | clock tick for `now.value` (ms) |
| `60` | [L262](web/src/components/AgentsView.vue#L262) | scroll-bottom anchor tolerance (px) |
| `120` | [L344](web/src/components/AgentsView.vue#L344), [L349](web/src/components/AgentsView.vue#L349) | `truncate` cap for inline tool-call summaries (chars) |
| `"460px"` / `"320px"` / `"200px"` | inline `:max-height` strings at [L723](web/src/components/AgentsView.vue#L723), [L770](web/src/components/AgentsView.vue#L770), [L774](web/src/components/AgentsView.vue#L774), [L791](web/src/components/AgentsView.vue#L791), [L810](web/src/components/AgentsView.vue#L810), [L840](web/src/components/AgentsView.vue#L840) | per-row max heights for `<FormattedContent>` |

Three regex-based parsers operate on server-generated round IDs (an internal, structured contract — not user intent), at [L404-L411](web/src/components/AgentsView.vue#L404-L411) (`roundSortKey`) and [L543-L549](web/src/components/AgentsView.vue#L543-L549) (pending-round inference in `timeline`):

- `/^r-msg:(\d+)$/`
- `/^r-compacted-(\d+)$/`
- `/^r(\d+)$/`

One heuristic falls outside the round-id parsing: the tool-pair bucketer at [L451-L452](web/src/components/AgentsView.vue#L451-L452) and [L468-L469](web/src/components/AgentsView.vue#L468-L469) synthesizes a fallback key `` `${entry.messageIndex}:${entry.blockIndex}` `` when `toolUseId` is missing. Empirically the server-side `getConversationSnapshot()` at [src/agents/base.ts](src/agents/base.ts#L364) always sets `toolUseId` for `tool_call`, `tool_result`, and `tool_error` kinds (the field is the API-level correlation key); the fallback is dead-but-load-bearing — it cannot be exercised without breaking the server contract first.

## Cross-references

- G41 (approved, [../G41/APPROVED.md](../G41/APPROVED.md)) introduces [web/src/api/types.ts](web/src/api/types.ts) with `AgentRole`, `AgentState`, `RuntimeState`, `Plan`, `PlanStage`, `ApiState`, and wires `vue-tsc` into the SPA build. G46 must land after G41 and reuse those types; the design must not re-declare `AgentState` locally.
- G49 (sibling, [../G49-usewebsocket-send-leaky-envelope.md](../G49-usewebsocket-send-leaky-envelope.md)) touches the same composables/utils area. Independent.
- Round-1 F18 (system-prompt bloat) — server-side analogue. Out of scope.

## What "fixing G46" must achieve

1. Every distinct responsibility identified above ((1)–(7)) lives in its own file with an explicit prop/emit surface. No single file in the agents-view subsystem exceeds ~250 lines including template and styles.
2. All TypeScript shapes consumed from the server come from [web/src/api/types.ts](web/src/api/types.ts) (extended where necessary). UI-only shapes (`Round`, `ToolPair`, `TimelineItem`) live in a single colocated `types.ts`.
3. The pure data transformation `ConversationEntry[] → TimelineItem[]` is a stand-alone module testable without a DOM.
4. All polling intervals, scroll thresholds, and truncate caps come from a named constants module — no `setInterval(..., 5000)` or `truncate(x, 120)` literals at call sites.
5. The `messageIndex:blockIndex` heuristic for missing `toolUseId` is removed; tool entries with no `toolUseId` are dropped with a `console.warn` (treated as a server protocol violation).
6. Regex usage on `roundId` is replaced by a structured parser; this is not user-intent parsing but removing regex aligns the code with the project-wide principle.
7. The web build (`vue-tsc --noEmit && vite build`) passes without regressions.
