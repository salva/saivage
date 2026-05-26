<script setup lang="ts">
import FormattedContent from "../FormattedContent.vue";
import type { ChatLog, ChatMessage } from "../../api/types";
import { FORMATTED_CONTENT_MAX_HEIGHT_CHAT_MSG } from "./constants";

defineProps<{
  session: ChatLog;
}>();

function parseContent(content: string): string {
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content) as { content?: unknown };
      if (typeof parsed.content === "string") return parsed.content;
    } catch {
      // not JSON
    }
  }
  return content;
}

function formatHms(ts: string): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function modelLabel(source: Pick<ChatMessage, "provider" | "model" | "modelSpec">): string {
  return source.modelSpec ?? (source.provider && source.model ? `${source.provider}/${source.model}` : "");
}
</script>

<template>
  <div class="thread-header">
    <code>{{ session.session_id }}</code>
    <span>{{ session.channel }}</span>
    <span>{{ session.messages.length }} messages</span>
    <span class="live-time">{{ new Date(session.started_at).toLocaleString() }}</span>
  </div>

  <div class="thread-body">
    <article v-for="msg in session.messages" :key="msg.id" class="chat-msg" :class="msg.role">
      <div class="entry-label">
        <span>{{ msg.role }}</span>
        <em v-if="msg.role === 'assistant' && modelLabel(msg)" class="model-chip">{{ modelLabel(msg) }}</em>
        <time>{{ formatHms(msg.timestamp) }}</time>
        <em v-if="msg.event">{{ msg.event.type }}</em>
      </div>
      <div class="entry-content text-entry">
        <FormattedContent :content="parseContent(msg.content)" :max-height="FORMATTED_CONTENT_MAX_HEIGHT_CHAT_MSG" />
      </div>
    </article>
  </div>
</template>

<style scoped>
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
.thread-header code {
  color: var(--text);
  font-family: var(--mono);
}
.live-time {
  margin-left: auto;
  color: var(--warn);
  font-family: var(--mono);
}
.thread-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}
.chat-msg { margin-bottom: 10px; }
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
.model-chip {
  overflow: hidden;
  max-width: min(360px, 50vw);
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
  line-height: 1.2;
  text-overflow: ellipsis;
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
.text-entry { padding: 9px 11px; }
.chat-msg.user .text-entry {
  border-color: var(--entry-user-border);
  background: var(--entry-user-bg);
}
@media (max-width: 900px) {
  .thread-header {
    flex-wrap: wrap;
    height: auto;
    padding: 10px 16px;
  }
  .live-time { margin-left: 0; }
}
</style>
