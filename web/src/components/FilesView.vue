<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ChevronLeft, FileJson, FileText, Folder, FolderOpen, RefreshCw } from "lucide-vue-next";
import JsonHighlight from "./JsonHighlight.vue";
import FormattedContent from "./FormattedContent.vue";

interface FileEntry {
  name: string;
  type: "file" | "dir";
  size?: number;
  modified?: string;
}

const currentPath = ref("");
const entries = ref<FileEntry[]>([]);
const fileContent = ref<{ path: string; content: string; size: number; type: string; truncated: boolean } | null>(null);
const loading = ref(false);
const pathStack = ref<string[]>([""]);

async function fetchDir(path: string) {
  loading.value = true;
  fileContent.value = null;
  try {
    const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const data = await res.json();
      entries.value = (data.entries ?? []).sort((a: FileEntry, b: FileEntry) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      currentPath.value = path;
    }
  } catch { /* ignore */ }
  loading.value = false;
}

async function openEntry(entry: FileEntry) {
  const newPath = currentPath.value ? `${currentPath.value}/${entry.name}` : entry.name;
  if (entry.type === "dir") {
    pathStack.value.push(newPath);
    await fetchDir(newPath);
    return;
  }
  await loadFile(newPath);
}

async function loadFile(path: string) {
  loading.value = true;
  try {
    const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
    if (res.ok) fileContent.value = await res.json();
  } catch { /* ignore */ }
  loading.value = false;
}

function goUp() {
  if (pathStack.value.length <= 1) return;
  pathStack.value.pop();
  fetchDir(pathStack.value[pathStack.value.length - 1]);
}

function goToPathIndex(index: number) {
  pathStack.value = pathStack.value.slice(0, index + 1);
  fetchDir(pathStack.value[pathStack.value.length - 1]);
}

onMounted(() => fetchDir(""));

function iconFor(entry: FileEntry) {
  if (entry.type === "dir") return Folder;
  const ext = entry.name.split(".").pop()?.toLowerCase();
  if (ext === "json") return FileJson;
  return FileText;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatModified(ts?: string): string {
  return ts ? new Date(ts).toLocaleString() : "";
}

const breadcrumbs = computed(() => {
  if (!currentPath.value) return [{ label: ".saivage", index: 0 }];
  const parts = currentPath.value.split("/");
  return [
    { label: ".saivage", index: 0 },
    ...parts.map((part, index) => ({ label: part, index: index + 1 })),
  ];
});

const directoryStats = computed(() => {
  const dirs = entries.value.filter((entry) => entry.type === "dir").length;
  return { dirs, files: entries.value.length - dirs };
});

function parseJson(content: string): unknown {
  try { return JSON.parse(content); } catch { return content; }
}
</script>

<template>
  <section class="files-view">
    <aside class="file-tree-panel">
      <div class="panel-heading tree-heading">
        <h2>Artifacts</h2>
        <button class="icon-button" @click="fetchDir(currentPath)" title="Refresh directory">
          <RefreshCw :size="15" />
        </button>
      </div>

      <div class="path-bar">
        <button v-if="pathStack.length > 1" class="icon-button" @click="goUp" title="Go up">
          <ChevronLeft :size="16" />
        </button>
        <div class="breadcrumbs">
          <button
            v-for="bc in breadcrumbs"
            :key="bc.index"
            @click="goToPathIndex(bc.index)"
          >{{ bc.label }}</button>
        </div>
      </div>

      <div class="dir-stats">
        <span>{{ directoryStats.dirs }} dirs</span>
        <span>{{ directoryStats.files }} files</span>
      </div>

      <div class="tree-body">
        <div v-if="loading && entries.length === 0" class="tree-empty">Loading...</div>
        <div v-if="!loading && entries.length === 0" class="tree-empty">Empty directory</div>
        <button
          v-for="entry in entries"
          :key="entry.name"
          class="tree-item"
          :class="{ selected: fileContent?.path === (currentPath ? `${currentPath}/${entry.name}` : entry.name) }"
          @click="openEntry(entry)"
        >
          <component :is="iconFor(entry)" :size="16" :class="entry.type" />
          <span class="tree-name" :class="{ dir: entry.type === 'dir' }">{{ entry.name }}</span>
          <span class="tree-size">{{ formatSize(entry.size) }}</span>
        </button>
      </div>
    </aside>

    <section class="content-panel">
      <div v-if="!fileContent" class="content-empty">
        <FolderOpen :size="38" />
        <strong>Select an artifact</strong>
        <span>Browse persisted plans, notes, reports, logs, and runtime state.</span>
      </div>

      <template v-if="fileContent">
        <div class="content-header">
          <div>
            <strong>{{ fileContent.path }}</strong>
            <span>{{ fileContent.type }} · {{ formatSize(fileContent.size) }}</span>
          </div>
          <span v-if="fileContent.truncated" class="console-pill warn">truncated</span>
        </div>
        <div class="content-body">
          <JsonHighlight v-if="fileContent.type === 'json'" :data="parseJson(fileContent.content)" />
          <FormattedContent v-else-if="fileContent.type === 'md'" :content="fileContent.content" />
          <pre v-else class="content-text">{{ fileContent.content }}</pre>
        </div>
      </template>
    </section>
  </section>
</template>

<style scoped>
.files-view {
  display: grid;
  grid-template-columns: 340px minmax(0, 1fr);
  height: 100%;
  min-width: 0;
  overflow: hidden;
  background: var(--bg);
}

.file-tree-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-right: 1px solid var(--border);
  background: var(--surface-1);
}

.tree-heading h2 {
  font-size: 13px;
}

.icon-button {
  display: inline-grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}

.icon-button:hover {
  color: var(--text);
  background: var(--surface-2);
}

.path-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}

.breadcrumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.breadcrumbs button {
  max-width: 130px;
  overflow: hidden;
  border: 0;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  font-family: var(--mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.breadcrumbs button:not(:last-child)::after {
  content: "/";
  margin-left: 4px;
  color: var(--text-faint);
}

.breadcrumbs button:last-child {
  color: var(--text);
}

.dir-stats {
  display: flex;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 11px;
}

.tree-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
}

.tree-empty {
  padding: 32px 8px;
  color: var(--text-faint);
  text-align: center;
  font-size: 13px;
}

.tree-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 34px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
  text-align: left;
}

.tree-item:hover,
.tree-item.selected {
  border-color: var(--border);
  background: var(--surface-2);
}

.tree-item svg.dir,
.tree-name.dir {
  color: var(--accent);
}

.tree-name {
  min-width: 0;
  overflow: hidden;
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-size {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
}

.content-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}

.content-empty {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-faint);
  text-align: center;
}

.content-empty strong {
  color: var(--text);
}

.content-empty span {
  max-width: 360px;
  color: var(--text-muted);
  font-size: 13px;
}

.content-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 54px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-1);
}

.content-header div {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.content-header strong {
  overflow: hidden;
  color: var(--text);
  font-family: var(--mono);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-header span {
  color: var(--text-muted);
  font-size: 11px;
}

.console-pill.warn {
  border-color: rgba(224, 169, 68, 0.45);
  color: var(--warn);
}

.content-body {
  flex: 1;
  overflow: auto;
  padding: 16px;
}

.content-text {
  margin: 0;
  color: var(--text);
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

@media (max-width: 900px) {
  .files-view {
    grid-template-columns: 1fr;
  }

  .file-tree-panel {
    max-height: 42vh;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
}
</style>
