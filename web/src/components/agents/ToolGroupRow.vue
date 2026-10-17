<script setup lang="ts">
import ToolCallRow from "./ToolCallRow.vue";
import type { ToolGroup } from "./types";

defineProps<{
  group: ToolGroup;
  open: boolean;
  expanded: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  toggle: [id: string];
  "toggle-tool": [id: string];
  "open-file": [payload: { path: string; root: "project" | "saivage"; line?: number }];
  "open-conversation": [payload: { agentId: string; roundId?: string }];
}>();
</script>

<template>
  <button
    class="tool-group-row"
    :data-open="open ? 'true' : 'false'"
    :aria-expanded="open"
    :aria-label="`${group.label}: ${group.summary}`"
    @click="emit('toggle', group.id)"
  >
    <span class="chevron" aria-hidden="true">&rsaquo;</span>
    <strong>{{ group.label }}</strong>
    <span class="tool-group-summary">{{ group.summary }}</span>
  </button>
  <div v-if="open" class="tool-group-detail">
    <ToolCallRow
      v-for="pair in group.pairs"
      :key="pair.toolUseId"
      :pair="pair"
      :open="expanded.has(pair.toolUseId)"
      @toggle="emit('toggle-tool', $event)"
      @open-file="emit('open-file', $event)"
      @open-conversation="emit('open-conversation', $event)"
    />
  </div>
</template>

<style scoped>
.tool-group-row {
  display: grid;
  grid-template-columns: 14px auto minmax(0, 1fr);
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
.tool-group-row:hover { background: var(--surface-2); }
.tool-group-row strong { color: var(--accent); font-weight: 600; }
.tool-group-summary { overflow: hidden; color: var(--text-faint); text-overflow: ellipsis; white-space: nowrap; }
.chevron { display: inline-block; color: var(--text-faint); transition: transform 0.12s ease; }
.tool-group-row[data-open="true"] .chevron { transform: rotate(90deg); }
.tool-group-detail {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-left: 22px;
  padding-left: 8px;
  border-left: 2px solid var(--border-subtle, var(--border));
}
</style>
