<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { apiFetch, apiFetchJson } from "./utils/api";
import {
  Activity,
  BookOpen,
  Bot,
  Bug,
  FolderTree,
  LayoutDashboard,
  ListChecks,
  type LucideIcon,
} from "lucide-vue-next";
import ChatWindow from "./components/ChatWindow.vue";
import StatusPanel from "./components/StatusPanel.vue";
import PlanView from "./components/PlanView.vue";
import AgentsView from "./components/AgentsView.vue";
import FilesView from "./components/FilesView.vue";
import DebugView from "./components/DebugView.vue";

type Tab = "dashboard" | "plan" | "agents" | "files" | "debug";

interface TabConfig {
  id: Tab;
  label: string;
  description: string;
  icon: LucideIcon;
  hotkey: string;
}

const tabs: TabConfig[] = [
  { id: "dashboard", label: "Dashboard", description: "Live control room", icon: LayoutDashboard, hotkey: "1" },
  { id: "plan", label: "Plan", description: "Stages and evidence", icon: ListChecks, hotkey: "2" },
  { id: "agents", label: "Agents", description: "Worker conversations", icon: Bot, hotkey: "3" },
  { id: "files", label: "Files", description: "Saivage artifacts", icon: FolderTree, hotkey: "4" },
  { id: "debug", label: "Debug", description: "State, errors, timeline", icon: Bug, hotkey: "5" },
];

const activeTab = ref<Tab>("agents");
const focusStageId = ref<string | null>(null);
const projectPath = ref("…");
const chatRef = ref<InstanceType<typeof ChatWindow> | null>(null);
const showHelp = ref(false);
const runtimeStatus = ref<string>("");
const runtimeStage = ref<string>("");
const activeTabConfig = computed(() => tabs.find((tab) => tab.id === activeTab.value) ?? tabs[0]);

onMounted(async () => {
  try {
    const res = await apiFetch("/health");
    if (res.ok) {
      const data = await res.json();
      projectPath.value = data.project ?? "unknown";
    }
  } catch { /* keep placeholder */ }
  window.addEventListener("keydown", onGlobalKeydown);
  startTitleSync();
});

onUnmounted(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  stopTitleSync();
});

function selectTab(tab: Tab) {
  activeTab.value = tab;
}

function handleNavigate(tab: string, focusId?: string) {
  activeTab.value = tab as Tab;
  if (tab === "plan" && focusId) {
    focusStageId.value = focusId;
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "Escape" && showHelp.value) {
    showHelp.value = false;
    event.preventDefault();
    return;
  }
  // Don't intercept while typing in a form control.
  if (isTypingTarget(event.target)) return;

  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    showHelp.value = !showHelp.value;
    event.preventDefault();
    return;
  }
  if (event.key === "/") {
    activeTab.value = "dashboard";
    event.preventDefault();
    // Allow the dashboard to render before focusing.
    requestAnimationFrame(() => chatRef.value?.focusInput?.());
    return;
  }
  const match = tabs.find((t) => t.hotkey === event.key);
  if (match) {
    activeTab.value = match.id;
    event.preventDefault();
  }
}

// --- Document title sync ---------------------------------------------------

let titleTimer: ReturnType<typeof setInterval> | null = null;

async function pollTitleStatus() {
  try {
    const data = await apiFetchJson<{ status?: string; phase?: string; currentStage?: { id?: string } | null }>(
      "/api/state",
    );
    runtimeStatus.value = (data.status ?? data.phase ?? "").toString();
    runtimeStage.value = data.currentStage?.id ?? "";
  } catch (err) {
    // Distinguish auth errors so the title reflects them.
    if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 401) {
      runtimeStatus.value = "unauthorized";
      runtimeStage.value = "";
      return;
    }
    runtimeStatus.value = "";
    runtimeStage.value = "";
  }
}

function startTitleSync() {
  pollTitleStatus();
  titleTimer = setInterval(pollTitleStatus, 8000);
}

function stopTitleSync() {
  if (titleTimer) clearInterval(titleTimer);
  titleTimer = null;
}

watch([runtimeStatus, runtimeStage, activeTabConfig], ([status, stage, tab]) => {
  const parts: string[] = ["Saivage"];
  if (status === "unauthorized") parts.push("⚠ unauthorized");
  else if (status) parts.push(status);
  if (stage) parts.push(stage);
  parts.push(`· ${tab.label}`);
  document.title = parts.join(" · ").replace("· ·", "·");
}, { immediate: true });
</script>

<template>
  <div class="app-shell">
    <aside class="rail" aria-label="Saivage sections">
      <div class="brand">
        <div class="brand-mark">
          <Activity :size="18" />
        </div>
        <div class="brand-text">
          <strong>Saivage</strong>
          <span>v2 runtime</span>
        </div>
      </div>

      <nav class="nav-list">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          class="nav-item"
          :class="{ active: activeTab === tab.id }"
          :title="`${tab.label} (press ${tab.hotkey})`"
          :aria-label="`${tab.label} (shortcut ${tab.hotkey})`"
          @click="selectTab(tab.id)"
        >
          <component :is="tab.icon" :size="18" />
          <span>{{ tab.label }}</span>
          <span class="hotkey" aria-hidden="true">{{ tab.hotkey }}</span>
        </button>
      </nav>

      <a
        class="nav-item docs-link"
        href="/docs/"
        target="_blank"
        rel="noopener"
        title="Open documentation in a new tab"
        aria-label="Open documentation in a new tab"
      >
        <BookOpen :size="18" />
        <span>Docs</span>
        <span class="hotkey" aria-hidden="true">↗</span>
      </a>

      <button
        class="nav-item help-toggle"
        type="button"
        title="Keyboard shortcuts (press ?)"
        aria-label="Show keyboard shortcuts"
        @click="showHelp = true"
      >
        <span aria-hidden="true" class="help-glyph">?</span>
        <span>Shortcuts</span>
      </button>
    </aside>

    <section class="workspace">
      <header class="workspace-header">
        <div>
          <p class="eyebrow">{{ activeTabConfig.description }}</p>
          <h1>{{ activeTabConfig.label }}</h1>
        </div>
        <div class="header-meta">
          <span class="console-pill">{{ projectPath }}</span>
          <span class="console-pill">live</span>
        </div>
      </header>

      <main class="main">
        <section v-show="activeTab === 'dashboard'" class="dashboard-grid">
          <ChatWindow ref="chatRef" class="chat" />
          <StatusPanel class="status" @navigate="handleNavigate" />
        </section>
        <PlanView
          v-if="activeTab === 'plan'"
          class="full-view"
          :focus-stage-id="focusStageId"
          @focus-consumed="focusStageId = null"
        />
        <AgentsView v-if="activeTab === 'agents'" class="full-view" />
        <FilesView v-if="activeTab === 'files'" class="full-view" />
        <DebugView v-if="activeTab === 'debug'" class="full-view" />
      </main>
    </section>

    <div
      v-if="showHelp"
      class="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-title"
      @click.self="showHelp = false"
    >
      <div class="help-card">
        <header>
          <h2 id="shortcuts-title">Keyboard shortcuts</h2>
          <button type="button" class="console-button" aria-label="Close shortcuts" @click="showHelp = false">Close</button>
        </header>
        <dl>
          <div v-for="tab in tabs" :key="tab.id">
            <dt><kbd>{{ tab.hotkey }}</kbd></dt>
            <dd>Open {{ tab.label }}</dd>
          </div>
          <div>
            <dt><kbd>/</kbd></dt>
            <dd>Focus the chat input</dd>
          </div>
          <div>
            <dt><kbd>Enter</kbd></dt>
            <dd>Send chat message</dd>
          </div>
          <div>
            <dt><kbd>Shift</kbd> + <kbd>Enter</kbd></dt>
            <dd>Insert newline in chat</dd>
          </div>
          <div>
            <dt><kbd>?</kbd></dt>
            <dd>Toggle this help overlay</dd>
          </div>
          <div>
            <dt><kbd>Esc</kbd></dt>
            <dd>Close this overlay</dd>
          </div>
        </dl>
      </div>
    </div>
  </div>
</template>

<style scoped>
.app-shell {
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr);
  height: 100vh;
  min-width: 0;
  background: var(--bg);
  color: var(--text);
}

.rail {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--border);
  background: var(--bg);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 70px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
}

.brand-mark {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border: 1px solid var(--border-strong);
  border-radius: 8px;
  color: var(--accent);
  background: var(--surface-2);
}

.brand-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.brand-text strong {
  color: var(--text);
  font-size: 15px;
  line-height: 1.2;
}

.brand-text span {
  color: var(--text-muted);
  font-size: 11px;
}

.nav-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 10px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 38px;
  padding: 0 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  text-decoration: none;
  box-sizing: border-box;
}

.nav-item:hover {
  color: var(--text);
  background: var(--surface-1);
}

.nav-item.active {
  color: var(--text);
  border-color: var(--border);
  background: var(--surface-2);
  border-left: 2px solid var(--accent);
}

.nav-item.active svg {
  color: var(--accent);
}

.nav-item span {
  font-size: 13px;
  font-weight: 560;
}

.nav-item .hotkey {
  margin-left: auto;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-1);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 10px;
  font-weight: 600;
}

.help-toggle {
  margin: auto 10px 12px;
  color: var(--text-muted);
}
.help-toggle .help-glyph {
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
}

.help-overlay {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: var(--overlay-bg);
  z-index: 50;
}
.help-card {
  width: min(440px, 90vw);
  max-height: 80vh;
  overflow: auto;
  padding: 18px 20px;
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  background: var(--surface-1);
  color: var(--text);
  box-shadow: var(--shadow-3);
}
.help-card header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.help-card h2 { margin: 0; font-size: 15px; }
.help-card dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 8px 16px;
  margin: 0;
}
.help-card dl > div { display: contents; }
.help-card dt {
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.help-card dd {
  margin: 0;
  color: var(--text-muted);
  font-size: 13px;
  align-self: center;
}
.help-card kbd {
  display: inline-block;
  padding: 2px 7px;
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: 4px;
  background: var(--bg);
  font-family: var(--mono);
  font-size: 11.5px;
  color: var(--text);
}

.workspace {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.workspace-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 70px;
  padding: 0 22px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
}

.eyebrow {
  margin: 0 0 3px;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 650;
  text-transform: uppercase;
}

.workspace-header h1 {
  margin: 0;
  color: var(--text);
  font-size: 19px;
  font-weight: 700;
}

.header-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.main {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.dashboard-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(340px, 430px);
  width: 100%;
  min-width: 0;
  min-height: 0;
}

.chat,
.status,
.full-view {
  min-width: 0;
  min-height: 0;
}

.status {
  border-left: 1px solid var(--border);
}

.full-view {
  flex: 1;
  overflow: hidden;
}

@media (max-width: 900px) {
  .app-shell {
    grid-template-columns: 66px minmax(0, 1fr);
  }

  .brand {
    justify-content: center;
    padding: 0;
  }

  .brand-text,
  .nav-item span,
  .header-meta {
    display: none;
  }

  .nav-item {
    justify-content: center;
    padding: 0;
  }

  .dashboard-grid {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(0, 1fr) minmax(220px, 34vh);
  }

  .status {
    display: flex;
    border-left: 0;
    border-top: 1px solid var(--border);
  }
}
</style>
