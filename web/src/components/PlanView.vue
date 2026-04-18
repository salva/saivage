<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";

interface StageInfo {
  id: number;
  title: string;
  goal: string;
  status: string;
  entryCriteria: string;
  exitCriteria: string;
  started?: string;
  completed?: string;
}

interface MasterPlan {
  version: number;
  created: string;
  lastUpdated: string;
  activeStage: number | null;
  iterative: boolean;
  vision: string;
  objectives: string[];
  successCriteria: string[];
  stages: StageInfo[];
}

interface StageTask {
  ref: string;
  title: string;
  goal: string;
  agentType: string;
  dependsOn: string[];
  status: string;
  result?: string;
}

interface StagePlan {
  stageId: number;
  title: string;
  status: string;
  created: string;
  lastUpdated: string;
  goal: string;
  approach: string;
  tasks: StageTask[];
  notes: string;
}

interface PlanData {
  project: { description: string; objectives: string[]; root: string };
  masterPlan: MasterPlan | null;
  activeStagePlan: StagePlan | null;
  journal: string;
}

const plan = ref<PlanData | null>(null);
const expandedStage = ref<number | null>(null);
const stagePlanCache = ref<Map<number, StagePlan>>(new Map());
const loadingStage = ref<number | null>(null);
const activeSection = ref<"overview" | "stages" | "journal">("overview");
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchPlan() {
  try {
    const res = await fetch("/api/plan");
    if (res.ok) {
      const data = await res.json();
      if (!data.error) {
        plan.value = data;
        // Cache active stage plan
        if (data.activeStagePlan) {
          stagePlanCache.value.set(data.activeStagePlan.stageId, data.activeStagePlan);
        }
      }
    }
  } catch { /* ignore */ }
}

async function fetchStagePlan(stageId: number) {
  if (stagePlanCache.value.has(stageId)) return;
  loadingStage.value = stageId;
  try {
    const res = await fetch(`/api/plan/stages/${stageId}`);
    if (res.ok) {
      const data = await res.json();
      if (!data.error) {
        stagePlanCache.value.set(stageId, data);
      }
    }
  } catch { /* ignore */ }
  loadingStage.value = null;
}

function toggleStage(stageId: number) {
  if (expandedStage.value === stageId) {
    expandedStage.value = null;
  } else {
    expandedStage.value = stageId;
    fetchStagePlan(stageId);
  }
}

onMounted(() => {
  fetchPlan();
  pollTimer = setInterval(fetchPlan, 10000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

function stageStatusColor(status: string): string {
  switch (status) {
    case "completed": return "#3fb950";
    case "active": return "#58a6ff";
    case "skipped": return "#d29922";
    default: return "#484f58";
  }
}

function taskStatusColor(status: string): string {
  switch (status) {
    case "completed": case "done": return "#3fb950";
    case "in-progress": case "active": return "#58a6ff";
    case "blocked": return "#d29922";
    case "failed": case "cancelled": return "#f85149";
    default: return "#484f58";
  }
}

const stageProgress = computed(() => {
  if (!plan.value?.masterPlan) return { completed: 0, total: 0 };
  const stages = plan.value.masterPlan.stages;
  return {
    completed: stages.filter(s => s.status === "completed").length,
    total: stages.length,
  };
});

const journalLines = computed(() => {
  if (!plan.value?.journal) return [];
  return plan.value.journal.split("\n").filter(l => l.trim());
});
</script>

<template>
  <div class="plan-container">
    <!-- Section nav -->
    <div class="section-nav">
      <button class="section-tab" :class="{ active: activeSection === 'overview' }" @click="activeSection = 'overview'">Overview</button>
      <button class="section-tab" :class="{ active: activeSection === 'stages' }" @click="activeSection = 'stages'">Stages</button>
      <button class="section-tab" :class="{ active: activeSection === 'journal' }" @click="activeSection = 'journal'">Journal</button>
    </div>

    <div v-if="!plan" class="empty-state">Loading plan data…</div>

    <!-- Overview -->
    <div v-else-if="activeSection === 'overview'" class="section-content">
      <div class="card">
        <h2>Project</h2>
        <div class="field">
          <span class="field-label">Description</span>
          <p class="field-value">{{ plan.project.description || "—" }}</p>
        </div>
        <div class="field" v-if="plan.project.objectives?.length">
          <span class="field-label">Objectives</span>
          <ul class="objectives-list">
            <li v-for="(obj, i) in plan.project.objectives" :key="i">{{ obj }}</li>
          </ul>
        </div>
        <div class="field">
          <span class="field-label">Project Root</span>
          <code class="mono">{{ plan.project.root }}</code>
        </div>
      </div>

      <div v-if="plan.masterPlan" class="card">
        <h2>Master Plan</h2>
        <div class="plan-meta">
          <span>v{{ plan.masterPlan.version }}</span>
          <span>Created {{ plan.masterPlan.created }}</span>
          <span>Updated {{ plan.masterPlan.lastUpdated }}</span>
          <span v-if="plan.masterPlan.iterative" class="badge badge-blue">iterative</span>
        </div>

        <div class="field">
          <span class="field-label">Vision</span>
          <p class="field-value vision-text">{{ plan.masterPlan.vision }}</p>
        </div>

        <div class="field" v-if="plan.masterPlan.objectives?.length">
          <span class="field-label">Plan Objectives</span>
          <ul class="objectives-list">
            <li v-for="(obj, i) in plan.masterPlan.objectives" :key="i">{{ obj }}</li>
          </ul>
        </div>

        <div class="field" v-if="plan.masterPlan.successCriteria?.length">
          <span class="field-label">Success Criteria</span>
          <ul class="criteria-list">
            <li v-for="(c, i) in plan.masterPlan.successCriteria" :key="i">{{ c }}</li>
          </ul>
        </div>

        <div class="progress-bar-container">
          <div class="progress-label">Stage Progress: {{ stageProgress.completed }} / {{ stageProgress.total }}</div>
          <div class="progress-bar">
            <div class="progress-fill" :style="{ width: stageProgress.total ? (stageProgress.completed / stageProgress.total * 100) + '%' : '0%' }"></div>
          </div>
        </div>
      </div>

      <!-- Active stage summary -->
      <div v-if="plan.activeStagePlan" class="card">
        <h2>Active Stage: {{ plan.activeStagePlan.title }}</h2>
        <div class="field">
          <span class="field-label">Goal</span>
          <p class="field-value">{{ plan.activeStagePlan.goal }}</p>
        </div>
        <div class="field">
          <span class="field-label">Approach</span>
          <p class="field-value">{{ plan.activeStagePlan.approach }}</p>
        </div>
        <div class="task-summary">
          <span class="task-count" v-for="status in ['completed', 'in-progress', 'pending', 'blocked', 'failed']" :key="status">
            <span class="status-dot" :style="{ background: taskStatusColor(status) }"></span>
            {{ plan.activeStagePlan.tasks.filter(t => t.status === status).length }} {{ status }}
          </span>
        </div>
      </div>
    </div>

    <!-- Stages -->
    <div v-else-if="activeSection === 'stages'" class="section-content">
      <div v-if="!plan.masterPlan" class="empty-state">No master plan generated yet.</div>
      <div v-else>
        <div
          v-for="stage in plan.masterPlan.stages" :key="stage.id"
          class="stage-card"
          :class="{ active: stage.status === 'active', expanded: expandedStage === stage.id }"
          @click="toggleStage(stage.id)"
        >
          <div class="stage-header">
            <span class="stage-status-dot" :style="{ background: stageStatusColor(stage.status) }"></span>
            <span class="stage-id">Stage {{ stage.id }}</span>
            <span class="stage-title">{{ stage.title }}</span>
            <span class="stage-status-badge" :style="{ color: stageStatusColor(stage.status) }">{{ stage.status }}</span>
          </div>
          <div class="stage-goal">{{ stage.goal }}</div>
          <div v-if="stage.started || stage.completed" class="stage-dates">
            <span v-if="stage.started">Started: {{ stage.started }}</span>
            <span v-if="stage.completed"> · Completed: {{ stage.completed }}</span>
          </div>

          <!-- Expanded stage detail -->
          <div v-if="expandedStage === stage.id" class="stage-detail" @click.stop>
            <div v-if="loadingStage === stage.id" class="loading">Loading stage plan…</div>
            <template v-else-if="stagePlanCache.get(stage.id)">
              <div class="detail-section">
                <span class="field-label">Entry Criteria</span>
                <p class="field-value">{{ stage.entryCriteria }}</p>
              </div>
              <div class="detail-section">
                <span class="field-label">Exit Criteria</span>
                <p class="field-value">{{ stage.exitCriteria }}</p>
              </div>
              <div class="detail-section" v-if="stagePlanCache.get(stage.id)!.approach">
                <span class="field-label">Approach</span>
                <p class="field-value">{{ stagePlanCache.get(stage.id)!.approach }}</p>
              </div>
              <h3 class="tasks-heading">Tasks</h3>
              <div v-for="task in stagePlanCache.get(stage.id)!.tasks" :key="task.ref" class="task-row">
                <span class="status-dot" :style="{ background: taskStatusColor(task.status) }"></span>
                <div class="task-info">
                  <div class="task-title"><span class="task-ref">{{ task.ref }}</span> {{ task.title }}</div>
                  <div class="task-goal">{{ task.goal }}</div>
                  <div class="task-meta">
                    <span class="task-agent">{{ task.agentType }}</span>
                    <span v-if="task.dependsOn?.length" class="task-deps">depends: {{ task.dependsOn.join(", ") }}</span>
                    <span class="task-status" :style="{ color: taskStatusColor(task.status) }">{{ task.status }}</span>
                  </div>
                  <div v-if="task.result" class="task-result">{{ task.result }}</div>
                </div>
              </div>
              <div v-if="stagePlanCache.get(stage.id)!.notes" class="detail-section notes-section">
                <span class="field-label">Notes</span>
                <p class="field-value">{{ stagePlanCache.get(stage.id)!.notes }}</p>
              </div>
            </template>
            <div v-else class="loading">No stage plan available.</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Journal -->
    <div v-else-if="activeSection === 'journal'" class="section-content">
      <div v-if="!plan.journal" class="empty-state">No journal entries yet.</div>
      <pre v-else class="journal-content">{{ plan.journal }}</pre>
    </div>
  </div>
</template>

<style scoped>
.plan-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0d1117;
}

.section-nav {
  display: flex;
  gap: 4px;
  padding: 10px 20px;
  border-bottom: 1px solid #21262d;
  background: #161b22;
}

.section-tab {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}

.section-tab:hover {
  color: #c9d1d9;
  background: #21262d;
}

.section-tab.active {
  color: #58a6ff;
  background: #0d1117;
  font-weight: 600;
}

.section-content {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.empty-state {
  color: #484f58;
  font-size: 14px;
  padding: 40px 20px;
  text-align: center;
}

/* Cards */
.card {
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 8px;
  padding: 20px;
}

.card h2 {
  font-size: 15px;
  font-weight: 600;
  color: #c9d1d9;
  margin-bottom: 14px;
  padding-bottom: 8px;
  border-bottom: 1px solid #21262d;
}

.field {
  margin-bottom: 12px;
}

.field-label {
  display: block;
  font-size: 11px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}

.field-value {
  font-size: 13px;
  color: #c9d1d9;
  line-height: 1.5;
}

.vision-text {
  font-size: 14px;
  color: #e6edf3;
  line-height: 1.6;
}

.mono {
  font-family: monospace;
  font-size: 12px;
  color: #8b949e;
  background: #0d1117;
  padding: 2px 6px;
  border-radius: 3px;
}

.objectives-list, .criteria-list {
  list-style: none;
  padding: 0;
}

.objectives-list li, .criteria-list li {
  font-size: 13px;
  color: #c9d1d9;
  padding: 4px 0 4px 16px;
  position: relative;
  line-height: 1.4;
}

.objectives-list li::before {
  content: "→";
  position: absolute;
  left: 0;
  color: #58a6ff;
}

.criteria-list li::before {
  content: "✓";
  position: absolute;
  left: 0;
  color: #3fb950;
}

.plan-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 14px;
}

.badge {
  padding: 1px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
}

.badge-blue {
  color: #58a6ff;
  background: rgba(88, 166, 255, 0.15);
}

/* Progress bar */
.progress-bar-container {
  margin-top: 14px;
}

.progress-label {
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 6px;
}

.progress-bar {
  height: 6px;
  background: #21262d;
  border-radius: 3px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: #3fb950;
  border-radius: 3px;
  transition: width 0.5s ease;
}

/* Task summary on overview */
.task-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
}

.task-count {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: #8b949e;
}

/* Stage cards */
.stage-card {
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 8px;
  padding: 14px 18px;
  cursor: pointer;
  transition: border-color 0.2s;
}

.stage-card:hover {
  border-color: #30363d;
}

.stage-card.active {
  border-left: 3px solid #58a6ff;
}

.stage-card.expanded {
  border-color: #58a6ff;
}

.stage-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.stage-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.stage-id {
  font-size: 12px;
  color: #8b949e;
  font-family: monospace;
  flex-shrink: 0;
}

.stage-title {
  font-size: 14px;
  font-weight: 600;
  color: #c9d1d9;
  flex: 1;
}

.stage-status-badge {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.stage-goal {
  font-size: 13px;
  color: #8b949e;
  line-height: 1.4;
  margin-bottom: 4px;
}

.stage-dates {
  font-size: 11px;
  color: #484f58;
}

/* Stage detail expanded */
.stage-detail {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid #21262d;
}

.detail-section {
  margin-bottom: 12px;
}

.tasks-heading {
  font-size: 12px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin: 14px 0 8px;
}

.task-row {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #21262d;
  align-items: flex-start;
}

.task-row:last-child {
  border-bottom: none;
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-top: 5px;
  flex-shrink: 0;
}

.task-info {
  min-width: 0;
  flex: 1;
}

.task-title {
  font-size: 13px;
  color: #c9d1d9;
  font-weight: 500;
}

.task-ref {
  font-family: monospace;
  font-size: 11px;
  color: #58a6ff;
  margin-right: 4px;
}

.task-goal {
  font-size: 12px;
  color: #8b949e;
  margin-top: 2px;
  line-height: 1.3;
}

.task-meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: #484f58;
  margin-top: 4px;
}

.task-agent {
  color: #d2a8ff;
}

.task-deps {
  font-family: monospace;
}

.task-status {
  font-weight: 600;
}

.task-result {
  font-size: 12px;
  color: #8b949e;
  margin-top: 4px;
  padding: 6px 8px;
  background: #0d1117;
  border-radius: 4px;
  line-height: 1.4;
}

.notes-section {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid #21262d;
}

.loading {
  font-size: 13px;
  color: #484f58;
  padding: 8px 0;
}

/* Journal */
.journal-content {
  font-family: monospace;
  font-size: 12px;
  color: #8b949e;
  line-height: 1.6;
  background: #161b22;
  border: 1px solid #21262d;
  border-radius: 8px;
  padding: 20px;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  flex: 1;
}
</style>
