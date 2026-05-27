// F01 B07 — Filesystem walker for ingest in `fs` mode.
//
// Walks a root directory with picomatch-driven include / exclude globs.
// Hard exclusions always apply on top of caller-supplied excludes:
//   `**/.git/**`, `**/node_modules/**`, `**/.saivage/**`, plus anything
//   `shouldSkipPath` rejects.
//
// Symlink-cycle protection uses a visited-inode set keyed on
// (dev, ino) from `fs.statSync`. Symlinks that point outside the root
// are followed exactly once.

import { promises as fs, type Stats } from "node:fs";
import * as path from "node:path";
import picomatch from "picomatch";
import { shouldSkipPath } from "./security/secrets.js";

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

export async function* walk(opts: WalkOptions): AsyncIterable<WalkedFile> {
  const root = path.resolve(opts.root);
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
    const st = await fs.stat(root);
    if (st.isDirectory()) visited.add(`${st.dev}:${st.ino}`);
  } catch {
    return;
  }
  yield* walkDir(root);
}
