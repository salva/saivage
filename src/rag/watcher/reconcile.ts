// F01 B12 — Reconcile sweep.
//
// Walks every `SourceRoot` (honouring per-source include/exclude + the
// build/cache exclusions + the secret exclusion guard) and compares each
// candidate file's current `sha256(content)` against the persisted
// `file_state` entry from the store. Returns the list of paths whose state
// disagrees so the caller can route them through `runIngest`. Deletions are
// surfaced as paths present in `file_state` that no longer exist on disk.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { walk } from "../walker.js";
import { BUILD_CACHE_EXCLUSIONS } from "./exclusions.js";
import type { SourceRoot } from "../types.js";
import type { VectorStore } from "../store/index.js";

export interface ReconcileResult {
  changedPaths: string[];
  removedPaths: string[];
  scanned: number;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

export async function reconcile(
  sources: ReadonlyArray<SourceRoot>,
  store: VectorStore,
): Promise<ReconcileResult> {
  const priorState = await store.getFileState();
  const seenPaths = new Set<string>();
  const changedPaths: string[] = [];
  let scanned = 0;

  for (const src of sources) {
    const include = src.include ?? ["**/*"];
    const exclude = [...(src.exclude ?? []), ...BUILD_CACHE_EXCLUSIONS];
    for await (const wf of walk({ root: src.root, include, exclude })) {
      scanned += 1;
      // Store paths relative to source root so downstream ingest matches
      // walker semantics; but file_state keys may differ depending on caller.
      // We use the absolute path here; the ingest pipeline normalises.
      const absPath = wf.absPath;
      seenPaths.add(absPath);
      let content: string;
      try {
        content = await fs.readFile(absPath, "utf8");
      } catch {
        continue;
      }
      const sourceHash = sha256Hex(content);
      const prior = priorState.get(absPath);
      if (!prior || prior.sourceHash !== sourceHash) {
        changedPaths.push(absPath);
      }
    }
  }

  // Anything in prior state that lies under one of the source roots but is no
  // longer on disk is a deletion.
  const sourceRoots = sources.map((s) => path.resolve(s.root));
  const removedPaths: string[] = [];
  for (const p of priorState.keys()) {
    if (seenPaths.has(p)) continue;
    if (sourceRoots.some((r) => p === r || p.startsWith(r + path.sep))) {
      removedPaths.push(p);
    }
  }

  return { changedPaths, removedPaths, scanned };
}
