<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { CheckCircle2, CircleDot, History, ListChecks, RefreshCw } from "lucide-vue-next";
import { apiFetch } from "../utils/api";

const props = defineProps<{ focusStageId?: string | null }>();
const emit = defineEmits<{ "focus-consumed": [] }>();

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
  id: string;
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
  failure_reason?: string;
}

interface StageDetail {
  stage_id: string;
  tasks: { tasks: { id: string; description: string; type: string; status: string }[] } | null;
  summary: { result?: string; summary?: string; outcomes_achieved?: string[]; outcomes_missed?: string[]; escalation?: { reason?: string } } | null;
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
const loading = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchPlan() {
  loading.value = true;
  try {
    const [planRes, stateRes, configRes] = await Promise.all([
      apiFetch("/api/plan"),
      apiFetch("/api/state"),
      apiFetch("/api/config"),
    ]);
    if (planRes.ok) {
      const data = await planRes.json();
      plan.value = data.plan;
      history.value = data.history?.stages ?? [];
    }
    if (stateRes.ok) {
      const data = await stateRes.json();
      if (data.plan && !plan.value) plan.value = data.plan;
    }
    if (configRes.ok) config.value = await configRes.json();
  } catch { /* ignore */ }
  loading.value = false;
}

async function fetchStageDetail(stageId: string) {
  try {
    const res = await apiFetch(`/api/plan/stages/${stageId}`);
    if (res.ok) stageDetail.value = await res.json();
  } catch { /* ignore */ }
}

function toggleStage(stageId: string) {
  if (expandedStage.value === stageId) {
    expandedStage.value = null;
    stageDetail.value = null;
    return;
  }
  expandedStage.value = stageId;
  fetchStageDetail(stageId);
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
    case "completed": return "var(--accent-2)";
    case "escalated": return "var(--warn)";
    case "failed": return "var(--danger)";
    case "aborted": return "var(--orange)";
    default: return "var(--text-muted)";
  }
}

function formatDate(ts?: string): string {
  return ts ? new Date(ts).toLocaleString() : "unknown";
}

const activeStages = computed(() => plan.value?.stages ?? []);
const completedCount = computed(() => history.value.filter((entry) => entry.result === "completed").length);
const issueCount = computed(() => history.value.filter((entry) => entry.result === "failed" || entry.result === "escalated" || entry.result === "aborted").length);
const currentStage = computed(() => activeStages.value.find((stage) => stage.id === plan.value?.current_stage_id) ?? null);
const stageRefs = ref<Record<string, HTMLElement | null>>({});

function setStageRef(id: string) {
  return (el: Element | null) => { stageRefs.value[id] = el as HTMLElement | null; };
}

function isHistoryStage(stageId: string): boolean {
  return history.value.some(h => h.id === stageId);
}

watch(() => props.focusStageId, async (stageId) => {
  if (!stageId) return;
  activeSection.value = isHistoryStage(stageId) ? "history" : "stages";
  if (expandedStage.value !== stageId) {
    expandedStage.value = stageId;
    fetchStageDetail(stageId);
  }
  emit("focus-consumed");
  await nextTick();
  stageRefs.value[stageId]?.scrollIntoView({ behavior: "smooth", block: "center" });
}, { immediate: true });
</script>

<template>
  <section class="plan-view">
    <div class="plan-toolbar">
      <div class="summary-strip">
        <div class="summary-item">
          <ListChecks :size="16" />
          <strong>{{ activeStages.length }}</strong>
          <span>active</span>
        </div>
        <div class="summary-item">
          <CheckCircle2 :size="16" />
          <strong class="ok">{{ completedCount }}</strong>
          <span>completed</span>
        </div>
        <div class="summary-item">
          <CircleDot :size="16" />
          <strong>{{ currentStage?.id ?? 'none' }}</strong>
          <span>current</span>
        </div>
        <div class="summary-item">
          <History :size="16" />
          <strong class="bad">{{ issueCount }}</strong>
          <span>issues</span>
        </div>
      </div>
      <button class="console-button refresh" @click="fetchPlan" :disabled="loading" title="Refresh plan" aria-label="Refresh plan">
        <RefreshCw :size="15" :class="{ spin: loading }" />
        <span>Refresh</span>
      </button>
    </div>

    <div class="section-nav" role="tablist" aria-label="Plan sections">
      <button class="section-tab" :class="{ active: activeSection === 'overview' }" @click="activeSection = 'overview'">Overview</button>
      <button class="section-tab" :class="{ active: activeSection === 'stages' }" @click="activeSection = 'stages'">Stages</button>
      <button class="section-tab" :class="{ active: activeSection === 'history' }" @click="activeSection = 'history'">History</button>
    </div>

    <div v-if="!plan && !config" class="empty-state">Loading plan data...</div>

    <div v-else-if="activeSection === 'overview'" class="section-content overview-grid">
      <section class="project-panel">
        <h2>{{ config?.project_name ?? 'Project' }}</h2>
        <div class="meta-line"><span>provider</span><strong>{{ config?.provider ?? 'unknown' }}</strong></div>
        <div class="meta-line"><span>updated</span><strong>{{ formatDate(plan?.updated_at) }}</strong></div>
        <div v-if="config?.objectives?.length" class="objective-list">
          <h3>Objectives</h3>
          <div v-for="(obj, index) in config.objectives" :key="index" class="objective-row">{{ obj }}</div>
        </div>
      </section>

      <section class="pipeline-panel">
        <h2>Stage Pipeline</h2>
        <div v-if="activeStages.length === 0" class="empty-inline">No active stages.</div>
        <button
          v-for="(stage, index) in activeStages"
          :key="stage.id"
          class="pipeline-row"
          :class="{ current: stage.id === plan?.current_stage_id }"
          :aria-label="`Open stage ${stage.id}`"
          @click="activeSection = 'stages'; toggleStage(stage.id)"
        >
          <span class="pipeline-index">{{ index + 1 }}</span>
          <span class="pipeline-body">
            <strong>{{ stage.id }}</strong>
            <span>{{ stage.objective }}</span>
          </span>
        </button>
      </section>
    </div>

    <div v-else-if="activeSection === 'stages'" class="section-content list-content">
      <div v-if="activeStages.length === 0" class="empty-state">No stages in the active plan.</div>
      <article
        v-for="stage in activeStages"
        :key="stage.id"
        class="stage-row"
        :ref="setStageRef(stage.id)"
        :class="{ expanded: expandedStage === stage.id, current: stage.id === plan?.current_stage_id }"
      >
        <button class="stage-summary" @click="toggleStage(stage.id)">
          <span class="stage-status"></span>
          <span class="stage-main">
            <strong>{{ stage.id }}</strong>
            <span>{{ stage.objective }}</span>
          </span>
          <span class="expand-label">{{ expandedStage === stage.id ? 'Collapse' : 'Open' }}</span>
        </button>

        <div v-if="expandedStage === stage.id" class="stage-detail">
          <div class="detail-grid">
            <section v-if="stage.expected_outcomes?.length">
              <h3>Expected Outcomes</h3>
              <ul><li v-for="(item, i) in stage.expected_outcomes" :key="i">{{ item }}</li></ul>
            </section>
            <section v-if="stage.acceptance_criteria?.length">
              <h3>Acceptance Criteria</h3>
              <ul><li v-for="(item, i) in stage.acceptance_criteria" :key="i">{{ item }}</li></ul>
            </section>
            <section v-if="stage.references?.length">
              <h3>References</h3>
              <ul><li v-for="(item, i) in stage.references" :key="i"><code>{{ item }}</code></li></ul>
            </section>
            <section v-if="stage.tags?.length">
              <h3>Tags</h3>
              <div class="tags"><span v-for="tag in stage.tags" :key="tag">{{ tag }}</span></div>
            </section>
          </div>

          <section v-if="stageDetail && stageDetail.stage_id === stage.id" class="evidence-panel">
            <h3>Task Evidence</h3>
            <div v-if="stageDetail.tasks?.tasks?.length" class="task-table">
              <div v-for="task in stageDetail.tasks.tasks" :key="task.id" class="task-row">
                <span>{{ task.id }}</span>
                <span>{{ task.type }}</span>
                <strong :style="{ color: resultColor(task.status) }">{{ task.status }}</strong>
                <p>{{ task.description }}</p>
              </div>
            </div>
            <div v-else class="empty-inline">No tasks recorded yet.</div>

            <div v-if="stageDetail.reports?.length" class="report-list">
              <article v-for="report in stageDetail.reports" :key="report.task_id" class="report-row">
                <div><strong>{{ report.task_id }}</strong><span :style="{ color: resultColor(report.status) }">{{ report.status }}</span></div>
                <p>{{ report.failure_reason ?? report.summary }}</p>
              </article>
            </div>
          </section>
        </div>
      </article>
    </div>

    <div v-else-if="activeSection === 'history'" class="section-content list-content">
      <div v-if="history.length === 0" class="empty-state">No completed stages yet.</div>
      <article
        v-for="entry in [...history].reverse()"
        :key="entry.id"
        class="history-card"
        :ref="setStageRef(entry.id)"
        :class="{ expanded: expandedStage === entry.id }"
      >
        <button class="history-summary-row" @click="toggleStage(entry.id)">
          <span class="result-mark" :style="{ color: resultColor(entry.result) }">{{ entry.result }}</span>
          <span class="history-main">
            <strong>{{ entry.id }}</strong>
            <span>{{ entry.summary }}</span>
          </span>
          <time v-if="entry.completed_at">{{ formatDate(entry.completed_at) }}</time>
        </button>

        <div v-if="entry.actual_outcomes?.length" class="outcomes">
          <span v-for="(outcome, i) in entry.actual_outcomes" :key="i">{{ outcome }}</span>
        </div>

        <div v-if="expandedStage === entry.id && stageDetail && stageDetail.stage_id === entry.id" class="stage-detail history-detail">
          <section v-if="stageDetail.summary">
            <h3>Stage Summary</h3>
            <p>{{ stageDetail.summary.summary }}</p>
            <div v-if="stageDetail.summary.outcomes_achieved?.length" class="outcomes achieved">
              <span v-for="(outcome, i) in stageDetail.summary.outcomes_achieved" :key="i">{{ outcome }}</span>
            </div>
            <div v-if="stageDetail.summary.outcomes_missed?.length" class="outcomes missed">
              <span v-for="(outcome, i) in stageDetail.summary.outcomes_missed" :key="i">{{ outcome }}</span>
            </div>
          </section>
          <section v-if="stageDetail.reports?.length" class="report-list">
            <article v-for="report in stageDetail.reports" :key="report.task_id" class="report-row">
              <div><strong>{{ report.task_id }}</strong><span :style="{ color: resultColor(report.status) }">{{ report.status }}</span></div>
              <p>{{ report.failure_reason ?? report.summary }}</p>
            </article>
          </section>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.plan-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

.plan-toolbar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
}

.summary-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

.summary-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  min-height: 38px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--text-muted);
  background: var(--bg);
}

.summary-item strong {
  overflow: hidden;
  color: var(--text);
  font-family: var(--mono);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.summary-item strong.ok { color: var(--accent-2); }
.summary-item strong.bad { color: var(--danger); }
.summary-item span { font-size: 11px; text-transform: uppercase; }

.refresh {
  padding: 0 10px;
}

.section-nav {
  display: flex;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
}

.section-tab {
  min-width: 86px;
  height: 32px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}

.section-tab:hover,
.section-tab.active {
  color: var(--text);
  background: var(--surface-2);
}

.section-tab.active {
  border-color: var(--accent);
}

.section-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.overview-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.45fr) minmax(0, 1fr);
  gap: 16px;
}

.project-panel,
.pipeline-panel {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  padding: 16px;
}

.project-panel h2,
.pipeline-panel h2 {
  margin: 0 0 12px;
  font-size: 15px;
}

.meta-line {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 10px;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
  font-size: 13px;
}

.meta-line span,
.objective-list h3,
.stage-detail h3 {
  color: var(--text-muted);
  font-size: 11px;
  text-transform: uppercase;
}

.meta-line strong {
  overflow: hidden;
  color: var(--text);
  font-family: var(--mono);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.objective-list {
  margin-top: 14px;
}

.objective-row {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  color: var(--text);
  font-size: 13px;
  line-height: 1.4;
}

.pipeline-row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  gap: 10px;
  width: 100%;
  padding: 10px 0;
  border: 0;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.pipeline-row:hover {
  background: var(--hover-bg);
}

.pipeline-index {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border);
  border-radius: 50%;
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 11px;
}

.pipeline-row.current .pipeline-index {
  border-color: var(--accent);
  color: var(--accent);
}

.pipeline-body {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.pipeline-body strong,
.stage-main strong,
.history-main strong {
  color: var(--accent);
  font-family: var(--mono);
  font-size: 12px;
}

.pipeline-body span,
.stage-main span,
.history-main span {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.35;
}

.list-content {
  max-width: 1120px;
  width: 100%;
}

.stage-row,
.history-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  margin-bottom: 9px;
  overflow: hidden;
}

.stage-row.current {
  border-color: var(--entry-accent-border);
}

.stage-row.expanded,
.history-card.expanded {
  border-color: var(--border-strong);
}

.stage-summary,
.history-summary-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 58px;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  padding: 10px 14px;
  text-align: left;
}

.stage-summary:hover,
.history-summary-row:hover {
  background: var(--surface-2);
}

.stage-status {
  width: 10px;
  height: 10px;
  border: 2px solid var(--border-strong);
  border-radius: 50%;
}

.stage-row.current .stage-status {
  border-color: var(--accent);
  background: var(--accent);
}

.stage-main,
.history-main {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.expand-label,
.history-summary-row time {
  color: var(--text-faint);
  font-size: 11px;
  font-family: var(--mono);
}

.stage-detail {
  padding: 14px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.stage-detail section {
  min-width: 0;
}

.stage-detail h3 {
  margin: 0 0 7px;
  font-weight: 750;
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  padding: 4px 0;
  color: var(--text);
  font-size: 12px;
  line-height: 1.35;
}

code {
  color: var(--code-color);
  background: var(--code-bg);
  border-radius: var(--radius-sm);
  padding: 1px 5px;
  font-size: 11px;
}

.tags,
.outcomes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tags span,
.outcomes span {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 3px 8px;
  color: var(--text-muted);
  font-size: 11px;
}

.evidence-panel {
  margin-top: 14px;
}

.task-table {
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
}

.task-row {
  display: grid;
  grid-template-columns: 120px 80px 90px minmax(0, 1fr);
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  align-items: baseline;
}

.task-row:last-child {
  border-bottom: 0;
}

.task-row span,
.task-row strong {
  font-family: var(--mono);
  font-size: 11px;
}

.task-row p,
.report-row p,
.history-detail p {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.35;
}

.report-list {
  display: grid;
  gap: 7px;
  margin-top: 10px;
}

.report-row {
  display: grid;
  gap: 5px;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 9px 10px;
  background: var(--surface-1);
}

.report-row div {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 12px;
}

.result-mark {
  min-width: 82px;
  font-size: 11px;
  font-weight: 750;
  text-transform: uppercase;
}

.empty-state,
.empty-inline {
  color: var(--text-faint);
  text-align: center;
}

.empty-state {
  padding: 42px;
}

.empty-inline {
  padding: 18px;
  font-size: 13px;
}

.outcomes {
  padding: 0 14px 12px;
}

.outcomes.achieved span { border-color: var(--entry-accent-border); color: var(--accent); }
.outcomes.missed span { border-color: var(--entry-danger-border); color: var(--danger); }

@media (max-width: 980px) {
  .overview-grid,
  .detail-grid {
    grid-template-columns: 1fr;
  }

  .summary-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .plan-toolbar {
    grid-template-columns: 1fr;
  }

  .task-row {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .summary-strip {
    grid-template-columns: 1fr;
  }
}
</style>
