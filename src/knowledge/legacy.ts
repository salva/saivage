/**
 * F01 B07 — Legacy knowledge tree refusal / cleanup.
 *
 * Pre-F01 deployments stored skills/memory as a JSON tree under
 * `.saivage/skills/...` and `.saivage/memory/...`. F01 cuts over to a
 * SQLite sidecar at `.saivage/knowledge/store.sqlite` and the JSON
 * tree must not coexist with a populated sidecar.
 *
 * `refuseOrCleanLegacyTree` enforces the three cases (design §A.8 / B07):
 *  1. no markers → no-op
 *  2. markers + populated sidecar → silently remove the legacy paths
 *  3. markers + empty sidecar → hard-fail with `KNOWLEDGE_MIGRATION_REQUIRED`
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { log } from "../log.js";
import { KnowledgeStoreError } from "./store.js";
import { openSidecar } from "./sidecar.js";
import { recordCount } from "./sidecar-queries.js";

/**
 * Canonical legacy markers (subset of what the old seed produced — any
 * one is enough to flag the tree as legacy).
 */
const LEGACY_MARKERS = [
  ".saivage/skills/project/index.json",
  ".saivage/skills/project/audit.jsonl",
  ".saivage/memory/project/index.json",
  ".saivage/memory/project/audit.jsonl",
] as const;

/** Top-level legacy directories removed when sidecar is populated. */
const LEGACY_DIRS = [".saivage/skills", ".saivage/memory"] as const;

function detectLegacyMarkers(projectRoot: string): string[] {
  return LEGACY_MARKERS
    .map((rel) => join(projectRoot, rel))
    .filter((abs) => existsSync(abs));
}

export async function refuseOrCleanLegacyTree(projectRoot: string): Promise<void> {
  const present = detectLegacyMarkers(projectRoot);
  if (present.length === 0) return;

  // Transiently open the sidecar to inspect emptiness. `openSidecar`
  // mkdirs `.saivage/knowledge/` and runs migrations on demand.
  const sidecar = await openSidecar(projectRoot);
  let count: number;
  try {
    count = recordCount(sidecar);
  } finally {
    sidecar.close();
  }

  if (count === 0) {
    throw new KnowledgeStoreError(
      "KNOWLEDGE_MIGRATION_REQUIRED",
      "legacy knowledge tree detected at " + present[0]
        + " but sidecar is empty; manual migration required",
    );
  }

  for (const rel of LEGACY_DIRS) {
    const abs = join(projectRoot, rel);
    if (existsSync(abs)) rmSync(abs, { recursive: true, force: true });
  }
  log.info("knowledge.legacy-tree-removed " + JSON.stringify({ projectRoot }));
}
