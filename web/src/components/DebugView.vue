<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import JsonHighlight from "./JsonHighlight.vue";

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
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function fetchState() {
  try {
    const res = await fetch("/api/debug/state");
    if (res.ok) stateData.value = await res.json();
  } catch { /* ignore */ }
}

async function fetchErrors() {
  try {
    const res = await fetch("/api/debug/errors");
    if (res.ok) {
      const data = await res.json();
      errors.value = data.errors ?? [];
    }
  } catch { /* ignore */ }
}

async function fetchTimeline() {
  try {
    const res = await fetch("/api/debug/timeline");
    if (res.ok) {
      const data = await res.json();
      timeline.value = data.events ?? [];
    }
  } catch { /* ignore */ }
}

function fetchAll() {
  fetchState();
  fetchErrors();
  fetchTimeline();
}

onMounted(() => {
  fetchAll();
  pollTimer = setInterval(fetchAll, 8000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

function toggleSection(key: string) {
  if (expandedSections.value.has(key)) {
    expandedSections.value.delete(key);
  } else {
    expandedSections.value.add(key);
  }
}

function severityColor(severity: string): string {
  switch (severity) {
    case "error": return "#f85149";
    case "warning": return "#d29922";
    case "info": return "#58a6ff";
    default: return "#8b949e";
  }
}

function eventColor(type: string): string {
  if (type.includes("completed")) return "#3fb950";
  if (type.includes("failed") || type.includes("escalated")) return "#f85149";
  if (type.includes("started")) return "#58a6ff";
  return "#8b949e";
}

function eventIcon(type: string): string {
  if (type.includes("completed")) return "✓";
  if (type.includes("failed")) return "✗";
  if (type.includes("escalated")) return "⬆";
  if (type.includes("started")) return "▶";
  return "•";
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleString();
}

const STATE_SECTIONS = [
  { key: "runtime", label: "Runtime State" },
  { key: "plan", label: "Plan" },
  { key: "history", label: "Plan History" },
  { key: "config", label: "Project Config" },
  { key: "saivage_config", label: "Saivage Config" },
];
</script>

<template>
  <div class="debug-view">
    <div class="debug-tabs">
      <button class="dtab" :class="{ active: activeTab === 'state' }" @click="activeTab = 'state'">State</button>
      <button class="dtab" :class="{ active: activeTab === 'errors' }" @click="activeTab = 'errors'">
        Errors <span v-if="errors.length" class="err-badge">{{ errors.length }}</span>
      </button>
      <button class="dtab" :class="{ active: activeTab === 'timeline' }" @click="activeTab = 'timeline'">Timeline</button>
    </div>

    <!-- State -->
    <div v-if="activeTab === 'state'" class="debug-content">
      <div v-if="!stateData" class="debug-empty">Loading state data…</div>
      <template v-if="stateData">
        <div
          v-for="section in STATE_SECTIONS"
          :key="section.key"
          class="state-section"
        >
          <div class="section-header" @click="toggleSection(section.key)">
            <span class="section-expand">{{ expandedSections.has(section.key) ? '▼' : '▶' }}</span>
            <span class="section-label">{{ section.label }}</span>
            <span class="section-hint" v-if="!stateData[section.key]">null</span>
          </div>
          <JsonHighlight
            v-if="expandedSections.has(section.key) && stateData[section.key]"
            :data="stateData[section.key]"
            max-height="400px"
          />
        </div>
      </template>
    </div>

    <!-- Errors -->
    <div v-if="activeTab === 'errors'" class="debug-content">
      <div v-if="errors.length === 0" class="debug-empty">No errors recorded</div>
      <div v-for="(err, i) in errors" :key="i" class="error-card">
        <div class="error-header">
          <span class="error-severity" :style="{ color: severityColor(err.severity) }">{{ err.severity }}</span>
          <span class="error-type">{{ err.type }}</span>
          <span class="error-source">{{ err.source }}</span>
          <span v-if="err.timestamp" class="error-time">{{ formatTime(err.timestamp) }}</span>
        </div>
        <div class="error-message">{{ err.message }}</div>
        <JsonHighlight v-if="err.details" :data="err.details" max-height="200px" />
      </div>
    </div>

    <!-- Timeline -->
    <div v-if="activeTab === 'timeline'" class="debug-content">
      <div v-if="timeline.length === 0" class="debug-empty">No events recorded</div>
      <div v-for="(ev, i) in timeline" :key="i" class="timeline-item">
        <div class="tl-marker">
          <span class="tl-icon" :style="{ color: eventColor(ev.type) }">{{ eventIcon(ev.type) }}</span>
          <span v-if="i < timeline.length - 1" class="tl-line"></span>
        </div>
        <div class="tl-content">
          <div class="tl-header">
            <span class="tl-type" :style="{ color: eventColor(ev.type) }">{{ ev.type }}</span>
            <span class="tl-source">{{ ev.source }}</span>
            <span class="tl-time">{{ formatTime(ev.timestamp) }}</span>
          </div>
          <div class="tl-desc">{{ ev.description }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debug-view { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

.debug-tabs { display: flex; gap: 4px; padding: 12px 16px; border-bottom: 1px solid #21262d; background: #161b22; flex-shrink: 0; }
.dtab { background: none; border: none; color: #8b949e; font-size: 13px; padding: 4px 12px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; gap: 6px; }
.dtab:hover { color: #c9d1d9; background: #21262d; }
.dtab.active { color: #58a6ff; background: #0d1117; font-weight: 600; }
.err-badge { font-size: 10px; background: #f85149; color: #fff; padding: 1px 5px; border-radius: 8px; }

.debug-content { flex: 1; overflow-y: auto; padding: 16px; }
.debug-empty { font-size: 14px; color: #484f58; text-align: center; padding: 48px; }

/* State sections */
.state-section { margin-bottom: 8px; background: #161b22; border: 1px solid #21262d; border-radius: 6px; overflow: hidden; }
.section-header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; }
.section-header:hover { background: #21262d; }
.section-expand { font-size: 10px; color: #484f58; width: 14px; }
.section-label { font-size: 13px; font-weight: 600; color: #c9d1d9; }
.section-hint { font-size: 11px; color: #484f58; font-style: italic; margin-left: auto; }


/* Errors */
.error-card { background: #161b22; border: 1px solid #21262d; border-radius: 6px; padding: 12px; margin-bottom: 8px; }
.error-header { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; flex-wrap: wrap; }
.error-severity { font-size: 11px; font-weight: 700; text-transform: uppercase; }
.error-type { font-size: 11px; color: #8b949e; background: #21262d; padding: 1px 6px; border-radius: 3px; }
.error-source { font-size: 12px; font-family: monospace; color: #58a6ff; }
.error-time { font-size: 11px; color: #484f58; margin-left: auto; }
.error-message { font-size: 13px; color: #c9d1d9; line-height: 1.4; }


/* Timeline */
.timeline-item { display: flex; gap: 12px; }
.tl-marker { display: flex; flex-direction: column; align-items: center; width: 20px; flex-shrink: 0; }
.tl-icon { font-size: 14px; font-weight: 700; }
.tl-line { width: 2px; flex: 1; background: #21262d; margin: 4px 0; }
.tl-content { padding-bottom: 16px; min-width: 0; flex: 1; }
.tl-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; flex-wrap: wrap; }
.tl-type { font-size: 11px; font-weight: 600; }
.tl-source { font-size: 12px; font-family: monospace; color: #58a6ff; }
.tl-time { font-size: 11px; color: #484f58; margin-left: auto; }
.tl-desc { font-size: 12px; color: #8b949e; line-height: 1.4; }
</style>
