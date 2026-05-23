<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ data: unknown; maxHeight?: string }>();

interface Token {
  type: "key" | "string" | "number" | "boolean" | "null" | "brace" | "bracket" | "colon" | "comma" | "whitespace";
  text: string;
}

function tokenize(json: string): Token[] {
  const tokens: Token[] = [];
  const len = json.length;
  let i = 0;
  let expectKey = false;
  const stack: string[] = [];

  while (i < len) {
    const ch = json[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t") {
      let ws = ch;
      while (i + 1 < len && (json[i + 1] === " " || json[i + 1] === "\n" || json[i + 1] === "\r" || json[i + 1] === "\t")) {
        ws += json[++i];
      }
      tokens.push({ type: "whitespace", text: ws });
      i++;
      continue;
    }
    if (ch === "{") {
      tokens.push({ type: "brace", text: ch });
      stack.push("{");
      expectKey = true;
      i++;
    } else if (ch === "}") {
      tokens.push({ type: "brace", text: ch });
      stack.pop();
      expectKey = false;
      i++;
    } else if (ch === "[") {
      tokens.push({ type: "bracket", text: ch });
      stack.push("[");
      expectKey = false;
      i++;
    } else if (ch === "]") {
      tokens.push({ type: "bracket", text: ch });
      stack.pop();
      expectKey = false;
      i++;
    } else if (ch === ":") {
      tokens.push({ type: "colon", text: ": " });
      expectKey = false;
      // Skip optional space after colon
      if (i + 1 < len && json[i + 1] === " ") i++;
      i++;
    } else if (ch === ",") {
      tokens.push({ type: "comma", text: "," });
      expectKey = stack[stack.length - 1] === "{";
      i++;
    } else if (ch === '"') {
      let str = '"';
      i++;
      while (i < len && json[i] !== '"') {
        if (json[i] === "\\") {
          str += json[i++];
        }
        if (i < len) str += json[i++];
      }
      str += '"';
      i++;
      tokens.push({ type: expectKey ? "key" : "string", text: str });
      if (expectKey) expectKey = false;
    } else if (ch === "t" || ch === "f") {
      const word = json.slice(i).match(/^(true|false)/)?.[0] ?? ch;
      tokens.push({ type: "boolean", text: word });
      i += word.length;
    } else if (ch === "n") {
      const word = json.slice(i).match(/^null/)?.[0] ?? ch;
      tokens.push({ type: "null", text: word });
      i += word.length;
    } else if (ch === "-" || (ch >= "0" && ch <= "9")) {
      let num = ch;
      i++;
      while (i < len && /[0-9.eE+\-]/.test(json[i])) {
        num += json[i++];
      }
      tokens.push({ type: "number", text: num });
    } else {
      i++;
    }
  }
  return tokens;
}

const tokens = computed<Token[]>(() => {
  try {
    const formatted = JSON.stringify(props.data, null, 2);
    if (formatted === undefined) return [{ type: "string", text: "undefined" }];
    return tokenize(formatted);
  } catch {
    return [{ type: "string", text: String(props.data) }];
  }
});
</script>

<template>
  <pre class="json-hl" :style="maxHeight ? { maxHeight } : {}"><template
    v-for="(tok, i) in tokens" :key="i"
  ><span :class="'jt-' + tok.type">{{ tok.text }}</span></template></pre>
</template>

<style scoped>
.json-hl {
  margin: 0;
  padding: 12px;
  font-family: "SF Mono", "Cascadia Code", "Fira Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  background: var(--code-block-bg);
  border-top: 1px solid var(--code-block-border);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  tab-size: 2;
}

.jt-key { color: var(--syn-key); }
.jt-string { color: var(--syn-string); }
.jt-number { color: var(--syn-number); }
.jt-boolean { color: var(--syn-boolean); }
.jt-null { color: var(--syn-null); font-style: italic; }
.jt-brace, .jt-bracket { color: var(--syn-punctuation); }
.jt-colon { color: var(--syn-punctuation); }
.jt-comma { color: var(--syn-punctuation); }
</style>
