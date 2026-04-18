/**
 * Stash: saves large tool results to disk so the model can access them
 * selectively via read_stash, instead of blowing up the context window.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../log.js";

const STASH_DIR = join(homedir(), ".saivage", "stash");

/** Ensure stash directory exists */
function ensureDir(): void {
  mkdirSync(STASH_DIR, { recursive: true });
}

/**
 * Save content to a stash file. Returns the file path.
 */
export function stashResult(content: string, toolName: string): string {
  ensureDir();
  const id = randomUUID().slice(0, 12);
  const filename = `${toolName}_${id}.txt`;
  const filepath = join(STASH_DIR, filename);
  writeFileSync(filepath, content, "utf-8");
  log.info(`Stashed ${content.length} chars from tool "${toolName}" → ${filepath}`);
  return filepath;
}

/**
 * Read a portion of a stashed file.
 */
export function readStash(filepath: string, offset = 0, length = 10_000): { content: string; totalSize: number; offset: number; length: number } {
  // Security: only allow reading from the stash directory
  const resolved = join(filepath);
  if (!resolved.startsWith(STASH_DIR)) {
    throw new Error(`read_stash only works on stashed files under ${STASH_DIR}`);
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
  for (const f of readdirSync(STASH_DIR)) {
    const fp = join(STASH_DIR, f);
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
