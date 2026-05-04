<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { AlertTriangle, Braces, Clock, RefreshCw } from "lucide-vue-next";
import JsonHighlight from "./JsonHighlight.vue";
import { apiFetch } from "../utils/api";

interface ErrorEntry {
  source: string;
  type: string;
  severity: string;
  message: string;
  details?: unknown;
  timestamp?: string;
}

interface TimelineEvent {
  timestamp: string;
  type: string;
  source: string;
  description: string;
}

const activeTab = ref<"state" | "errors" | "timeline">("state");
const stateData = ref<Record<string, unknown> | null>(null);
const errors = ref<ErrorEntry[]>([]);
const timeline = ref<TimelineEvent[]>([]);
const expandedSections = ref<Set<string>>(new Set(["runtime"]));
const loading = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchState() {
  try {
    const res = await apiFetch("/api/debug/state");
    if (res.ok) stateData.value = await res.json();
  } catch { /* ignore */ }
}

async function fetchErrors() {
  try {
    const res = await apiFetch("/api/debug/errors");
    if (res.ok) {
      const data = await res.json();
      errors.value = data.errors ?? [];
    }
  } catch { /* ignore */ }
}

async function fetchTimeline() {
  try {
    const res = await apiFetch("/api/debug/timeline");
    if (res.ok) {
      const data = await res.json();
      timeline.value = data.events ?? [];
    }
  } catch { /* ignore */ }
}

async function fetchAll() {
  loading.value = true;
  await Promise.all([fetchState(), fetchErrors(), fetchTimeline()]);
  loading.value = false;
}

onMounted(() => {
  fetchAll();
  pollTimer = setInterval(fetchAll, 8000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

function toggleSection(key: string) {
  const next = new Set(expandedSections.value);
  if (next.has(key)) next.delete(key); else next.add(key);
  expandedSections.value = next;
}

function severityColor(severity: string): string {
  switch (severity) {
    case "error": return "var(--danger)";
    case "warning": return "var(--warn)";
    case "info": return "var(--accent)";
    default: return "var(--text-muted)";
  }
}

function eventColor(type: string): string {
  if (type.includes("completed")) return "var(--accent-2)";
  if (type.includes("failed") || type.includes("escalated")) return "var(--danger)";
  if (type.includes("started")) return "var(--accent)";
  return "var(--text-muted)";
}

function formatTime(ts?: string): string {
  return ts ? new Date(ts).toLocaleString() : "unknown";
}

const STATE_SECTIONS = [
  { key: "runtime", label: "Runtime State" },
  { key: "plan", label: "Plan" },
  { key: "history", label: "Plan History" },
  { key: "config", label: "Project Config" },
  { key: "saivage_config", label: "Saivage Config" },
];

const tabItems = computed(() => [
  { id: "state", label: "State", icon: Braces, count: STATE_SECTIONS.length },
  { id: "errors", label: "Errors", icon: AlertTriangle, count: errors.value.length },
  { id: "timeline", label: "Timeline", icon: Clock, count: timeline.value.length },
] as const);
</script>

<template>
  <section class="debug-view">
    <div class="debug-toolbar">
      <div class="debug-tabs">
        <button
          v-for="tab in tabItems"
          :key="tab.id"
          class="dtab"
          :class="{ active: activeTab === tab.id }"
          @click="activeTab = tab.id"
        >
          <component :is="tab.icon" :size="15" />
          <span>{{ tab.label }}</span>
          <strong>{{ tab.count }}</strong>
        </button>
      </div>
      <button class="console-button refresh" @click="fetchAll" :disabled="loading" title="Refresh debug data" aria-label="Refresh debug data">
        <RefreshCw :size="15" :class="{ spin: loading }" />
        <span>Refresh</span>
      </button>
    </div>

    <div v-if="activeTab === 'state'" class="debug-content state-grid">
      <div v-if="!stateData" class="debug-empty">Loading state data...</div>
      <section
        v-for="section in STATE_SECTIONS"
        v-else
        :key="section.key"
        class="state-section"
      >
        <button class="state-header" @click="toggleSection(section.key)">
          <span>{{ expandedSections.has(section.key) ? 'open' : 'closed' }}</span>
          <strong>{{ section.label }}</strong>
          <em v-if="!stateData[section.key]">null</em>
        </button>
        <JsonHighlight
          v-if="expandedSections.has(section.key) && stateData[section.key]"
          :data="stateData[section.key]"
          max-height="520px"
        />
      </section>
    </div>

    <div v-if="activeTab === 'errors'" class="debug-content list-content">
      <div v-if="errors.length === 0" class="debug-empty">No errors recorded</div>
      <article v-for="(err, i) in errors" :key="i" class="error-card">
        <div class="error-header">
          <span class="severity" :style="{ color: severityColor(err.severity) }">{{ err.severity }}</span>
          <strong>{{ err.type }}</strong>
          <code>{{ err.source }}</code>
          <time>{{ formatTime(err.timestamp) }}</time>
        </div>
        <p>{{ err.message }}</p>
        <JsonHighlight v-if="err.details" :data="err.details" max-height="240px" />
      </article>
    </div>

    <div v-if="activeTab === 'timeline'" class="debug-content list-content">
      <div v-if="timeline.length === 0" class="debug-empty">No events recorded</div>
      <article v-for="(ev, i) in timeline" :key="i" class="timeline-row">
        <span class="timeline-dot" :style="{ background: eventColor(ev.type) }"></span>
        <div>
          <header>
            <strong :style="{ color: eventColor(ev.type) }">{{ ev.type }}</strong>
            <code>{{ ev.source }}</code>
            <time>{{ formatTime(ev.timestamp) }}</time>
          </header>
          <p>{{ ev.description }}</p>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.debug-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg);
}

.debug-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
}

.debug-tabs {
  display: flex;
  gap: 7px;
  min-width: 0;
}

.dtab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--text-muted);
  background: transparent;
  cursor: pointer;
}

.dtab:hover,
.dtab.active {
  color: var(--text);
  background: var(--surface-2);
}

.dtab.active {
  border-color: var(--accent);
}

.dtab span {
  font-size: 12px;
}

.dtab strong {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}

.refresh {
  padding: 0 10px;
}

.debug-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
}

.state-grid {
  display: grid;
  align-content: start;
  gap: 10px;
}

.state-section,
.error-card,
.timeline-row {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  overflow: hidden;
}

.state-header {
  display: grid;
  grid-template-columns: 54px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 42px;
  border: 0;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  padding: 0 12px;
  text-align: left;
}

.state-header:hover {
  background: var(--surface-2);
}

.state-header span,
.state-header em {
  color: var(--text-faint);
  font-size: 11px;
  font-style: normal;
  font-family: var(--mono);
}

.state-header strong {
  font-size: 13px;
}

.list-content {
  max-width: 1080px;
  width: 100%;
}

.error-card {
  margin-bottom: 9px;
  padding: 12px;
}

.error-header {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.severity {
  font-size: 11px;
  font-weight: 800;
  text-transform: uppercase;
}

.error-header strong {
  color: var(--text);
  font-size: 13px;
}

code {
  color: #9dd2ff;
  background: var(--bg);
  border-radius: 4px;
  padding: 2px 6px;
  font-family: var(--mono);
  font-size: 11px;
}

time {
  margin-left: auto;
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}

.error-card p,
.timeline-row p {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.4;
}

.error-card :deep(.json-hl) {
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
}

.timeline-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  margin-bottom: 8px;
  padding: 12px;
}

.timeline-dot {
  width: 10px;
  height: 10px;
  margin-top: 4px;
  border-radius: 50%;
}

.timeline-row header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 5px;
}

.timeline-row header strong {
  font-size: 12px;
}

.debug-empty {
  display: grid;
  place-items: center;
  min-height: 220px;
  color: var(--text-faint);
  font-size: 14px;
}

@media (max-width: 780px) {
  .debug-toolbar {
    flex-direction: column;
  }

  .debug-tabs {
    overflow-x: auto;
  }

  time {
    margin-left: 0;
  }
}
</style>
