<script setup lang="ts">
import { ref } from "vue";
import ChatWindow from "./components/ChatWindow.vue";
import StatusPanel from "./components/StatusPanel.vue";
import PlanView from "./components/PlanView.vue";
import AgentsView from "./components/AgentsView.vue";
import FilesView from "./components/FilesView.vue";
import DebugView from "./components/DebugView.vue";

type Tab = "dashboard" | "plan" | "agents" | "files" | "debug";
const activeTab = ref<Tab>("dashboard");
const focusStageId = ref<string | null>(null);

function handleNavigate(tab: string, focusId?: string) {
  activeTab.value = tab as Tab;
  if (tab === "plan" && focusId) {
    focusStageId.value = focusId;
  }
}
</script>

<template>
  <div class="app">
    <header class="header">
      <h1>Saivage <span class="version">v2</span></h1>
      <nav class="tabs">
        <button
          class="tab"
          :class="{ active: activeTab === 'dashboard' }"
          @click="activeTab = 'dashboard'"
        >Dashboard</button>
        <button
          class="tab"
          :class="{ active: activeTab === 'plan' }"
          @click="activeTab = 'plan'"
        >Plan</button>
        <button
          class="tab"
          :class="{ active: activeTab === 'agents' }"
          @click="activeTab = 'agents'"
        >Agents</button>
        <button
          class="tab"
          :class="{ active: activeTab === 'files' }"
          @click="activeTab = 'files'"
        >Files</button>
        <button
          class="tab"
          :class="{ active: activeTab === 'debug' }"
          @click="activeTab = 'debug'"
        >Debug</button>
      </nav>
      <span class="tagline">autonomous AI agent</span>
    </header>
    <main class="main">
      <template v-if="activeTab === 'dashboard'">
        <ChatWindow class="chat" />
        <StatusPanel class="status" @navigate="handleNavigate" />
      </template>
      <template v-else-if="activeTab === 'plan'">
        <PlanView class="full-view" :focus-stage-id="focusStageId" @focus-consumed="focusStageId = null" />
      </template>
      <template v-else-if="activeTab === 'agents'">
        <AgentsView class="full-view" />
      </template>
      <template v-else-if="activeTab === 'files'">
        <FilesView class="full-view" />
      </template>
      <template v-else-if="activeTab === 'debug'">
        <DebugView class="full-view" />
      </template>
    </main>
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.header {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid #21262d;
  background: #161b22;
}

.header h1 {
  font-size: 18px;
  font-weight: 600;
  color: #58a6ff;
}

.version {
  font-size: 11px;
  font-weight: 400;
  color: #8b949e;
  vertical-align: super;
}

.tabs {
  display: flex;
  gap: 4px;
  margin-left: 12px;
}

.tab {
  background: none;
  border: none;
  color: #8b949e;
  font-size: 13px;
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.15s;
}

.tab:hover {
  color: #c9d1d9;
  background: #21262d;
}

.tab.active {
  color: #58a6ff;
  background: #0d1117;
  font-weight: 600;
}

.tagline {
  font-size: 13px;
  color: #8b949e;
  margin-left: auto;
}

.main {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.chat {
  flex: 1;
  min-width: 0;
}

.status {
  width: 420px;
  border-left: 1px solid #21262d;
  flex-shrink: 0;
}

.full-view {
  flex: 1;
  overflow: hidden;
}
</style>
