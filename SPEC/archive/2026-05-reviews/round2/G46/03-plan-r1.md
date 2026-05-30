# G46 — Plan (r1, Design A)

Assumes G41 ([../G41/APPROVED.md](../G41/APPROVED.md)) has landed: [web/src/api/types.ts](web/src/api/types.ts) exists with `AgentRole`, `AgentState`, `RuntimeState`, `Plan`, `PlanStage`, `ApiState`; [web/package.json](web/package.json) has `vue-tsc` wired into `build` and `typecheck`.

## Implementation steps

### Step 1 — Extend `web/src/api/types.ts`

Open [web/src/api/types.ts](web/src/api/types.ts) and append the conversation + chat shapes from [02-design-r1.md](./02-design-r1.md) §"Shared types (extends G41)". Specifically add:

- `ConversationEntryKind` literal union.
- `ConversationEntry` interface.
- `ActivityStatus` interface.
- `AgentConversation` interface (uses G41's `AgentRole`).
- `ChatMessage`, `ChatLog`, `ChatSession` interfaces.

Anchor comments to the canonical server sources: `src/agents/base.ts L41-L75`, `src/types.ts L308-L329`, `src/server/server.ts L183-L196 / L289-L294`.

### Step 2 — Create the constants module

Create `web/src/components/agents/constants.ts` with the exports from [02-design-r1.md](./02-design-r1.md) §"Constants module" verbatim.

### Step 3 — Create the round-id parser

Create `web/src/components/agents/round-id.ts` with the body from [02-design-r1.md](./02-design-r1.md) §"Round-id parser (no regex)".

### Step 4 — Create UI-only types

Create `web/src/components/agents/types.ts`:

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

### Step 5 — Extract the timeline transformer

Create `web/src/components/agents/timeline.ts`. Port `roundsToTimeline` from [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue#L412-L530) with these changes:

1. Export as `entriesToTimeline(entries, pendingRoundId)`.
2. Replace `/^r(\d+)$/.exec(...)` in the pending-round inference loop ([L546-L548](web/src/components/AgentsView.vue#L546-L548)) with:
   ```ts
   const parsed = parseRoundId(e.roundId);
   if (parsed.kind === "round" && parsed.index > bestK) {
     bestK = parsed.index;
     pendingRoundId = e.roundId;
   }
   ```
3. Replace the inline 3-tuple regex `roundSortKey` ([L404-L411](web/src/components/AgentsView.vue#L404-L411)) with `roundIdSortKey(id)` from `round-id.ts`. Sort comparator becomes:
   ```ts
   items.sort((a, b) => {
     if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
     const [at, av] = roundIdSortKey(a.id);
     const [bt, bv] = roundIdSortKey(b.id);
     return at !== bt ? at - bt : av - bv;
   });
   ```
4. Delete the `messageIndex:blockIndex` fallback in the tool-pair bucketer ([L451-L452](web/src/components/AgentsView.vue#L451-L452), [L468-L469](web/src/components/AgentsView.vue#L468-L469)). Replace with:
   ```ts
   if (!entry.toolUseId) {
     console.warn(
       `[agents-view] tool entry without toolUseId; dropping. kind=${entry.kind} round=${entry.roundId}`,
     );
     continue;
   }
   const key = entry.toolUseId;
   ```
   (applies to both the `tool_call` branch and the `tool_result` / `tool_error` branch). Logs once per entry; if log volume becomes a problem this becomes an explicit issue, not a silent recovery.
5. Output `TimelineItem` using the discriminated-union form from step 4 — drop the `if (item.round)` / `item.round!` non-null assertions that the old optional-fields shape required.

### Step 6 — Add the timeline transformer test

Create `web/src/components/agents/timeline.test.ts` covering the cases enumerated in [02-design-r1.md](./02-design-r1.md) §"Timeline transformer". Mirror the test harness conventions of [web/src/composables/useAuthState.test.ts](web/src/composables/useAuthState.test.ts#L1) (`vitest` `describe`/`it`). Build small `ConversationEntry` fixture factories inline (no fixture file) since the shapes are flat literals.

Coverage targets (all assertions explicit):

| Test | Asserts |
|---|---|
| empty input | returns `[]` |
| one assistant `text` under `r1` | one `round` item, `hasAssistant: true` |
| matched `tool_call` + `tool_result` | `toolPairs[0].status === "ok"`, both entries present |
| `tool_call` only under latest `r${k}` with pending | `status === "pending"` |
| `tool_result` orphan | `status === "orphan"`, `call === undefined` |
| `tool_error` | `status === "error"` |
| tool entry missing `toolUseId` | dropped, no synthesized pair, `console.warn` called once |
| `model_issue` alone under a round | one `diagnostic` item, no `round` item |
| `r-pre` + `r-compacted-3` + `r2` mix | items sorted tier 0 → 2 → 3; compacted clusters present |
| same-timestamp `r1` and `r-pre` | `r-pre` sorts before `r1` (tier 0 < tier 2) |

### Step 7 — Create the composables

Create `web/src/composables/useAgentRoster.ts`:

```ts
import { onUnmounted, ref, type Ref } from "vue";
import type { AgentState, ChatSession } from "../api/types";
import { ApiError, apiFetch } from "../utils/api";
import {
  CLOCK_TICK_MS,
  ROSTER_POLL_INTERVAL_MS,
} from "../components/agents/constants";

export interface AgentRoster {
  activeAgents: Ref<AgentState[]>;
  chatSessions: Ref<ChatSession[]>;
  now: Ref<number>;
  refresh(): Promise<void>;
}

export function useAgentRoster(): AgentRoster {
  const activeAgents = ref<AgentState[]>([]);
  const chatSessions = ref<ChatSession[]>([]);
  const now = ref(Date.now());

  async function refresh() {
    try {
      const [stateRes, chatsRes] = await Promise.all([
        apiFetch("/api/state"),
        apiFetch("/api/chats"),
      ]);
      if (stateRes.ok) {
        const data = await stateRes.json();
        activeAgents.value = (data.state?.active_agents ?? [])
          .filter((agent: AgentState) => agent.agent_type !== "chat");
      }
      if (chatsRes.ok) {
        const data = await chatsRes.json();
        chatSessions.value = data.sessions ?? [];
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        activeAgents.value = [];
        chatSessions.value = [];
      }
    }
  }

  void refresh();
  const pollTimer = setInterval(refresh, ROSTER_POLL_INTERVAL_MS);
  const clockTimer = setInterval(() => { now.value = Date.now(); }, CLOCK_TICK_MS);
  onUnmounted(() => {
    clearInterval(pollTimer);
    clearInterval(clockTimer);
  });

  return { activeAgents, chatSessions, now, refresh };
}
```

Create `web/src/composables/useAgentConversation.ts` porting the body of `loadAgentConversation` ([L156-L228](web/src/components/AgentsView.vue#L156-L228)), `startAgentPolling` / `stopAgentPolling` ([L243-L256](web/src/components/AgentsView.vue#L243-L256)), `isScrolledToBottom` / `scrollToBottom` ([L258-L266](web/src/components/AgentsView.vue#L258-L266)), and `toggleDetails` / `detailsOpen` ([L269-L277](web/src/components/AgentsView.vue#L269-L277)) into one composable. Reuse `AGENT_CONVERSATION_POLL_INTERVAL_MS` and `SCROLL_BOTTOM_TOLERANCE_PX` from `constants.ts`. The returned shape matches [02-design-r1.md](./02-design-r1.md) §"Composables".

Create `web/src/composables/useChatSessions.ts` with a thin `loadSession(sessionId): Promise<ChatLog | null>` that wraps `apiFetch("/api/chats/" + id)` and returns parsed JSON or `null` on non-OK / ApiError. Session listing comes from `useAgentRoster.chatSessions` to avoid a duplicate poll.

### Step 8 — Create the leaf components

Create the six files under `web/src/components/agents/`:

1. `ToolCallRow.vue` — port the per-pair `<template v-for>` body at [L725-L803](web/src/components/AgentsView.vue#L725-L803). Props `pair: ToolPair`, `open: boolean`. Emits `(toggle, toolUseId)`, `(open-file, payload)`. Owns `formatPair` (the existing wrapper at [L351-L358](web/src/components/AgentsView.vue#L351-L358)) and `onPartClick` ([L360-L366](web/src/components/AgentsView.vue#L360-L366)). Uses `FORMATTED_CONTENT_MAX_HEIGHT_TOOL_DETAIL` from `constants.ts` for the expanded panels.

2. `AgentRoundCard.vue` — port the `<section v-if="item.kind === 'round'">` block at [L703-L820](web/src/components/AgentsView.vue#L703-L820). Props `round: Round`, `defaultModelSpec: string | null`, `expanded: ReadonlySet<string>`. Emits `(toggle-details, id)`, `(open-file, payload)`. Renders reasoning entries, tool list (delegates to `<ToolCallRow>`), diagnostics, context. Uses `FORMATTED_CONTENT_MAX_HEIGHT_REASONING` / `_DIAGNOSTIC` from `constants.ts`. Local helpers `diagnosticTone`, `diagnosticLabel` ([L320-L334](web/src/components/AgentsView.vue#L320-L334)) move here.

3. `AgentConversationPane.vue` — port the rest of the agent thread ([L673-L853](web/src/components/AgentsView.vue#L673-L853)): header, body wrapper with `ref="threadBody"`, the `timeline` `computed` (now calling `entriesToTimeline` from `timeline.ts`), the `defaultModelSpec` `computed` ([L561-L566](web/src/components/AgentsView.vue#L561-L566)), the standalone-diagnostic / standalone-context / compacted-cluster branches, and the footer pending-call indicator ([L824-L843](web/src/components/AgentsView.vue#L824-L843)). Local helpers `roleColor` ([L304-L315](web/src/components/AgentsView.vue#L304-L315)), `elapsed`, `durationSince`, `durationUntil` ([L283-L302](web/src/components/AgentsView.vue#L283-L302), [L367-L383](web/src/components/AgentsView.vue#L367-L383)) move here. Props/emits as in [02-design-r1.md](./02-design-r1.md). The `threadBody` ref is bound from the composable.

4. `ChatSessionPane.vue` — port the `<template v-if="selectedSession">` block at [L845-L867](web/src/components/AgentsView.vue#L845-L867). Props `session: ChatLog`, `now: number`. Local helpers `parseContent` ([L317-L325](web/src/components/AgentsView.vue#L317-L325)), `modelLabel` ([L340-L342](web/src/components/AgentsView.vue#L340-L342)), `formatHms` ([L336-L338](web/src/components/AgentsView.vue#L336-L338)) move here. Uses `FORMATTED_CONTENT_MAX_HEIGHT_CHAT_MSG`.

5. `ConversationSidebar.vue` — port the `<aside class="sidebar">` block at [L573-L639](web/src/components/AgentsView.vue#L573-L639). Props `{ activeAgents, chatSessions, selection, now }`. Emits `(select-agent, agentId)`, `(select-session, sessionId)`. Local helpers `elapsed`, `timeAgo`, `roleColor` are passed via the prop `now` plus tiny inline functions (`timeAgo` ([L294-L302](web/src/components/AgentsView.vue#L294-L302)) moves here). `filteredSessions` ([L568](web/src/components/AgentsView.vue#L568)) becomes a local `computed` over the prop.

6. `AgentsView.vue` (new coordinator) — composes the three composables, wires selection state, and lays out the grid:

   ```vue
   <script setup lang="ts">
   import { ref } from "vue";
   import type { AgentConversation, ChatLog } from "../../api/types";
   import type { SelectionKind } from "./types";
   import { useAgentRoster } from "../../composables/useAgentRoster";
   import { useAgentConversation } from "../../composables/useAgentConversation";
   import { useChatSessions } from "../../composables/useChatSessions";
   import ConversationSidebar from "./ConversationSidebar.vue";
   import AgentConversationPane from "./AgentConversationPane.vue";
   import ChatSessionPane from "./ChatSessionPane.vue";

   const emit = defineEmits<{
     (e: "open-file", payload: { path: string; root: "project" | "saivage" }): void;
   }>();

   const roster = useAgentRoster();
   const agentConv = useAgentConversation();
   const chats = useChatSessions();

   const selectionKind = ref<SelectionKind | null>(null);
   const selectedId = ref<string | null>(null);
   const selectedSession = ref<ChatLog | null>(null);

   async function onSelectAgent(agentId: string) {
     selectionKind.value = "agent";
     selectedId.value = agentId;
     selectedSession.value = null;
     await agentConv.load(agentId);
   }

   async function onSelectSession(sessionId: string) {
     selectionKind.value = "chat";
     selectedId.value = sessionId;
     agentConv.stop();
     selectedSession.value = await chats.loadSession(sessionId);
   }
   </script>

   <template>
     <section class="agents-view">
       <ConversationSidebar
         :active-agents="roster.activeAgents.value"
         :chat-sessions="roster.chatSessions.value"
         :selection="selectionKind && selectedId ? { kind: selectionKind, id: selectedId } : null"
         :now="roster.now.value"
         @select-agent="onSelectAgent"
         @select-session="onSelectSession"
       />
       <main class="thread-panel">
         <AgentConversationPane
           v-if="agentConv.conversation.value && selectionKind === 'agent'"
           :conversation="agentConv.conversation.value"
           :loading="agentConv.loading.value"
           :now="roster.now.value"
           :expanded="agentConv.expanded.value"
           @open-file="(p) => emit('open-file', p)"
           @toggle-details="agentConv.toggleDetails"
         />
         <ChatSessionPane
           v-else-if="selectedSession && selectionKind === 'chat'"
           :session="selectedSession"
           :now="roster.now.value"
         />
         <div v-else class="thread-empty">…</div>
       </main>
     </section>
   </template>

   <style scoped>
   /* layout grid only (~30 lines from the original .agents-view + .thread-panel + .thread-empty rules) */
   </style>
   ```

   Default-selection behaviour from [L149-L154](web/src/components/AgentsView.vue#L149-L154) (`maybeSelectDefaultConversation`) moves into a `watch(roster.activeAgents, …)` in the coordinator: when no selection exists and the roster gains a first entry, call `onSelectAgent(first.agent_id)`.

### Step 9 — Wire the coordinator into the app

Edit [web/src/App.vue](web/src/App.vue):

1. Change `import AgentsView from "./components/AgentsView.vue";` to `import AgentsView from "./components/agents/AgentsView.vue";`.
2. No prop/emit changes — the new coordinator preserves the existing `@open-file` emit surface.

### Step 10 — Delete the old monolith

```bash
rm web/src/components/AgentsView.vue
```

Architecture-first; no re-export shim, no alias path. Confirm no other imports remain:

```bash
grep -rn "components/AgentsView" web/src
```

Only [web/src/App.vue](web/src/App.vue) should appear, pointing at the new path.

### Step 11 — CSS split

Distribute the 625-line `<style scoped>` block across the new components by class prefix:

| Class prefix | Target file |
|---|---|
| `.agents-view`, `.thread-panel`, `.thread-empty` (layout) | `agents/AgentsView.vue` |
| `.sidebar*`, `.stab*`, `.sidebar-item*`, `.role-line*`, `.item-*` | `agents/ConversationSidebar.vue` |
| `.thread-header*`, `.agent-thread-*`, `.thread-body`, `.agent-thread-footer` | `agents/AgentConversationPane.vue` |
| `.agent-round*`, `.agent-diagnostic-row`, `.agent-context-*`, `.agent-compacted-*` | `agents/AgentRoundCard.vue` |
| `.agent-tool-*`, `.tool-link*`, `.tool-code`, `.chevron` | `agents/ToolCallRow.vue` |
| `.chat-msg`, `.entry-*`, `.text-entry`, `.model-chip` | `agents/ChatSessionPane.vue` |
| `.live-time`, `.live-pill*` | `agents/AgentConversationPane.vue` |

Use `wc -l` after each split to verify per-file line counts match the [02-design-r1.md](./02-design-r1.md) targets.

## Validation

Per [../G41/03-plan-r2.md](../G41/03-plan-r2.md) §"Validation", the web package now type-checks under `vue-tsc`. Run from `web/`:

```bash
cd web && npm run typecheck     # vue-tsc --noEmit -p tsconfig.json
cd web && npm run build         # vue-tsc + vite build
cd web && npm test              # vitest — exercises useAuthState + new timeline.test.ts
```

All three must pass with zero errors. The new `timeline.test.ts` must report 10/10 passing.

Manual smoke (already-running v3 harness or local dev server):

1. Open the Agents tab. Confirm the active-agents sidebar lists running agents within `ROSTER_POLL_INTERVAL_MS` (5 s).
2. Select an active agent. Confirm rounds, tool rows (collapsed and expanded), and the pending-call footer render identically to the pre-split version. Use the network panel to confirm `/api/agents/:id/conversation` polls at 3 s.
3. Switch to History, select a session. Confirm chat messages render identically.
4. Trigger an agent finish (let the agent reach a terminal state). Confirm the 404 path closes the live-pill and stops the per-agent poll (the timer count in DevTools should drop by one).
5. Use a tool that emits `open-file` (e.g., a `read_file` tool call inline link). Confirm the file opens in the Files pane — the emit bubbles through coordinator → App.vue unchanged.

## Rollback

If validation fails, `git checkout -- web/src/App.vue web/src/api/types.ts && git clean -fd web/src/components/agents web/src/composables/useAgentRoster.ts web/src/composables/useAgentConversation.ts web/src/composables/useChatSessions.ts` restores the pre-change state. The deleted `web/src/components/AgentsView.vue` is recovered via `git checkout HEAD -- web/src/components/AgentsView.vue`.

## Files touched

New:

- `web/src/components/agents/AgentsView.vue`
- `web/src/components/agents/ConversationSidebar.vue`
- `web/src/components/agents/AgentConversationPane.vue`
- `web/src/components/agents/AgentRoundCard.vue`
- `web/src/components/agents/ToolCallRow.vue`
- `web/src/components/agents/ChatSessionPane.vue`
- `web/src/components/agents/types.ts`
- `web/src/components/agents/constants.ts`
- `web/src/components/agents/round-id.ts`
- `web/src/components/agents/timeline.ts`
- `web/src/components/agents/timeline.test.ts`
- `web/src/composables/useAgentRoster.ts`
- `web/src/composables/useAgentConversation.ts`
- `web/src/composables/useChatSessions.ts`

Edited:

- [web/src/api/types.ts](web/src/api/types.ts) — append conversation + chat types.
- [web/src/App.vue](web/src/App.vue) — single import-path change.

Deleted:

- [web/src/components/AgentsView.vue](web/src/components/AgentsView.vue) (1,492 lines).
