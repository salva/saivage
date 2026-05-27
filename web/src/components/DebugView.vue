<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { AlertTriangle, Braces, Brain, Clock, FileText, Lightbulb, RefreshCw } from "lucide-vue-next";
import JsonHighlight from "./JsonHighlight.vue";
import FormattedContent from "./FormattedContent.vue";
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

interface RolePrompt {
  name: string;
  role: string;
  content: string;
}

interface SkillSummary {
  id: string;
  name: string;
  scope: string;
  scope_ref?: string;
  status: string;
  updated_at: string;
  triggers: string[];
  target_agents: string[];
  survive_compaction: boolean;
  description: string;
}

interface SkillDetail {
  record: SkillSummary & Record<string, unknown>;
  body: string;
  redacted_spans: number;
}

interface MemorySummary {
  id: string;
  topic: { domain: string; subject: string; aspect?: string };
  scope: string;
  scope_ref?: string;
  status: string;
  updated_at: string;
  keys: string[];
  target_agents: string[];
  source_ref?: { kind: string; id: string };
}

interface MemoryDetail extends MemorySummary {
  body: string;
  redacted_spans: number;
}

const activeTab = ref<"state" | "errors" | "timeline" | "prompts" | "skills" | "memories">("state");
const stateData = ref<Record<string, unknown> | null>(null);
const errors = ref<ErrorEntry[]>([]);
const timeline = ref<TimelineEvent[]>([]);
const prompts = ref<RolePrompt[]>([]);
const selectedPrompt = ref<string | null>(null);
const skills = ref<SkillSummary[]>([]);
const selectedSkillId = ref<string | null>(null);
const skillDetail = ref<SkillDetail | null>(null);
const skillDetailLoading = ref(false);
const memories = ref<MemorySummary[]>([]);
const selectedMemoryId = ref<string | null>(null);
const memoryDetail = ref<MemoryDetail | null>(null);
const memoryDetailLoading = ref(false);
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

async function fetchPrompts() {
  try {
    const res = await apiFetch("/api/debug/prompts");
    if (res.ok) {
      const data = await res.json();
      prompts.value = data.prompts ?? [];
      if (!selectedPrompt.value && prompts.value.length > 0) {
        selectedPrompt.value = prompts.value[0].name;
      }
    }
  } catch { /* ignore */ }
}

async function fetchSkills() {
  try {
    const res = await apiFetch("/api/debug/skills");
    if (res.ok) {
      const data = await res.json();
      skills.value = data.skills ?? [];
      if (!selectedSkillId.value && skills.value.length > 0) {
        await selectSkill(skills.value[0].id);
      }
    }
  } catch { /* ignore */ }
}

async function selectSkill(id: string) {
  selectedSkillId.value = id;
  skillDetail.value = null;
  skillDetailLoading.value = true;
  try {
    const res = await apiFetch(`/api/debug/skills/${encodeURIComponent(id)}`);
    if (res.ok) {
      skillDetail.value = await res.json();
    }
  } catch { /* ignore */ }
  finally { skillDetailLoading.value = false; }
}

async function fetchMemories() {
  try {
    const res = await apiFetch("/api/debug/memories");
    if (res.ok) {
      const data = await res.json();
      memories.value = data.memories ?? [];
      if (!selectedMemoryId.value && memories.value.length > 0) {
        await selectMemory(memories.value[0].id);
      }
    }
  } catch { /* ignore */ }
}

async function selectMemory(id: string) {
  selectedMemoryId.value = id;
  memoryDetail.value = null;
  memoryDetailLoading.value = true;
  try {
    const res = await apiFetch(`/api/debug/memories/${encodeURIComponent(id)}`);
    if (res.ok) {
      memoryDetail.value = await res.json();
    }
  } catch { /* ignore */ }
  finally { memoryDetailLoading.value = false; }
}

async function fetchAll() {
  loading.value = true;
  await Promise.all([
    fetchState(),
    fetchErrors(),
    fetchTimeline(),
    fetchPrompts(),
    fetchSkills(),
    fetchMemories(),
  ]);
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
  { id: "prompts", label: "Prompts", icon: FileText, count: prompts.value.length },
  { id: "skills", label: "Skills", icon: Lightbulb, count: skills.value.length },
  { id: "memories", label: "Memories", icon: Brain, count: memories.value.length },
] as const);

const activePrompt = computed<RolePrompt | null>(() => {
  if (!selectedPrompt.value) return null;
  return prompts.value.find((p) => p.name === selectedPrompt.value) ?? null;
});

const activeSkill = computed<SkillSummary | null>(() => {
  if (!selectedSkillId.value) return null;
  return skills.value.find((s) => s.id === selectedSkillId.value) ?? null;
});

const activeMemory = computed<MemorySummary | null>(() => {
  if (!selectedMemoryId.value) return null;
  return memories.value.find((m) => m.id === selectedMemoryId.value) ?? null;
});

function memoryTopicLabel(t: MemorySummary["topic"]): string {
  return [t.domain, t.subject, t.aspect].filter(Boolean).join(" / ");
}

function shortId(id: string): string {
  return id.length > 14 ? id.slice(0, 6) + "…" + id.slice(-6) : id;
}
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

    <div v-if="activeTab === 'prompts'" class="debug-content prompts-content">
      <div v-if="prompts.length === 0" class="debug-empty">No prompts available</div>
      <template v-else>
        <aside class="prompts-sidebar">
          <button
            v-for="p in prompts"
            :key="p.name"
            class="prompt-item"
            :class="{ active: selectedPrompt === p.name }"
            @click="selectedPrompt = p.name"
          >
            <strong>{{ p.name }}</strong>
            <span v-if="p.role !== p.name.replace('-', '_')">{{ p.role }}</span>
          </button>
        </aside>
        <article class="prompt-viewer">
          <header v-if="activePrompt" class="prompt-header">
            <strong>{{ activePrompt.name }}.md</strong>
            <code>role: {{ activePrompt.role }}</code>
            <span>{{ activePrompt.content.length.toLocaleString() }} chars</span>
          </header>
          <div v-if="activePrompt" class="prompt-body">
            <FormattedContent :content="activePrompt.content" />
          </div>
          <div v-else class="debug-empty">Select a prompt to view its rendered content</div>
        </article>
      </template>
    </div>

    <div v-if="activeTab === 'skills'" class="debug-content prompts-content">
      <div v-if="skills.length === 0" class="debug-empty">No skills recorded for this project</div>
      <template v-else>
        <aside class="prompts-sidebar">
          <button
            v-for="s in skills"
            :key="s.id"
            class="prompt-item"
            :class="{ active: selectedSkillId === s.id }"
            @click="selectSkill(s.id)"
          >
            <strong>{{ s.name }}</strong>
            <span>{{ s.scope }} · {{ s.status }}</span>
          </button>
        </aside>
        <article class="prompt-viewer">
          <header v-if="activeSkill" class="prompt-header">
            <strong>{{ activeSkill.name }}</strong>
            <code>{{ activeSkill.scope }}</code>
            <code>{{ activeSkill.status }}</code>
            <code v-if="activeSkill.target_agents.length">→ {{ activeSkill.target_agents.join(", ") }}</code>
            <span>{{ shortId(activeSkill.id) }}</span>
            <time>{{ formatTime(activeSkill.updated_at) }}</time>
          </header>
          <div v-if="skillDetailLoading" class="debug-empty">Loading skill…</div>
          <div v-else-if="skillDetail" class="prompt-body">
            <FormattedContent :content="skillDetail.body" />
          </div>
          <div v-else class="debug-empty">Select a skill to view its body</div>
        </article>
      </template>
    </div>

    <div v-if="activeTab === 'memories'" class="debug-content prompts-content">
      <div v-if="memories.length === 0" class="debug-empty">No memories recorded for this project</div>
      <template v-else>
        <aside class="prompts-sidebar">
          <button
            v-for="m in memories"
            :key="m.id"
            class="prompt-item"
            :class="{ active: selectedMemoryId === m.id }"
            @click="selectMemory(m.id)"
          >
            <strong>{{ memoryTopicLabel(m.topic) }}</strong>
            <span>{{ m.scope }} · {{ m.status }}</span>
          </button>
        </aside>
        <article class="prompt-viewer">
          <header v-if="activeMemory" class="prompt-header">
            <strong>{{ memoryTopicLabel(activeMemory.topic) }}</strong>
            <code>{{ activeMemory.scope }}</code>
            <code>{{ activeMemory.status }}</code>
            <code v-if="activeMemory.target_agents.length">→ {{ activeMemory.target_agents.join(", ") }}</code>
            <span>{{ shortId(activeMemory.id) }}</span>
            <time>{{ formatTime(activeMemory.updated_at) }}</time>
          </header>
          <div v-if="memoryDetailLoading" class="debug-empty">Loading memory…</div>
          <div v-else-if="memoryDetail" class="prompt-body">
            <FormattedContent :content="memoryDetail.body" />
          </div>
          <div v-else class="debug-empty">Select a memory to view its body</div>
        </article>
      </template>
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
  align-items: flex-start;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
}

.debug-tabs {
  display: flex;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-width: thin;
}

.dtab {
  display: inline-flex;
  align-items: center;
  flex: 0 0 auto;
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
  flex: 0 0 auto;
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

.prompts-content {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr);
  gap: 12px;
  padding: 12px 16px;
  min-height: 0;
}

.prompts-sidebar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  padding: 8px;
}

.prompt-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 6px 9px;
  border: 1px solid transparent;
  border-radius: 5px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
  font-family: var(--mono);
  font-size: 12px;
}

.prompt-item:hover {
  background: var(--surface-2);
}

.prompt-item.active {
  border-color: var(--accent);
  background: var(--surface-2);
}

.prompt-item span {
  color: var(--text-muted);
  font-size: 10px;
}

.prompt-viewer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface-1);
  overflow: hidden;
}

.prompt-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-2);
  font-size: 12px;
  color: var(--text-muted);
}

.prompt-header strong {
  color: var(--text);
  font-family: var(--mono);
}

.prompt-header code {
  color: var(--accent);
  font-size: 11px;
}

.prompt-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px;
  font-size: 13px;
  line-height: 1.55;
}

@media (max-width: 900px) {
  .prompts-content {
    grid-template-columns: 1fr;
  }

  .prompts-sidebar {
    max-height: 180px;
  }
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
  color: var(--code-color);
  background: var(--code-bg);
  border-radius: var(--radius-sm);
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
