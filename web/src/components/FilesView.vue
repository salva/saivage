<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
import JsonHighlight from "./JsonHighlight.vue";

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
  } else {
    await loadFile(newPath);
  }
}

async function loadFile(path: string) {
  loading.value = true;
  try {
    const res = await fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      fileContent.value = await res.json();
    }
  } catch { /* ignore */ }
  loading.value = false;
}

function goUp() {
  if (pathStack.value.length > 1) {
    pathStack.value.pop();
    fetchDir(pathStack.value[pathStack.value.length - 1]);
  }
}

function goToRoot() {
  pathStack.value = [""];
  fetchDir("");
}

function goToPathIndex(index: number) {
  pathStack.value = pathStack.value.slice(0, index + 1);
  fetchDir(pathStack.value[pathStack.value.length - 1]);
}

onMounted(() => {
  fetchDir("");
});

function fileIcon(entry: FileEntry): string {
  if (entry.type === "dir") return "📁";
  const ext = entry.name.split(".").pop()?.toLowerCase();
  if (ext === "json") return "📋";
  if (ext === "md") return "📝";
  if (ext === "txt" || ext === "log") return "📄";
  return "📄";
}

function formatSize(bytes?: number): string {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

const breadcrumbs = computed(() => {
  if (!currentPath.value) return [{ label: ".saivage", index: 0 }];
  const parts = currentPath.value.split("/");
  return [
    { label: ".saivage", index: 0 },
    ...parts.map((p, i) => ({ label: p, index: i + 1 })),
  ];
});

function parseJson(content: string): unknown {
  try { return JSON.parse(content); } catch { return content; }
}
</script>

<template>
  <div class="files-view">
    <div class="file-tree-panel">
      <div class="tree-header">
        <div class="breadcrumbs">
          <span
            v-for="bc in breadcrumbs"
            :key="bc.index"
            class="bc-item"
            @click="goToPathIndex(bc.index)"
          >{{ bc.label }}<span class="bc-sep" v-if="bc.index < breadcrumbs.length - 1"> / </span></span>
        </div>
        <button v-if="pathStack.length > 1" class="up-btn" @click="goUp">↑ Up</button>
      </div>

      <div class="tree-body">
        <div v-if="loading && entries.length === 0" class="tree-empty">Loading…</div>
        <div v-if="!loading && entries.length === 0" class="tree-empty">Empty directory</div>
        <div
          v-for="entry in entries"
          :key="entry.name"
          class="tree-item"
          @click="openEntry(entry)"
        >
          <span class="tree-icon">{{ fileIcon(entry) }}</span>
          <span class="tree-name" :class="{ dir: entry.type === 'dir' }">{{ entry.name }}</span>
          <span class="tree-size">{{ formatSize(entry.size) }}</span>
        </div>
      </div>
    </div>

    <div class="content-panel">
      <div v-if="!fileContent" class="content-empty">
        <div class="content-empty-icon">📂</div>
        <div>Select a file to view its contents</div>
      </div>

      <template v-if="fileContent">
        <div class="content-header">
          <span class="content-path">{{ fileContent.path }}</span>
          <span class="content-size">{{ formatSize(fileContent.size) }}</span>
          <span v-if="fileContent.truncated" class="content-truncated">truncated</span>
        </div>
        <div class="content-body">
          <JsonHighlight v-if="fileContent.type === 'json'" :data="parseJson(fileContent.content)" />
          <pre v-else class="content-text">{{ fileContent.content }}</pre>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.files-view { display: flex; height: 100%; overflow: hidden; }

.file-tree-panel { width: 320px; border-right: 1px solid #21262d; display: flex; flex-direction: column; flex-shrink: 0; background: #161b22; }
.tree-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid #21262d; flex-shrink: 0; }
.breadcrumbs { font-size: 12px; color: #8b949e; }
.bc-item { cursor: pointer; color: #58a6ff; }
.bc-item:hover { text-decoration: underline; }
.bc-item:last-child { color: #c9d1d9; cursor: default; }
.bc-item:last-child:hover { text-decoration: none; }
.bc-sep { color: #484f58; }
.up-btn { background: none; border: 1px solid #30363d; color: #8b949e; font-size: 11px; padding: 2px 8px; border-radius: 4px; cursor: pointer; }
.up-btn:hover { color: #c9d1d9; border-color: #484f58; }

.tree-body { flex: 1; overflow-y: auto; padding: 4px 8px; }
.tree-empty { font-size: 13px; color: #484f58; text-align: center; padding: 24px; }
.tree-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 4px; cursor: pointer; font-size: 13px; }
.tree-item:hover { background: #21262d; }
.tree-icon { font-size: 14px; flex-shrink: 0; }
.tree-name { color: #c9d1d9; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tree-name.dir { color: #58a6ff; font-weight: 500; }
.tree-size { font-size: 11px; color: #484f58; font-family: monospace; flex-shrink: 0; }

.content-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
.content-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #484f58; font-size: 14px; gap: 8px; }
.content-empty-icon { font-size: 32px; opacity: 0.5; }

.content-header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid #21262d; background: #161b22; flex-shrink: 0; }
.content-path { font-size: 13px; font-family: monospace; color: #c9d1d9; font-weight: 600; }
.content-size { font-size: 11px; color: #8b949e; margin-left: auto; }
.content-truncated { font-size: 10px; color: #d29922; background: rgba(210, 153, 34, 0.15); padding: 1px 6px; border-radius: 3px; }

.content-body { flex: 1; overflow: auto; padding: 16px; }
.content-text { font-family: monospace; font-size: 12px; line-height: 1.5; color: #c9d1d9; white-space: pre-wrap; word-break: break-word; margin: 0; }
</style>
