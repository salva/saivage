<script setup lang="ts">
import { computed } from "vue";
import JsonHighlight from "./JsonHighlight.vue";
import { renderMarkdown } from "../utils/markdown";

const props = withDefaults(defineProps<{
  content: string;
  maxHeight?: string;
}>(), {
  maxHeight: undefined,
});

type ParsedContent =
  | { kind: "json"; data: unknown }
  | { kind: "text"; text: string };

const parsed = computed<ParsedContent>(() => {
  const content = props.content ?? "";
  const trimmed = content.trim();
  if (!trimmed) return { kind: "text", text: content };

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return { kind: "json", data: JSON.parse(trimmed) };
    } catch {
      // Fall through to text.
    }
  }

  const embedded = extractEmbeddedJson(trimmed);
  if (embedded) return embedded;

  return { kind: "text", text: content };
});

const renderedMarkdown = computed(() => {
  if (parsed.value.kind !== "text") return "";
  return renderMarkdown(parsed.value.text);
});

function extractEmbeddedJson(value: string): ParsedContent | null {
  const start = firstJsonStart(value);
  if (start < 0) return null;

  const prefix = value.slice(0, start).trim();
  if (prefix && !/^(Tool call|Tool result|Result|Error|Response|Request)\b/i.test(prefix)) {
    return null;
  }

  const candidate = value.slice(start).trim();
  try {
    return { kind: "json", data: JSON.parse(candidate) };
  } catch {
    return null;
  }
}

function firstJsonStart(value: string): number {
  const objectStart = value.indexOf("{");
  const arrayStart = value.indexOf("[");
  if (objectStart === -1) return arrayStart;
  if (arrayStart === -1) return objectStart;
  return Math.min(objectStart, arrayStart);
}
</script>

<template>
  <JsonHighlight
    v-if="parsed.kind === 'json'"
    :data="parsed.data"
    :max-height="maxHeight"
    class="formatted-json"
  />
  <div v-else class="formatted-text" v-html="renderedMarkdown"></div>
</template>

<style scoped>
.formatted-json {
  border-top: none;
  border-radius: 4px;
}

.formatted-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.5;
}

.formatted-text :deep(strong) { color: var(--text); font-weight: 600; }
.formatted-text :deep(em) { font-style: italic; }
.formatted-text :deep(.md-h1) { display: block; font-size: 16px; margin: 8px 0 4px; }
.formatted-text :deep(.md-h2) { display: block; font-size: 14px; margin: 6px 0 3px; }
.formatted-text :deep(.md-h3) { display: block; font-size: 13px; margin: 4px 0 2px; }
.formatted-text :deep(.md-code) { background: var(--surface-3); color: var(--accent-2); padding: 1px 5px; border-radius: 3px; font-family: monospace; font-size: 12px; }
.formatted-text :deep(.md-code-block) { background: var(--surface-1); border: 1px solid var(--border); padding: 10px 12px; border-radius: 6px; margin: 6px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; white-space: pre; }
.formatted-text :deep(.md-code-block code) { font-family: monospace; color: var(--text); }
.formatted-text :deep(.md-bullet) {
  display: grid;
  grid-template-columns: 18px 1fr;
  gap: 4px;
  align-items: baseline;
  padding: 1px 0 1px 6px;
}
.formatted-text :deep(.md-marker) {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
  user-select: none;
}
.formatted-text :deep(.md-bullet-text) { min-width: 0; }
</style>
