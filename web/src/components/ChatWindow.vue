<script setup lang="ts">
import { ref, nextTick, watch } from "vue";
import { useWebSocket } from "../composables/useWebSocket";
import { renderMarkdown } from "../utils/markdown";

interface Message {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

const messages = ref<Message[]>([]);
const inputText = ref("");
const chatBody = ref<HTMLElement | null>(null);
const thinking = ref(false);
const sessionId = ref<string | null>(null);
let msgId = 0;

const { connected, events, send } = useWebSocket();

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

</script>

<template>
  <div class="chat-window">
    <div class="chat-header">
      <span class="chat-title">Chat</span>
      <span class="conn-badge" :class="{ online: connected }">{{ connected ? 'connected' : 'disconnected' }}</span>
      <span v-if="sessionId" class="session-badge">{{ sessionId.slice(0, 12) }}</span>
    </div>

    <div class="chat-body" ref="chatBody">
      <div v-if="messages.length === 0 && !thinking" class="chat-empty">
        Send a message to interact with the Saivage assistant.
      </div>
      <div v-for="msg in messages" :key="msg.id" class="msg" :class="msg.role">
        <div class="msg-meta">
          <span class="msg-role">{{ msg.role }}</span>
          <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
        </div>
        <div v-if="msg.role === 'assistant'" class="msg-content" v-html="renderMarkdown(msg.content)"></div>
        <div v-else class="msg-content">{{ msg.content }}</div>
      </div>
      <div v-if="thinking" class="msg assistant">
        <div class="msg-meta"><span class="msg-role">assistant</span></div>
        <div class="msg-content thinking-dots"><span></span><span></span><span></span></div>
      </div>
    </div>

    <form class="chat-input" @submit.prevent="sendMessage">
      <input
        v-model="inputText"
        type="text"
        placeholder="Type a message…"
        :disabled="!connected"
        autocomplete="off"
      />
      <button type="submit" :disabled="!connected || !inputText.trim()">Send</button>
    </form>
  </div>
</template>

<style scoped>
.chat-window { display: flex; flex-direction: column; height: 100%; background: #0d1117; }

.chat-header { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #21262d; flex-shrink: 0; }
.chat-title { font-size: 14px; font-weight: 600; color: #c9d1d9; }
.conn-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; color: #f85149; background: rgba(248, 81, 73, 0.1); }
.conn-badge.online { color: #3fb950; background: rgba(63, 185, 80, 0.1); }
.session-badge { font-size: 10px; color: #8b949e; font-family: monospace; }
.session-badge { font-size: 10px; font-family: monospace; color: #8b949e; margin-left: auto; }

.chat-body { flex: 1; overflow-y: auto; padding: 16px; }
.chat-empty { color: #484f58; font-size: 14px; text-align: center; padding: 48px 16px; }

.msg { margin-bottom: 12px; max-width: 85%; }
.msg.user { margin-left: auto; }
.msg.assistant { margin-right: auto; }
.msg.system { margin-left: auto; margin-right: auto; max-width: 90%; }

.msg-meta { display: flex; gap: 8px; margin-bottom: 3px; }
.msg-role { font-size: 11px; font-weight: 600; text-transform: uppercase; }
.msg.user .msg-role { color: #58a6ff; }
.msg.assistant .msg-role { color: #3fb950; }
.msg.system .msg-role { color: #d29922; }
.msg-time { font-size: 10px; color: #484f58; }

.msg-content { font-size: 13px; line-height: 1.5; padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; word-break: break-word; }
.msg.user .msg-content { background: #1f6feb; color: #fff; border-bottom-right-radius: 2px; }
.msg.assistant .msg-content { background: #161b22; color: #c9d1d9; border: 1px solid #21262d; border-bottom-left-radius: 2px; }
.msg.system .msg-content { background: rgba(210, 153, 34, 0.08); color: #d29922; font-size: 12px; text-align: center; border-radius: 4px; border: 1px solid rgba(210, 153, 34, 0.15); }
.msg.system .msg-content.stage-event { text-align: left; font-size: 11px; }

/* Thinking dots */
.thinking-dots { display: flex; gap: 4px; padding: 12px 16px !important; }
.thinking-dots span { width: 8px; height: 8px; background: #8b949e; border-radius: 50%; animation: dot-pulse 1.4s ease-in-out infinite; }
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dot-pulse { 0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); } 40% { opacity: 1; transform: scale(1); } }

/* Markdown in assistant messages */
.msg.assistant .msg-content :deep(strong) { color: #e6edf3; font-weight: 600; }
.msg.assistant .msg-content :deep(em) { font-style: italic; }
.msg.assistant .msg-content :deep(.md-h1) { display: block; font-size: 16px; margin: 8px 0 4px; }
.msg.assistant .msg-content :deep(.md-h2) { display: block; font-size: 14px; margin: 6px 0 3px; }
.msg.assistant .msg-content :deep(.md-h3) { display: block; font-size: 13px; margin: 4px 0 2px; }
.msg.assistant .msg-content :deep(.md-code) { background: #0d1117; color: #79c0ff; padding: 1px 5px; border-radius: 3px; font-family: monospace; font-size: 12px; }
.msg.assistant .msg-content :deep(.md-code-block) { background: #0d1117; padding: 10px 12px; border-radius: 6px; margin: 6px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre; }
.msg.assistant .msg-content :deep(.md-code-block code) { font-family: monospace; color: #c9d1d9; }
.msg.assistant .msg-content :deep(.md-bullet) { display: block; padding-left: 8px; }

.chat-input { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #21262d; background: #161b22; flex-shrink: 0; }
.chat-input input { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #c9d1d9; font-size: 13px; outline: none; }
.chat-input input:focus { border-color: #58a6ff; }
.chat-input input:disabled { opacity: 0.5; }
.chat-input button { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
.chat-input button:hover:not(:disabled) { background: #2ea043; }
.chat-input button:disabled { opacity: 0.5; cursor: default; }
</style>
