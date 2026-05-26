/**
 * Stash: saves large tool results to disk so the model can access them
 * selectively via read_stash, instead of blowing up the context window.
 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { saivageDir } from "../config.js";
import { log } from "../log.js";

function stashDir(): string {
  return join(saivageDir(), "tmp", "stash");
}

async function ensureDir(): Promise<void> {
  await mkdir(stashDir(), { recursive: true });
}

/** Save content to a stash file. Returns the absolute file path. */
export async function stashResult(content: string, toolName: string): Promise<string> {
  await ensureDir();
  const id = randomUUID().slice(0, 12);
  const filename = `${toolName}_${id}.txt`;
  const filepath = join(stashDir(), filename);
  await writeFile(filepath, content, "utf-8");
  log.info(`Stashed ${content.length} chars from tool "${toolName}" → ${filepath}`);
  return filepath;
}

/** Read a portion of a stashed file. */
export async function readStash(
  filepath: string,
  offset = 0,
  length = 10_000,
): Promise<{ content: string; totalSize: number; offset: number; length: number }> {
  const stashRoot = resolve(stashDir());
  const resolved = resolve(filepath);
  const rel = relative(stashRoot, resolved);
  if (rel.startsWith("..") || resolve(stashRoot, rel) !== resolved) {
    throw new Error(`read_stash only works on stashed files under ${stashRoot}`);
  }
  const full = await readFile(filepath, "utf-8");
  const chunk = full.slice(offset, offset + length);
  return { content: chunk, totalSize: full.length, offset, length: chunk.length };
}

/** Clean up stash files older than maxAgeMs (default 24h). Returns the count removed. */
export async function cleanStash(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  await ensureDir();
  const now = Date.now();
  const dir = stashDir();
  const entries = await readdir(dir);
  const results = await Promise.all(
    entries.map(async (f): Promise<number> => {
      const fp = join(dir, f);
      try {
        const st = await stat(fp);
        if (now - st.mtimeMs > maxAgeMs) {
          await unlink(fp);
          return 1;
        }
      } catch { /* ignore ENOENT / EACCES */ }
      return 0;
    }),
  );
  const removed = results.reduce((a, b) => a + b, 0);
  if (removed > 0) log.info(`Cleaned ${removed} stale stash files`);
  return removed;
}
