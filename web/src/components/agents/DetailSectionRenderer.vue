<script setup lang="ts">
import FormattedContent from "../FormattedContent.vue";
import type { DetailLink, DetailSection, InlinePart } from "../../utils/toolDisplay";

defineProps<{
  sections: DetailSection[];
  links: DetailLink[];
}>();

const emit = defineEmits<{
  "open-file": [payload: { path: string; root: "project" | "saivage"; line?: number }];
  "open-conversation": [payload: { agentId: string; roundId?: string }];
}>();

function partText(part: InlinePart): string {
  if (part.kind === "file") return part.line ? `${part.path}:${part.line}` : part.path;
  if (part.kind === "url") return part.url;
  if (part.kind === "conversation") return part.label;
  return part.value;
}

function openPart(part: InlinePart) {
  if (part.kind === "file") emit("open-file", { path: part.path, root: part.root ?? "project", ...(part.line !== undefined ? { line: part.line } : {}) });
  if (part.kind === "url") window.open(part.url, "_blank", "noopener,noreferrer");
  if (part.kind === "conversation" && part.agentId) emit("open-conversation", { agentId: part.agentId, ...(part.roundId ? { roundId: part.roundId } : {}) });
}

function openLink(link: DetailLink) {
  if (link.kind === "file") emit("open-file", { path: link.path, root: link.root ?? "project", ...(link.line !== undefined ? { line: link.line } : {}) });
  if (link.kind === "url") window.open(link.url, "_blank", "noopener,noreferrer");
  if (link.kind === "conversation") emit("open-conversation", { agentId: link.agentId, ...(link.roundId ? { roundId: link.roundId } : {}) });
}
</script>

<template>
  <div class="detail-sections">
    <section v-for="(section, idx) in sections" :key="idx" class="detail-section" :data-kind="section.kind">
      <h5 v-if="section.title">{{ section.title }}</h5>
      <FormattedContent
        v-if="section.kind === 'text'"
        :content="section.content"
      />
      <pre v-else-if="section.kind === 'code'" :style="{ maxHeight: section.maxHeight || undefined }"><code>{{ section.content }}</code></pre>
      <pre v-else-if="section.kind === 'diff'" class="detail-diff" :style="{ maxHeight: section.maxHeight || undefined }"><code>{{ section.content }}</code></pre>
      <div v-else-if="section.kind === 'terminal'" class="terminal" :style="{ maxHeight: section.maxHeight || undefined }">
        <div v-if="section.exitCode !== undefined" class="terminal-exit" :data-error="section.exitCode === 0 ? 'false' : 'true'">exit {{ section.exitCode }}</div>
        <pre v-if="section.stdout"><code>{{ section.stdout }}</code></pre>
        <pre v-if="section.stderr" class="stderr"><code>{{ section.stderr }}</code></pre>
        <span v-if="!section.stdout && !section.stderr" class="empty">No output</span>
      </div>
      <table v-else-if="section.kind === 'table'">
        <thead><tr><th v-for="column in section.columns" :key="column">{{ column }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, rIdx) in section.rows" :key="rIdx">
            <td v-for="(cell, cIdx) in row" :key="cIdx">
              <template v-for="(part, pIdx) in cell" :key="pIdx">
                <button
                  v-if="part.kind === 'file' || part.kind === 'conversation'"
                  class="inline-link"
                  type="button"
                  @click.stop="openPart(part)"
                >{{ partText(part) }}</button>
                <a
                  v-else-if="part.kind === 'url'"
                  class="inline-link"
                  :href="part.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  @click.stop
                >{{ part.url }}</a>
                <code v-else-if="part.kind === 'code'">{{ part.value }}</code>
                <span v-else :data-tone="part.tone || undefined">{{ part.value }}</span>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
      <ul v-else-if="section.kind === 'list'">
        <li v-for="(item, itemIdx) in section.items" :key="itemIdx">
          <template v-for="(part, pIdx) in item" :key="pIdx">
            <button v-if="part.kind === 'file' || part.kind === 'conversation'" class="inline-link" type="button" @click.stop="openPart(part)">{{ partText(part) }}</button>
            <a v-else-if="part.kind === 'url'" class="inline-link" :href="part.url" target="_blank" rel="noopener noreferrer" @click.stop>{{ part.url }}</a>
            <code v-else-if="part.kind === 'code'">{{ part.value }}</code>
            <span v-else :data-tone="part.tone || undefined">{{ part.value }}</span>
          </template>
        </li>
      </ul>
      <div v-else-if="section.kind === 'attachments'" class="attachments">
        <div v-for="(attachment, aIdx) in section.attachments" :key="aIdx" class="attachment">
          <span>{{ attachment.filename || 'attachment' }}</span>
          <code>{{ attachment.mime }}</code>
          <span v-if="attachment.sizeBytes">{{ attachment.sizeBytes.toLocaleString() }} B</span>
        </div>
      </div>
    </section>
    <div v-if="links.length" class="detail-links">
      <button v-for="(link, idx) in links" :key="idx" type="button" class="detail-link" @click.stop="openLink(link)">
        {{ link.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.detail-sections { display: flex; flex-direction: column; gap: 8px; }
.detail-section { display: flex; flex-direction: column; gap: 4px; }
h5 { margin: 0; color: var(--text-faint); font-family: var(--mono); font-size: 10px; letter-spacing: 0.06em; text-transform: uppercase; }
pre { overflow-x: hidden; overflow-y: auto; margin: 0; padding: 8px; border: 1px solid var(--border-subtle, var(--border)); border-radius: 5px; background: var(--code-block-bg); color: var(--code-block-text); font-size: 12px; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; min-width: 0; max-width: 100%; }
pre code { white-space: inherit; overflow-wrap: inherit; word-break: inherit; }
.detail-diff code { white-space: pre-wrap; }
.terminal { overflow-x: hidden; overflow-y: auto; padding: 8px; border: 1px solid var(--border-subtle, var(--border)); border-radius: 5px; background: var(--code-block-bg); }
.terminal pre { border: 0; padding: 0; background: transparent; }
.terminal .stderr { color: var(--danger); }
.terminal-exit { margin-bottom: 4px; color: var(--accent-2); font-family: var(--mono); font-size: 11px; }
.terminal-exit[data-error="true"] { color: var(--danger); }
.empty { color: var(--text-faint); }
table { width: 100%; border-collapse: collapse; font-size: 12px; }
th, td { padding: 4px 6px; border: 1px solid var(--border-subtle, var(--border)); text-align: left; vertical-align: top; }
th { color: var(--text-muted); background: var(--surface-2); font-weight: 600; }
.inline-link,
.detail-link { border: 0; padding: 0; color: var(--accent); background: transparent; cursor: pointer; font: inherit; text-decoration: underline; }
.detail-links { display: flex; flex-wrap: wrap; gap: 8px; }
.detail-link { padding: 2px 6px; border: 1px solid var(--border-subtle, var(--border)); border-radius: 4px; text-decoration: none; font-family: var(--mono); font-size: 11px; }
.attachment { display: flex; flex-wrap: wrap; gap: 8px; color: var(--text-muted); }
[data-tone="ok"] { color: var(--accent-2); }
[data-tone="warn"] { color: var(--warn); }
[data-tone="error"] { color: var(--danger); }
[data-tone="muted"] { color: var(--text-faint); }
</style>
