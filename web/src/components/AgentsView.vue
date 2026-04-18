<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from "vue";

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

const activeAgents = ref<AgentState[]>([]);
const chatSessions = ref<ChatSession[]>([]);
const selectedSession = ref<ChatLog | null>(null);
const selectedId = ref<string | null>(null);
const loading = ref(false);
const activeTab = ref<"active" | "history">("active");
const now = ref(Date.now());
let pollTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

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

async function loadSession(sessionId: string) {
  if (selectedId.value === sessionId) return;
  selectedId.value = sessionId;
  loading.value = true;
  try {
    const res = await fetch(`/api/chats/${sessionId}`);
    if (res.ok) {
      selectedSession.value = await res.json();
    }
  } catch { /* ignore */ }
  loading.value = false;
}

onMounted(() => {
  fetchData();
  pollTimer = setInterval(fetchData, 5000);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (clockTimer) clearInterval(clockTimer);
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
    case "inspector": return "#f0883e";
    default: return "#c9d1d9";
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
          <div v-for="agent in activeAgents" :key="agent.agent_id" class="sidebar-item">
            <div class="item-header">
              <span class="agent-role" :style="{ color: roleColor(agent.agent_type) }">{{ agent.agent_type }}</span>
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
            :class="{ selected: selectedId === session.session_id }"
            @click="loadSession(session.session_id)"
          >
            <div class="item-header">
              <span class="session-id">{{ session.session_id.slice(0, 16) }}</span>
              <span class="session-time">{{ timeAgo(session.updated_at) }}</span>
            </div>
            <div class="item-sub">{{ session.message_count }} messages · {{ session.channel }}</div>
          </div>
        </template>
      </div>
    </div>

    <div class="thread-panel">
      <div v-if="!selectedSession && !loading" class="thread-empty">
        <div class="thread-empty-icon">💬</div>
        <div>Select a chat session to view the conversation</div>
      </div>

      <div v-if="loading" class="thread-empty">Loading conversation…</div>

      <template v-if="selectedSession && !loading">
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
            <div class="msg-content" :class="{ 'msg-tool': isToolMessage(parseContent(msg.content)) }">{{ parseContent(msg.content) }}</div>
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
.sidebar-item.clickable:hover { border-color: #30363d; }
.sidebar-item.selected { border-color: #58a6ff; background: rgba(56, 139, 253, 0.1); }
.item-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2px; }
.agent-role { font-size: 13px; font-weight: 600; }
.agent-time { font-size: 11px; color: #d29922; font-family: monospace; }
.session-id { font-size: 12px; font-family: monospace; color: #c9d1d9; }
.session-time { font-size: 11px; color: #8b949e; }
.item-sub { font-size: 11px; color: #8b949e; }
.item-task { font-size: 11px; color: #58a6ff; font-family: monospace; margin-top: 2px; }

.thread-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.thread-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #484f58; font-size: 14px; gap: 8px; }
.thread-empty-icon { font-size: 32px; opacity: 0.5; }

.thread-header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #21262d; background: #161b22; flex-shrink: 0; }
.thread-id { font-size: 13px; font-family: monospace; color: #c9d1d9; font-weight: 600; }
.thread-channel { font-size: 11px; color: #8b949e; background: #21262d; padding: 1px 6px; border-radius: 3px; }
.thread-time { font-size: 11px; color: #8b949e; }
.thread-count { font-size: 11px; color: #8b949e; margin-left: auto; }

.thread-body { flex: 1; overflow-y: auto; padding: 16px; }

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
