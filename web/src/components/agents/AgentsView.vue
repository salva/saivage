<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Bot, Clock3 } from "lucide-vue-next";
import AgentConversationPane from "./AgentConversationPane.vue";
import ChatSessionPane from "./ChatSessionPane.vue";
import ConversationSidebar from "./ConversationSidebar.vue";
import { useAgentConversation } from "../../composables/useAgentConversation";
import { useAgentRoster } from "../../composables/useAgentRoster";
import { useChatSessions } from "../../composables/useChatSessions";
import type { ChatLog } from "../../api/types";
import type { SelectionKind } from "./types";

const emit = defineEmits<{
  "open-file": [payload: { path: string; root: "project" | "saivage" }];
}>();

type Selection = { kind: SelectionKind; id: string };

const { activeAgents, chatSessions, now } = useAgentRoster();
const {
  conversation: selectedAgent,
  loading: agentLoading,
  expanded,
  load: loadAgentConversation,
  stop: stopAgentPolling,
  bindThreadBody,
  toggleDetails,
} = useAgentConversation();
const { loadSession } = useChatSessions();

const selected = ref<Selection | null>(null);
const selectedSession = ref<ChatLog | null>(null);
const chatLoading = ref(false);
const agentPane = ref<InstanceType<typeof AgentConversationPane> | null>(null);
const loading = computed(() => agentLoading.value || chatLoading.value);

let autoSelecting = false;

bindThreadBody(() => agentPane.value?.getThreadBodyEl() ?? null);

async function selectAgent(agentId: string): Promise<void> {
  chatLoading.value = false;
  selected.value = { kind: "agent", id: agentId };
  selectedSession.value = null;
  await loadAgentConversation(agentId);
  if (selected.value?.kind !== "agent" || selected.value.id !== agentId) {
    stopAgentPolling();
  }
}

async function selectSession(sessionId: string): Promise<void> {
  selected.value = { kind: "chat", id: sessionId };
  selectedSession.value = null;
  stopAgentPolling();
  chatLoading.value = true;
  try {
    const session = await loadSession(sessionId);
    if (selected.value?.kind === "chat" && selected.value.id === sessionId) {
      selectedSession.value = session;
    }
  } finally {
    chatLoading.value = false;
  }
}

watch(
  activeAgents,
  (agents) => {
    if (selected.value || loading.value || autoSelecting) return;
    const first = agents[0];
    if (!first) return;
    autoSelecting = true;
    void selectAgent(first.agent_id).finally(() => {
      autoSelecting = false;
    });
  },
  { immediate: true },
);
</script>

<template>
  <section class="agents-view">
    <ConversationSidebar
      :active-agents="activeAgents"
      :chat-sessions="chatSessions"
      :selection="selected"
      :now="now"
      @select-agent="selectAgent"
      @select-session="selectSession"
    />

    <main class="thread-panel">
      <div v-if="!selectedAgent && !selectedSession && !loading" class="thread-empty">
        <Bot :size="42" />
        <strong>Select a conversation</strong>
        <span>Watch active agents, reasoning traces, model repairs, and chat sessions.</span>
      </div>

      <div v-else-if="loading" class="thread-empty">
        <Clock3 :size="34" />
        <strong>Loading conversation...</strong>
      </div>

      <AgentConversationPane
        v-else-if="selected?.kind === 'agent' && selectedAgent"
        ref="agentPane"
        :conversation="selectedAgent"
        :now="now"
        :expanded="expanded"
        @toggle-details="toggleDetails"
        @open-file="emit('open-file', $event)"
      />

      <ChatSessionPane
        v-else-if="selected?.kind === 'chat' && selectedSession"
        :session="selectedSession"
      />
    </main>
  </section>
</template>

<style scoped>
.agents-view {
  display: grid;
  grid-template-columns: 330px minmax(0, 1fr);
  height: 100%;
  min-width: 0;
  overflow: hidden;
  background: var(--bg);
}
.thread-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}
.thread-empty {
  display: grid;
  height: 100%;
  place-items: center;
  align-content: center;
  gap: 8px;
  color: var(--text-faint);
  text-align: center;
}
.thread-empty strong {
  color: var(--text);
}
.thread-empty span {
  max-width: 360px;
  color: var(--text-muted);
  font-size: 13px;
}
@media (max-width: 900px) {
  .agents-view {
    grid-template-columns: 1fr;
  }
}
</style>
