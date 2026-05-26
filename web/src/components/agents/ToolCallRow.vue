<script setup lang="ts">
import FormattedContent from "../FormattedContent.vue";
import { formatToolPair, type InlinePart } from "../../utils/toolFormatters";
import type { ToolPair } from "./types";
import { FORMATTED_CONTENT_MAX_HEIGHT_TOOL_DETAIL } from "./constants";

const props = defineProps<{
  pair: ToolPair;
  open: boolean;
}>();

const emit = defineEmits<{
  toggle: [id: string];
  "open-file": [payload: { path: string; root: "project" | "saivage" }];
}>();

function formatted() {
  return formatToolPair(
    props.pair.toolName,
    props.pair.call?.content,
    props.pair.result?.content,
    props.pair.status === "error",
  );
}

function onPartClick(part: InlinePart) {
  if (part.kind === "file") {
    emit("open-file", { path: part.path, root: part.root ?? "project" });
  } else if (part.kind === "url") {
    window.open(part.url, "_blank", "noopener,noreferrer");
  }
}
</script>

<template>
  <button
    class="agent-tool-row"
    :data-status="pair.status"
    :data-open="open ? 'true' : 'false'"
    :aria-expanded="open"
    :aria-label="`tool ${pair.toolName} ${pair.status}`"
    :title="pair.call?.timestamp ? new Date(pair.call.timestamp).toLocaleString() : undefined"
    @click="emit('toggle', pair.toolUseId)"
  >
    <span class="chevron" aria-hidden="true">&rsaquo;</span>
    <strong>{{ formatted().label }}</strong>
    <span class="agent-tool-summary">
      <template v-for="(part, idx) in formatted().summary" :key="`s${idx}`">
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
    <span class="agent-tool-result" :data-tone="formatted().resultTone || undefined">
      <template v-if="pair.status === 'pending'">...</template>
      <template v-else-if="pair.status === 'missing'">no result</template>
      <template v-else>
        <template v-for="(part, idx) in formatted().result" :key="`r${idx}`">
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
  <div v-if="open" class="agent-tool-detail">
    <div v-if="pair.call" class="agent-tool-detail-block">
      <span class="agent-tool-detail-label">input</span>
      <FormattedContent :content="pair.call.content" :max-height="FORMATTED_CONTENT_MAX_HEIGHT_TOOL_DETAIL" />
    </div>
    <div v-if="pair.result" class="agent-tool-detail-block" :class="{ error: pair.status === 'error' }">
      <span class="agent-tool-detail-label">{{ pair.status === 'error' ? 'error' : 'result' }}</span>
      <FormattedContent :content="pair.result.content" :max-height="FORMATTED_CONTENT_MAX_HEIGHT_TOOL_DETAIL" />
    </div>
  </div>
</template>

<style scoped>
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

.agent-tool-row:hover { background: var(--surface-2); }
.agent-tool-row strong {
  overflow: hidden;
  color: var(--accent);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chevron {
  display: inline-block;
  color: var(--text-faint);
  transition: transform 0.12s ease;
}
.agent-tool-row[data-open="true"] .chevron { transform: rotate(90deg); }
.agent-tool-summary,
.agent-tool-result {
  overflow: hidden;
  color: var(--text-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-tool-summary { color: var(--text-muted); }
[data-tone="ok"] { color: var(--accent-2); }
[data-tone="warn"] { color: var(--warn); }
[data-tone="error"] { color: var(--danger); }
[data-tone="muted"] { color: var(--text-faint); }
.tool-link {
  border-bottom: 1px dotted transparent;
  color: var(--accent);
  text-decoration: none;
}
.agent-tool-row:hover .tool-link { border-bottom-color: currentColor; }
.tool-link:hover { color: var(--accent-2); }
.tool-code {
  padding: 0;
  background: transparent;
  color: var(--text);
  font-family: var(--mono);
  font-size: inherit;
}
.agent-tool-row[data-status="ok"] strong { color: var(--accent-2); }
.agent-tool-row[data-status="pending"] strong,
.agent-tool-row[data-status="pending"] .agent-tool-result { color: var(--accent); }
.agent-tool-row[data-status="pending"] .agent-tool-result { font-style: italic; }
.agent-tool-row[data-status="error"] strong,
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
  color: var(--text);
  font-size: 12px;
  line-height: 1.5;
}
.agent-tool-detail-block.error { color: var(--danger); }
.agent-tool-detail-label {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
@media (max-width: 900px) {
  .agent-tool-row {
    grid-template-columns: 14px 1fr;
    grid-auto-flow: row;
  }
}
</style>
