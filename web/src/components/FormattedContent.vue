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
  white-space: normal;
  word-break: break-word;
  line-height: 1.5;
}

.formatted-text :deep(strong) { color: var(--text); font-weight: 600; }
.formatted-text :deep(em) { font-style: italic; }
.formatted-text :deep(h1) { display: block; font-size: 16px; margin: 8px 0 4px; }
.formatted-text :deep(h2) { display: block; font-size: 14px; margin: 6px 0 3px; }
.formatted-text :deep(h3) { display: block; font-size: 13px; margin: 4px 0 2px; }
.formatted-text :deep(code) { background: var(--code-bg); color: var(--code-color); padding: 1px 5px; border-radius: 3px; font-family: monospace; font-size: 12px; }
.formatted-text :deep(pre) { background: var(--code-block-bg); border: 1px solid var(--code-block-border); padding: 10px 12px; border-radius: 6px; margin: 6px 0; overflow-x: auto; font-size: 12px; line-height: 1.5; }
.formatted-text :deep(pre code) { font-family: monospace; color: var(--code-block-text); background: transparent; padding: 0; }
.formatted-text :deep(ul), .formatted-text :deep(ol) { padding-left: 1.2em; margin: 4px 0; }
.formatted-text :deep(li) { line-height: 1.4; }
.formatted-text :deep(blockquote) { border-left: 3px solid var(--border, #444); padding-left: 10px; margin: 6px 0; color: var(--text-muted); }
.formatted-text :deep(a) { color: var(--link, #6cf); text-decoration: underline; }
.formatted-text :deep(hr) { border: 0; border-top: 1px solid var(--border, #444); margin: 8px 0; }
.formatted-text :deep(table) { border-collapse: collapse; margin: 8px 0; font-size: 12px; }
.formatted-text :deep(th), .formatted-text :deep(td) { border: 1px solid var(--border, #444); padding: 4px 8px; text-align: left; }
.formatted-text :deep(th) { background: var(--bg-strong, rgba(255,255,255,0.05)); font-weight: 600; }
.formatted-text :deep(th[align="right"]), .formatted-text :deep(td[align="right"]) { text-align: right; }
.formatted-text :deep(th[align="center"]), .formatted-text :deep(td[align="center"]) { text-align: center; }
</style>
