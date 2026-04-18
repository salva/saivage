<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from "vue";

interface Todo {
  id: string;
  goal: string;
  status: string;
  priority: number;
  agentType?: string;
  createdAt?: string;
  updatedAt?: string;
}

interface Agent {
  id: string;
  type: string;
  taskId: string;
  iteration: number;
  startedAt?: string;
}

interface AppState {
  todos: Todo[];
  activeAgents: Agent[];
}

interface LogEntry {
  role: string;
  type: "text" | "thinking" | "tool_call" | "tool_result";
  text?: string;
  tool?: string;
  args?: string;
  isError?: boolean;
}

interface AgentLog {
  agentId: string;
  taskId?: string;
  goal?: string;
  type?: string;
  iteration: number;
  startedAt?: string;
  entries: LogEntry[];
}

const state = ref<AppState>({ todos: [], activeAgents: [] });
const now = ref(Date.now());
const expandedAgent = ref<string | null>(null);
const agentLog = ref<AgentLog | null>(null);
const logLoading = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let logPollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchState() {
  try {
    const res = await fetch("/api/state");
    if (res.ok) {
      state.value = await res.json();
    }
  } catch {
    // Ignore fetch errors during polling
  }
}

async function fetchAgentLog(agentId: string) {
  try {
    logLoading.value = true;
    const res = await fetch(`/api/agents/${agentId}/log`);
    if (res.ok) {
      agentLog.value = await res.json();
    } else {
      agentLog.value = null;
      expandedAgent.value = null;
    }
  } catch {
    agentLog.value = null;
  } finally {
    logLoading.value = false;
  }
}

function toggleAgent(agentId: string) {
  if (expandedAgent.value === agentId) {
    expandedAgent.value = null;
    agentLog.value = null;
    if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
  } else {
    expandedAgent.value = agentId;
    fetchAgentLog(agentId);
    if (logPollTimer) clearInterval(logPollTimer);
    logPollTimer = setInterval(() => fetchAgentLog(agentId), 5000);
  }
}

// Stop log polling if expanded agent disappears
watch(() => state.value.activeAgents, (agents) => {
  if (expandedAgent.value && !agents.find(a => a.id === expandedAgent.value)) {
    expandedAgent.value = null;
    agentLog.value = null;
    if (logPollTimer) { clearInterval(logPollTimer); logPollTimer = null; }
  }
});

onMounted(() => {
  fetchState();
  pollTimer = setInterval(fetchState, 3000);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (clockTimer) clearInterval(clockTimer);
  if (logPollTimer) clearInterval(logPollTimer);
});

function statusColor(status: string): string {
  switch (status) {
    case "completed": return "#3fb950";
    case "in-progress": return "#58a6ff";
    case "blocked": return "#d29922";
    case "failed": return "#f85149";
    default: return "#8b949e";
  }
}

function elapsed(startedAt?: string): string {
  if (!startedAt) return "";
  const ms = now.value - new Date(startedAt).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  return `${mins}m ${s}s`;
}

function agentGoal(agent: Agent): string {
  const todo = state.value.todos.find(t => t.id === agent.taskId);
  if (!todo) return agent.taskId.slice(0, 8);
  return todo.goal.length > 80 ? todo.goal.slice(0, 80) + "…" : todo.goal;
}

// Show recent todos first: in-progress, then pending, then recent completed/failed
const sortedTodos = computed(() => {
  const order: Record<string, number> = { "in-progress": 0, "pending": 1, "blocked": 2, "failed": 3, "completed": 4 };
  return [...state.value.todos]
    .sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5))
    .slice(0, 30);
});

const stats = computed(() => {
  const todos = state.value.todos;
  return {
    total: todos.length,
    completed: todos.filter(t => t.status === "completed").length,
    failed: todos.filter(t => t.status === "failed").length,
    active: state.value.activeAgents.length,
  };
});
</script>

<template>
  <div class="status-panel">
    <!-- Stats bar -->
    <div class="stats-bar">
      <div class="stat">
        <span class="stat-num">{{ stats.active }}</span>
        <span class="stat-label">active</span>
      </div>
      <div class="stat">
        <span class="stat-num stat-ok">{{ stats.completed }}</span>
        <span class="stat-label">done</span>
      </div>
      <div class="stat">
        <span class="stat-num stat-err">{{ stats.failed }}</span>
        <span class="stat-label">failed</span>
      </div>
      <div class="stat">
        <span class="stat-num">{{ stats.total }}</span>
        <span class="stat-label">total</span>
      </div>
    </div>

    <section class="section">
      <h2>Active Agents</h2>
      <div v-if="state.activeAgents.length === 0" class="empty">
        No active agents
      </div>
      <div v-for="agent in state.activeAgents" :key="agent.id"
           class="agent-card"
           :class="{ expanded: expandedAgent === agent.id }"
           @click="toggleAgent(agent.id)">
        <div class="agent-header">
          <span class="agent-type">{{ agent.type }}</span>
          <span class="agent-elapsed">{{ elapsed(agent.startedAt) }}</span>
        </div>
        <div class="agent-goal">{{ agentGoal(agent) }}</div>
        <div class="agent-footer">
          <span class="progress-label">iteration {{ agent.iteration }}</span>
          <span class="expand-hint">{{ expandedAgent === agent.id ? '▲ hide log' : '▼ show log' }}</span>
        </div>

        <!-- Expanded conversation log -->
        <div v-if="expandedAgent === agent.id" class="agent-log" @click.stop>
          <div v-if="logLoading && !agentLog" class="log-loading">Loading…</div>
          <div v-else-if="agentLog" class="log-entries">
            <div v-for="(entry, idx) in agentLog.entries" :key="idx"
                 class="log-entry"
                 :class="[`log-${entry.type}`, entry.isError ? 'log-error' : '']">
              <template v-if="entry.type === 'thinking'">
                <span class="log-icon">💭</span>
                <span class="log-text">{{ entry.text }}</span>
              </template>
              <template v-else-if="entry.type === 'tool_call'">
                <span class="log-icon">🔧</span>
                <span class="log-tool-name">{{ entry.tool }}</span>
                <span class="log-args">{{ entry.args }}</span>
              </template>
              <template v-else-if="entry.type === 'tool_result'">
                <span class="log-icon">{{ entry.isError ? '❌' : '📄' }}</span>
                <span class="log-text log-result-text">{{ entry.text }}</span>
              </template>
              <template v-else>
                <span class="log-icon">💬</span>
                <span class="log-text">{{ entry.text }}</span>
              </template>
            </div>
          </div>
          <div v-else class="log-loading">Agent no longer running</div>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Work Queue</h2>
      <div v-if="state.todos.length === 0" class="empty">
        No work items
      </div>
      <div v-for="todo in sortedTodos" :key="todo.id" class="todo-item">
        <span class="status-dot" :style="{ background: statusColor(todo.status) }"></span>
        <div class="todo-info">
          <div class="todo-goal">{{ todo.goal }}</div>
          <div class="todo-meta">
            <span class="todo-status">{{ todo.status }}</span>
            <span v-if="todo.agentType"> · {{ todo.agentType }}</span>
            <span v-if="todo.updatedAt"> · {{ elapsed(todo.createdAt) }} ago</span>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.status-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  background: #161b22;
}

/* --- Stats bar --- */
.stats-bar {
  display: flex;
  justify-content: space-around;
  padding: 12px 16px;
  border-bottom: 1px solid #21262d;
  background: #0d1117;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

.stat-num {
  font-size: 18px;
  font-weight: 700;
  color: #c9d1d9;
  font-family: monospace;
}

.stat-ok { color: #3fb950; }
.stat-err { color: #f85149; }

.stat-label {
  font-size: 10px;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.section {
  padding: 16px;
  border-bottom: 1px solid #21262d;
}

h2 {
  font-size: 13px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.empty {
  font-size: 13px;
  color: #484f58;
  padding: 8px 0;
}

.agent-card {
  background: #0d1117;
  border-radius: 6px;
  padding: 10px;
  margin-bottom: 8px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.agent-card:hover {
  border-color: #30363d;
}

.agent-card.expanded {
  border-color: #58a6ff;
}

.agent-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
}

.agent-type {
  font-size: 13px;
  font-weight: 600;
  color: #58a6ff;
}

.agent-elapsed {
  font-size: 11px;
  color: #d29922;
  font-family: monospace;
}

.agent-goal {
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 8px;
  line-height: 1.3;
  word-break: break-word;
}

.progress-label {
  font-size: 11px;
  color: #8b949e;
  font-family: monospace;
}

.agent-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
}

.expand-hint {
  font-size: 10px;
  color: #484f58;
}

/* --- Agent log viewer --- */

.agent-log {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid #21262d;
  max-height: 400px;
  overflow-y: auto;
}

.log-loading {
  font-size: 12px;
  color: #484f58;
  padding: 8px 0;
}

.log-entries {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.log-entry {
  display: flex;
  gap: 6px;
  font-size: 11px;
  line-height: 1.4;
  padding: 3px 0;
  align-items: flex-start;
}

.log-icon {
  flex-shrink: 0;
  width: 16px;
  text-align: center;
}

.log-text {
  color: #8b949e;
  word-break: break-word;
  white-space: pre-wrap;
}

.log-thinking .log-text {
  color: #c9d1d9;
  font-style: italic;
}

.log-tool_call {
  color: #58a6ff;
}

.log-tool-name {
  font-weight: 600;
  color: #58a6ff;
  flex-shrink: 0;
}

.log-args {
  color: #484f58;
  font-family: monospace;
  font-size: 10px;
  word-break: break-all;
  max-height: 60px;
  overflow: hidden;
}

.log-tool_result .log-text {
  color: #6e7681;
  font-family: monospace;
  font-size: 10px;
  max-height: 80px;
  overflow: hidden;
}

.log-error .log-text {
  color: #f85149;
}

.todo-item {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  padding: 8px 0;
  border-bottom: 1px solid #21262d;
}

.todo-item:last-child {
  border-bottom: none;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
}

.todo-info {
  min-width: 0;
}

.todo-goal {
  font-size: 13px;
  color: #c9d1d9;
  line-height: 1.4;
  word-break: break-word;
}

.todo-meta {
  font-size: 11px;
  color: #8b949e;
  margin-top: 2px;
}

.todo-status {
  font-weight: 600;
}
</style>
