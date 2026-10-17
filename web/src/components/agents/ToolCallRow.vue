<script setup lang="ts">
import { computed } from "vue";
import ToolDetailPanel from "./ToolDetailPanel.vue";
import { buildToolDisplay, type InlinePart } from "../../utils/toolDisplay";
import type { ToolPair } from "./types";

const props = defineProps<{
  pair: ToolPair;
  open: boolean;
}>();

const emit = defineEmits<{
  toggle: [id: string];
  "open-file": [payload: { path: string; root: "project" | "saivage"; line?: number }];
  "open-conversation": [payload: { agentId: string; roundId?: string }];
}>();

const display = computed(() => buildToolDisplay(props.pair));

function onPartClick(part: InlinePart) {
  if (part.kind === "file") {
    emit("open-file", { path: part.path, root: part.root ?? "project", ...(part.line !== undefined ? { line: part.line } : {}) });
  } else if (part.kind === "url") {
    window.open(part.url, "_blank", "noopener,noreferrer");
  } else if (part.kind === "conversation" && part.agentId) {
    emit("open-conversation", { agentId: part.agentId, ...(part.roundId ? { roundId: part.roundId } : {}) });
  }
}

function partLabel(part: InlinePart): string {
  if (part.kind === "file") return part.line ? `${part.path}:${part.line}` : part.path;
  if (part.kind === "url") return part.url;
  if (part.kind === "conversation") return part.label;
  return part.value;
}

function isClickable(part: InlinePart): boolean {
  if (part.kind === "file" || part.kind === "url") return true;
  if (part.kind === "conversation") return !!part.agentId;
  return false;
}

function displayTitle(): string {
  const target = display.value.target.map(partLabel).join("");
  const status = display.value.status.map(partLabel).join("");
  return `${display.value.action} ${target} ${status}`.trim();
  }
</script>

<template>
  <button
    class="agent-tool-row"
    :data-status="pair.status"
    :data-tone="display.tone"
    :data-open="open ? 'true' : 'false'"
    :aria-expanded="open"
    :aria-label="`tool ${pair.toolName} ${pair.status}: ${displayTitle()}`"
    :title="pair.call?.timestamp ? new Date(pair.call.timestamp).toLocaleString() : undefined"
    @click="emit('toggle', pair.toolUseId)"
  >
    <span class="chevron" aria-hidden="true">&rsaquo;</span>
    <strong>{{ display.action }}</strong>
    <span class="agent-tool-target">
      <template v-for="(part, idx) in display.target" :key="`t${idx}`">
        <span
          v-if="isClickable(part)"
          class="tool-link"
          role="button"
          tabindex="0"
          @click.stop.prevent="onPartClick(part)"
          @keydown.enter.stop.prevent="onPartClick(part)"
          @keydown.space.stop.prevent="onPartClick(part)"
        >{{ partLabel(part) }}</span>
        <code v-else-if="part.kind === 'code'" class="tool-code">{{ part.value }}</code>
        <span v-else :data-tone="part.kind === 'text' ? part.tone || undefined : undefined">{{ partLabel(part) }}</span>
      </template>
    </span>
    <span class="agent-tool-status" :data-tone="display.tone || undefined">
      <template v-if="pair.status === 'pending'">...</template>
      <template v-else-if="pair.status === 'missing'">no result</template>
      <template v-else>
        <template v-for="(part, idx) in display.status" :key="`s${idx}`">
          <span
            v-if="isClickable(part)"
            class="tool-link"
            role="button"
            tabindex="0"
            @click.stop.prevent="onPartClick(part)"
            @keydown.enter.stop.prevent="onPartClick(part)"
            @keydown.space.stop.prevent="onPartClick(part)"
          >{{ partLabel(part) }}</span>
          <code v-else-if="part.kind === 'code'" class="tool-code">{{ part.value }}</code>
          <span v-else :data-tone="part.kind === 'text' ? part.tone || undefined : undefined">{{ partLabel(part) }}</span>
        </template>
      </template>
    </span>
  </button>
  <div v-if="open" class="agent-tool-detail">
    <ToolDetailPanel
      :pair="pair"
      :display="display"
      @open-file="emit('open-file', $event)"
      @open-conversation="emit('open-conversation', $event)"
    />
  </div>
</template>

<style scoped>
.agent-tool-row {
  display: grid;
  grid-template-columns: 14px auto minmax(0, 1fr) max-content;
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
.agent-tool-target,
.agent-tool-status {
  overflow: hidden;
  color: var(--text-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.agent-tool-target { color: var(--text-muted); }
.agent-tool-status { justify-self: end; max-width: min(42vw, 520px); }
[data-tone="ok"] { color: var(--accent-2); }
[data-tone="warn"] { color: var(--warn); }
[data-tone="error"] { color: var(--danger); }
[data-tone="pending"] { color: var(--accent); }
[data-tone="muted"] { color: var(--text-faint); }
.tool-link {
  display: inline;
  margin: 0;
  padding: 0;
  border: 0;
  border-bottom: 1px dotted transparent;
  color: var(--accent);
  background: transparent;
  cursor: pointer;
  font: inherit;
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
.agent-tool-row[data-tone="ok"] strong { color: var(--accent-2); }
.agent-tool-row[data-status="pending"] strong,
.agent-tool-row[data-status="pending"] .agent-tool-status { color: var(--accent); }
.agent-tool-row[data-status="pending"] .agent-tool-status { font-style: italic; }
.agent-tool-row[data-status="error"] strong,
.agent-tool-row[data-status="error"] .agent-tool-status { color: var(--danger); }
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
@media (max-width: 900px) {
  .agent-tool-row {
    grid-template-columns: 14px 1fr;
    grid-auto-flow: row;
  }
  .agent-tool-row strong,
  .agent-tool-target,
  .agent-tool-status { grid-column: 2; justify-self: start; max-width: 100%; }
}
</style>
