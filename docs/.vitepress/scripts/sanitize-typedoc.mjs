#!/usr/bin/env node
/**
 * Post-process TypeDoc-generated markdown so VitePress (Vue SFC compiler)
 * doesn't try to parse placeholder tokens like `<role>` or `<task-id>`
 * as HTML elements.
 *
 * Strategy: walk every .md file under docs/api/ and, outside fenced code
 * blocks and outside inline `…` code spans, escape `<` characters that
 * begin a lowercase placeholder (`<role>`, `<repo>/skills`, etc.) but
 * are NOT real HTML the typedoc theme emitted (`<a id=…>`, `<br>`, etc.).
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

const ROOT = "docs/api";

// Allow-list: real HTML tags emitted by typedoc-plugin-markdown.
const ALLOWED = /^(\/?(a|br|sub|sup|kbd|code|em|strong|b|i|p|table|tr|td|th|thead|tbody|div|span|hr)\b)/i;

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.isFile() && entry.name.endsWith(".md")) yield p;
  }
}

function escapeOutsideCode(input) {
  const lines = input.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s{0,3}```/.test(line) || /^\s{0,3}~~~/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    // Skip table-row separators verbatim.
    let out = "";
    let j = 0;
    let inInlineCode = false;
    while (j < line.length) {
      const ch = line[j];
      if (ch === "`") {
        inInlineCode = !inInlineCode;
        out += ch;
        j++;
        continue;
      }
      if (!inInlineCode && ch === "<") {
        const rest = line.slice(j + 1);
        if (ALLOWED.test(rest)) {
          out += ch;
          j++;
          continue;
        }
        // Escape this `<` to `&lt;`.
        out += "&lt;";
        j++;
        continue;
      }
      out += ch;
      j++;
    }
    lines[i] = out;
  }
  return lines.join("\n");
}

let touched = 0;
for await (const file of walk(ROOT)) {
  const original = await fs.readFile(file, "utf-8");
  const cleaned = escapeOutsideCode(original);
  if (cleaned !== original) {
    await fs.writeFile(file, cleaned, "utf-8");
    touched++;
  }
}
console.log(`escaped placeholders in ${touched} file(s)`);
