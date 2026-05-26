<script setup lang="ts">
import { computed, ref } from "vue";
import FormattedContent from "../FormattedContent.vue";
import AgentRoundCard from "./AgentRoundCard.vue";
import { entriesToTimeline } from "./timeline";
import { parseRoundId } from "./round-id";
import type { AgentConversation, ConversationEntry, AgentRole } from "../../api/types";
import "./agent-conversation-pane.css";
import {
  FORMATTED_CONTENT_MAX_HEIGHT_CONTEXT,
  FORMATTED_CONTENT_MAX_HEIGHT_DIAGNOSTIC,
} from "./constants";

const props = defineProps<{
  conversation: AgentConversation;
  now: number;
  expanded: ReadonlySet<string>;
}>();

const emit = defineEmits<{
  "toggle-details": [id: string];
  "open-file": [payload: { path: string; root: "project" | "saivage" }];
}>();

const threadBody = ref<HTMLElement | null>(null);

function getThreadBodyEl(): HTMLElement | null {
  return threadBody.value;
}

defineExpose({ getThreadBodyEl });

const pendingRoundId = computed(() => {
  if (!props.conversation.activity_status?.pending_call) return null;
  let bestK = -1;
  let id: string | null = null;
  for (const entry of props.conversation.entries) {
    const parsed = parseRoundId(entry.roundId);
    if (parsed.kind === "round" && parsed.index > bestK) {
      bestK = parsed.index;
      id = entry.roundId;
    }
  }
  return id;
});

const timeline = computed(() => entriesToTimeline(props.conversation.entries, pendingRoundId.value));
const defaultModelSpec = computed(() => {
  for (const item of timeline.value) {
    if (item.kind === "round" && item.round.modelSpec) return item.round.modelSpec;
  }
  return null;
});

function elapsed(startedAt: string): string {
  const ms = props.now - new Date(startedAt).getTime();
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function roleColor(role: AgentRole): string {
  switch (role) {
    case "planner": return "var(--purple)";
    case "manager": return "var(--accent)";
    case "coder": return "var(--accent-2)";
    case "researcher": return "var(--warn)";
    case "data_agent": return "var(--teal)";
    case "reviewer": return "var(--purple)";
    case "designer": return "var(--pink, var(--accent))";
    case "inspector": return "var(--orange)";
    case "chat": return "var(--text-muted)";
  }
}

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

function durationSince(ts: string): string {
  const ms = Math.max(0, props.now - new Date(ts).getTime());
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function durationUntil(ts: string): string {
  const ms = Math.max(0, new Date(ts).getTime() - props.now);
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}
</script>

<template>
  <div class="thread-header agent-thread-header">
    <strong class="agent-thread-role" :style="{ color: roleColor(conversation.role) }">{{ conversation.role }}</strong>
    <code class="agent-thread-id">{{ conversation.agent_id }}</code>
    <em v-if="defaultModelSpec" class="agent-thread-model" :title="defaultModelSpec">{{ defaultModelSpec }}</em>
    <span v-if="conversation.started_at" class="live-time">{{ elapsed(conversation.started_at) }}</span>
    <span v-if="conversation.finished_at" class="live-pill finished"><span></span>finished</span>
    <span v-else class="live-pill"><span></span>live</span>
  </div>

  <div class="thread-body agent-thread-body" ref="threadBody">
    <template v-for="item in timeline" :key="item.id">
      <AgentRoundCard
        v-if="item.kind === 'round'"
        :round="item.round"
        :default-model-spec="defaultModelSpec"
        :expanded="expanded"
        @toggle-details="emit('toggle-details', $event)"
        @open-file="emit('open-file', $event)"
      />

      <div
        v-else-if="item.kind === 'diagnostic'"
        class="agent-diagnostic-row standalone"
        :data-tone="diagnosticTone(item.diagnostic.kind)"
        :title="new Date(item.diagnostic.timestamp).toLocaleString()"
      >
        <span class="agent-diagnostic-label">{{ diagnosticLabel(item.diagnostic.kind) }}</span>
        <FormattedContent :content="item.diagnostic.content" :max-height="FORMATTED_CONTENT_MAX_HEIGHT_DIAGNOSTIC" />
      </div>

      <section
        v-else-if="item.kind === 'context'"
        class="agent-context-standalone"
        :data-round-id="item.context.id"
      >
        <div
          v-for="c in item.context.context"
          :key="`${item.context.id}-ctx-${c.messageIndex}-${c.blockIndex}`"
          class="agent-context-block"
          :title="new Date(c.timestamp).toLocaleString()"
        >
          <FormattedContent :content="c.content" :max-height="FORMATTED_CONTENT_MAX_HEIGHT_CONTEXT" />
        </div>
      </section>

      <section v-else class="agent-compacted-cluster">
        <button
          class="agent-compacted-summary"
          :aria-expanded="expanded.has(item.id)"
          @click="emit('toggle-details', item.id)"
        >
          <span class="chevron" aria-hidden="true">&rsaquo;</span>
          <span>- compacted, {{ item.compacted.length }} diagnostic{{ item.compacted.length === 1 ? '' : 's' }} re-keyed -</span>
        </button>
        <div v-if="expanded.has(item.id)" class="agent-compacted-body">
          <div
            v-for="(c, idx) in item.compacted"
            :key="`${item.id}-${idx}`"
            class="agent-diagnostic-row"
            :data-tone="diagnosticTone(c.kind)"
            :title="new Date(c.timestamp).toLocaleString()"
          >
            <span class="agent-diagnostic-label">{{ diagnosticLabel(c.kind) }}</span>
            <FormattedContent :content="c.content" :max-height="FORMATTED_CONTENT_MAX_HEIGHT_DIAGNOSTIC" />
          </div>
        </div>
      </section>
    </template>

    <footer
      v-if="conversation.activity_status?.pending_call"
      class="agent-thread-footer"
      :data-state="conversation.activity_status.pending_call.status"
      role="status"
      aria-live="polite"
    >
      <span class="dot" aria-hidden="true" />
      <template v-if="conversation.activity_status.pending_call.status === 'in_flight'">
        <span>Waiting for model... {{ durationSince(conversation.activity_status.pending_call.started_at) }}<template v-if="conversation.activity_status.pending_call.attempt > 1"> (attempt {{ conversation.activity_status.pending_call.attempt }})</template></span>
      </template>
      <template v-else>
        <span>
          <template v-if="conversation.activity_status.pending_call.reason === 'throttled'">Throttled by provider</template>
          <template v-else>Transient model error</template>
          <template v-if="conversation.activity_status.pending_call.retry_at"> - retrying in {{ durationUntil(conversation.activity_status.pending_call.retry_at) }}</template>
        </span>
        <span class="detail">attempt {{ conversation.activity_status.pending_call.attempt }}</span>
      </template>
    </footer>
  </div>
</template>
