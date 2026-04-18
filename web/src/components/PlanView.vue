<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";

interface Stage {
  id: string;
  objective: string;
  starting_points?: string[];
  expected_outcomes?: string[];
  acceptance_criteria?: string[];
  references?: string[];
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
  actual_outcomes?: string[];
  completed_at?: string;
}

interface TaskReport {
  task_id: string;
  stage_id: string;
  status: string;
  summary: string;
  type?: string;
}

interface StageDetail {
  stage_id: string;
  tasks: { tasks: { id: string; description: string; type: string; status: string }[] } | null;
  summary: { result: string; summary: string } | null;
  reports: TaskReport[];
}

interface Config {
  project_name: string;
  objectives: string[];
  provider: string;
}

const plan = ref<Plan | null>(null);
const history = ref<HistoryEntry[]>([]);
const config = ref<Config | null>(null);
const expandedStage = ref<string | null>(null);
const stageDetail = ref<StageDetail | null>(null);
const activeSection = ref<"overview" | "stages" | "history">("overview");
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchPlan() {
  try {
    const [planRes, stateRes, healthRes] = await Promise.all([
      fetch("/api/plan"),
      fetch("/api/state"),
      fetch("/health"),
    ]);
    if (planRes.ok) {
      const data = await planRes.json();
      plan.value = data.plan;
      history.value = data.history?.entries ?? [];
    }
    if (stateRes.ok) {
      const data = await stateRes.json();
      if (data.plan && !plan.value) plan.value = data.plan;
    }
    if (healthRes.ok) {
      const data = await healthRes.json();
      if (!config.value) {
        config.value = {
          project_name: data.project ?? "",
          objectives: [],
          provider: "",
        };
      }
    }
  } catch { /* ignore */ }
}

async function fetchStageDetail(stageId: string) {
  try {
    const res = await fetch(`/api/plan/stages/${stageId}`);
    if (res.ok) stageDetail.value = await res.json();
  } catch { /* ignore */ }
}

function toggleStage(stageId: string) {
  if (expandedStage.value === stageId) {
    expandedStage.value = null;
    stageDetail.value = null;
  } else {
    expandedStage.value = stageId;
    fetchStageDetail(stageId);
  }
}

onMounted(() => {
  fetchPlan();
  pollTimer = setInterval(fetchPlan, 8000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

function resultColor(result: string): string {
  switch (result) {
    case "completed": return "#3fb950";
    case "escalated": return "#d29922";
    case "failed": return "#f85149";
    default: return "#8b949e";
  }
}

const allStages = computed(() => {
  const active = plan.value?.stages ?? [];
  return active;
});
</script>

<template>
  <div class="plan-container">
    <div class="section-nav">
      <button class="section-tab" :class="{ active: activeSection === 'overview' }" @click="activeSection = 'overview'">Overview</button>
      <button class="section-tab" :class="{ active: activeSection === 'stages' }" @click="activeSection = 'stages'">Stages</button>
      <button class="section-tab" :class="{ active: activeSection === 'history' }" @click="activeSection = 'history'">History</button>
    </div>

    <div v-if="!plan && !config" class="empty-state">Loading plan data…</div>

    <!-- Overview -->
    <div v-else-if="activeSection === 'overview'" class="section-content">
      <div class="card">
        <h2>Project</h2>
        <div class="field" v-if="config?.project_name">
          <span class="field-label">Name</span>
          <span class="field-value">{{ config.project_name }}</span>
        </div>
      </div>

      <div v-if="plan" class="card">
        <h2>Plan</h2>
        <div class="plan-summary">
          <span>{{ plan.stages.length }} active stage{{ plan.stages.length !== 1 ? 's' : '' }}</span>
          <span v-if="plan.current_stage_id"> · current: <code>{{ plan.current_stage_id }}</code></span>
          <span> · {{ history.length }} completed</span>
        </div>
        <div class="field" v-if="plan.updated_at">
          <span class="field-label">Last Updated</span>
          <span class="field-value mono">{{ new Date(plan.updated_at).toLocaleString() }}</span>
        </div>
      </div>

      <div v-if="plan && plan.stages.length > 0" class="card">
        <h2>Stage Pipeline</h2>
        <div class="pipeline">
          <div v-for="(stage, i) in plan.stages" :key="stage.id" class="pipeline-item"
               :class="{ current: stage.id === plan.current_stage_id }">
            <div class="pipeline-marker">
              <span class="pipeline-dot" :class="{ active: stage.id === plan.current_stage_id }"></span>
              <span v-if="i < plan.stages.length - 1" class="pipeline-line"></span>
            </div>
            <div class="pipeline-content">
              <div class="pipeline-id">{{ stage.id }}</div>
              <div class="pipeline-obj">{{ stage.objective }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Stages detail -->
    <div v-else-if="activeSection === 'stages'" class="section-content">
      <div v-if="allStages.length === 0" class="empty-state">No stages in plan.</div>
      <div v-for="stage in allStages" :key="stage.id" class="stage-card" @click="toggleStage(stage.id)">
        <div class="stage-header">
          <span class="stage-id-badge" :class="{ current: stage.id === plan?.current_stage_id }">{{ stage.id }}</span>
          <span class="expand-icon">{{ expandedStage === stage.id ? '▲' : '▼' }}</span>
        </div>
        <div class="stage-objective">{{ stage.objective }}</div>

        <div v-if="expandedStage === stage.id" class="stage-detail" @click.stop>
          <div v-if="stage.expected_outcomes?.length" class="detail-section">
            <h3>Expected Outcomes</h3>
            <ul><li v-for="(o, i) in stage.expected_outcomes" :key="i">{{ o }}</li></ul>
          </div>
          <div v-if="stage.acceptance_criteria?.length" class="detail-section">
            <h3>Acceptance Criteria</h3>
            <ul><li v-for="(c, i) in stage.acceptance_criteria" :key="i">{{ c }}</li></ul>
          </div>
          <div v-if="stage.references?.length" class="detail-section">
            <h3>References</h3>
            <ul><li v-for="(r, i) in stage.references" :key="i"><code>{{ r }}</code></li></ul>
          </div>
          <div v-if="stage.tags?.length" class="detail-section">
            <h3>Tags</h3>
            <div class="tags"><span v-for="t in stage.tags" :key="t" class="tag">{{ t }}</span></div>
          </div>

          <!-- Task reports if loaded -->
          <div v-if="stageDetail && stageDetail.stage_id === stage.id" class="detail-section">
            <h3>Tasks</h3>
            <div v-if="stageDetail.tasks?.tasks?.length">
              <div v-for="task in stageDetail.tasks.tasks" :key="task.id" class="task-row">
                <span class="task-id">{{ task.id }}</span>
                <span class="task-type">{{ task.type }}</span>
                <span class="task-status" :style="{ color: resultColor(task.status) }">{{ task.status }}</span>
                <span class="task-desc">{{ task.description.slice(0, 80) }}</span>
              </div>
            </div>
            <div v-else class="empty-state">No tasks recorded yet.</div>

            <div v-if="stageDetail.reports?.length" class="reports-section">
              <h3>Reports</h3>
              <div v-for="report in stageDetail.reports" :key="report.task_id" class="report-card">
                <div class="report-header">
                  <span class="report-id">{{ report.task_id }}</span>
                  <span class="report-status" :style="{ color: resultColor(report.status) }">{{ report.status }}</span>
                </div>
                <div class="report-summary">{{ report.summary }}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- History -->
    <div v-else-if="activeSection === 'history'" class="section-content">
      <div v-if="history.length === 0" class="empty-state">No completed stages yet.</div>
      <div v-for="entry in [...history].reverse()" :key="entry.stage_id" class="history-card">
        <div class="history-header">
          <span class="history-id">{{ entry.stage_id }}</span>
          <span class="history-result" :style="{ color: resultColor(entry.result) }">{{ entry.result }}</span>
          <span v-if="entry.completed_at" class="history-time">{{ new Date(entry.completed_at).toLocaleString() }}</span>
        </div>
        <div class="history-summary">{{ entry.summary }}</div>
        <div v-if="entry.actual_outcomes?.length" class="history-outcomes">
          <h4>Outcomes</h4>
          <ul><li v-for="(o, i) in entry.actual_outcomes" :key="i">{{ o }}</li></ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plan-container { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.section-nav { display: flex; gap: 4px; padding: 12px 16px; border-bottom: 1px solid #21262d; background: #161b22; flex-shrink: 0; }
.section-tab { background: none; border: none; color: #8b949e; font-size: 13px; padding: 4px 12px; border-radius: 4px; cursor: pointer; }
.section-tab:hover { color: #c9d1d9; background: #21262d; }
.section-tab.active { color: #58a6ff; background: #0d1117; font-weight: 600; }

.section-content { flex: 1; overflow-y: auto; padding: 16px; }
.empty-state { font-size: 14px; color: #484f58; padding: 32px; text-align: center; }

.card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
h2 { font-size: 14px; font-weight: 600; color: #c9d1d9; margin-bottom: 12px; }
.field { margin-bottom: 8px; }
.field-label { display: block; font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2px; }
.field-value { font-size: 13px; color: #c9d1d9; }
.mono { font-family: monospace; }

.plan-summary { font-size: 13px; color: #8b949e; margin-bottom: 8px; }
.plan-summary code { color: #58a6ff; background: #0d1117; padding: 1px 4px; border-radius: 3px; font-size: 12px; }

/* Pipeline visualization */
.pipeline { padding-left: 4px; }
.pipeline-item { display: flex; gap: 12px; }
.pipeline-item.current .pipeline-obj { color: #c9d1d9; font-weight: 500; }
.pipeline-marker { display: flex; flex-direction: column; align-items: center; width: 16px; flex-shrink: 0; }
.pipeline-dot { width: 10px; height: 10px; border-radius: 50%; background: #30363d; border: 2px solid #484f58; flex-shrink: 0; }
.pipeline-dot.active { background: #58a6ff; border-color: #58a6ff; box-shadow: 0 0 6px rgba(88, 166, 255, 0.4); }
.pipeline-line { width: 2px; flex: 1; background: #21262d; margin: 2px 0; }
.pipeline-content { padding-bottom: 16px; min-width: 0; }
.pipeline-id { font-size: 11px; font-weight: 700; color: #58a6ff; font-family: monospace; margin-bottom: 2px; }
.pipeline-obj { font-size: 12px; color: #8b949e; line-height: 1.4; }

/* Stage cards */
.stage-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.2s; }
.stage-card:hover { border-color: #30363d; }
.stage-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
.stage-id-badge { font-size: 12px; font-weight: 700; font-family: monospace; color: #8b949e; padding: 2px 8px; background: #0d1117; border-radius: 4px; }
.stage-id-badge.current { color: #58a6ff; background: rgba(56, 139, 253, 0.15); }
.expand-icon { font-size: 10px; color: #484f58; }
.stage-objective { font-size: 13px; color: #c9d1d9; line-height: 1.4; }

.stage-detail { margin-top: 12px; padding-top: 12px; border-top: 1px solid #21262d; cursor: default; }
.detail-section { margin-bottom: 12px; }
h3 { font-size: 12px; font-weight: 600; color: #8b949e; margin-bottom: 6px; }
h4 { font-size: 11px; font-weight: 600; color: #8b949e; margin-bottom: 4px; }
ul { list-style: none; padding: 0; }
li { font-size: 12px; color: #c9d1d9; padding: 2px 0; padding-left: 12px; position: relative; }
li::before { content: "•"; position: absolute; left: 0; color: #484f58; }
code { font-size: 11px; color: #58a6ff; background: #0d1117; padding: 1px 4px; border-radius: 3px; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag { font-size: 10px; padding: 2px 6px; background: #21262d; color: #8b949e; border-radius: 3px; }

/* Tasks table */
.task-row { display: flex; gap: 8px; align-items: baseline; padding: 4px 0; font-size: 12px; border-bottom: 1px solid #21262d; }
.task-id { font-family: monospace; color: #8b949e; min-width: 80px; }
.task-type { font-size: 11px; color: #d29922; min-width: 60px; }
.task-status { font-size: 11px; font-weight: 600; min-width: 60px; }
.task-desc { color: #c9d1d9; flex: 1; min-width: 0; }

/* Reports */
.reports-section { margin-top: 12px; }
.report-card { background: #0d1117; border-radius: 6px; padding: 10px; margin-bottom: 6px; border: 1px solid #21262d; }
.report-header { display: flex; justify-content: space-between; margin-bottom: 4px; }
.report-id { font-size: 12px; font-family: monospace; color: #8b949e; }
.report-status { font-size: 11px; font-weight: 600; }
.report-summary { font-size: 12px; color: #c9d1d9; line-height: 1.4; }

/* History */
.history-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px; margin-bottom: 8px; }
.history-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.history-id { font-size: 13px; font-weight: 700; font-family: monospace; color: #c9d1d9; }
.history-result { font-size: 12px; font-weight: 600; }
.history-time { font-size: 11px; color: #484f58; margin-left: auto; }
.history-summary { font-size: 13px; color: #8b949e; line-height: 1.5; }
.history-outcomes { margin-top: 8px; }
</style>
