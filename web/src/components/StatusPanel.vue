<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";

interface AgentState {
  role: string;
  agent_id: string;
  status: string;
  current_task_id?: string;
  channel?: string;
  started_at: string;
}

interface RuntimeState {
  status: string;
  current_stage_id: string | null;
  active_agents: AgentState[];
  started_at: string;
  updated_at: string;
  pid: number;
}

interface Stage {
  id: string;
  objective: string;
  tags?: string[];
}

interface Plan {
  updated_at: string;
  current_stage_id: string | null;
  stages: Stage[];
}

interface HistoryEntry {
  stage_id: string;
  result: string;
  summary: string;
  completed_at?: string;
}

const state = ref<RuntimeState | null>(null);
const plan = ref<Plan | null>(null);
const history = ref<HistoryEntry[]>([]);
const now = ref(Date.now());
let pollTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;

async function fetchState() {
  try {
    const [stateRes, planRes] = await Promise.all([
      fetch("/api/state"),
      fetch("/api/plan"),
    ]);
    if (stateRes.ok) {
      const data = await stateRes.json();
      state.value = data.state;
      if (data.plan) plan.value = data.plan;
    }
    if (planRes.ok) {
      const data = await planRes.json();
      if (data.plan) plan.value = data.plan;
      history.value = data.history?.entries ?? [];
    }
  } catch { /* ignore */ }
}

onMounted(() => {
  fetchState();
  pollTimer = setInterval(fetchState, 4000);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  if (clockTimer) clearInterval(clockTimer);
});

function elapsed(startedAt?: string): string {
  if (!startedAt) return "";
  const ms = now.value - new Date(startedAt).getTime();
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function statusColor(status: string): string {
  switch (status) {
    case "running": return "#3fb950";
    case "idle": return "#8b949e";
    case "error": return "#f85149";
    case "suspended": return "#d29922";
    default: return "#484f58";
  }
}

function roleColor(role: string): string {
  switch (role) {
    case "planner": return "#bc8cff";
    case "manager": return "#58a6ff";
    case "coder": return "#3fb950";
    case "researcher": return "#d29922";
    case "inspector": return "#f0883e";
    case "chat": return "#8b949e";
    default: return "#c9d1d9";
  }
}

const stats = computed(() => {
  const completed = history.value.filter(h => h.result === "completed").length;
  const failed = history.value.filter(h => h.result === "failed" || h.result === "escalated").length;
  const remaining = plan.value?.stages.length ?? 0;
  const agents = (state.value?.active_agents ?? []).filter(a => a.role !== "chat").length;
  return { completed, failed, remaining, agents };
});

const currentStage = computed(() => {
  const sid = plan.value?.current_stage_id ?? state.value?.current_stage_id;
  if (!sid) return null;
  return plan.value?.stages.find(s => s.id === sid) ?? null;
});

const activeWorkers = computed(() =>
  (state.value?.active_agents ?? []).filter(a => a.role !== "chat")
);
</script>

<template>
  <div class="status-panel">
    <div class="runtime-bar">
      <span class="runtime-dot" :style="{ background: statusColor(state?.status ?? 'idle') }"></span>
      <span class="runtime-label">{{ state?.status ?? 'connecting…' }}</span>
      <span class="runtime-elapsed" v-if="state?.started_at">{{ elapsed(state.started_at) }}</span>
    </div>

    <div class="stats-bar">
      <div class="stat">
        <span class="stat-num">{{ stats.agents }}</span>
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
        <span class="stat-num">{{ stats.remaining }}</span>
        <span class="stat-label">queued</span>
      </div>
    </div>

    <section class="section" v-if="currentStage">
      <h2>Current Stage</h2>
      <div class="stage-card">
        <div class="stage-id">{{ currentStage.id }}</div>
        <div class="stage-obj">{{ currentStage.objective }}</div>
        <div v-if="currentStage.tags?.length" class="stage-tags">
          <span v-for="tag in currentStage.tags" :key="tag" class="tag">{{ tag }}</span>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Active Agents</h2>
      <div v-if="activeWorkers.length === 0" class="empty">No active agents</div>
      <div v-for="agent in activeWorkers" :key="agent.agent_id" class="agent-card">
        <div class="agent-header">
          <span class="agent-role" :style="{ color: roleColor(agent.role) }">{{ agent.role }}</span>
          <span class="agent-elapsed">{{ elapsed(agent.started_at) }}</span>
        </div>
        <div class="agent-task" v-if="agent.current_task_id">{{ agent.current_task_id }}</div>
        <div class="agent-id">{{ agent.agent_id.slice(0, 16) }}</div>
      </div>
    </section>

    <section class="section" v-if="plan && plan.stages.length > 0">
      <h2>Stage Queue</h2>
      <div v-for="stage in plan.stages" :key="stage.id" class="queue-item"
           :class="{ current: stage.id === plan.current_stage_id }">
        <span class="queue-id">{{ stage.id }}</span>
        <span class="queue-obj">{{ stage.objective.slice(0, 60) }}{{ stage.objective.length > 60 ? '…' : '' }}</span>
      </div>
    </section>

    <section class="section" v-if="history.length > 0">
      <h2>Completed</h2>
      <div v-for="entry in history.slice(-10).reverse()" :key="entry.stage_id" class="history-item">
        <span class="history-icon">{{ entry.result === 'completed' ? '✓' : entry.result === 'escalated' ? '⬆' : '✗' }}</span>
        <span class="history-id">{{ entry.stage_id }}</span>
        <span class="history-result" :class="entry.result">{{ entry.result }}</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.status-panel { display: flex; flex-direction: column; height: 100%; overflow-y: auto; background: #161b22; }

.runtime-bar { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #21262d; background: #0d1117; }
.runtime-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.runtime-label { font-size: 13px; font-weight: 600; color: #c9d1d9; text-transform: uppercase; }
.runtime-elapsed { font-size: 11px; color: #8b949e; font-family: monospace; margin-left: auto; }

.stats-bar { display: flex; justify-content: space-around; padding: 12px 16px; border-bottom: 1px solid #21262d; background: #0d1117; }
.stat { display: flex; flex-direction: column; align-items: center; gap: 2px; }
.stat-num { font-size: 18px; font-weight: 700; color: #c9d1d9; font-family: monospace; }
.stat-ok { color: #3fb950; }
.stat-err { color: #f85149; }
.stat-label { font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }

.section { padding: 16px; border-bottom: 1px solid #21262d; }
h2 { font-size: 13px; font-weight: 600; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 10px; }
.empty { font-size: 13px; color: #484f58; padding: 4px 0; }

.stage-card { background: #0d1117; border-radius: 6px; padding: 10px; border: 1px solid #30363d; }
.stage-id { font-size: 11px; font-weight: 700; color: #58a6ff; font-family: monospace; margin-bottom: 4px; }
.stage-obj { font-size: 12px; color: #c9d1d9; line-height: 1.4; }
.stage-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.tag { font-size: 10px; padding: 2px 6px; background: #21262d; color: #8b949e; border-radius: 3px; }

.agent-card { background: #0d1117; border-radius: 6px; padding: 10px; margin-bottom: 6px; border: 1px solid #21262d; }
.agent-header { display: flex; justify-content: space-between; margin-bottom: 4px; }
.agent-role { font-size: 13px; font-weight: 600; }
.agent-elapsed { font-size: 11px; color: #d29922; font-family: monospace; }
.agent-task { font-size: 12px; color: #c9d1d9; margin-bottom: 2px; }
.agent-id { font-size: 10px; color: #484f58; font-family: monospace; }

.queue-item { display: flex; align-items: baseline; gap: 8px; padding: 4px 0; font-size: 12px; }
.queue-item.current { color: #58a6ff; font-weight: 600; }
.queue-id { font-family: monospace; color: #8b949e; min-width: 80px; flex-shrink: 0; }
.queue-obj { color: #c9d1d9; }

.history-item { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12px; }
.history-icon { font-size: 11px; width: 16px; text-align: center; }
.history-id { font-family: monospace; color: #8b949e; }
.history-result { font-size: 11px; font-weight: 600; }
.history-result.completed { color: #3fb950; }
.history-result.escalated { color: #d29922; }
.history-result.failed { color: #f85149; }
</style>
