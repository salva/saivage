<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { SendHorizontal, Wifi, WifiOff } from "lucide-vue-next";
import { useWebSocket } from "../composables/useWebSocket";
import { renderMarkdown } from "../utils/markdown";

interface Message {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

const messages = ref<Message[]>([]);
const inputText = ref("");
const chatBody = ref<HTMLElement | null>(null);
const thinking = ref(false);
const sessionId = ref<string | null>(null);
let msgId = 0;

const { connected, events, send } = useWebSocket();
const sessionLabel = computed(() => sessionId.value ? sessionId.value.slice(0, 14) : "new session");

watch(() => events.value.length, () => {
  const ev = events.value[events.value.length - 1];
  if (!ev) return;

  if (ev.type === "session" && ev.sessionId) {
    const newSid = ev.sessionId as string;
    if (sessionId.value && sessionId.value !== newSid) {
      messages.value = [];
      msgId = 0;
    }
    sessionId.value = newSid;
    loadHistory(newSid);
    return;
  }

  if (ev.type === "thinking") {
    thinking.value = true;
    scrollToBottom();
    return;
  }

  if (ev.type === "message" && ev.content) {
    thinking.value = false;
    messages.value.push({
      id: ++msgId,
      role: "assistant",
      content: ev.content as string,
      timestamp: new Date(),
      provider: ev.provider as string | undefined,
      model: ev.model as string | undefined,
      modelSpec: ev.modelSpec as string | undefined,
      requestedModelSpec: ev.requestedModelSpec as string | undefined,
    });
    scrollToBottom();
  } else if (ev.type === "system" || ev.type === "event") {
    thinking.value = false;
    messages.value.push({
      id: ++msgId,
      role: "system",
      content: (ev.content ?? ev.summary ?? JSON.stringify(ev)) as string,
      timestamp: new Date(),
    });
    scrollToBottom();
  }
});

async function loadHistory(sid: string) {
  try {
    const res = await fetch(`/api/chats/${sid}`);
    if (!res.ok) return;
    const log = await res.json();
    if (!log.messages?.length) return;
    if (messages.value.length > 0) return;
    for (const msg of log.messages) {
      messages.value.push({
        id: ++msgId,
        role: msg.role,
        content: msg.content,
        timestamp: new Date(msg.timestamp),
        provider: msg.provider,
        model: msg.model,
        modelSpec: msg.modelSpec,
        requestedModelSpec: msg.requestedModelSpec,
      });
    }
    scrollToBottom();
  } catch { /* ignore */ }
}

function sendMessage() {
  const text = inputText.value.trim();
  if (!text || !connected.value) return;
  messages.value.push({
    id: ++msgId,
    role: "user",
    content: text,
    timestamp: new Date(),
  });
  send(JSON.stringify({ type: "message", content: text }));
  inputText.value = "";
  scrollToBottom();
}

function scrollToBottom() {
  nextTick(() => {
    if (chatBody.value) {
      chatBody.value.scrollTop = chatBody.value.scrollHeight;
    }
  });
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function roleLabel(role: Message["role"]): string {
  if (role === "assistant") return "Saivage";
  if (role === "system") return "Event";
  return "You";
}

function modelLabel(msg: Message): string {
  return msg.modelSpec ?? (msg.provider && msg.model ? `${msg.provider}/${msg.model}` : "");
}
</script>

<template>
  <section class="chat-window">
    <div class="panel-heading chat-heading">
      <div>
        <h2>Command Stream</h2>
        <span>{{ sessionLabel }}</span>
      </div>
      <div class="connection" :class="{ online: connected }">
        <Wifi v-if="connected" :size="15" />
        <WifiOff v-else :size="15" />
        <span>{{ connected ? 'connected' : 'offline' }}</span>
      </div>
    </div>

    <div class="chat-body" ref="chatBody">
      <div v-if="messages.length === 0 && !thinking" class="chat-empty">
        <div class="empty-title">Ready for operator input</div>
        <div class="empty-copy">Ask for status, add a note, or steer the current run.</div>
      </div>

      <article v-for="msg in messages" :key="msg.id" class="msg" :class="msg.role">
        <div class="msg-meta">
          <span class="msg-role">{{ roleLabel(msg.role) }}</span>
          <span v-if="msg.role === 'assistant' && modelLabel(msg)" class="model-chip">{{ modelLabel(msg) }}</span>
          <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
        </div>
        <div v-if="msg.role === 'assistant'" class="msg-content" v-html="renderMarkdown(msg.content)"></div>
        <div v-else class="msg-content">{{ msg.content }}</div>
      </article>

      <article v-if="thinking" class="msg assistant compact">
        <div class="msg-meta"><span class="msg-role">Saivage</span></div>
        <div class="msg-content thinking-dots"><span></span><span></span><span></span></div>
      </article>
    </div>

    <form class="chat-input" @submit.prevent="sendMessage">
      <input
        v-model="inputText"
        type="text"
        placeholder="Send a runtime instruction or question"
        :disabled="!connected"
        autocomplete="off"
      />
      <button class="send-btn" type="submit" :disabled="!connected || !inputText.trim()" title="Send message">
        <SendHorizontal :size="17" />
        <span>Send</span>
      </button>
    </form>
  </section>
</template>

<style scoped>
.chat-window {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.chat-heading > div:first-child {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.chat-heading span {
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 11px;
}

.connection {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  color: var(--danger);
  font-size: 12px;
}

.connection.online {
  color: var(--accent-2);
}

.chat-body {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px;
}

.chat-empty {
  display: grid;
  align-content: center;
  min-height: 180px;
  border: 1px dashed var(--border);
  border-radius: var(--radius);
  color: var(--text-muted);
  text-align: center;
}

.empty-title {
  color: var(--text);
  font-weight: 650;
}

.empty-copy {
  margin-top: 4px;
  font-size: 13px;
}

.msg {
  width: min(780px, 92%);
  margin-bottom: 14px;
}

.msg.user {
  margin-left: auto;
}

.msg.system {
  width: min(860px, 96%);
  margin-left: auto;
  margin-right: auto;
}

.msg-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 4px;
}

.msg-role {
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.msg.assistant .msg-role { color: var(--accent-2); }
.msg.user .msg-role { color: var(--accent); }
.msg.system .msg-role { color: var(--warn); }

.msg-time {
  color: var(--text-faint);
  font-size: 11px;
  font-family: var(--mono);
}

.model-chip {
  overflow: hidden;
  max-width: min(360px, 55vw);
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  text-overflow: ellipsis;
  text-transform: none;
  white-space: nowrap;
}

.msg-content {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  color: var(--text);
  background: var(--surface-1);
  font-size: 13px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.msg.user .msg-content {
  border-color: rgba(106, 166, 255, 0.36);
  background: rgba(106, 166, 255, 0.14);
}

.msg.system .msg-content {
  border-color: rgba(224, 169, 68, 0.35);
  color: #efc977;
  background: rgba(224, 169, 68, 0.08);
  font-size: 12px;
}

.thinking-dots {
  display: inline-flex;
  gap: 5px;
  width: auto;
  padding: 12px 14px !important;
}

.thinking-dots span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-muted);
  animation: dot-pulse 1.4s ease-in-out infinite;
}

.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }

@keyframes dot-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

.msg.assistant .msg-content :deep(strong) { color: #eef4fb; font-weight: 650; }
.msg.assistant .msg-content :deep(em) { font-style: italic; }
.msg.assistant .msg-content :deep(.md-h1) { display: block; font-size: 16px; margin: 8px 0 4px; }
.msg.assistant .msg-content :deep(.md-h2) { display: block; font-size: 14px; margin: 6px 0 3px; }
.msg.assistant .msg-content :deep(.md-h3) { display: block; font-size: 13px; margin: 4px 0 2px; }
.msg.assistant .msg-content :deep(.md-code) { background: var(--bg); color: #9dd2ff; padding: 1px 5px; border-radius: 3px; font-family: var(--mono); font-size: 12px; }
.msg.assistant .msg-content :deep(.md-code-block) { background: var(--bg); padding: 10px 12px; border-radius: 6px; margin: 6px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre; }
.msg.assistant .msg-content :deep(.md-code-block code) { font-family: var(--mono); color: var(--text); }
.msg.assistant .msg-content :deep(.md-bullet) { display: block; padding-left: 8px; }

.chat-input {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface-1);
}

.chat-input input {
  min-width: 0;
  height: 38px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  padding: 0 12px;
  outline: none;
  color: var(--text);
  background: var(--bg);
  font-size: 13px;
}

.chat-input input:focus {
  border-color: var(--accent);
}

.send-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  height: 38px;
  min-width: 92px;
  border: 1px solid rgba(41, 199, 138, 0.45);
  border-radius: 7px;
  color: #e8fff5;
  background: #16875c;
  cursor: pointer;
  font-size: 13px;
  font-weight: 650;
}

.send-btn:hover:not(:disabled) {
  background: #1a9b6a;
}

.send-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
</style>
