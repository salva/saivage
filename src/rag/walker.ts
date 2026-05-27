// F01 B07 — Filesystem walker for ingest in `fs` mode.
//
// Walks a root directory with picomatch-driven include / exclude globs.
// Hard exclusions always apply on top of caller-supplied excludes:
//   `**/.git/**`, `**/node_modules/**`, `**/.saivage/**`, plus anything
//   `shouldSkipPath` rejects.
//
// Symlink containment: every entry is canonicalised via `realpath` and
// silently skipped if its real path escapes the canonicalised root.
// Directory cycles are detected via a visited-inode set keyed on
// `(dev, ino)` from `fs.statSync`.

import { promises as fs, type Stats } from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";
import { shouldSkipPath } from "./security/secrets.js";
import { log } from "../log.js";

const HARD_EXCLUDES: ReadonlyArray<string> = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.saivage/**",
];

export interface WalkOptions {
  root: string;
  include: string[];
  exclude?: string[];
}

export interface WalkedFile {
  /** Absolute path on disk. */
  absPath: string;
  /** POSIX path relative to root. */
  relPath: string;
  /** File size in bytes. */
  size: number;
  /** Modification time in ms. */
  mtimeMs: number;
}

function escapesRoot(rootReal: string, realAbs: string): boolean {
  const rel = path.relative(rootReal, realAbs);
  return rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
}

export async function* walk(opts: WalkOptions): AsyncIterable<WalkedFile> {
  const root = path.resolve(opts.root);
  let rootReal: string;
  try {
    rootReal = await fs.realpath(root);
  } catch {
    return;
  }
  const includeMatch = picomatch(opts.include, { dot: true });
  const excludeMatch = picomatch([...(opts.exclude ?? []), ...HARD_EXCLUDES], { dot: true });
  const visited = new Set<string>(); // `${dev}:${ino}` for directories

  async function* walkDir(dir: string): AsyncIterable<WalkedFile> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (excludeMatch(rel)) continue;
      if (shouldSkipPath(rel)) continue;

      let realAbs: string;
      try {
        realAbs = await fs.realpath(abs);
      } catch {
        continue;
      }
      if (escapesRoot(rootReal, realAbs)) {
        log.warn(
          "rag.walker.symlink-escape " +
            JSON.stringify({ root: rootReal, path: realAbs }),
        );
        continue;
      }

      let st: Stats;
      try {
        st = await fs.stat(abs); // follows symlinks
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        const key = `${st.dev}:${st.ino}`;
        if (visited.has(key)) continue;
        visited.add(key);
        yield* walkDir(abs);
      } else if (st.isFile()) {
        if (!includeMatch(rel)) continue;
        yield {
          absPath: abs,
          relPath: rel,
          size: st.size,
          mtimeMs: st.mtimeMs,
        };
      }
    }
  }

  // Seed visited set with root.
  try {
    const st = await fs.stat(rootReal);
    if (st.isDirectory()) visited.add(`${st.dev}:${st.ino}`);
  } catch {
    return;
  }
  yield* walkDir(root);
}

