<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { AlertTriangle, CheckCircle2, Clock3, ListTree, Users } from "lucide-vue-next";

const emit = defineEmits<{
  navigate: [tab: string, focusId?: string];
}>();

interface AgentState {
  agent_type: string;
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
  id: string;
  result: string;
  summary: string;
  actual_outcomes?: string[];
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
      history.value = data.history?.stages ?? [];
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
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function statusColor(status: string): string {
  switch (status) {
    case "running": return "var(--accent-2)";
    case "idle": return "var(--text-muted)";
    case "error": return "var(--danger)";
    case "suspended": return "var(--warn)";
    default: return "var(--text-faint)";
  }
}

function roleColor(role: string): string {
  switch (role) {
    case "planner": return "var(--purple)";
    case "manager": return "var(--accent)";
    case "coder": return "var(--accent-2)";
    case "researcher": return "var(--warn)";
    case "data_agent": return "#64d2ff";
    case "reviewer": return "#d0a2ff";
    case "inspector": return "var(--orange)";
    case "chat": return "var(--text-muted)";
    default: return "var(--text)";
  }
}

const ROLE_ORDER: Record<string, number> = {
  planner: 0, manager: 1, coder: 2, researcher: 3, data_agent: 4, reviewer: 5, inspector: 6, chat: 7,
};

const stats = computed(() => {
  const completed = history.value.filter(h => h.result === "completed").length;
  const failed = history.value.filter(h => h.result === "failed" || h.result === "escalated").length;
  const remaining = plan.value?.stages.length ?? 0;
  const agents = (state.value?.active_agents ?? []).filter(a => a.agent_type !== "chat").length;
  return { completed, failed, remaining, agents };
});

const currentStageId = computed(() => state.value?.current_stage_id ?? plan.value?.current_stage_id ?? null);
const currentStage = computed(() => {
  const sid = currentStageId.value;
  if (!sid) return null;
  return plan.value?.stages.find(s => s.id === sid) ?? null;
});

const activeWorkers = computed(() =>
  (state.value?.active_agents ?? [])
    .filter(a => a.agent_type !== "chat")
    .sort((a, b) => (ROLE_ORDER[a.agent_type] ?? 9) - (ROLE_ORDER[b.agent_type] ?? 9))
);

const recentHistory = computed(() => history.value.slice(-8).reverse());
</script>

<template>
  <aside class="status-panel">
    <div class="runtime-block">
      <div class="runtime-main">
        <span class="status-dot" :style="{ background: statusColor(state?.status ?? 'idle') }"></span>
        <div>
          <div class="runtime-label">{{ state?.status ?? 'connecting' }}</div>
          <div class="runtime-sub" v-if="state?.pid">pid {{ state.pid }}</div>
        </div>
        <span class="runtime-elapsed" v-if="state?.started_at">{{ elapsed(state.started_at) }}</span>
      </div>
      <div class="updated" v-if="state?.updated_at">updated {{ elapsed(state.updated_at) }} ago</div>
    </div>

    <div class="metric-grid">
      <button class="metric" @click="emit('navigate', 'agents')">
        <Users :size="15" />
        <strong>{{ stats.agents }}</strong>
        <span>agents</span>
      </button>
      <button class="metric" @click="emit('navigate', 'plan')">
        <ListTree :size="15" />
        <strong>{{ stats.remaining }}</strong>
        <span>queued</span>
      </button>
      <button class="metric" @click="emit('navigate', 'plan')">
        <CheckCircle2 :size="15" />
        <strong class="ok">{{ stats.completed }}</strong>
        <span>done</span>
      </button>
      <button class="metric" @click="emit('navigate', 'debug')">
        <AlertTriangle :size="15" />
        <strong class="bad">{{ stats.failed }}</strong>
        <span>issues</span>
      </button>
    </div>

    <section class="section" v-if="currentStage">
      <div class="section-title">
        <Clock3 :size="14" />
        <span>Current Stage</span>
      </div>
      <button class="stage-focus" @click="emit('navigate', 'plan', currentStage.id)">
        <span class="stage-id">{{ currentStage.id }}</span>
        <span class="stage-obj">{{ currentStage.objective }}</span>
        <span v-if="currentStage.tags?.length" class="tag-row">
          <span v-for="tag in currentStage.tags" :key="tag" class="tag">{{ tag }}</span>
        </span>
      </button>
    </section>

    <section class="section">
      <div class="section-title">
        <Users :size="14" />
        <span>Workers</span>
      </div>
      <div v-if="activeWorkers.length === 0" class="empty">No active workers</div>
      <button
        v-for="agent in activeWorkers"
        :key="agent.agent_id"
        class="agent-row"
        @click="emit('navigate', 'agents')"
      >
        <span class="agent-role" :style="{ color: roleColor(agent.agent_type) }">{{ agent.agent_type }}</span>
        <span class="agent-time">{{ elapsed(agent.started_at) }}</span>
        <span v-if="agent.current_task_id" class="agent-task" @click.stop="emit('navigate', 'plan', agent.current_task_id)">{{ agent.current_task_id }}</span>
        <span class="agent-id">{{ agent.agent_id }}</span>
      </button>
    </section>

    <section class="section" v-if="plan?.stages.length">
      <div class="section-title">
        <ListTree :size="14" />
        <span>Queue</span>
      </div>
      <button
        v-for="stage in plan.stages.slice(0, 7)"
        :key="stage.id"
        class="queue-row"
        :class="{ current: stage.id === currentStageId }"
        @click="emit('navigate', 'plan', stage.id)"
      >
        <span>{{ stage.id }}</span>
        <strong>{{ stage.objective }}</strong>
      </button>
    </section>

    <section class="section" v-if="recentHistory.length">
      <div class="section-title">
        <CheckCircle2 :size="14" />
        <span>Recent History</span>
      </div>
      <button
        v-for="entry in recentHistory"
        :key="entry.id"
        class="history-row"
        @click="emit('navigate', 'plan', entry.id)"
      >
        <span class="history-result" :class="entry.result">{{ entry.result }}</span>
        <span class="history-id">{{ entry.id }}</span>
        <strong v-if="entry.summary">{{ entry.summary }}</strong>
      </button>
    </section>
  </aside>
</template>

<style scoped>
.status-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  background: var(--surface-1);
}

.runtime-block {
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.runtime-main {
  display: flex;
  align-items: center;
  gap: 10px;
}

.runtime-label {
  color: var(--text);
  font-size: 13px;
  font-weight: 750;
  text-transform: uppercase;
}

.runtime-sub,
.updated {
  color: var(--text-faint);
  font-size: 11px;
  font-family: var(--mono);
}

.runtime-elapsed {
  margin-left: auto;
  color: var(--warn);
  font-size: 12px;
  font-family: var(--mono);
}

.updated {
  margin-top: 8px;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  border-bottom: 1px solid var(--border);
}

.metric {
  display: grid;
  justify-items: center;
  gap: 3px;
  min-width: 0;
  padding: 12px 6px;
  border: 0;
  border-right: 1px solid var(--border);
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}

.metric:last-child {
  border-right: 0;
}

.metric:hover {
  background: var(--surface-2);
}

.metric strong {
  color: var(--text);
  font-size: 18px;
  line-height: 1;
  font-family: var(--mono);
}

.metric strong.ok { color: var(--accent-2); }
.metric strong.bad { color: var(--danger); }

.metric span {
  font-size: 10px;
  text-transform: uppercase;
}

.section {
  padding: 14px 14px 15px;
  border-bottom: 1px solid var(--border);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 9px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 750;
  text-transform: uppercase;
}

.empty {
  color: var(--text-faint);
  font-size: 13px;
}

.stage-focus,
.agent-row,
.queue-row,
.history-row {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.stage-focus:hover,
.agent-row:hover,
.queue-row:hover,
.history-row:hover {
  border-color: var(--border-strong);
  background: var(--surface-2);
}

.stage-focus {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px;
}

.stage-id,
.history-id,
.agent-id,
.agent-task,
.queue-row span {
  font-family: var(--mono);
}

.stage-id {
  color: var(--accent);
  font-size: 12px;
  font-weight: 750;
}

.stage-obj {
  color: var(--text);
  font-size: 13px;
  line-height: 1.35;
}

.tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.tag {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 7px;
  color: var(--text-muted);
  font-size: 10px;
}

.agent-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 3px 8px;
  padding: 9px 10px;
  margin-bottom: 6px;
}

.agent-role {
  font-size: 12px;
  font-weight: 750;
}

.agent-time {
  color: var(--warn);
  font-family: var(--mono);
  font-size: 11px;
}

.agent-task {
  grid-column: 1 / -1;
  color: var(--accent);
  font-size: 11px;
}

.agent-id {
  grid-column: 1 / -1;
  color: var(--text-faint);
  font-size: 10px;
}

.queue-row,
.history-row {
  display: grid;
  gap: 3px;
  padding: 8px 9px;
  margin-bottom: 5px;
}

.queue-row.current {
  border-color: rgba(106, 166, 255, 0.55);
}

.queue-row span {
  color: var(--accent);
  font-size: 11px;
}

.queue-row strong,
.history-row strong {
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-row {
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
}

.history-result {
  font-size: 10px;
  font-weight: 750;
  text-transform: uppercase;
}

.history-result.completed { color: var(--accent-2); }
.history-result.escalated { color: var(--warn); }
.history-result.failed { color: var(--danger); }

.history-id {
  color: var(--text-muted);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-row strong {
  grid-column: 1 / -1;
}
</style>
