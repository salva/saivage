<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from "vue";
import FormattedContent from "./FormattedContent.vue";

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
  kind: "text" | "tool_call" | "tool_result" | "tool_error";
  content: string;
  tool?: string;
}

interface AgentConversation {
  agent_id: string;
  role: string;
  message_count: number;
  entries: ConversationEntry[];
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
const autoScroll = ref(true);
const threadBody = ref<HTMLElement | null>(null);
const collapsedTools = ref<Set<number>>(new Set());
let pollTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let agentPollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchData() {
  try {
    const [stateRes, chatsRes] = await Promise.all([
      fetch("/api/state"),
      fetch("/api/chats"),
    ]);
    if (stateRes.ok) {
      const data = await stateRes.json();
      activeAgents.value = (data.state?.active_agents ?? [])
        .filter((a: AgentState) => a.agent_type !== "chat");
    }
    if (chatsRes.ok) {
      const data = await chatsRes.json();
      chatSessions.value = data.sessions ?? [];
    }
  } catch { /* ignore */ }
}

async function loadAgentConversation(agentId: string) {
  if (selectionKind.value === "agent" && selectedId.value === agentId && selectedAgent.value) {
    // Just refresh
    try {
      const res = await fetch(`/api/agents/${agentId}/conversation`);
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
  collapsedTools.value = new Set();
  try {
    const res = await fetch(`/api/agents/${agentId}/conversation`);
    if (res.ok) {
      selectedAgent.value = await res.json() as AgentConversation;
      await nextTick();
      scrollToBottom();
    }
  } catch { /* ignore */ }
  loading.value = false;
  startAgentPolling(agentId);
}

async function loadSession(sessionId: string) {
  if (selectionKind.value === "chat" && selectedId.value === sessionId) return;
  selectedId.value = sessionId;
  selectionKind.value = "chat";
  selectedAgent.value = null;
  loading.value = true;
  collapsedTools.value = new Set();
  stopAgentPolling();
  try {
    const res = await fetch(`/api/chats/${sessionId}`);
    if (res.ok) {
      selectedSession.value = await res.json();
    }
  } catch { /* ignore */ }
  loading.value = false;
}

function startAgentPolling(agentId: string) {
  stopAgentPolling();
  agentPollTimer = setInterval(() => {
    if (selectionKind.value === "agent" && selectedId.value === agentId) {
      loadAgentConversation(agentId);
    } else {
      stopAgentPolling();
    }
  }, 3000);
}

function stopAgentPolling() {
  if (agentPollTimer) { clearInterval(agentPollTimer); agentPollTimer = null; }
}

function isScrolledToBottom(): boolean {
  if (!threadBody.value) return true;
  const el = threadBody.value;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollToBottom() {
  if (threadBody.value) {
    threadBody.value.scrollTop = threadBody.value.scrollHeight;
  }
}

function toggleToolCollapse(index: number) {
  const s = new Set(collapsedTools.value);
  if (s.has(index)) s.delete(index); else s.add(index);
  collapsedTools.value = s;
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
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function timeAgo(ts: string): string {
  const ms = now.value - new Date(ts).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function roleColor(role: string): string {
  switch (role) {
    case "planner": return "#bc8cff";
    case "manager": return "#58a6ff";
    case "coder": return "#3fb950";
    case "researcher": return "#d29922";
    case "data_agent": return "#2f81f7";
    case "reviewer": return "#a371f7";
    case "inspector": return "#f0883e";
    default: return "#c9d1d9";
  }
}

function kindIcon(kind: string): string {
  switch (kind) {
    case "text": return "";
    case "tool_call": return "\u2192";
    case "tool_result": return "\u2190";
    case "tool_error": return "\u2716";
    default: return "";
  }
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "tool_call": return "Tool Call";
    case "tool_result": return "Result";
    case "tool_error": return "Error";
    default: return "";
  }
}

function msgRoleColor(role: string): string {
  switch (role) {
    case "user": return "#58a6ff";
    case "assistant": return "#3fb950";
    case "system": return "#d29922";
    default: return "#8b949e";
  }
}

function isToolMessage(content: string): boolean {
  return content.startsWith("Tool call:") || content.startsWith("Tool result:");
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

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "\u2026";
}

const filteredSessions = computed(() => {
  return chatSessions.value.filter(s => s.message_count > 0);
});
</script>

<template>
  <div class="agents-view">
    <div class="sidebar">
      <div class="sidebar-tabs">
        <button class="stab" :class="{ active: activeTab === 'active' }" @click="activeTab = 'active'">
          Active <span v-if="activeAgents.length" class="badge">{{ activeAgents.length }}</span>
        </button>
        <button class="stab" :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
          Chat History <span v-if="filteredSessions.length" class="badge">{{ filteredSessions.length }}</span>
        </button>
      </div>

      <div class="sidebar-content">
        <!-- Active agents -->
        <template v-if="activeTab === 'active'">
          <div v-if="activeAgents.length === 0" class="sidebar-empty">No active agents</div>
          <div
            v-for="agent in activeAgents"
            :key="agent.agent_id"
            class="sidebar-item clickable"
            :class="{ selected: selectionKind === 'agent' && selectedId === agent.agent_id }"
            @click="loadAgentConversation(agent.agent_id)"
          >
            <div class="item-header">
              <span class="agent-role" :style="{ color: roleColor(agent.agent_type) }">{{ agent.agent_type }}</span>
              <span class="agent-status">
                <span class="pulse"></span>
                running
              </span>
              <span class="agent-time">{{ elapsed(agent.started_at) }}</span>
            </div>
            <div class="item-sub">{{ agent.agent_id }}</div>
            <div v-if="agent.current_task_id" class="item-task">{{ agent.current_task_id }}</div>
          </div>
        </template>

        <!-- Chat history -->
        <template v-else>
          <div v-if="filteredSessions.length === 0" class="sidebar-empty">No chat sessions</div>
          <div
            v-for="session in filteredSessions"
            :key="session.session_id"
            class="sidebar-item clickable"
            :class="{ selected: selectionKind === 'chat' && selectedId === session.session_id }"
            @click="loadSession(session.session_id)"
          >
            <div class="item-header">
              <span class="session-id">{{ session.session_id.slice(0, 16) }}</span>
              <span class="session-time">{{ timeAgo(session.updated_at) }}</span>
            </div>
            <div class="item-sub">{{ session.message_count }} messages &middot; {{ session.channel }}</div>
          </div>
        </template>
      </div>
    </div>

    <div class="thread-panel">
      <!-- Empty state -->
      <div v-if="!selectedAgent && !selectedSession && !loading" class="thread-empty">
        <div class="thread-empty-icon">&#x1F916;</div>
        <div>Select an active agent to watch its conversation</div>
        <div class="thread-empty-hint">Click an agent in the sidebar to see what it's doing in real-time</div>
      </div>

      <div v-if="loading" class="thread-empty">
        <div class="spinner"></div>
        Loading conversation&hellip;
      </div>

      <!-- Agent conversation (Copilot-style) -->
      <template v-if="selectedAgent && selectionKind === 'agent' && !loading">
        <div class="thread-header agent-header">
          <span class="agent-role-badge" :style="{ background: roleColor(selectedAgent.role) }">{{ selectedAgent.role }}</span>
          <span class="thread-id">{{ selectedAgent.agent_id }}</span>
          <span class="thread-count">{{ selectedAgent.message_count }} messages &middot; {{ selectedAgent.entries.length }} entries</span>
          <span class="live-badge"><span class="pulse"></span>Live</span>
        </div>

        <div class="thread-body" ref="threadBody">
          <div
            v-for="(entry, idx) in selectedAgent.entries"
            :key="idx"
            class="entry"
            :class="[entry.kind, entry.role]"
          >
            <!-- Text messages (thinking / user input) -->
            <template v-if="entry.kind === 'text'">
              <div class="entry-bar" :class="entry.role">
                <span class="entry-role-label">{{ entry.role === 'assistant' ? 'Thinking' : entry.role === 'user' ? 'Context' : 'System' }}</span>
              </div>
              <div class="entry-content text-content" :class="entry.role">
                <FormattedContent :content="entry.content" max-height="420px" />
              </div>
            </template>

            <!-- Tool calls -->
            <template v-if="entry.kind === 'tool_call'">
              <div class="tool-header" @click="toggleToolCollapse(idx)">
                <span class="tool-icon call">{{ kindIcon(entry.kind) }}</span>
                <span class="tool-name">{{ entry.tool }}</span>
                <span class="tool-chevron" :class="{ collapsed: collapsedTools.has(idx) }">&#9660;</span>
              </div>
              <div v-if="!collapsedTools.has(idx)" class="entry-content tool-content">
                <FormattedContent :content="entry.content" max-height="300px" />
              </div>
            </template>

            <!-- Tool results -->
            <template v-if="entry.kind === 'tool_result' || entry.kind === 'tool_error'">
              <div class="tool-header result-header" :class="{ error: entry.kind === 'tool_error' }" @click="toggleToolCollapse(idx)">
                <span class="tool-icon" :class="entry.kind === 'tool_error' ? 'error' : 'result'">{{ kindIcon(entry.kind) }}</span>
                <span class="tool-result-label">{{ kindLabel(entry.kind) }}</span>
                <span class="tool-result-preview">{{ truncate(entry.content.split('\n')[0], 80) }}</span>
                <span class="tool-chevron" :class="{ collapsed: collapsedTools.has(idx) }">&#9660;</span>
              </div>
              <div v-if="!collapsedTools.has(idx)" class="entry-content tool-content" :class="{ 'error-content': entry.kind === 'tool_error' }">
                <FormattedContent :content="entry.content" max-height="300px" />
              </div>
            </template>
          </div>

          <!-- Thinking indicator at bottom -->
          <div class="thinking-indicator">
            <span class="thinking-dot"></span>
            <span class="thinking-dot"></span>
            <span class="thinking-dot"></span>
          </div>
        </div>
      </template>

      <!-- Chat session (existing) -->
      <template v-if="selectedSession && selectionKind === 'chat' && !loading">
        <div class="thread-header">
          <span class="thread-id">{{ selectedSession.session_id }}</span>
          <span class="thread-channel">{{ selectedSession.channel }}</span>
          <span class="thread-time">{{ new Date(selectedSession.started_at).toLocaleString() }}</span>
          <span class="thread-count">{{ selectedSession.messages.length }} messages</span>
        </div>

        <div class="thread-body">
          <div
            v-for="msg in selectedSession.messages"
            :key="msg.id"
            class="msg"
            :class="[msg.role, { event: !!msg.event }]"
          >
            <div class="msg-header">
              <span class="msg-role" :style="{ color: msgRoleColor(msg.role) }">{{ msg.role }}</span>
              <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
              <span v-if="msg.event" class="msg-event-type">{{ msg.event.type }}</span>
            </div>
            <div class="msg-content" :class="{ 'msg-tool': isToolMessage(parseContent(msg.content)) }">
              <FormattedContent :content="parseContent(msg.content)" max-height="360px" />
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.agents-view { display: flex; height: 100%; overflow: hidden; }

.sidebar { width: 280px; border-right: 1px solid #21262d; display: flex; flex-direction: column; flex-shrink: 0; background: #161b22; }
.sidebar-tabs { display: flex; border-bottom: 1px solid #21262d; flex-shrink: 0; }
.stab { flex: 1; background: none; border: none; color: #8b949e; font-size: 12px; padding: 10px 8px; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 6px; }
.stab:hover { color: #c9d1d9; background: #21262d; }
.stab.active { color: #58a6ff; border-bottom: 2px solid #58a6ff; font-weight: 600; }
.badge { font-size: 10px; background: #30363d; color: #c9d1d9; padding: 1px 6px; border-radius: 10px; }
.sidebar-content { flex: 1; overflow-y: auto; padding: 8px; }
.sidebar-empty { font-size: 13px; color: #484f58; text-align: center; padding: 24px 8px; }

.sidebar-item { padding: 8px 10px; border-radius: 6px; margin-bottom: 4px; background: #0d1117; border: 1px solid #21262d; }
.sidebar-item.clickable { cursor: pointer; }
.sidebar-item.clickable:hover { border-color: #30363d; background: #161b22; }
.sidebar-item.selected { border-color: #58a6ff; background: rgba(56, 139, 253, 0.1); }
.item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; gap: 6px; }
.agent-role { font-size: 13px; font-weight: 600; }
.agent-status { font-size: 10px; color: #3fb950; display: flex; align-items: center; gap: 4px; }
.agent-time { font-size: 11px; color: #d29922; font-family: monospace; margin-left: auto; }
.session-id { font-size: 12px; font-family: monospace; color: #c9d1d9; }
.session-time { font-size: 11px; color: #8b949e; }
.item-sub { font-size: 11px; color: #8b949e; font-family: monospace; }
.item-task { font-size: 11px; color: #58a6ff; font-family: monospace; margin-top: 2px; }

.pulse {
  display: inline-block;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #3fb950;
  animation: pulse-anim 2s ease-in-out infinite;
}
@keyframes pulse-anim {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

/* ─── Thread panel ─── */
.thread-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.thread-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #484f58; font-size: 14px; gap: 8px; }
.thread-empty-icon { font-size: 36px; opacity: 0.5; }
.thread-empty-hint { font-size: 12px; color: #30363d; }

.spinner { width: 20px; height: 20px; border: 2px solid #30363d; border-top-color: #58a6ff; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ─── Thread header ─── */
.thread-header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #21262d; background: #161b22; flex-shrink: 0; }
.agent-header { gap: 8px; }
.thread-id { font-size: 12px; font-family: monospace; color: #8b949e; }
.thread-channel { font-size: 11px; color: #8b949e; background: #21262d; padding: 1px 6px; border-radius: 3px; }
.thread-time { font-size: 11px; color: #8b949e; }
.thread-count { font-size: 11px; color: #8b949e; margin-left: auto; }

.agent-role-badge {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px;
  color: #fff; padding: 2px 8px; border-radius: 4px;
}

.live-badge {
  font-size: 10px; color: #3fb950; display: flex; align-items: center; gap: 4px;
  background: rgba(63, 185, 80, 0.1); padding: 2px 8px; border-radius: 10px;
}

/* ─── Thread body ─── */
.thread-body { flex: 1; overflow-y: auto; padding: 12px 16px; }

/* ─── Conversation entries (Copilot style) ─── */
.entry { margin-bottom: 2px; }

.entry-bar {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;
  padding: 6px 0 2px; color: #8b949e;
}
.entry-bar.assistant { color: #3fb950; }
.entry-bar.user { color: #58a6ff; }
.entry-bar.system { color: #d29922; }

.entry-role-label { font-size: 10px; }

.entry-content {
  font-size: 13px; line-height: 1.55; padding: 6px 12px; border-radius: 6px;
  margin-bottom: 4px;
}

.text-content.assistant { background: #0d1117; color: #c9d1d9; border-left: 3px solid #3fb950; }
.text-content.user { background: rgba(56, 139, 253, 0.08); color: #c9d1d9; border-left: 3px solid #58a6ff; }
.text-content.system { background: rgba(210, 153, 34, 0.08); color: #d29922; border-left: 3px solid #d29922; font-size: 12px; }

/* ─── Tool calls / results ─── */
.tool-header {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 8px; cursor: pointer; border-radius: 4px;
  font-size: 12px; color: #8b949e;
  background: #161b22; border: 1px solid #21262d;
  margin-top: 2px;
}
.tool-header:hover { background: #1c2128; border-color: #30363d; }

.tool-icon { font-size: 12px; font-weight: 700; width: 16px; text-align: center; }
.tool-icon.call { color: #58a6ff; }
.tool-icon.result { color: #3fb950; }
.tool-icon.error { color: #f85149; }

.tool-name { font-weight: 600; color: #58a6ff; font-family: monospace; font-size: 12px; }
.tool-result-label { font-weight: 600; color: #3fb950; font-size: 11px; }
.tool-result-preview { color: #484f58; font-size: 11px; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.result-header.error .tool-result-label { color: #f85149; }
.result-header.error .tool-result-preview { color: #f85149; }

.tool-chevron { font-size: 8px; color: #484f58; transition: transform 0.15s; margin-left: auto; }
.tool-chevron.collapsed { transform: rotate(-90deg); }

.tool-content {
  font-family: monospace; font-size: 11px; line-height: 1.45;
  background: #0d1117; color: #8b949e; border: 1px solid #21262d;
  border-top: none; border-radius: 0 0 4px 4px;
  padding: 6px 10px; max-height: 300px; overflow-y: auto;
}
.error-content { color: #f85149; background: rgba(248, 81, 73, 0.05); }

/* ─── Thinking indicator ─── */
.thinking-indicator {
  display: flex; gap: 4px; padding: 12px 0 4px; justify-content: center;
}
.thinking-dot {
  width: 6px; height: 6px; border-radius: 50%; background: #30363d;
  animation: thinking 1.4s ease-in-out infinite;
}
.thinking-dot:nth-child(2) { animation-delay: 0.2s; }
.thinking-dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes thinking {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.2); }
}

/* ─── Chat session messages (existing) ─── */
.msg { margin-bottom: 12px; max-width: 90%; }
.msg.user { margin-left: auto; }
.msg.assistant { margin-right: auto; }
.msg.system { margin-left: auto; margin-right: auto; max-width: 95%; }
.msg.event { max-width: 95%; }

.msg-header { display: flex; gap: 8px; align-items: center; margin-bottom: 3px; }
.msg-role { font-size: 11px; font-weight: 600; text-transform: uppercase; }
.msg-time { font-size: 10px; color: #484f58; }
.msg-event-type { font-size: 10px; color: #d29922; background: rgba(210, 153, 34, 0.15); padding: 1px 5px; border-radius: 3px; }

.msg-content { font-size: 13px; line-height: 1.5; padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
.msg.user .msg-content { background: #1f6feb; color: #fff; border-bottom-right-radius: 2px; }
.msg.assistant .msg-content { background: #161b22; color: #c9d1d9; border: 1px solid #21262d; border-bottom-left-radius: 2px; }
.msg.system .msg-content { background: rgba(210, 153, 34, 0.1); color: #d29922; font-size: 12px; text-align: center; border-radius: 4px; }
.msg-tool { font-family: monospace; font-size: 11px; background: #0d1117 !important; color: #8b949e !important; border: 1px solid #21262d !important; }
</style>
