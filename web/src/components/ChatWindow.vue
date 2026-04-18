<script setup lang="ts">
import { ref, nextTick, watch } from "vue";
import { useWebSocket } from "../composables/useWebSocket";

interface Message {
  id: number;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: Date;
}

const messages = ref<Message[]>([]);
const inputText = ref("");
const chatBody = ref<HTMLElement | null>(null);
let msgId = 0;

const { connected, events, send } = useWebSocket();

watch(() => events.value.length, () => {
  const ev = events.value[events.value.length - 1];
  if (!ev) return;
  if (ev.type === "message" && ev.content) {
    messages.value.push({
      id: ++msgId,
      role: "assistant",
      content: ev.content as string,
      timestamp: new Date(),
    });
    scrollToBottom();
  } else if (ev.type === "system" || ev.type === "event") {
    messages.value.push({
      id: ++msgId,
      role: "system",
      content: (ev.content ?? ev.summary ?? JSON.stringify(ev)) as string,
      timestamp: new Date(),
    });
    scrollToBottom();
  }
});

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
    </div>

    <div class="chat-body" ref="chatBody">
      <div v-if="messages.length === 0" class="chat-empty">
        Send a message to interact with the Saivage v2 assistant.
      </div>
      <div v-for="msg in messages" :key="msg.id" class="msg" :class="msg.role">
        <div class="msg-meta">
          <span class="msg-role">{{ msg.role }}</span>
          <span class="msg-time">{{ formatTime(msg.timestamp) }}</span>
        </div>
        <div class="msg-content" v-text="msg.content"></div>
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
.chat-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid #21262d; flex-shrink: 0; }
.chat-title { font-size: 14px; font-weight: 600; color: #c9d1d9; }
.conn-badge { font-size: 11px; padding: 2px 8px; border-radius: 10px; color: #f85149; background: rgba(248, 81, 73, 0.1); }
.conn-badge.online { color: #3fb950; background: rgba(63, 185, 80, 0.1); }
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
.msg.system .msg-content { background: rgba(210, 153, 34, 0.1); color: #d29922; font-size: 12px; text-align: center; border-radius: 4px; }
.chat-input { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #21262d; background: #161b22; flex-shrink: 0; }
.chat-input input { flex: 1; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; color: #c9d1d9; font-size: 13px; outline: none; }
.chat-input input:focus { border-color: #58a6ff; }
.chat-input input:disabled { opacity: 0.5; }
.chat-input button { background: #238636; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
.chat-input button:hover:not(:disabled) { background: #2ea043; }
.chat-input button:disabled { opacity: 0.5; cursor: default; }
</style>
