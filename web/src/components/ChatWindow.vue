<script setup lang="ts">
import { ref, nextTick, watch, computed } from "vue";
import { useWebSocket, type WsEvent } from "../composables/useWebSocket";

type EntryKind = "user" | "assistant" | "work_submitted" | "work_dispatched" | "work_completed" | "work_failed" | "agent_progress";

interface ChatEntry {
  kind: EntryKind;
  content: string;
  timestamp: Date;
  meta?: Record<string, unknown>;
}

const { connected, events, send } = useWebSocket();
const entries = ref<ChatEntry[]>([]);
const thinking = ref(false);
const input = ref("");
const messagesEl = ref<HTMLElement | null>(null);

// Track active agent progress keyed by todoId
const activeProgress = ref<Map<string, { iteration: number; summary: string }>>(new Map());

// Watch for incoming WebSocket events
watch(
  () => events.value.length,
  () => {
    const evt = events.value[events.value.length - 1];
    if (!evt) return;
    handleEvent(evt);
  },
);

function handleEvent(evt: WsEvent) {
  switch (evt.type) {
    case "message":
      entries.value.push({
        kind: "assistant",
        content: String(evt.content ?? ""),
        timestamp: new Date(),
      });
      scrollToBottom();
      break;

    case "thinking":
      thinking.value = evt.active as boolean;
      scrollToBottom();
      break;

    case "work_submitted":
      entries.value.push({
        kind: "work_submitted",
        content: String(evt.goal ?? ""),
        timestamp: new Date(),
        meta: { todoId: evt.todoId, agentType: evt.agentType, priority: evt.priority },
      });
      scrollToBottom();
      break;

    case "work_dispatched":
      entries.value.push({
        kind: "work_dispatched",
        content: String(evt.goal ?? ""),
        timestamp: new Date(),
        meta: { todoId: evt.todoId, agentId: evt.agentId, agentType: evt.agentType },
      });
      scrollToBottom();
      break;

    case "work_completed":
      entries.value.push({
        kind: "work_completed",
        content: String(evt.result ?? ""),
        timestamp: new Date(),
        meta: { todoId: evt.todoId },
      });
      // Clear progress for this task
      activeProgress.value.delete(String(evt.todoId));
      scrollToBottom();
      break;

    case "work_failed":
      entries.value.push({
        kind: "work_failed",
        content: String(evt.error ?? ""),
        timestamp: new Date(),
        meta: { todoId: evt.todoId },
      });
      activeProgress.value.delete(String(evt.todoId));
      scrollToBottom();
      break;

    case "agent_progress": {
      const todoId = String(evt.todoId);
      activeProgress.value.set(todoId, {
        iteration: evt.iteration as number,
        summary: String(evt.summary ?? ""),
      });
      // Update reactive map
      activeProgress.value = new Map(activeProgress.value);
      break;
    }

    case "planning":
      if (evt.status === "started") {
        entries.value.push({
          kind: "work_dispatched",
          content: "Autonomous planner is analyzing project objectives and deciding what to work on next…",
          timestamp: new Date(),
          meta: { agentType: "planner" },
        });
        scrollToBottom();
      } else if (evt.status === "completed") {
        entries.value.push({
          kind: "work_submitted",
          content: `Planner created ${evt.tasksCreated} new task(s)`,
          timestamp: new Date(),
          meta: { agentType: "planner" },
        });
        scrollToBottom();
      } else if (evt.status === "idle") {
        entries.value.push({
          kind: "assistant",
          content: `🧠 ${String(evt.message ?? "Planner found no promising tasks")}`,
          timestamp: new Date(),
        });
        scrollToBottom();
      }
      break;
  }
}

function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  entries.value.push({
    kind: "user",
    content: text,
    timestamp: new Date(),
  });

  send(text);
  input.value = "";
  scrollToBottom();
}

function scrollToBottom() {
  nextTick(() => {
    if (messagesEl.value) {
      messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
    }
  });
}

function shortId(id: unknown): string {
  return String(id ?? "").slice(0, 8);
}

const progressEntries = computed(() => Array.from(activeProgress.value.entries()));
</script>

<template>
  <div class="chat-window">
    <div ref="messagesEl" class="messages">
      <template v-for="(entry, i) in entries" :key="i">
        <!-- User message -->
        <div v-if="entry.kind === 'user'" class="message user">
          <div class="message-role">You</div>
          <div class="message-content user-content">{{ entry.content }}</div>
        </div>

        <!-- Assistant message -->
        <div v-else-if="entry.kind === 'assistant'" class="message assistant">
          <div class="message-role">Saivage</div>
          <div class="message-content assistant-content">{{ entry.content }}</div>
        </div>

        <!-- Work submitted -->
        <div v-else-if="entry.kind === 'work_submitted'" class="event-card submitted">
          <div class="event-icon">📋</div>
          <div class="event-body">
            <div class="event-title">Work submitted</div>
            <div class="event-detail">{{ entry.content }}</div>
            <div class="event-meta">
              <span class="badge badge-type">{{ entry.meta?.agentType }}</span>
              <span class="badge badge-id">{{ shortId(entry.meta?.todoId) }}</span>
            </div>
          </div>
        </div>

        <!-- Work dispatched -->
        <div v-else-if="entry.kind === 'work_dispatched'" class="event-card dispatched">
          <div class="event-icon">🚀</div>
          <div class="event-body">
            <div class="event-title">Agent started</div>
            <div class="event-detail">{{ entry.content }}</div>
            <div class="event-meta">
              <span class="badge badge-type">{{ entry.meta?.agentType }}</span>
              <span class="badge badge-id">agent {{ shortId(entry.meta?.agentId) }}</span>
            </div>
          </div>
        </div>

        <!-- Work completed -->
        <div v-else-if="entry.kind === 'work_completed'" class="event-card completed">
          <div class="event-icon">✅</div>
          <div class="event-body">
            <div class="event-title">Work completed</div>
            <div
              class="event-detail result-detail"
              :class="{ collapsed: !entry.meta?.expanded && entry.content.length > 300 }"
              @click="entry.meta = { ...entry.meta, expanded: !entry.meta?.expanded }"
            >
              {{ entry.content }}
            </div>
            <div v-if="entry.content.length > 300" class="expand-toggle" @click="entry.meta = { ...entry.meta, expanded: !entry.meta?.expanded }">
              {{ entry.meta?.expanded ? '▲ collapse' : '▼ show full result' }}
            </div>
            <div class="event-meta">
              <span class="badge badge-id">{{ shortId(entry.meta?.todoId) }}</span>
            </div>
          </div>
        </div>

        <!-- Work failed -->
        <div v-else-if="entry.kind === 'work_failed'" class="event-card failed">
          <div class="event-icon">❌</div>
          <div class="event-body">
            <div class="event-title">Work failed</div>
            <div class="event-detail">{{ entry.content }}</div>
            <div class="event-meta">
              <span class="badge badge-id">{{ shortId(entry.meta?.todoId) }}</span>
            </div>
          </div>
        </div>
      </template>

      <!-- Active progress indicators (floating at bottom) -->
      <div v-for="[todoId, progress] in progressEntries" :key="todoId" class="progress-indicator">
        <div class="progress-header">
          <span class="progress-spinner">⏳</span>
          <span class="progress-text">{{ progress.summary }}</span>
          <span class="progress-count">iter {{ progress.iteration }}</span>
        </div>
      </div>

      <!-- Thinking indicator -->
      <div v-if="thinking" class="thinking">
        <div class="thinking-dots">
          <span></span><span></span><span></span>
        </div>
        <span class="thinking-text">Thinking…</span>
      </div>

      <div v-if="entries.length === 0 && !thinking" class="empty">
        Send a message to get started.
      </div>
    </div>
    <div class="input-area">
      <div class="status-dot" :class="{ connected }"></div>
      <input
        v-model="input"
        type="text"
        placeholder="Type a message..."
        @keydown.enter="sendMessage"
      />
      <button @click="sendMessage" :disabled="!connected || !input.trim()">
        Send
      </button>
    </div>
  </div>
</template>

<style scoped>
.chat-window {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

/* --- Messages --- */
.message {
  margin-bottom: 16px;
  max-width: 80%;
}

.message.user {
  margin-left: auto;
}

.message-role {
  font-size: 11px;
  color: #8b949e;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.message-content {
  padding: 10px 14px;
  border-radius: 8px;
  line-height: 1.5;
  white-space: pre-wrap;
}

.user-content {
  background: #1f6feb;
  color: #fff;
}

.assistant-content {
  background: #21262d;
  color: #c9d1d9;
}

/* --- Event cards --- */
.event-card {
  display: flex;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  border-left: 3px solid;
  background: #161b22;
}

.event-card.submitted { border-left-color: #58a6ff; }
.event-card.dispatched { border-left-color: #d2a8ff; }
.event-card.completed { border-left-color: #3fb950; }
.event-card.failed { border-left-color: #f85149; }

.event-icon {
  font-size: 18px;
  flex-shrink: 0;
  margin-top: 1px;
}

.event-body {
  min-width: 0;
  flex: 1;
}

.event-title {
  font-size: 12px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.3px;
  margin-bottom: 4px;
}

.event-detail {
  font-size: 13px;
  color: #c9d1d9;
  line-height: 1.4;
  word-break: break-word;
  white-space: pre-wrap;
}

.result-detail {
  cursor: pointer;
}

.result-detail.collapsed {
  max-height: 100px;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
  -webkit-mask-image: linear-gradient(to bottom, black 60%, transparent 100%);
}

.expand-toggle {
  font-size: 11px;
  color: #58a6ff;
  cursor: pointer;
  margin-top: 4px;
}

.expand-toggle:hover {
  text-decoration: underline;
}

.event-meta {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}

.badge {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: monospace;
}

.badge-type {
  background: #1f2937;
  color: #d2a8ff;
}

.badge-id {
  background: #1f2937;
  color: #8b949e;
}

/* --- Progress indicator --- */
.progress-indicator {
  margin-bottom: 8px;
  padding: 8px 12px;
  background: #161b22;
  border-radius: 6px;
  border: 1px solid #21262d;
}

.progress-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.progress-spinner {
  font-size: 14px;
}

.progress-text {
  font-size: 12px;
  color: #8b949e;
  flex: 1;
}

.progress-count {
  font-size: 11px;
  color: #58a6ff;
  font-family: monospace;
}

/* --- Thinking indicator --- */
.thinking {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
}

.thinking-dots {
  display: flex;
  gap: 4px;
}

.thinking-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #58a6ff;
  animation: thinking-bounce 1.4s infinite ease-in-out both;
}

.thinking-dots span:nth-child(1) { animation-delay: -0.32s; }
.thinking-dots span:nth-child(2) { animation-delay: -0.16s; }

@keyframes thinking-bounce {
  0%, 80%, 100% { transform: scale(0.4); opacity: 0.4; }
  40% { transform: scale(1); opacity: 1; }
}

.thinking-text {
  font-size: 13px;
  color: #8b949e;
}

/* --- Empty & input --- */
.empty {
  text-align: center;
  color: #484f58;
  padding: 40px 0;
}

.input-area {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid #21262d;
  background: #161b22;
  align-items: center;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f85149;
  flex-shrink: 0;
}

.status-dot.connected {
  background: #3fb950;
}

input {
  flex: 1;
  padding: 8px 12px;
  background: #0d1117;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #c9d1d9;
  font-size: 14px;
  outline: none;
}

input:focus {
  border-color: #58a6ff;
}

button {
  padding: 8px 16px;
  background: #238636;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 14px;
}

button:disabled {
  background: #21262d;
  color: #484f58;
  cursor: not-allowed;
}

button:hover:not(:disabled) {
  background: #2ea043;
}
</style>
