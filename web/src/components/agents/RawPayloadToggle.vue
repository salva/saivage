<script setup lang="ts">
import { ref } from "vue";
import FormattedContent from "../FormattedContent.vue";
import { FORMATTED_CONTENT_MAX_HEIGHT_TOOL_DETAIL } from "./constants";

const props = defineProps<{
  request?: string;
  response?: string;
  responseKind: "result" | "error" | "missing";
}>();

const open = ref(false);
const selected = ref<"request" | "response">("request");
</script>

<template>
  <div class="raw-payload">
    <button class="raw-toggle" type="button" @click="open = !open">
      {{ open ? "Hide raw" : "View raw" }}
    </button>
    <div v-if="open" class="raw-body">
      <div class="raw-tabs" role="tablist" aria-label="Raw tool payload">
        <button
          type="button"
          :aria-selected="selected === 'request'"
          :data-active="selected === 'request' ? 'true' : 'false'"
          @click="selected = 'request'"
        >Request</button>
        <button
          type="button"
          :aria-selected="selected === 'response'"
          :data-active="selected === 'response' ? 'true' : 'false'"
          :disabled="responseKind === 'missing'"
          @click="selected = 'response'"
        >{{ responseKind === "error" ? "Error" : "Response" }}</button>
      </div>
      <FormattedContent
        v-if="selected === 'request'"
        :content="props.request || 'No request payload recorded.'"
        :max-height="FORMATTED_CONTENT_MAX_HEIGHT_TOOL_DETAIL"
      />
      <FormattedContent
        v-else
        :content="props.response || 'No response payload recorded.'"
        :max-height="FORMATTED_CONTENT_MAX_HEIGHT_TOOL_DETAIL"
      />
    </div>
  </div>
</template>

<style scoped>
.raw-payload { margin-top: 6px; }
.raw-toggle,
.raw-tabs button {
  border: 1px solid var(--border-subtle, var(--border));
  border-radius: 4px;
  color: var(--text-muted);
  background: transparent;
  font-family: var(--mono);
  font-size: 11px;
  cursor: pointer;
}
.raw-toggle { padding: 2px 6px; }
.raw-toggle:hover,
.raw-tabs button:hover:not(:disabled) { color: var(--text); border-color: var(--accent); }
.raw-body { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.raw-tabs { display: flex; gap: 4px; }
.raw-tabs button { padding: 2px 6px; }
.raw-tabs button[data-active="true"] { color: var(--accent); border-color: var(--accent); }
.raw-tabs button:disabled { cursor: not-allowed; opacity: 0.45; }
</style>
