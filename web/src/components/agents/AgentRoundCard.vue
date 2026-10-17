<script setup lang="ts">
import { computed } from "vue";
import FormattedContent from "../FormattedContent.vue";
import ToolCallRow from "./ToolCallRow.vue";
import ToolGroupRow from "./ToolGroupRow.vue";
import type { ConversationEntry } from "../../api/types";
import type { Round } from "./types";
import { groupToolPairs, isToolGroup } from "./toolGrouping";
import {
  FORMATTED_CONTENT_MAX_HEIGHT_CONTEXT,
  FORMATTED_CONTENT_MAX_HEIGHT_DIAGNOSTIC,
  FORMATTED_CONTENT_MAX_HEIGHT_REASONING,
} from "./constants";

const props = defineProps<{
  round: Round;
  defaultModelSpec: string | null;
  expanded: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  "toggle-details": [id: string];
  "open-file": [payload: { path: string; root: "project" | "saivage"; line?: number }];
  "open-conversation": [payload: { agentId: string; roundId?: string }];
}>();

const toolItems = computed(() => groupToolPairs(props.round.id, props.round.toolPairs));

function diagnosticTone(kind: ConversationEntry["kind"]): "ok" | "warn" | "danger" | "neutral" {
  if (kind === "model_recovered") return "ok";
  if (kind === "model_repair") return "warn";
  if (kind === "model_issue") return "danger";
  return "neutral";
}

function diagnosticLabel(kind: ConversationEntry["kind"]): string {
  switch (kind) {
    case "model_issue": return "Model Issue";
    case "model_repair": return "Model Repair";
    case "model_recovered": return "Model Recovered";
    default: return kind;
  }
}
</script>

<template>
  <section class="agent-round" :data-round-id="round.id">
    <div
      v-if="round.modelSpec && round.modelSpec !== defaultModelSpec"
      class="agent-round-via"
      :title="round.requestedModelSpec ? `requested: ${round.requestedModelSpec}` : round.modelSpec"
    >via {{ round.modelSpec }}</div>

    <div
      v-for="entry in round.reasoning"
      :key="`${round.id}-reasoning-${entry.messageIndex}-${entry.blockIndex}`"
      class="agent-round-reasoning"
      :class="{ 'agent-activity-lead': entry.kind === 'activity' }"
    >
      <FormattedContent :content="entry.content" :max-height="FORMATTED_CONTENT_MAX_HEIGHT_REASONING" />
    </div>

    <div v-if="round.toolPairs.length > 0" class="agent-tool-list">
      <template v-for="item in toolItems" :key="isToolGroup(item) ? item.id : `${round.id}-tool-${item.toolUseId}`">
        <ToolGroupRow
          v-if="isToolGroup(item)"
          :group="item"
          :open="expanded.has(item.id)"
          :expanded="expanded"
          @toggle="emit('toggle-details', $event)"
          @toggle-tool="emit('toggle-details', $event)"
          @open-file="emit('open-file', $event)"
          @open-conversation="emit('open-conversation', $event)"
        />
        <ToolCallRow
          v-else
          :pair="item"
          :open="expanded.has(item.toolUseId)"
          @toggle="emit('toggle-details', $event)"
          @open-file="emit('open-file', $event)"
          @open-conversation="emit('open-conversation', $event)"
        />
      </template>
    </div>

    <div
      v-for="d in round.diagnostics"
      :key="`${round.id}-diag-${d.timestamp}-${d.blockIndex}`"
      class="agent-diagnostic-row"
      :data-tone="diagnosticTone(d.kind)"
      :title="new Date(d.timestamp).toLocaleString()"
    >
      <span class="agent-diagnostic-label">{{ diagnosticLabel(d.kind) }}</span>
      <FormattedContent :content="d.content" :max-height="FORMATTED_CONTENT_MAX_HEIGHT_DIAGNOSTIC" />
    </div>

    <div
      v-for="c in round.context"
      :key="`${round.id}-ctx-${c.messageIndex}-${c.blockIndex}`"
      class="agent-context-block"
    >
      <FormattedContent :content="c.content" :max-height="FORMATTED_CONTENT_MAX_HEIGHT_CONTEXT" />
    </div>
  </section>
</template>

<style scoped>
.agent-round {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.agent-round-via {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}
.agent-round-reasoning {
  color: var(--text);
  font-size: 13px;
  line-height: 1.55;
}
.agent-activity-lead {
  color: var(--text-muted);
  font-style: italic;
}
.agent-tool-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 2px;
}
.agent-diagnostic-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 12px;
}
.agent-diagnostic-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.agent-diagnostic-row[data-tone="ok"] { color: var(--accent-2); }
.agent-diagnostic-row[data-tone="warn"] { color: var(--warn); }
.agent-diagnostic-row[data-tone="danger"] { color: var(--danger); }
.agent-context-block {
  padding: 0 0 0 10px;
  border-left: 2px solid var(--border-subtle, var(--border));
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.55;
}
</style>
