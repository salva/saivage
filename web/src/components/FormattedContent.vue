<script setup lang="ts">
import { computed } from "vue";
import JsonHighlight from "./JsonHighlight.vue";

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
  <div v-else class="formatted-text">{{ parsed.text }}</div>
</template>

<style scoped>
.formatted-json {
  border-top: none;
  border-radius: 4px;
}

.formatted-text {
  white-space: pre-wrap;
  word-break: break-word;
}
</style>