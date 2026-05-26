# G46 — Design (r1)

## Problem statement

Per [01-analysis-r1.md](./01-analysis-r1.md): [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1-L1492) is a 1,492-line SFC that fuses roster polling, chat session listing, per-agent conversation streaming, and round/tool-pair rendering into one shared state graph, and re-declares 9 ad-hoc TypeScript shapes — two of which (`AgentState`, `ConversationEntry`) duplicate canonical server types and one of which (`AgentState`) widens G41's `AgentRole` literal union back to `string`.

## Constraints

- **Architecture-first, no backward compatibility.** No shim file, no re-export of the old SFC contents under the original name. The original 1,492-line file is replaced; consumers (today only [web/src/App.vue](web/src/App.vue#L1-L590)) import from the new location of the coordinator and nothing else.
- **No migration shims.** No "compat" props, no `defineExpose` keeping pre-split internals reachable.
- **Remove obsolete code.** The `messageIndex:blockIndex` fallback key in the tool-pair bucketer is removed (see analysis §"Hardcoded UI values and heuristics"). The regex round-id parsers are removed.
- **Project-wide principles.**
  1. *No regex for parsing user intent.* The round-id regexes parse a server-internal correlation key (not user intent), but the principle is honoured by replacing them with a structured parser, eliminating regex from the surface.
  2. *Avoid hardcoded values; prefer config.* Poll intervals, scroll tolerances, and truncation caps move to a named constants module. They remain code constants, not server config — they are UI tuning and have no server-side meaning, and pushing them through `/api/config` would be over-engineering.
  3. *No fragile agent-tool-call heuristics.* The synthesized `toolUseId` fallback is deleted. The server guarantees `toolUseId` on every `tool_call`/`tool_result`/`tool_error` entry ([src/agents/base.ts](src/agents/base.ts#L364)); an entry without one is logged once and dropped.
- **G41 ordering.** G46 lands after G41 ([../G41/APPROVED.md](../G41/APPROVED.md)). The shared module [web/src/api/types.ts](web/src/api/types.ts) is extended, not duplicated.
- **Avoid over-engineering.** No Pinia store, no ESLint rule, no codegen, no full route-level refactor. Just split, type, and test.

## Proposal A — Coordinator + 4 focused leaf components, 3 composables, 1 transformer, 1 constants module (RECOMMENDED)

### Component tree

```
web/src/components/agents/
  AgentsView.vue                 (coordinator, layout grid)
  ConversationSidebar.vue        (tabs: Active / History)
  AgentConversationPane.vue      (active-agent timeline rendering)
  AgentRoundCard.vue             (one Round = reasoning + tools + diag + ctx)
  ToolCallRow.vue                (one ToolPair row + expandable detail)
  ChatSessionPane.vue            (chat-session log rendering)
  constants.ts                   (poll intervals, scroll, truncation caps)
  round-id.ts                    (structured parser, no regex)
  timeline.ts                    (ConversationEntry[] → TimelineItem[])
  timeline.test.ts               (unit tests for the transformer)
  types.ts                       (UI-only types: Round, ToolPair, TimelineItem, SelectionKind)

web/src/composables/
  useAgentRoster.ts              (polls /api/state, filters non-chat agents)
  useChatSessions.ts             (polls /api/chats, filters empty)
  useAgentConversation.ts        (per-agent fetch+poll+404 closeout+scroll anchor)
```

### Shared types (extends G41)

[web/src/api/types.ts](web/src/api/types.ts) gains the conversation and chat shapes (mirroring [src/agents/base.ts](src/agents/base.ts#L41-L75) and [src/types.ts](src/types.ts#L308-L330)):

```ts
// Mirrors ConversationEntry at src/agents/base.ts L41-L63.
export type ConversationEntryKind =
  | "text"
  | "activity"
  | "model_issue"
  | "model_repair"
  | "model_recovered"
  | "tool_call"
  | "tool_result"
  | "tool_error";

export interface ConversationEntry {
  role: "user" | "assistant" | "system";
  kind: ConversationEntryKind;
  content: string;
  timestamp: string;
  roundId: string;
  messageIndex: number;
  blockIndex: number;
  toolUseId?: string;   // present iff kind ∈ {tool_call, tool_result, tool_error}
  toolName?: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

// Mirrors ActivityStatus at src/agents/base.ts L66-L75.
export interface ActivityStatus {
  pending_call: {
    started_at: string;
    status: "in_flight" | "backoff";
    attempt: number;
    reason: string | null;
    retry_at: string | null;
  } | null;
  last_activity_at: string;
}

// Response envelope of GET /api/agents/:id/conversation
// (src/server/server.ts L183-L196). `role` is AgentRole (G41 union).
export interface AgentConversation {
  agent_id: string;
  role: AgentRole;
  started_at?: string;
  message_count: number;
  entries: ConversationEntry[];
  activity_status: ActivityStatus | null;
  finished_at?: string;
}

// Mirrors ChatMessageSchema at src/types.ts L308-L320.
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
  event?: { type: string; stage_id?: string; summary?: string };
  note_id?: string;
  inspector_request_id?: string;
}

// Mirrors ChatLogSchema at src/types.ts L322-L329.
export interface ChatLog {
  session_id: string;
  channel: string;
  started_at: string;
  updated_at: string;
  messages: ChatMessage[];
}

// Aggregate row from GET /api/chats (src/server/server.ts L289-L294).
// No standalone server schema — the shape is the projection over ChatLog.
export interface ChatSession {
  session_id: string;
  channel: string;
  started_at: string;
  updated_at: string;
  message_count: number;
}
```

UI-only types stay colocated in `web/src/components/agents/types.ts`:

```ts
import type { ConversationEntry } from "../../api/types";

export type SelectionKind = "agent" | "chat";

export type ToolPairStatus = "pending" | "ok" | "error" | "orphan" | "missing";

export interface ToolPair {
  toolUseId: string;
  toolName: string;
  call?: ConversationEntry;
  result?: ConversationEntry;
  status: ToolPairStatus;
}

export interface Round {
  id: string;
  startedAt: string;
  hasAssistant: boolean;
  reasoning: ConversationEntry[];
  toolPairs: ToolPair[];
  context: ConversationEntry[];
  diagnostics: ConversationEntry[];
  modelSpec?: string;
  requestedModelSpec?: string;
}

export type TimelineItem =
  | { kind: "round"; id: string; timestamp: string; round: Round }
  | { kind: "diagnostic"; id: string; timestamp: string; diagnostic: ConversationEntry }
  | { kind: "context"; id: string; timestamp: string; context: Round }
  | { kind: "compacted"; id: string; timestamp: string; compacted: ConversationEntry[] };
```

The discriminated union (G41 style) replaces the 1,492-line file's `TimelineItem` interface whose four payload fields were all optional and forced `item.round!` non-null assertions in the template.

### Constants module

`web/src/components/agents/constants.ts`:

```ts
/** Polling and rendering tunables for the Agents view. UI-only; no server semantics. */
export const ROSTER_POLL_INTERVAL_MS = 5_000;
export const AGENT_CONVERSATION_POLL_INTERVAL_MS = 3_000;
export const CLOCK_TICK_MS = 1_000;
export const SCROLL_BOTTOM_TOLERANCE_PX = 60;
export const INLINE_SUMMARY_MAX_CHARS = 120;
export const FORMATTED_CONTENT_MAX_HEIGHT_REASONING = "460px";
export const FORMATTED_CONTENT_MAX_HEIGHT_TOOL_DETAIL = "320px";
export const FORMATTED_CONTENT_MAX_HEIGHT_DIAGNOSTIC = "200px";
export const FORMATTED_CONTENT_MAX_HEIGHT_CHAT_MSG = "380px";
```

### Round-id parser (no regex)

`web/src/components/agents/round-id.ts`:

```ts
/** Structured parse of server-generated roundId. Mirrors the contract in
 *  src/agents/base.ts (search: `roundId`). Never thrown — invalid IDs sort
 *  last via tier 4. No regex: parsing is a fixed-prefix branch. */
export type RoundIdShape =
  | { tier: 0; kind: "pre" }                          // r-pre
  | { tier: 1; kind: "msg"; index: number }           // r-msg:N
  | { tier: 2; kind: "round"; index: number }         // rN
  | { tier: 3; kind: "compacted"; index: number }     // r-compacted-N
  | { tier: 4; kind: "unknown" };

export function parseRoundId(id: string): RoundIdShape {
  if (id === "r-pre") return { tier: 0, kind: "pre" };
  if (id.startsWith("r-msg:")) {
    const n = Number.parseInt(id.slice("r-msg:".length), 10);
    if (Number.isFinite(n)) return { tier: 1, kind: "msg", index: n };
  }
  if (id.startsWith("r-compacted-")) {
    const n = Number.parseInt(id.slice("r-compacted-".length), 10);
    if (Number.isFinite(n)) return { tier: 3, kind: "compacted", index: n };
  }
  if (id.length > 1 && id.startsWith("r")) {
    const n = Number.parseInt(id.slice(1), 10);
    if (Number.isFinite(n)) return { tier: 2, kind: "round", index: n };
  }
  return { tier: 4, kind: "unknown" };
}

export function roundIdSortKey(id: string): [number, number] {
  const parsed = parseRoundId(id);
  if (parsed.kind === "pre" || parsed.kind === "unknown") return [parsed.tier, 0];
  return [parsed.tier, parsed.index];
}
```

### Timeline transformer

`web/src/components/agents/timeline.ts` exports `entriesToTimeline(entries: ConversationEntry[], pendingRoundId: string | null): TimelineItem[]`. The body is the existing [L412-L530](web/src/components/AgentsView.vue#L412-L530) `roundsToTimeline` plus:

- Removed `${messageIndex}:${blockIndex}` fallback. If a `tool_call`/`tool_result`/`tool_error` entry has no `toolUseId`, the function calls `console.warn(...)` once and skips the entry (no synthetic pair). Aligns with project principle 3.
- Pending-round inference uses `parseRoundId(e.roundId).kind === "round"` instead of `/^r(\d+)$/.exec(...)`.
- Sort uses `roundIdSortKey(id)` instead of the inline 3-tuple regex sort.

Companion `timeline.test.ts` covers, at minimum:

- empty input → `[]`
- one reasoning entry under `r1` → one `round` item with `hasAssistant: true`.
- `tool_call` + matching `tool_result` under one round → `toolPairs` with `status: "ok"`.
- `tool_call` without result under the latest `r${k}` while `pending` is set → `status: "pending"`.
- `tool_result` without preceding `tool_call` → orphan pair with `status: "orphan"`.
- `tool_error` entry → `status: "error"`.
- diagnostic-only round (`model_issue` etc.) with no reasoning → standalone `diagnostic` items.
- `r-pre` and `r-compacted-N` buckets → `compacted` items, sorted by tier.
- mixed timestamps + same-timestamp tie → tier-based ordering deterministic.

Co-located with [web/src/components/agents/timeline.ts](web/src/components/agents/timeline.ts), runs under `vitest` via the existing [web/package.json](web/package.json) test runner (same harness as [web/src/composables/useAuthState.test.ts](web/src/composables/useAuthState.test.ts#L1)).

### Composables

`useAgentRoster()` → `{ activeAgents: Readonly<Ref<AgentState[]>>; chatSessions: Readonly<Ref<ChatSession[]>>; now: Readonly<Ref<number>>; stop(): void }`.

- Single `setInterval` at `ROSTER_POLL_INTERVAL_MS` polling `/api/state` + `/api/chats` in parallel (preserves the current `Promise.all` at [L131-L134](web/src/components/AgentsView.vue#L131-L134)).
- Separate `setInterval` at `CLOCK_TICK_MS` for `now`.
- `onUnmounted` clears both.

`useAgentConversation()` →
```ts
{
  conversation: Readonly<Ref<AgentConversation | null>>;
  loading: Readonly<Ref<boolean>>;
  threadBody: Ref<HTMLElement | null>;
  expanded: Readonly<Ref<ReadonlySet<string>>>;
  load(agentId: string): Promise<void>;
  toggleDetails(id: string): void;
  stop(): void;
}
```
- Owns `selectedId`, the 404 closeout block ([L165-L178](web/src/components/AgentsView.vue#L165-L178)), `isScrolledToBottom` / `scrollToBottom`, and `agentPollTimer` at `AGENT_CONVERSATION_POLL_INTERVAL_MS`.
- `load()` is idempotent: second call for same id re-polls instead of resetting.

`useChatSessions()` reuses the same `/api/chats` poll. Implementation choice (see §Trade-offs): expose `chatSessions` via `useAgentRoster` directly to avoid two redundant 5s timers; `useChatSessions` becomes a thin selector + the one-shot `loadSession(id): Promise<ChatLog | null>`.

### Component responsibilities

| File | Lines (target) | Props | Emits | Responsibility |
|---|---|---|---|---|
| `agents/AgentsView.vue` | ≤ 180 | none | `(open-file)` | Layout grid. Instantiates `useAgentRoster` + `useAgentConversation` + `useChatSessions`. Owns `selectedKind: SelectionKind \| null`, `selectedId: string \| null`. Forwards `open-file` from `ToolCallRow`. |
| `agents/ConversationSidebar.vue` | ≤ 180 | `{ activeAgents: AgentState[]; chatSessions: ChatSession[]; selection: { kind: SelectionKind; id: string } \| null; now: number }` | `(select-agent, agentId)`, `(select-session, sessionId)` | Active/History tabs. No fetching. Pure presentation. |
| `agents/AgentConversationPane.vue` | ≤ 240 | `{ conversation: AgentConversation; loading: boolean; now: number; expanded: ReadonlySet<string> }` | `(open-file)`, `(toggle-details, id)` | Owns the `timeline` `computed` (delegating to `entriesToTimeline`), the thread-body ref for scroll anchoring, header rendering. Renders rounds via `<AgentRoundCard>`, standalone diagnostics, compacted clusters, and the footer. |
| `agents/AgentRoundCard.vue` | ≤ 160 | `{ round: Round; defaultModelSpec: string \| null; expanded: ReadonlySet<string> }` | `(open-file)`, `(toggle-details, id)` | One round. Renders reasoning, the tool list (delegating each pair to `<ToolCallRow>`), diagnostics, and context blocks. |
| `agents/ToolCallRow.vue` | ≤ 140 | `{ pair: ToolPair; open: boolean }` | `(open-file)`, `(toggle, toolUseId)` | One tool-pair row + expandable detail. Calls `formatToolPair` from [web/src/utils/toolFormatters.ts](web/src/utils/toolFormatters.ts). |
| `agents/ChatSessionPane.vue` | ≤ 130 | `{ session: ChatLog; now: number }` | none | Chat-session log. |

The `<style scoped>` block (625 lines) is split per component by the CSS each component actually uses; nothing is duplicated. Shared design tokens already come from CSS variables (`--accent`, `--surface-1`, …) at the app root.

### Prop / emit surface, exhaustive

All payloads are typed against `web/src/api/types.ts` (G41 module). The cross-file event `open-file` keeps its existing shape (`{ path: string; root: "project" | "saivage" }`) because it crosses into [web/src/App.vue](web/src/App.vue) and matches the existing emit at [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L8-L10).

### Anti-principles checklist (must hold)

| Principle | Status in design |
|---|---|
| No regex for user intent | No regex at all — `round-id.ts` uses fixed-prefix branching + `Number.parseInt`. |
| No hardcoded values | All UI tunables in `constants.ts`. |
| No fragile agent-tool-call heuristics | `messageIndex:blockIndex` fallback deleted; missing `toolUseId` triggers `console.warn` and entry is dropped. |
| Architecture-first / no shims | Old `web/src/components/AgentsView.vue` deleted; `App.vue` imports from `agents/AgentsView.vue`. |
| No backward compat | No alias path, no re-export, no `defineExpose`. |
| Remove obsolete code | All 9 local interfaces deleted; the inline `roundsToTimeline` deleted; the regex sort key deleted. |

### File size before/after

Before:

- [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L1-L1492): 1,492 lines.

After (target):

| File | Lines (estimate) |
|---|---|
| `web/src/components/agents/AgentsView.vue` | ~160 |
| `web/src/components/agents/ConversationSidebar.vue` | ~170 |
| `web/src/components/agents/AgentConversationPane.vue` | ~230 |
| `web/src/components/agents/AgentRoundCard.vue` | ~150 |
| `web/src/components/agents/ToolCallRow.vue` | ~130 |
| `web/src/components/agents/ChatSessionPane.vue` | ~120 |
| `web/src/components/agents/types.ts` | ~35 |
| `web/src/components/agents/constants.ts` | ~15 |
| `web/src/components/agents/round-id.ts` | ~30 |
| `web/src/components/agents/timeline.ts` | ~140 |
| `web/src/components/agents/timeline.test.ts` | ~220 |
| `web/src/composables/useAgentRoster.ts` | ~55 |
| `web/src/composables/useAgentConversation.ts` | ~120 |
| `web/src/composables/useChatSessions.ts` | ~40 |
| `web/src/api/types.ts` (added section) | ~75 |
| **Subtotal product code (excl. test)** | ~1,395 |
| **Test code** | ~220 |

Each individual SFC sits well below the issue's proposed 400-line cap. Total product-code line count is roughly flat (slightly under the original 1,492 because removed duplication and the deleted heuristic outweigh added type declarations).

## Proposal B — Pinia store + three-pane split

Centralize `selectedKind`, `selectedId`, `activeAgents`, `chatSessions`, `selectedAgent`, `selectedSession`, and `expandedDetails` in a new Pinia store `useAgentsViewStore` (in `web/src/stores/`). Split AgentsView into a coordinator + three siblings (`ConversationSidebar`, `AgentConversationPane`, `ChatSessionPane`); skip the `AgentRoundCard` / `ToolCallRow` extraction.

**Pros.**

- Devtools observability for selection state across mount/unmount.
- Cross-tab future-proofing: if a future feature reads `selectedAgent` from a different SPA route, the store is ready.

**Cons.**

- Introduces a Pinia dependency for the first time (current `web/package.json` has no Pinia entry; only Vue 3.5, vue-router-style code paths, and Vite). Adding Pinia for one screen is over-engineering and bloats the bundle.
- AgentsView already unmounts cleanly on tab switch — the store would persist state the user explicitly closed, which is a behavior regression, not a feature.
- Leaves the 297-line template's tool-pair rendering inline. The 75-line per-pair `<template v-for>` ([L725-L803](web/src/components/AgentsView.vue#L725-L803)) is the densest part of the file and the highest-conflict surface; not extracting `ToolCallRow.vue` misses the deepest part of the smell.
- Conflicts with the project rule "avoid over-engineering."

**Verdict.** Reject.

## Proposal C — Layout-only split + one giant composable

Three siblings (`ConversationSidebar`, `AgentConversationPane`, `ChatSessionPane`) sharing one giant `useAgentsViewState` composable that bundles every ref the original `<script setup>` declares.

**Pros.**

- Minimal churn.

**Cons.**

- `useAgentsViewState` recreates the monolith inside a composable: ~400-line file with four unrelated concerns. Trades a 1,492-line SFC for a 400-line composable + three thin shells.
- Round bucketing stays inside `AgentConversationPane`, which itself remains ~500 lines.
- Doesn't address the issue's explicit framing: "decompose by responsibility."

**Verdict.** Reject.

## Recommendation

**Proposal A.** It is the only proposal that:

1. Reaches the issue's target structural split (coordinator + four siblings, all under ~250 lines).
2. Makes the round-bucketing transformer testable in isolation (Proposal C leaves it inside a SFC; Proposal B leaves it in the same component).
3. Aligns with the three new project-wide principles in one pass.
4. Reuses G41's [web/src/api/types.ts](web/src/api/types.ts) module and extends it consistently with the precedent G41 set (hand-written mirror of `src/types.ts` Zod schemas, snake_case preserved, narrow literal unions).
5. Adds no new third-party dependency.

## Daemon impact

Web-only change. No `saivage.service` restart needed beyond the standard `vue-tsc --noEmit && vite build` validation step required by G41.
