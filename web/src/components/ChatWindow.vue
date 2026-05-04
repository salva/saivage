<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { SendHorizontal, Wifi, WifiOff, ShieldAlert, Loader2, ArrowDown, KeyRound } from "lucide-vue-next";
import { useWebSocket } from "../composables/useWebSocket";
import { renderMarkdown } from "../utils/markdown";
import { apiFetchJson, getApiToken, setApiToken } from "../utils/api";
import { clockTime } from "../utils/time";

defineExpose<{
  focusInput: () => void;
}>({
  focusInput: () => focusInput(),
});

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
const inputRef = ref<HTMLTextAreaElement | null>(null);
const chatBody = ref<HTMLElement | null>(null);
const thinking = ref(false);
const sessionId = ref<string | null>(null);
let msgId = 0;
const loadedHistoryFor = ref<string | null>(null);
const stickToBottom = ref(true);
const unseenCount = ref(0);
const tokenInput = ref("");

const { connected, status, events, send, reconnect } = useWebSocket();

// Debounce the visible status by 400 ms so rapid connecting/closed flicker
// during reconnect attempts doesn't strobe the chip.
const displayStatus = ref(status.value);
let statusDebounceTimer: ReturnType<typeof setTimeout> | null = null;
watch(status, (next) => {
  if (next === "open" || next === "unauthorized") {
    if (statusDebounceTimer) clearTimeout(statusDebounceTimer);
    statusDebounceTimer = null;
    displayStatus.value = next;
    return;
  }
  if (statusDebounceTimer) clearTimeout(statusDebounceTimer);
  statusDebounceTimer = setTimeout(() => {
    displayStatus.value = next;
    statusDebounceTimer = null;
  }, 400);
});

const sessionLabel = computed(() => sessionId.value ? sessionId.value.slice(0, 14) : "new session");
const connectionLabel = computed(() => {
  switch (displayStatus.value) {
    case "open": return "connected";
    case "connecting": return "connecting…";
    case "unauthorized": return "unauthorized";
    default: return "offline";
  }
});
const inputDisabled = computed(() => !connected.value);

watch(() => events.value.length, () => {
  const ev = events.value[events.value.length - 1];
  if (!ev) return;

  if (ev.type === "session" && ev.sessionId) {
    const newSid = ev.sessionId as string;
    // The server hands out a fresh session id on every WebSocket
    // connection. A reconnect therefore arrives as a "new" session even
    // though the operator has not asked for one. Treat the first session
    // event after reconnect as informational: keep on-screen history
    // intact, just track the new id.
    sessionId.value = newSid;
    if (loadedHistoryFor.value !== newSid && messages.value.length === 0) {
      loadHistory(newSid);
    } else {
      loadedHistoryFor.value = newSid;
    }
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
    if (stickToBottom.value) scrollToBottom();
    else unseenCount.value += 1;
  } else if (ev.type === "system" || ev.type === "event") {
    thinking.value = false;
    messages.value.push({
      id: ++msgId,
      role: "system",
      content: (ev.content ?? ev.summary ?? JSON.stringify(ev)) as string,
      timestamp: new Date(),
    });
    if (stickToBottom.value) scrollToBottom();
    else unseenCount.value += 1;
  }
});

async function loadHistory(sid: string) {
  try {
    const log = await apiFetchJson<{ messages?: Array<{ role: Message["role"]; content: string; timestamp: string; provider?: string; model?: string; modelSpec?: string; requestedModelSpec?: string }> }>(`/api/chats/${sid}`);
    loadedHistoryFor.value = sid;
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
  } catch (err) {
    console.warn(`[chat] failed to load history for ${sid}`, err);
  }
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
  stickToBottom.value = true;
  unseenCount.value = 0;
  resizeInput();
  scrollToBottom(true);
}

function handleInputKeydown(event: KeyboardEvent) {
  // Enter sends; Shift+Enter (or Ctrl/Meta+Enter for symmetry) inserts a newline.
  if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
    event.preventDefault();
    sendMessage();
  }
}

function onInput() {
  resizeInput();
}

function resizeInput() {
  const el = inputRef.value;
  if (!el) return;
  el.style.height = "auto";
  // 8 lines max ~ 18 px line-height + padding
  const max = 8 * 20 + 12;
  el.style.height = `${Math.min(el.scrollHeight, max)}px`;
}

function focusInput() {
  inputRef.value?.focus();
}

function onScroll() {
  if (!chatBody.value) return;
  stickToBottom.value = isAtBottom();
  if (stickToBottom.value) unseenCount.value = 0;
}

function isAtBottom(): boolean {
  const el = chatBody.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}

function scrollToBottom(force = false) {
  nextTick(() => {
    const el = chatBody.value;
    if (!el) return;
    if (force || stickToBottom.value) {
      el.scrollTop = el.scrollHeight;
      unseenCount.value = 0;
    }
  });
}

function jumpToLatest() {
  stickToBottom.value = true;
  scrollToBottom(true);
}

function submitToken() {
  const value = tokenInput.value.trim();
  if (!value) return;
  setApiToken(value);
  tokenInput.value = "";
  reconnect();
}

onMounted(() => {
  // Pre-fill the token field if one is already stored, so the operator can
  // see what's being used without copying credentials around.
  tokenInput.value = getApiToken() ?? "";
  resizeInput();
});

onUnmounted(() => {
  if (statusDebounceTimer) clearTimeout(statusDebounceTimer);
});

function formatTime(d: Date): string {
  return clockTime(d);
}

function roleLabel(role: Message["role"]): string {
  if (role === "assistant") return "Saivage";
  if (role === "system") return "Event";
  return "You";
}

function modelLabel(msg: Message): string {
  return msg.modelSpec ?? (msg.provider && msg.model ? `${msg.provider}/${msg.model}` : "");
}

function shortModelLabel(msg: Message): string {
  const full = modelLabel(msg);
  if (!full) return "";
  // Show only the model id (provider/model -> model). Preserves the full
  // string in the title attribute for hover discovery.
  const slash = full.lastIndexOf("/");
  return slash === -1 ? full : full.slice(slash + 1);
}
</script>

<template>
  <section class="chat-window">
    <div class="panel-heading chat-heading">
      <div>
        <h2>Command Stream</h2>
        <span>{{ sessionLabel }}</span>
      </div>
      <div class="connection" :class="{ online: connected, unauthorized: displayStatus === 'unauthorized', connecting: displayStatus === 'connecting' }">
        <ShieldAlert v-if="displayStatus === 'unauthorized'" :size="15" />
        <Loader2 v-else-if="displayStatus === 'connecting'" :size="15" class="spin" />
        <Wifi v-else-if="connected" :size="15" />
        <WifiOff v-else :size="15" />
        <span>{{ connectionLabel }}</span>
      </div>
    </div>

    <div
      v-if="displayStatus === 'unauthorized'"
      class="auth-panel"
      role="alert"
      aria-live="polite"
    >
      <div class="auth-icon"><KeyRound :size="22" /></div>
      <div class="auth-body">
        <strong>Saivage requires an API token</strong>
        <p>The server has <code>SAIVAGE_API_TOKEN</code> set. Paste the token below to connect; it is stored in this browser only.</p>
        <form class="auth-form" @submit.prevent="submitToken">
          <input
            v-model="tokenInput"
            type="password"
            placeholder="Paste API token"
            autocomplete="off"
            spellcheck="false"
            aria-label="API token"
          />
          <button class="console-button" type="submit" :disabled="!tokenInput.trim()">Connect</button>
        </form>
      </div>
    </div>

    <div class="chat-body" ref="chatBody" @scroll.passive="onScroll">
      <div v-if="messages.length === 0 && !thinking" class="chat-empty">
        <div class="empty-title">Ready for operator input</div>
        <div class="empty-copy">Ask for status, add a note, or steer the current run.</div>
      </div>

      <article v-for="msg in messages" :key="msg.id" class="msg" :class="msg.role">
        <div class="msg-meta">
          <span class="msg-role">{{ roleLabel(msg.role) }}</span>
          <span v-if="msg.role === 'assistant' && modelLabel(msg)" class="model-chip" :title="modelLabel(msg)">{{ shortModelLabel(msg) }}</span>
          <time class="msg-time" :title="msg.timestamp.toLocaleString()">{{ formatTime(msg.timestamp) }}</time>
        </div>
        <div v-if="msg.role === 'assistant'" class="msg-content" v-html="renderMarkdown(msg.content)"></div>
        <div v-else class="msg-content">{{ msg.content }}</div>
      </article>

      <article v-if="thinking" class="msg assistant compact">
        <div class="msg-meta"><span class="msg-role">Saivage</span></div>
        <div class="msg-content thinking-dots"><span></span><span></span><span></span></div>
      </article>
    </div>

    <button
      v-if="!stickToBottom && messages.length > 0"
      type="button"
      class="jump-latest"
      :class="{ unseen: unseenCount > 0 }"
      @click="jumpToLatest"
      aria-label="Scroll to latest messages"
    >
      <ArrowDown :size="14" />
      <span v-if="unseenCount > 0">{{ unseenCount }} new</span>
      <span v-else>Jump to latest</span>
    </button>

    <form class="chat-input" @submit.prevent="sendMessage">
      <textarea
        ref="inputRef"
        v-model="inputText"
        rows="1"
        :placeholder="inputDisabled ? 'Waiting for connection…' : 'Send a runtime instruction · Enter to send · Shift+Enter for newline'"
        :disabled="inputDisabled"
        autocomplete="off"
        spellcheck="false"
        @keydown="handleInputKeydown"
        @input="onInput"
      ></textarea>
      <button class="send-btn" type="submit" :disabled="inputDisabled || !inputText.trim()" title="Send message (Enter)" aria-label="Send message">
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

.connection.unauthorized {
  color: var(--warning, #d29922);
}

.connection.connecting {
  color: var(--text-muted);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
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
.msg.assistant .msg-content :deep(.md-bullet) {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 4px;
  align-items: baseline;
  padding: 1px 0 1px 6px;
}
.msg.assistant .msg-content :deep(.md-marker) {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
  user-select: none;
}
.msg.assistant .msg-content :deep(.md-bullet-text) { min-width: 0; }

.chat-input {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid var(--border);
  background: var(--surface-1);
  align-items: end;
}

.chat-input textarea {
  min-width: 0;
  min-height: 38px;
  max-height: 172px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  padding: 9px 12px;
  outline: none;
  color: var(--text);
  background: var(--bg);
  font-size: 13px;
  font-family: inherit;
  line-height: 1.4;
  resize: none;
  overflow-y: auto;
}

.chat-input textarea:focus {
  border-color: var(--accent);
}

.chat-input textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
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

.auth-panel {
  display: flex;
  gap: 14px;
  margin: 12px 16px 0;
  padding: 14px 16px;
  border: 1px solid rgba(255, 173, 102, 0.5);
  border-radius: 8px;
  background: rgba(255, 173, 102, 0.08);
  align-items: flex-start;
}
.auth-icon {
  flex: 0 0 auto;
  color: var(--warn, #ffae66);
  margin-top: 2px;
}
.auth-body { flex: 1 1 auto; min-width: 0; }
.auth-body strong { display: block; color: var(--text); font-size: 13px; margin-bottom: 4px; }
.auth-body p { margin: 0 0 10px; color: var(--text-muted); font-size: 12.5px; line-height: 1.5; }
.auth-body code { font-family: var(--mono); font-size: 12px; color: #ffd1a8; }
.auth-form { display: flex; gap: 8px; }
.auth-form input {
  flex: 1 1 auto;
  min-width: 0;
  height: 34px;
  border: 1px solid var(--border-strong);
  border-radius: 6px;
  padding: 0 10px;
  background: var(--bg);
  color: var(--text);
  font-family: var(--mono);
  font-size: 12.5px;
  outline: none;
}
.auth-form input:focus { border-color: var(--warn, #ffae66); }
.auth-form button { height: 34px; }

.jump-latest {
  position: absolute;
  right: 24px;
  bottom: 86px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  z-index: 2;
}
.jump-latest:hover { background: var(--surface-3); }
.jump-latest.unseen {
  border-color: var(--accent);
  color: var(--accent);
  background: rgba(41, 199, 138, 0.08);
}
.chat-window { position: relative; }
</style>
