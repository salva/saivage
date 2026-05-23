<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { Bot, Clock3, MessageSquare } from "lucide-vue-next";
import FormattedContent from "./FormattedContent.vue";
import { ApiError, apiFetch } from "../utils/api";
import { formatToolPair, type FormattedToolPair, type InlinePart } from "../utils/toolFormatters";

const emit = defineEmits<{
  (e: "open-file", payload: { path: string; root: "project" | "saivage" }): void;
}>();

interface AgentState {
  agent_type: string;
  agent_id: string;
  status: string;
  current_task_id?: string;
  started_at: string;
}

interface ChatSession {
  session_id: string;
  channel: string;
  started_at: string;
  updated_at: string;
  message_count: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
  event?: { type: string; stage_id?: string; summary?: string };
}

interface ChatLog {
  session_id: string;
  channel: string;
  started_at: string;
  updated_at: string;
  messages: ChatMessage[];
}

interface ConversationEntry {
  role: "user" | "assistant" | "system";
  kind:
    | "text"
    | "activity"
    | "model_issue"
    | "model_repair"
    | "model_recovered"
    | "tool_call"
    | "tool_result"
    | "tool_error";
  content: string;
  timestamp: string;
  roundId: string;
  messageIndex: number;
  blockIndex: number;
  toolUseId?: string;
  toolName?: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

interface ActivityStatus {
  pending_call: {
    started_at: string;
    status: "in_flight" | "backoff";
    attempt: number;
    reason: string | null;
    retry_at: string | null;
  } | null;
  last_activity_at: string;
}

interface AgentConversation {
  agent_id: string;
  role: string;
  started_at?: string;
  message_count: number;
  entries: ConversationEntry[];
  activity_status: ActivityStatus | null;
  finished_at?: string;
}

interface Round {
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

interface ToolPair {
  toolUseId: string;
  toolName: string;
  call?: ConversationEntry;
  result?: ConversationEntry;
  status: "pending" | "ok" | "error" | "orphan" | "missing";
}

interface TimelineItem {
  kind: "round" | "diagnostic" | "context" | "compacted";
  id: string;
  timestamp: string;
  round?: Round;
  diagnostic?: ConversationEntry;
  context?: Round;
  compacted?: ConversationEntry[];
}

type SelectionKind = "agent" | "chat";

const activeAgents = ref<AgentState[]>([]);
const chatSessions = ref<ChatSession[]>([]);
const selectedSession = ref<ChatLog | null>(null);
const selectedAgent = ref<AgentConversation | null>(null);
const selectedId = ref<string | null>(null);
const selectionKind = ref<SelectionKind | null>(null);
const loading = ref(false);
const activeTab = ref<"active" | "history">("active");
const now = ref(Date.now());
const threadBody = ref<HTMLElement | null>(null);
const expandedDetails = ref<Set<string>>(new Set());
let pollTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let agentPollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchData() {
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
    maybeSelectDefaultConversation();
  } catch { /* ignore */ }
}

function maybeSelectDefaultConversation() {
  if (selectionKind.value || loading.value) return;
  const firstActiveAgent = activeAgents.value[0];
  if (firstActiveAgent) {
    void loadAgentConversation(firstActiveAgent.agent_id);
  }
}

async function loadAgentConversation(agentId: string) {
  if (selectionKind.value === "agent" && selectedId.value === agentId && selectedAgent.value) {
    try {
      const res = await apiFetch(`/api/agents/${agentId}/conversation`);
      if (res.ok) {
        const data = await res.json() as AgentConversation;
        const wasAtBottom = isScrolledToBottom();
        selectedAgent.value = data;
        if (wasAtBottom) {
          await nextTick();
          scrollToBottom();
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        if (selectedAgent.value && selectedId.value === agentId) {
          const last = selectedAgent.value.entries.at(-1)?.timestamp
            ?? new Date().toISOString();
          selectedAgent.value = {
            ...selectedAgent.value,
            finished_at: selectedAgent.value.finished_at ?? last,
            activity_status: null,
          };
        }
        stopAgentPolling();
      }
    }
    return;
  }

  selectedId.value = agentId;
  selectionKind.value = "agent";
  selectedSession.value = null;
  loading.value = true;
  expandedDetails.value = new Set();
  try {
    const res = await apiFetch(`/api/agents/${agentId}/conversation`);
    if (res.ok) {
      selectedAgent.value = await res.json() as AgentConversation;
      await nextTick();
      scrollToBottom();
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      if (selectedAgent.value && selectedId.value === agentId) {
        const last = selectedAgent.value.entries.at(-1)?.timestamp
          ?? new Date().toISOString();
        selectedAgent.value = {
          ...selectedAgent.value,
          finished_at: selectedAgent.value.finished_at ?? last,
          activity_status: null,
        };
      }
      stopAgentPolling();
    }
  }
  loading.value = false;
  startAgentPolling(agentId);
}

async function loadSession(sessionId: string) {
  if (selectionKind.value === "chat" && selectedId.value === sessionId) return;
  selectedId.value = sessionId;
  selectionKind.value = "chat";
  selectedAgent.value = null;
  loading.value = true;
  expandedDetails.value = new Set();
  stopAgentPolling();
  try {
    const res = await apiFetch(`/api/chats/${sessionId}`);
    if (res.ok) selectedSession.value = await res.json();
  } catch { /* ignore */ }
  loading.value = false;
}

function startAgentPolling(agentId: string) {
  stopAgentPolling();
  agentPollTimer = setInterval(() => {
    if (selectionKind.value === "agent" && selectedId.value === agentId) loadAgentConversation(agentId);
    else stopAgentPolling();
  }, 3000);
}

function stopAgentPolling() {
  if (agentPollTimer) {
    clearInterval(agentPollTimer);
    agentPollTimer = null;
  }
}

function isScrolledToBottom(): boolean {
  if (!threadBody.value) return true;
  const el = threadBody.value;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollToBottom() {
  if (threadBody.value) threadBody.value.scrollTop = threadBody.value.scrollHeight;
}

function toggleDetails(id: string) {
  const next = new Set(expandedDetails.value);
  if (next.has(id)) next.delete(id); else next.add(id);
  expandedDetails.value = next;
}

function detailsOpen(id: string): boolean {
  return expandedDetails.value.has(id);
}

onMounted(() => {
  fetchData();
  pollTimer = setInterval(fetchData, 5000);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (clockTimer) clearInterval(clockTimer);
  stopAgentPolling();
});

function elapsed(startedAt: string): string {
  const ms = now.value - new Date(startedAt).getTime();
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function timeAgo(ts: string): string {
  const ms = now.value - new Date(ts).getTime();
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function roleColor(role: string): string {
  switch (role) {
    case "planner": return "var(--purple)";
    case "manager": return "var(--accent)";
    case "coder": return "var(--accent-2)";
    case "researcher": return "var(--warn)";
    case "data_agent": return "var(--teal)";
    case "reviewer": return "var(--purple)";
    case "inspector": return "var(--orange)";
    default: return "var(--text)";
  }
}

function parseContent(content: string): string {
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed.content === "string") return parsed.content;
    } catch { /* not JSON */ }
  }
  return content;
}

function formatHms(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function modelLabel(source: { provider?: string; model?: string; modelSpec?: string }): string {
  return source.modelSpec ?? (source.provider && source.model ? `${source.provider}/${source.model}` : "");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + "...";
}

function diagnosticTone(kind: ConversationEntry["kind"]): "ok" | "warn" | "danger" | "neutral" {
  if (kind === "model_recovered") return "ok";
  if (kind === "model_repair") return "warn";
  if (kind === "model_issue") return "danger";
  return "neutral";
}

function diagnosticLabel(kind: ConversationEntry["kind"]): string {
  switch (kind) {
    case "model_issue": return "Model Issue";
    case "model_repair": return "Model Repair";
    case "model_recovered": return "Model Recovered";
    default: return kind;
  }
}

function summarizeCallInput(entry: ConversationEntry): string {
  const first = entry.content.split("\n")[0] ?? "";
  return truncate(first, 120);
}

function summarizeResult(entry: ConversationEntry): string {
  const first = entry.content.split("\n")[0] ?? "";
  return truncate(first, 120);
}

function formatPair(pair: ToolPair): FormattedToolPair {
  return formatToolPair(
    pair.toolName,
    pair.call?.content,
    pair.result?.content,
    pair.status === "error",
  );
}

function onPartClick(part: InlinePart) {
  if (part.kind === "file") {
    emit("open-file", { path: part.path, root: part.root ?? "project" });
  } else if (part.kind === "url") {
    window.open(part.url, "_blank", "noopener,noreferrer");
  }
}

function durationSince(ts: string): string {
  const ms = Math.max(0, now.value - new Date(ts).getTime());
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function durationUntil(ts: string): string {
  const ms = Math.max(0, new Date(ts).getTime() - now.value);
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

function roundSortKey(id: string): [number, number, string] {
  // tier 0: r-pre. tier 1: r-msg:N. tier 2: r${k}. tier 3: r-compacted-${n}.
  if (id === "r-pre") return [0, 0, id];
  const msg = /^r-msg:(\d+)$/.exec(id);
  if (msg) return [1, Number(msg[1]), id];
  const compacted = /^r-compacted-(\d+)$/.exec(id);
  if (compacted) return [3, Number(compacted[1]), id];
  const round = /^r(\d+)$/.exec(id);
  if (round) return [2, Number(round[1]), id];
  return [4, 0, id];
}

function roundsToTimeline(
  entries: ConversationEntry[],
  pendingRoundId: string | null,
): TimelineItem[] {
  const buckets = new Map<string, ConversationEntry[]>();
  for (const entry of entries) {
    const list = buckets.get(entry.roundId);
    if (list) list.push(entry);
    else buckets.set(entry.roundId, [entry]);
  }

  const items: TimelineItem[] = [];
  for (const [id, bucket] of buckets) {
    const earliest = bucket.reduce(
      (acc, e) => (acc === "" || e.timestamp < acc ? e.timestamp : acc),
      "",
    );
    if (id === "r-pre" || id.startsWith("r-compacted-")) {
      items.push({ kind: "compacted", id, timestamp: earliest, compacted: bucket });
      continue;
    }

    const reasoning: ConversationEntry[] = [];
    const userText: ConversationEntry[] = [];
    const diagnostics: ConversationEntry[] = [];
    const callMap = new Map<string, ToolPair>();
    const orphanPairs: ToolPair[] = [];

    for (const entry of bucket) {
      if (
        entry.kind === "model_issue"
        || entry.kind === "model_repair"
        || entry.kind === "model_recovered"
      ) {
        diagnostics.push(entry);
      } else if (entry.kind === "tool_call") {
        const key = entry.toolUseId ?? `${entry.messageIndex}:${entry.blockIndex}`;
        const existing = callMap.get(key);
        if (existing) {
          existing.call = entry;
          existing.toolName = entry.toolName ?? existing.toolName;
        } else {
          callMap.set(key, {
            toolUseId: key,
            toolName: entry.toolName ?? "unknown",
            call: entry,
            status: "missing",
          });
        }
      } else if (entry.kind === "tool_result" || entry.kind === "tool_error") {
        const key = entry.toolUseId ?? `${entry.messageIndex}:${entry.blockIndex}`;
        const existing = callMap.get(key);
        const status: ToolPair["status"] = entry.kind === "tool_error" ? "error" : "ok";
        if (existing) {
          existing.result = entry;
          existing.toolName = existing.toolName ?? entry.toolName ?? "unknown";
          existing.status = status;
        } else {
          orphanPairs.push({
            toolUseId: key,
            toolName: entry.toolName ?? "unknown",
            result: entry,
            status: "orphan",
          });
        }
      } else if (entry.kind === "activity" || (entry.kind === "text" && entry.role === "assistant")) {
        reasoning.push(entry);
      } else if (entry.role === "user" && entry.kind === "text") {
        userText.push(entry);
      } else if (entry.role === "system" && entry.kind === "text") {
        userText.push(entry);
      }
    }

    const toolPairs: ToolPair[] = [...callMap.values(), ...orphanPairs];
    const isCurrentRound = pendingRoundId !== null && pendingRoundId === id;
    for (const pair of toolPairs) {
      if (!pair.result && pair.call && isCurrentRound) pair.status = "pending";
    }

    const modelEntry = reasoning.find((e) => e.modelSpec) ?? bucket.find((e) => e.modelSpec);
    const round: Round = {
      id,
      startedAt: earliest,
      hasAssistant: reasoning.length > 0,
      reasoning,
      toolPairs,
      context: userText,
      diagnostics,
      modelSpec: modelEntry?.modelSpec,
      requestedModelSpec: modelEntry?.requestedModelSpec,
    };

    if (reasoning.length > 0) {
      items.push({ kind: "round", id, timestamp: earliest, round });
    } else if (diagnostics.length > 0 && userText.length === 0 && toolPairs.length === 0) {
      for (const d of diagnostics) {
        items.push({
          kind: "diagnostic",
          id: `${d.timestamp}:${d.kind}:${id}`,
          timestamp: d.timestamp,
          diagnostic: d,
        });
      }
    } else {
      items.push({ kind: "context", id, timestamp: earliest, context: round });
    }
  }

  items.sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp.localeCompare(b.timestamp);
    const [at, av] = roundSortKey(a.id);
    const [bt, bv] = roundSortKey(b.id);
    if (at !== bt) return at - bt;
    return av - bv;
  });

  return items;
}

const timeline = computed<TimelineItem[]>(() => {
  const entries = selectedAgent.value?.entries ?? [];
  const pending = selectedAgent.value?.activity_status?.pending_call ?? null;
  // The pending round id is not exposed by the server; we infer it as the
  // most-recent r${k} round that has no tool result for at least one call,
  // OR the latest r${k} when no assistant entry exists yet for that round.
  let pendingRoundId: string | null = null;
  if (pending) {
    let bestK = -1;
    for (const e of entries) {
      const m = /^r(\d+)$/.exec(e.roundId);
      if (m) {
        const k = Number(m[1]);
        if (k > bestK) { bestK = k; pendingRoundId = e.roundId; }
      }
    }
  }
  return roundsToTimeline(entries, pendingRoundId);
});

// Ambient model for the whole thread: the modelSpec of the first round that
// has one. Per-round headers only render "via X" when a round's spec differs
// from this ambient value, so we don't repeat the model on every turn.
const defaultModelSpec = computed<string | null>(() => {
  for (const item of timeline.value) {
    if (item.kind === "round" && item.round?.modelSpec) return item.round.modelSpec;
  }
  return null;
});

const filteredSessions = computed(() => chatSessions.value.filter(session => session.message_count > 0));
</script>

<template>
  <section class="agents-view">
    <aside class="sidebar">
      <div class="sidebar-tabs">
        <button class="stab" :class="{ active: activeTab === 'active' }" @click="activeTab = 'active'">
          <Bot :size="15" />
          <span>Active</span>
          <strong>{{ activeAgents.length }}</strong>
        </button>
        <button class="stab" :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
          <MessageSquare :size="15" />
          <span>History</span>
          <strong>{{ filteredSessions.length }}</strong>
        </button>
      </div>

      <div class="sidebar-content">
        <template v-if="activeTab === 'active'">
          <div v-if="activeAgents.length === 0" class="sidebar-empty">No active agents</div>
          <button
            v-for="agent in activeAgents"
            :key="agent.agent_id"
            class="sidebar-item"
            :class="{ selected: selectionKind === 'agent' && selectedId === agent.agent_id }"
            @click="loadAgentConversation(agent.agent_id)"
          >
            <span class="role-line">
              <strong :style="{ color: roleColor(agent.agent_type) }">{{ agent.agent_type }}</strong>
              <em>{{ elapsed(agent.started_at) }}</em>
            </span>
            <span class="item-id">{{ agent.agent_id }}</span>
            <span v-if="agent.current_task_id" class="item-task">{{ agent.current_task_id }}</span>
          </button>
        </template>

        <template v-else>
          <div v-if="filteredSessions.length === 0" class="sidebar-empty">No chat sessions</div>
          <button
            v-for="session in filteredSessions"
            :key="session.session_id"
            class="sidebar-item"
            :class="{ selected: selectionKind === 'chat' && selectedId === session.session_id }"
            @click="loadSession(session.session_id)"
          >
            <span class="role-line">
              <strong>{{ session.session_id.slice(0, 16) }}</strong>
              <em>{{ timeAgo(session.updated_at) }}</em>
            </span>
            <span class="item-id">{{ session.message_count }} messages · {{ session.channel }}</span>
          </button>
        </template>
      </div>
    </aside>

    <main class="thread-panel">
      <div v-if="!selectedAgent && !selectedSession && !loading" class="thread-empty">
        <Bot :size="42" />
        <strong>Select a conversation</strong>
        <span>Watch active agents, reasoning traces, model repairs, and chat sessions.</span>
      </div>

      <div v-if="loading" class="thread-empty">
        <Clock3 :size="34" />
        <strong>Loading conversation...</strong>
      </div>

      <template v-if="selectedAgent && selectionKind === 'agent' && !loading">
        <div class="thread-header agent-thread-header">
          <strong class="agent-thread-role" :style="{ color: roleColor(selectedAgent.role) }">{{ selectedAgent.role }}</strong>
          <code class="agent-thread-id">{{ selectedAgent.agent_id }}</code>
          <em v-if="defaultModelSpec" class="agent-thread-model" :title="defaultModelSpec">{{ defaultModelSpec }}</em>
          <span v-if="selectedAgent.started_at" class="live-time">{{ elapsed(selectedAgent.started_at) }}</span>
          <span v-if="selectedAgent.finished_at" class="live-pill finished"><span></span>finished</span>
          <span v-else class="live-pill"><span></span>live</span>
        </div>

        <div class="thread-body agent-thread-body" ref="threadBody">
          <template v-for="item in timeline" :key="item.id">
            <!-- ROUND -->
            <section
              v-if="item.kind === 'round' && item.round"
              class="agent-round"
              :data-round-id="item.round.id"
            >
              <div
                v-if="item.round.modelSpec && item.round.modelSpec !== defaultModelSpec"
                class="agent-round-via"
                :title="item.round.requestedModelSpec ? `requested: ${item.round.requestedModelSpec}` : item.round.modelSpec"
              >via {{ item.round.modelSpec }}</div>

              <div
                v-for="entry in item.round.reasoning"
                :key="`${item.round.id}-reasoning-${entry.messageIndex}-${entry.blockIndex}`"
                class="agent-round-reasoning"
                :class="{ 'agent-activity-lead': entry.kind === 'activity' }"
              >
                <FormattedContent :content="entry.content" max-height="460px" />
              </div>

              <div
                v-if="item.round.toolPairs.length > 0"
                class="agent-tool-list"
              >
                <template v-for="pair in item.round.toolPairs" :key="`${item.round.id}-tool-${pair.toolUseId}`">
                  <button
                    class="agent-tool-row"
                    :data-status="pair.status"
                    :data-open="detailsOpen(pair.toolUseId) ? 'true' : 'false'"
                    :aria-expanded="detailsOpen(pair.toolUseId)"
                    :aria-label="`tool ${pair.toolName} ${pair.status}`"
                    :title="pair.call?.timestamp ? new Date(pair.call.timestamp).toLocaleString() : undefined"
                    @click="toggleDetails(pair.toolUseId)"
                  >
                    <span class="chevron" aria-hidden="true">›</span>
                    <strong>{{ formatPair(pair).label }}</strong>
                    <span class="agent-tool-summary">
                      <template v-for="(part, idx) in formatPair(pair).summary" :key="`s${idx}`">
                        <a
                          v-if="part.kind === 'file'"
                          class="tool-link tool-file"
                          :href="`#files:${part.root ?? 'project'}:${part.path}`"
                          @click.stop.prevent="onPartClick(part)"
                        >{{ part.path }}</a>
                        <a
                          v-else-if="part.kind === 'url'"
                          class="tool-link tool-url"
                          :href="part.url"
                          target="_blank"
                          rel="noopener noreferrer"
                          @click.stop
                        >{{ part.url }}</a>
                        <code v-else-if="part.kind === 'code'" class="tool-code">{{ part.value }}</code>
                        <span v-else :data-tone="part.tone || undefined">{{ part.value }}</span>
                      </template>
                    </span>
                    <span class="agent-tool-result" :data-tone="formatPair(pair).resultTone || undefined">
                      <template v-if="pair.status === 'pending'">…</template>
                      <template v-else-if="pair.status === 'missing'">no result</template>
                      <template v-else>
                        <template v-for="(part, idx) in formatPair(pair).result" :key="`r${idx}`">
                          <a
                            v-if="part.kind === 'file'"
                            class="tool-link tool-file"
                            :href="`#files:${part.root ?? 'project'}:${part.path}`"
                            @click.stop.prevent="onPartClick(part)"
                          >{{ part.path }}</a>
                          <a
                            v-else-if="part.kind === 'url'"
                            class="tool-link tool-url"
                            :href="part.url"
                            target="_blank"
                            rel="noopener noreferrer"
                            @click.stop
                          >{{ part.url }}</a>
                          <code v-else-if="part.kind === 'code'" class="tool-code">{{ part.value }}</code>
                          <span v-else :data-tone="part.tone || undefined">{{ part.value }}</span>
                        </template>
                      </template>
                    </span>
                  </button>
                  <div v-if="detailsOpen(pair.toolUseId)" class="agent-tool-detail">
                    <div v-if="pair.call" class="agent-tool-detail-block">
                      <span class="agent-tool-detail-label">input</span>
                      <FormattedContent :content="pair.call.content" max-height="320px" />
                    </div>
                    <div v-if="pair.result" class="agent-tool-detail-block" :class="{ error: pair.status === 'error' }">
                      <span class="agent-tool-detail-label">{{ pair.status === 'error' ? 'error' : 'result' }}</span>
                      <FormattedContent :content="pair.result.content" max-height="320px" />
                    </div>
                  </div>
                </template>
              </div>

              <div
                v-for="d in item.round.diagnostics"
                :key="`${item.round.id}-diag-${d.timestamp}-${d.blockIndex}`"
                class="agent-diagnostic-row"
                :data-tone="diagnosticTone(d.kind)"
                :title="new Date(d.timestamp).toLocaleString()"
              >
                <span class="agent-diagnostic-label">{{ diagnosticLabel(d.kind) }}</span>
                <FormattedContent :content="d.content" max-height="200px" />
              </div>

              <div
                v-for="c in item.round.context"
                :key="`${item.round.id}-ctx-${c.messageIndex}-${c.blockIndex}`"
                class="agent-context-block"
              >
                <FormattedContent :content="c.content" max-height="320px" />
              </div>
            </section>

            <!-- STANDALONE DIAGNOSTIC -->
            <div
              v-else-if="item.kind === 'diagnostic' && item.diagnostic"
              class="agent-diagnostic-row standalone"
              :data-tone="diagnosticTone(item.diagnostic.kind)"
              :title="new Date(item.diagnostic.timestamp).toLocaleString()"
            >
              <span class="agent-diagnostic-label">{{ diagnosticLabel(item.diagnostic.kind) }}</span>
              <FormattedContent :content="item.diagnostic.content" max-height="200px" />
            </div>

            <!-- STANDALONE CONTEXT (user-role text outside a round) -->
            <section
              v-else-if="item.kind === 'context' && item.context"
              class="agent-context-standalone"
              :data-round-id="item.context.id"
            >
              <div
                v-for="c in item.context.context"
                :key="`${item.context.id}-ctx-${c.messageIndex}-${c.blockIndex}`"
                class="agent-context-block"
                :title="new Date(c.timestamp).toLocaleString()"
              >
                <FormattedContent :content="c.content" max-height="320px" />
              </div>
            </section>

            <!-- COMPACTED CLUSTER -->
            <section
              v-else-if="item.kind === 'compacted' && item.compacted"
              class="agent-compacted-cluster"
            >
              <button
                class="agent-compacted-summary"
                :aria-expanded="detailsOpen(item.id)"
                @click="toggleDetails(item.id)"
              >
                <span class="chevron" aria-hidden="true">›</span>
                <span>— compacted, {{ item.compacted.length }} diagnostic{{ item.compacted.length === 1 ? '' : 's' }} re-keyed —</span>
              </button>
              <div v-if="detailsOpen(item.id)" class="agent-compacted-body">
                <div
                  v-for="(c, idx) in item.compacted"
                  :key="`${item.id}-${idx}`"
                  class="agent-diagnostic-row"
                  :data-tone="diagnosticTone(c.kind)"
                  :title="new Date(c.timestamp).toLocaleString()"
                >
                  <span class="agent-diagnostic-label">{{ diagnosticLabel(c.kind) }}</span>
                  <FormattedContent :content="c.content" max-height="200px" />
                </div>
              </div>
            </section>
          </template>

          <footer
            v-if="selectedAgent.activity_status?.pending_call"
            class="agent-thread-footer"
            :data-state="selectedAgent.activity_status.pending_call.status"
            role="status"
            aria-live="polite"
          >
            <span class="dot" aria-hidden="true" />
            <template v-if="selectedAgent.activity_status.pending_call.status === 'in_flight'">
              <span>Waiting for model… {{ durationSince(selectedAgent.activity_status.pending_call.started_at) }}<template v-if="selectedAgent.activity_status.pending_call.attempt > 1"> (attempt {{ selectedAgent.activity_status.pending_call.attempt }})</template></span>
            </template>
            <template v-else>
              <span>
                <template v-if="selectedAgent.activity_status.pending_call.reason === 'throttled'">Throttled by provider</template>
                <template v-else>Transient model error</template>
                <template v-if="selectedAgent.activity_status.pending_call.retry_at"> — retrying in {{ durationUntil(selectedAgent.activity_status.pending_call.retry_at) }}</template>
              </span>
              <span class="detail">attempt {{ selectedAgent.activity_status.pending_call.attempt }}</span>
            </template>
          </footer>
        </div>
      </template>

      <template v-if="selectedSession && selectionKind === 'chat' && !loading">
        <div class="thread-header">
          <code>{{ selectedSession.session_id }}</code>
          <span>{{ selectedSession.channel }}</span>
          <span>{{ selectedSession.messages.length }} messages</span>
          <span class="live-time">{{ new Date(selectedSession.started_at).toLocaleString() }}</span>
        </div>

        <div class="thread-body">
          <article v-for="msg in selectedSession.messages" :key="msg.id" class="chat-msg" :class="msg.role">
            <div class="entry-label">
              <span>{{ msg.role }}</span>
              <em v-if="msg.role === 'assistant' && modelLabel(msg)" class="model-chip">{{ modelLabel(msg) }}</em>
              <time>{{ formatHms(msg.timestamp) }}</time>
              <em v-if="msg.event">{{ msg.event.type }}</em>
            </div>
            <div class="entry-content text-entry">
              <FormattedContent :content="parseContent(msg.content)" max-height="380px" />
            </div>
          </article>
        </div>
      </template>
    </main>
  </section>
</template>

<style scoped>
.agents-view {
  display: grid;
  grid-template-columns: 330px minmax(0, 1fr);
  height: 100%;
  min-width: 0;
  overflow: hidden;
  background: var(--bg);
}

.sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-1);
}

.sidebar-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  padding: 10px;
  border-bottom: 1px solid var(--border);
}

.stab {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}

.stab:hover,
.stab.active {
  color: var(--text);
  background: var(--surface-2);
}

.stab.active {
  border-color: var(--accent);
}

.stab span {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
}

.stab strong {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}

.sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.sidebar-empty,
.thread-empty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: var(--text-faint);
  text-align: center;
}

.sidebar-empty {
  min-height: 140px;
  font-size: 13px;
}

.sidebar-item {
  display: grid;
  gap: 4px;
  width: 100%;
  margin-bottom: 7px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text);
  background: var(--bg);
  cursor: pointer;
  text-align: left;
}

.sidebar-item:hover,
.sidebar-item.selected {
  border-color: var(--border-strong);
  background: var(--surface-2);
}

.sidebar-item.selected {
  border-color: var(--accent);
}

.role-line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.role-line strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.role-line em,
.item-id,
.item-task {
  font-family: var(--mono);
  font-size: 11px;
  font-style: normal;
}

.role-line em {
  color: var(--warn);
}

.item-id {
  color: var(--text-faint);
}

.item-task {
  overflow: hidden;
  color: var(--accent);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.thread-empty {
  height: 100%;
}

.thread-empty strong {
  color: var(--text);
}

.thread-empty span {
  max-width: 360px;
  color: var(--text-muted);
  font-size: 13px;
}

.thread-header {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
  color: var(--text-muted);
  font-size: 12px;
}

.thread-header code,
.role-badge {
  font-family: var(--mono);
}

.thread-header code {
  color: var(--text);
}

.role-badge {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 11px;
  font-weight: 750;
  text-transform: uppercase;
}

.live-time {
  margin-left: auto;
  color: var(--warn);
  font-family: var(--mono);
}

.live-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--accent-2);
  font-size: 11px;
}

.live-pill span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent-2);
}

.live-pill.finished {
  color: var(--text-muted);
}

.live-pill.finished span {
  background: var(--text-muted);
}

.thread-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.chat-msg {
  margin-bottom: 10px;
}

.entry-label {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  text-transform: uppercase;
}

.entry-label time,
.entry-label em {
  color: var(--text-faint);
  font-family: var(--mono);
  font-style: normal;
  font-weight: 400;
  text-transform: none;
}

.entry-label .model-chip,
.agent-round-model {
  overflow: hidden;
  max-width: min(360px, 50vw);
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 10px;
  font-style: normal;
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
  text-transform: none;
  white-space: nowrap;
}

.chat-msg.assistant .entry-label { color: var(--accent-2); }
.chat-msg.user .entry-label { color: var(--accent); }
.chat-msg.system .entry-label { color: var(--warn); }

.entry-content {
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-1);
  color: var(--text);
  font-size: 13px;
  line-height: 1.55;
}

.text-entry {
  padding: 9px 11px;
}

.chat-msg.user .text-entry {
  border-color: var(--entry-user-border);
  background: var(--entry-user-bg);
}

/* === Agent round timeline (compact, borderless) === */
.agent-thread-header {
  display: flex;
  align-items: baseline;
  gap: 10px;
  min-height: 40px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  font-size: 12px;
}

.agent-thread-role {
  font-size: 13px;
  font-weight: 700;
  text-transform: lowercase;
  letter-spacing: 0;
}

.agent-thread-id {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}

.agent-thread-model {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
  font-style: normal;
  overflow: hidden;
  max-width: min(360px, 40vw);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-thread-body {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px 16px 20px;
}

.agent-round {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.agent-round-via {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}

.agent-round-reasoning {
  color: var(--text);
  font-size: 13px;
  line-height: 1.55;
}

.agent-activity-lead {
  color: var(--text-muted);
  font-style: italic;
}

.agent-tool-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 2px;
}

.agent-tool-row {
  display: grid;
  grid-template-columns: 14px auto minmax(0, 1fr) minmax(0, 1.4fr);
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 24px;
  padding: 2px 6px;
  border: 0;
  border-radius: 5px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-family: var(--mono);
  font-size: 12px;
}

.agent-tool-row:hover {
  background: var(--surface-2);
}

.agent-tool-row strong {
  color: var(--accent);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-tool-row .chevron {
  display: inline-block;
  transition: transform 0.12s ease;
  color: var(--text-faint);
}

.agent-tool-row[data-open="true"] .chevron {
  transform: rotate(90deg);
}

.agent-tool-row .agent-tool-summary,
.agent-tool-row .agent-tool-result {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-faint);
}

.agent-tool-row .agent-tool-summary {
  color: var(--text-muted);
}

.agent-tool-row [data-tone="ok"] { color: var(--accent-2); }
.agent-tool-row [data-tone="warn"] { color: var(--warn); }
.agent-tool-row [data-tone="error"] { color: var(--danger); }
.agent-tool-row [data-tone="muted"] { color: var(--text-faint); }

.agent-tool-row .tool-link {
  color: var(--accent);
  text-decoration: none;
  border-bottom: 1px dotted transparent;
}

.agent-tool-row:hover .tool-link {
  border-bottom-color: currentColor;
}

.agent-tool-row .tool-link:hover {
  color: var(--accent-2);
}

.agent-tool-row .tool-code {
  color: var(--text);
  background: transparent;
  padding: 0;
  font-family: var(--mono);
  font-size: inherit;
}

.agent-tool-row[data-status="ok"] strong { color: var(--accent-2); }
.agent-tool-row[data-status="pending"] strong { color: var(--accent); }
.agent-tool-row[data-status="pending"] .agent-tool-result {
  color: var(--accent);
  font-style: italic;
}
.agent-tool-row[data-status="error"] strong { color: var(--danger); }
.agent-tool-row[data-status="error"] .agent-tool-result { color: var(--danger); }
.agent-tool-row[data-status="orphan"] strong,
.agent-tool-row[data-status="missing"] strong { color: var(--warn); }

.agent-tool-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 2px 0 4px 22px;
  padding: 4px 0 4px 10px;
  border-left: 2px solid var(--border-subtle, var(--border));
}

.agent-tool-detail-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text);
}

.agent-tool-detail-block.error {
  color: var(--danger);
}

.agent-tool-detail-label {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.agent-diagnostic-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 0;
  border: 0;
  background: transparent;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--text-muted);
}

.agent-diagnostic-row .agent-diagnostic-label {
  font-weight: 600;
  font-size: 11px;
  letter-spacing: 0.04em;
}

.agent-diagnostic-row[data-tone="ok"] { color: var(--accent-2); }
.agent-diagnostic-row[data-tone="warn"] { color: var(--warn); }
.agent-diagnostic-row[data-tone="danger"] { color: var(--danger); }

.agent-context-standalone {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.agent-context-block {
  padding: 0 0 0 10px;
  border-left: 2px solid var(--border-subtle, var(--border));
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.55;
}

.agent-compacted-cluster {
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}

.agent-compacted-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 0;
  padding: 0;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.agent-compacted-summary .chevron {
  transition: transform 0.12s ease;
}

.agent-compacted-summary[aria-expanded="true"] .chevron {
  transform: rotate(90deg);
}

.agent-compacted-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-left: 14px;
}

.agent-thread-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 4px;
  padding: 4px 0;
  font-size: 12px;
  color: var(--text-muted);
  font-family: var(--mono);
}

.agent-thread-footer .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.agent-thread-footer[data-state="in_flight"] { color: var(--accent); }
.agent-thread-footer[data-state="in_flight"] .dot {
  animation: pulse 1.2s ease-in-out infinite;
}
.agent-thread-footer[data-state="backoff"] { color: var(--warn); }
.agent-thread-footer[data-state="backoff"] .dot {
  animation: pulse 0.8s ease-in-out infinite;
}

.agent-thread-footer .detail {
  opacity: 0.7;
  font-style: italic;
}

@media (max-width: 900px) {
  .agents-view {
    grid-template-columns: 1fr;
  }

  .sidebar {
    max-height: 38vh;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }

  .thread-header {
    flex-wrap: wrap;
    height: auto;
    padding: 10px 16px;
  }

  .live-time {
    margin-left: 0;
  }

  .agent-tool-row {
    grid-template-columns: 14px 1fr;
    grid-auto-flow: row;
  }
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}
</style>
