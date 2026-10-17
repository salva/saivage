<script setup lang="ts">
import { computed } from "vue";
import DetailSectionRenderer from "./DetailSectionRenderer.vue";
import RawPayloadToggle from "./RawPayloadToggle.vue";
import { buildToolDetail, type InlinePart, type ToolDisplayModel } from "../../utils/toolDisplay";
import type { ToolPair } from "./types";

const props = defineProps<{
  pair: ToolPair;
  display: ToolDisplayModel;
}>();

const emit = defineEmits<{
  "open-file": [payload: { path: string; root: "project" | "saivage"; line?: number }];
  "open-conversation": [payload: { agentId: string; roundId?: string }];
}>();

const detail = computed(() => buildToolDetail(props.pair, props.display));

function renderPart(part: InlinePart): string {
  if (part.kind === "file") return part.line ? `${part.path}:${part.line}` : part.path;
  if (part.kind === "url") return part.url;
  if (part.kind === "conversation") return part.label;
  return part.value;
}

function rawKind(): "result" | "error" | "missing" {
  if (props.pair.status === "error") return "error";
  if (!props.pair.result) return "missing";
  return "result";
}
</script>

<template>
  <div class="tool-detail-panel">
    <div class="tool-detail-header">
      <strong>{{ detail.title }}</strong>
      <span class="tool-detail-subtitle">
        <template v-for="(part, idx) in detail.subtitle" :key="idx">
          <code v-if="part.kind === 'code'">{{ part.value }}</code>
          <span v-else :data-tone="part.kind === 'text' ? part.tone || undefined : undefined">{{ renderPart(part) }}</span>
        </template>
      </span>
    </div>
    <dl v-if="detail.facts.length" class="tool-detail-facts">
      <div v-for="(fact, idx) in detail.facts" :key="idx" class="tool-detail-fact" :data-tone="fact.tone || undefined">
        <dt>{{ fact.label }}</dt>
        <dd>
          <template v-for="(part, pIdx) in fact.value" :key="pIdx">
            <code v-if="part.kind === 'code'">{{ part.value }}</code>
            <span v-else :data-tone="part.kind === 'text' ? part.tone || undefined : undefined">{{ renderPart(part) }}</span>
          </template>
        </dd>
      </div>
    </dl>
    <DetailSectionRenderer
      :sections="detail.sections"
      :links="detail.links"
      @open-file="emit('open-file', $event)"
      @open-conversation="emit('open-conversation', $event)"
    />
    <RawPayloadToggle
      :request="pair.call?.content"
      :response="pair.result?.content"
      :response-kind="rawKind()"
    />
  </div>
</template>

<style scoped>
.tool-detail-panel { display: flex; flex-direction: column; gap: 8px; }
.tool-detail-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.tool-detail-header strong { color: var(--text); font-size: 13px; }
.tool-detail-subtitle { color: var(--text-muted); font-family: var(--mono); font-size: 12px; }
.tool-detail-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 4px 10px; margin: 0; }
.tool-detail-fact { display: flex; flex-direction: column; gap: 1px; }
dt { color: var(--text-faint); font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
dd { margin: 0; color: var(--text-muted); font-size: 12px; }
code { color: var(--text); font-family: var(--mono); font-size: 12px; }
[data-tone="ok"] { color: var(--accent-2); }
[data-tone="warn"] { color: var(--warn); }
[data-tone="error"] { color: var(--danger); }
[data-tone="muted"] { color: var(--text-faint); }
</style>
