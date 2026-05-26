<script setup lang="ts">
import { computed, ref } from "vue";
import { Bot, MessageSquare } from "lucide-vue-next";
import type { AgentState, ChatSession, AgentRole } from "../../api/types";
import type { SelectionKind } from "./types";

const props = defineProps<{
  activeAgents: AgentState[];
  chatSessions: ChatSession[];
  selection: { kind: SelectionKind; id: string } | null;
  now: number;
}>();

const emit = defineEmits<{
  "select-agent": [agentId: string];
  "select-session": [sessionId: string];
}>();

const activeTab = ref<"active" | "history">("active");
const filteredSessions = computed(() => props.chatSessions.filter((session) => session.message_count > 0));

function elapsed(startedAt: string): string {
  const ms = props.now - new Date(startedAt).getTime();
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function timeAgo(ts: string): string {
  const ms = props.now - new Date(ts).getTime();
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-tabs">
      <button class="stab" :class="{ active: activeTab === 'active' }" @click="activeTab = 'active'">
        <Bot :size="15" />
        <span>Active</span>
        <strong>{{ activeAgents.length }}</strong>
      </button>
      <button class="stab" :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
        <MessageSquare :size="15" />
        <span>History</span>
        <strong>{{ filteredSessions.length }}</strong>
      </button>
    </div>

    <div class="sidebar-content">
      <template v-if="activeTab === 'active'">
        <div v-if="activeAgents.length === 0" class="sidebar-empty">No active agents</div>
        <button
          v-for="agent in activeAgents"
          :key="agent.agent_id"
          class="sidebar-item"
          :class="{ selected: selection?.kind === 'agent' && selection.id === agent.agent_id }"
          @click="emit('select-agent', agent.agent_id)"
        >
          <span class="role-line">
            <strong :style="{ color: roleColor(agent.agent_type) }">{{ agent.agent_type }}</strong>
            <em>{{ elapsed(agent.started_at) }}</em>
          </span>
          <span class="item-id">{{ agent.agent_id }}</span>
          <span v-if="agent.current_task_id" class="item-task">{{ agent.current_task_id }}</span>
        </button>
      </template>

      <template v-else>
        <div v-if="filteredSessions.length === 0" class="sidebar-empty">No chat sessions</div>
        <button
          v-for="session in filteredSessions"
          :key="session.session_id"
          class="sidebar-item"
          :class="{ selected: selection?.kind === 'chat' && selection.id === session.session_id }"
          @click="emit('select-session', session.session_id)"
        >
          <span class="role-line">
            <strong>{{ session.session_id.slice(0, 16) }}</strong>
            <em>{{ timeAgo(session.updated_at) }}</em>
          </span>
          <span class="item-id">{{ session.message_count }} messages &middot; {{ session.channel }}</span>
        </button>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-1);
}
.sidebar-tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
  padding: 10px;
  border-bottom: 1px solid var(--border);
}
.stab {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}
.stab:hover,
.stab.active {
  color: var(--text);
  background: var(--surface-2);
}
.stab.active { border-color: var(--accent); }
.stab span {
  overflow: hidden;
  font-size: 12px;
  text-overflow: ellipsis;
}
.stab strong {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}
.sidebar-content {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}
.sidebar-empty {
  display: grid;
  min-height: 140px;
  place-items: center;
  color: var(--text-faint);
  font-size: 13px;
  text-align: center;
}
.sidebar-item {
  display: grid;
  gap: 4px;
  width: 100%;
  margin-bottom: 7px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text);
  background: var(--bg);
  cursor: pointer;
  text-align: left;
}
.sidebar-item:hover,
.sidebar-item.selected {
  border-color: var(--border-strong);
  background: var(--surface-2);
}
.sidebar-item.selected { border-color: var(--accent); }
.role-line {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.role-line strong {
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.role-line em,
.item-id,
.item-task {
  font-family: var(--mono);
  font-size: 11px;
  font-style: normal;
}
.role-line em { color: var(--warn); }
.item-id { color: var(--text-faint); }
.item-task {
  overflow: hidden;
  color: var(--accent);
  text-overflow: ellipsis;
  white-space: nowrap;
}
@media (max-width: 900px) {
  .sidebar {
    max-height: 38vh;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}
</style>
