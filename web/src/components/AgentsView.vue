<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { Bot, Clock3, MessageSquare, Wrench } from "lucide-vue-next";
import FormattedContent from "./FormattedContent.vue";
import { ApiError, apiFetch } from "../utils/api";

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
    | "agent_result"
    | "tool_call"
    | "tool_result"
    | "tool_error";
  content: string;
  tool?: string;
  timestamp?: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

interface AgentConversation {
  agent_id: string;
  role: string;
  started_at?: string;
  message_count: number;
  entries: ConversationEntry[];
  activity_status?: ActivityStatus;
  finished_at?: string;
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

interface StepBlock {
  kind: "step";
  id: string;
  lead: ConversationEntry;
  toolCalls: ConversationEntry[];
  toolResults: ConversationEntry[];
}

interface SingleBlock {
  kind: "single";
  id: string;
  entry: ConversationEntry;
}

type ConversationBlock = StepBlock | SingleBlock;

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
    } catch { /* ignore */ }
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
    if (err instanceof ApiError && err.status === 404) markAgentFinished(agentId);
  }
  loading.value = false;
  startAgentPolling(agentId);
}

function markAgentFinished(agentId: string) {
  if (!selectedAgent.value || selectedId.value !== agentId) return;
  const finishedAt = new Date().toISOString();
  const entries = selectedAgent.value.entries.some((entry) => entry.kind === "agent_result")
    ? selectedAgent.value.entries
    : [
        ...selectedAgent.value.entries,
        {
          role: "system" as const,
          kind: "agent_result" as const,
          timestamp: finishedAt,
          content:
            "Conversation finished: the agent is no longer running. The returned payload has already been handed back to the parent conversation.",
        },
      ];

  selectedAgent.value = {
    ...selectedAgent.value,
    entries,
    finished_at: selectedAgent.value.finished_at ?? finishedAt,
    activity_status: selectedAgent.value.activity_status
      ? { ...selectedAgent.value.activity_status, pending_call: null, last_activity_at: finishedAt }
      : undefined,
  };
  stopAgentPolling();
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
    case "data_agent": return "#64d2ff";
    case "reviewer": return "#d0a2ff";
    case "inspector": return "var(--orange)";
    default: return "var(--text)";
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "tool_call": return "Tool Call";
    case "tool_result": return "Result";
    case "tool_error": return "Error";
    case "activity": return "Action";
    case "model_issue": return "Model Issue";
    case "model_repair": return "Model Repair";
    case "model_recovered": return "Model Recovered";
    case "agent_result": return "Finished";
    default: return "Message";
  }
}

function entryRoleLabel(entry: ConversationEntry): string {
  if (entry.kind !== "text") return kindLabel(entry.kind);
  if (entry.role === "assistant") return "Reasoning";
  if (entry.role === "user") return "Context";
  return "System";
}

function isTextLikeEntry(entry: ConversationEntry): boolean {
  return ["text", "activity", "model_issue", "model_repair", "model_recovered", "agent_result"].includes(entry.kind);
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

function formatTime(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function entryTime(entry: ConversationEntry): string {
  return entry.timestamp ? timeAgo(entry.timestamp) : "";
}

function modelLabel(source: { provider?: string; model?: string; modelSpec?: string }): string {
  return source.modelSpec ?? (source.provider && source.model ? `${source.provider}/${source.model}` : "");
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max) + "...";
}

function entryTone(entry: ConversationEntry): string {
  if (entry.kind === "tool_error" || entry.kind === "model_issue") return "danger";
  if (entry.kind === "model_repair") return "warn";
  if (entry.kind === "agent_result" && /returned (failure|abort|escalation) result/i.test(entry.content)) return "warn";
  if (entry.kind === "agent_result") return "ok";
  if (entry.kind === "model_recovered" || entry.kind === "tool_result") return "ok";
  if (entry.kind === "tool_call" || entry.kind === "activity") return "accent";
  return entry.role;
}

function isAssistantLead(entry: ConversationEntry): boolean {
  return (entry.kind === "text" && entry.role === "assistant") || entry.kind === "activity";
}

const groupedAgentEntries = computed<ConversationBlock[]>(() => {
  const entries = selectedAgent.value?.entries ?? [];
  const blocks: ConversationBlock[] = [];

  for (let index = 0; index < entries.length;) {
    const entry = entries[index];
    if (isAssistantLead(entry)) {
      const toolCalls: ConversationEntry[] = [];
      const toolResults: ConversationEntry[] = [];
      let nextIndex = index + 1;

      while (nextIndex < entries.length) {
        const next = entries[nextIndex];
        if (next.kind === "tool_call") {
          toolCalls.push(next);
          nextIndex += 1;
          continue;
        }
        if (next.kind === "tool_result" || next.kind === "tool_error") {
          toolResults.push(next);
          nextIndex += 1;
          continue;
        }
        break;
      }

      blocks.push({
        kind: "step",
        id: `step-${index}`,
        lead: entry,
        toolCalls,
        toolResults,
      });
      index = nextIndex;
      continue;
    }

    blocks.push({
      kind: "single",
      id: `entry-${index}`,
      entry,
    });
    index += 1;
  }

  return blocks;
});

function hasDetails(block: StepBlock): boolean {
  return block.toolCalls.length > 0 || block.toolResults.length > 0;
}

function detailSummary(block: StepBlock): string {
  const parts: string[] = [];
  if (block.toolCalls.length > 0) parts.push(`${block.toolCalls.length} call${block.toolCalls.length === 1 ? "" : "s"}`);
  if (block.toolResults.length > 0) parts.push(`${block.toolResults.length} result${block.toolResults.length === 1 ? "" : "s"}`);
  return parts.join(" · ") || "No tool details";
}

function detailsOpen(id: string): boolean {
  return expandedDetails.value.has(id);
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

const activityIndicator = computed<{
  state: "in_flight" | "backoff";
  primary: string;
  detail?: string;
} | null>(() => {
  const status = selectedAgent.value?.activity_status;
  if (!status) return null;
  if (status.pending_call) {
    const pc = status.pending_call;
    const elapsedStr = durationSince(pc.started_at);
    if (pc.status === "in_flight") {
      const attemptLabel = pc.attempt > 1 ? ` (attempt ${pc.attempt})` : "";
      return {
        state: "in_flight",
        primary: `Waiting for model… ${elapsedStr}${attemptLabel}`,
      };
    }
    const retry = pc.retry_at ? ` — retrying in ${durationUntil(pc.retry_at)}` : "";
    const reason = pc.reason === "throttled" ? "Throttled by provider" : "Transient model error";
    return {
      state: "backoff",
      primary: `${reason}${retry}`,
      detail: `attempt ${pc.attempt}`,
    };
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
        <div class="thread-header">
          <span class="role-badge" :style="{ borderColor: roleColor(selectedAgent.role), color: roleColor(selectedAgent.role) }">{{ selectedAgent.role }}</span>
          <code>{{ selectedAgent.agent_id }}</code>
          <span>{{ selectedAgent.message_count }} messages · {{ selectedAgent.entries.length }} entries</span>
          <span v-if="selectedAgent.started_at" class="live-time">{{ elapsed(selectedAgent.started_at) }}</span>
          <span v-if="selectedAgent.finished_at" class="live-pill finished"><span></span>finished</span>
          <span v-else class="live-pill"><span></span>live</span>
        </div>

        <div class="thread-body" ref="threadBody">
          <article
            v-for="block in groupedAgentEntries"
            :key="block.id"
            class="entry"
            :class="block.kind === 'step' ? entryTone(block.lead) : entryTone(block.entry)"
          >
            <template v-if="block.kind === 'step'">
              <div class="entry-label">
                <span>{{ entryRoleLabel(block.lead) }}</span>
                <em v-if="modelLabel(block.lead)" class="model-chip">{{ modelLabel(block.lead) }}</em>
                <time v-if="block.lead.timestamp" :title="new Date(block.lead.timestamp).toLocaleString()">{{ entryTime(block.lead) }}</time>
              </div>
              <div class="entry-content text-entry reasoning-entry">
                <FormattedContent :content="block.lead.content" max-height="460px" />
              </div>
              <div v-if="hasDetails(block)" class="step-tools">
                <button class="tool-header step-summary" @click="toggleDetails(block.id)">
                  <Wrench :size="14" />
                  <strong>{{ detailSummary(block) }}</strong>
                  <span>{{ detailsOpen(block.id) ? 'hide mechanics' : 'show mechanics' }}</span>
                </button>
                <div v-if="detailsOpen(block.id)" class="step-details">
                  <template v-for="(entry, idx) in block.toolCalls" :key="`${block.id}-call-${idx}`">
                    <button class="tool-header detail-item">
                      <Wrench :size="14" />
                      <strong>{{ entry.tool }}</strong>
                      <em v-if="modelLabel(entry)" class="model-chip">{{ modelLabel(entry) }}</em>
                      <time v-if="entry.timestamp">{{ entryTime(entry) }}</time>
                    </button>
                    <div class="entry-content tool-content detail-body">
                      <FormattedContent :content="entry.content" max-height="320px" />
                    </div>
                  </template>

                  <template v-for="(entry, idx) in block.toolResults" :key="`${block.id}-result-${idx}`">
                    <button class="tool-header result detail-item" :class="{ error: entry.kind === 'tool_error' }">
                      <strong>{{ kindLabel(entry.kind) }}</strong>
                      <time v-if="entry.timestamp">{{ entryTime(entry) }}</time>
                      <p>{{ truncate(entry.content.split('\n')[0], 100) }}</p>
                    </button>
                    <div class="entry-content tool-content detail-body" :class="{ error: entry.kind === 'tool_error' }">
                      <FormattedContent :content="entry.content" max-height="320px" />
                    </div>
                  </template>
                </div>
              </div>
            </template>

            <template v-else-if="isTextLikeEntry(block.entry)">
              <div class="entry-label">
                <span>{{ entryRoleLabel(block.entry) }}</span>
                <em v-if="modelLabel(block.entry)" class="model-chip">{{ modelLabel(block.entry) }}</em>
                <time v-if="block.entry.timestamp" :title="new Date(block.entry.timestamp).toLocaleString()">{{ entryTime(block.entry) }}</time>
              </div>
              <div class="entry-content text-entry">
                <FormattedContent :content="block.entry.content" max-height="460px" />
              </div>
            </template>

            <template v-else-if="block.entry.kind === 'tool_call'">
              <button class="tool-header" @click="toggleDetails(block.id)">
                <Wrench :size="14" />
                <strong>{{ block.entry.tool }}</strong>
                <em v-if="modelLabel(block.entry)" class="model-chip">{{ modelLabel(block.entry) }}</em>
                <time v-if="block.entry.timestamp">{{ entryTime(block.entry) }}</time>
                <span>{{ detailsOpen(block.id) ? 'hide details' : 'show details' }}</span>
              </button>
              <div v-if="detailsOpen(block.id)" class="entry-content tool-content">
                <FormattedContent :content="block.entry.content" max-height="320px" />
              </div>
            </template>

            <template v-else-if="block.entry.kind === 'tool_result' || block.entry.kind === 'tool_error'">
              <button class="tool-header result" :class="{ error: block.entry.kind === 'tool_error' }" @click="toggleDetails(block.id)">
                <strong>{{ kindLabel(block.entry.kind) }}</strong>
                <time v-if="block.entry.timestamp">{{ entryTime(block.entry) }}</time>
                <p>{{ truncate(block.entry.content.split('\n')[0], 100) }}</p>
                <span>{{ detailsOpen(block.id) ? 'hide details' : 'show details' }}</span>
              </button>
              <div v-if="detailsOpen(block.id)" class="entry-content tool-content" :class="{ error: block.entry.kind === 'tool_error' }">
                <FormattedContent :content="block.entry.content" max-height="320px" />
              </div>
            </template>
          </article>
          <div
            v-if="activityIndicator"
            class="activity-indicator"
            :class="`state-${activityIndicator.state}`"
            role="status"
            aria-live="polite"
          >
            <span class="dot" />
            <span class="primary">{{ activityIndicator.primary }}</span>
            <span v-if="activityIndicator.detail" class="detail">{{ activityIndicator.detail }}</span>
          </div>
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
              <time>{{ formatTime(msg.timestamp) }}</time>
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

.entry,
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
.tool-header .model-chip {
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

.entry.assistant .entry-label,
.chat-msg.assistant .entry-label { color: var(--accent-2); }
.entry.user .entry-label,
.chat-msg.user .entry-label { color: var(--accent); }
.entry.system .entry-label,
.chat-msg.system .entry-label { color: var(--warn); }
.entry.danger .entry-label { color: var(--danger); }
.entry.warn .entry-label { color: var(--warn); }
.entry.ok .entry-label { color: var(--accent-2); }
.entry.accent .entry-label { color: var(--accent); }

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

.reasoning-entry {
  border-color: rgba(157, 132, 255, 0.32);
  background: rgba(157, 132, 255, 0.08);
}

.entry.user .text-entry,
.chat-msg.user .text-entry {
  border-color: rgba(61, 214, 140, 0.35);
  background: rgba(61, 214, 140, 0.08);
}

.entry.danger .text-entry {
  border-color: rgba(239, 107, 100, 0.38);
  background: rgba(239, 107, 100, 0.08);
}

.entry.warn .text-entry {
  border-color: rgba(224, 169, 68, 0.38);
  background: rgba(224, 169, 68, 0.08);
}

.tool-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text-muted);
  background: var(--surface-1);
  cursor: pointer;
  text-align: left;
}

.tool-header:hover {
  border-color: var(--border-strong);
  background: var(--surface-2);
}

.step-tools {
  margin-top: 7px;
}

.step-summary {
  justify-content: space-between;
}

.step-details {
  display: grid;
  gap: 8px;
  margin-top: 8px;
  padding-left: 10px;
  border-left: 2px solid rgba(255, 255, 255, 0.08);
}

.detail-item {
  cursor: default;
}

.detail-body {
  margin-top: -2px;
}

.tool-header strong {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 12px;
}

.tool-header time,
.tool-header span {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}

.tool-header > span:last-child {
  margin-left: auto;
}

.tool-header p {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  margin: 0;
  color: var(--text-faint);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-header.result {
  grid-template-columns: auto auto minmax(0, 1fr) auto;
}

.tool-header.result strong {
  color: var(--accent-2);
}

.tool-header.result.error strong {
  color: var(--danger);
}

.tool-content {
  margin-top: -1px;
  border-radius: 0 0 7px 7px;
  padding: 8px 10px;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 12px;
}

.tool-content.error {
  border-color: rgba(239, 107, 100, 0.36);
  color: #ffaaa5;
  background: rgba(239, 107, 100, 0.06);
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
}

.activity-indicator {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  background: var(--panel, #1a1d24);
  border: 1px solid var(--border, #2a2f3a);
  color: var(--muted, #98a2b3);
  align-self: flex-start;
  width: fit-content;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}

.activity-indicator .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  flex-shrink: 0;
}

.activity-indicator.state-in_flight {
  color: var(--accent, #4ea1ff);
}

.activity-indicator.state-in_flight .dot {
  animation: pulse 1.2s ease-in-out infinite;
}

.activity-indicator.state-backoff {
  color: var(--warn, #f5a623);
}

.activity-indicator.state-backoff .dot {
  animation: pulse 0.8s ease-in-out infinite;
}

.activity-indicator.state-idle {
  color: var(--muted, #98a2b3);
  opacity: 0.7;
}

.activity-indicator .detail {
  opacity: 0.7;
  font-style: italic;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(0.7); }
}
</style>
