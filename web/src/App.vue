<script setup lang="ts">
import { computed, ref } from "vue";
import {
  Activity,
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
}

const tabs: TabConfig[] = [
  { id: "dashboard", label: "Dashboard", description: "Live control room", icon: LayoutDashboard },
  { id: "plan", label: "Plan", description: "Stages and evidence", icon: ListChecks },
  { id: "agents", label: "Agents", description: "Worker conversations", icon: Bot },
  { id: "files", label: "Files", description: "Saivage artifacts", icon: FolderTree },
  { id: "debug", label: "Debug", description: "State, errors, timeline", icon: Bug },
];

const activeTab = ref<Tab>("dashboard");
const focusStageId = ref<string | null>(null);
const activeTabConfig = computed(() => tabs.find((tab) => tab.id === activeTab.value) ?? tabs[0]);

function selectTab(tab: Tab) {
  activeTab.value = tab;
}

function handleNavigate(tab: string, focusId?: string) {
  activeTab.value = tab as Tab;
  if (tab === "plan" && focusId) {
    focusStageId.value = focusId;
  }
}
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
          :title="tab.label"
          @click="selectTab(tab.id)"
        >
          <component :is="tab.icon" :size="18" />
          <span>{{ tab.label }}</span>
        </button>
      </nav>
    </aside>

    <section class="workspace">
      <header class="workspace-header">
        <div>
          <p class="eyebrow">{{ activeTabConfig.description }}</p>
          <h1>{{ activeTabConfig.label }}</h1>
        </div>
        <div class="header-meta">
          <span class="console-pill">/work/target</span>
          <span class="console-pill">live</span>
        </div>
      </header>

      <main class="main">
        <section v-show="activeTab === 'dashboard'" class="dashboard-grid">
          <ChatWindow class="chat" />
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
  background: #0d1218;
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
  background: var(--surface-1);
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
}

.nav-item:hover {
  color: var(--text);
  background: var(--surface-1);
}

.nav-item.active {
  color: var(--text);
  border-color: var(--border);
  background: var(--surface-2);
}

.nav-item.active svg {
  color: var(--accent);
}

.nav-item span {
  font-size: 13px;
  font-weight: 560;
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
