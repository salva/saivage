/**
 * Stash: saves large tool results to disk so the model can access them
 * selectively via read_stash, instead of blowing up the context window.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { saivageDir } from "../config.js";
import { log } from "../log.js";

function stashDir(): string {
  return join(saivageDir(), "tmp", "stash");
}

/** Ensure stash directory exists */
function ensureDir(): void {
  mkdirSync(stashDir(), { recursive: true });
}

/**
 * Save content to a stash file. Returns the file path.
 */
export function stashResult(content: string, toolName: string): string {
  ensureDir();
  const id = randomUUID().slice(0, 12);
  const filename = `${toolName}_${id}.txt`;
  const filepath = join(stashDir(), filename);
  writeFileSync(filepath, content, "utf-8");
  log.info(`Stashed ${content.length} chars from tool "${toolName}" → ${filepath}`);
  return filepath;
}

/**
 * Read a portion of a stashed file.
 */
export function readStash(filepath: string, offset = 0, length = 10_000): { content: string; totalSize: number; offset: number; length: number } {
  // Security: only allow reading from the stash directory
  const stashRoot = resolve(stashDir());
  const resolved = resolve(filepath);
  if (resolved !== stashRoot && !resolved.startsWith(`${stashRoot}/`)) {
    throw new Error(`read_stash only works on stashed files under ${stashRoot}`);
  }
  const full = readFileSync(filepath, "utf-8");
  const chunk = full.slice(offset, offset + length);
  return {
    content: chunk,
    totalSize: full.length,
    offset,
    length: chunk.length,
  };
}

/**
 * Clean up stash files older than maxAgeMs (default 24h).
 */
export function cleanStash(maxAgeMs = 24 * 60 * 60 * 1000): number {
  ensureDir();
  const now = Date.now();
  let removed = 0;
  const dir = stashDir();
  for (const f of readdirSync(dir)) {
    const fp = join(dir, f);
    try {
      const st = statSync(fp);
      if (now - st.mtimeMs > maxAgeMs) {
        unlinkSync(fp);
        removed++;
      }
    } catch { /* ignore */ }
  }
  if (removed > 0) log.info(`Cleaned ${removed} stale stash files`);
  return removed;
}
