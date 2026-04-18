/**
 * Version store — snapshots of services/components for rollback.
 * Storage: ~/.saivage/versions/
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, cpSync } from "node:fs";
import { join } from "node:path";
import { saivageDir } from "../config.js";
import { log } from "../log.js";

export interface VersionEntry {
  id: string;
  name: string;
  version: string;
  createdAt: string;
  sourcePath: string;
  snapshotPath: string;
  metadata: Record<string, unknown>;
}

const versionsDir = () => join(saivageDir(), "versions");
const manifestPath = () => join(versionsDir(), "manifest.json");

function loadManifest(): VersionEntry[] {
  const fp = manifestPath();
  if (!existsSync(fp)) return [];
  return JSON.parse(readFileSync(fp, "utf-8"));
}

function saveManifest(entries: VersionEntry[]): void {
  mkdirSync(versionsDir(), { recursive: true });
  writeFileSync(manifestPath(), JSON.stringify(entries, null, 2) + "\n");
}

/** Create a snapshot of a service/component */
export function snapshot(params: {
  name: string;
  version: string;
  sourcePath: string;
  metadata?: Record<string, unknown>;
}): VersionEntry {
  const id = `${params.name}-${params.version}-${Date.now()}`;
  const snapshotPath = join(versionsDir(), id);

  mkdirSync(snapshotPath, { recursive: true });
  cpSync(params.sourcePath, snapshotPath, { recursive: true });

  const entry: VersionEntry = {
    id,
    name: params.name,
    version: params.version,
    createdAt: new Date().toISOString(),
    sourcePath: params.sourcePath,
    snapshotPath,
    metadata: params.metadata ?? {},
  };

  const manifest = loadManifest();
  manifest.push(entry);
  saveManifest(manifest);

  log.info(`Snapshot created: ${id}`);
  return entry;
}

/** List all versions of a service */
export function listVersions(name?: string): VersionEntry[] {
  const manifest = loadManifest();
  if (!name) return manifest;
  return manifest.filter((e) => e.name === name);
}

/** Get a specific version */
export function getVersion(id: string): VersionEntry | undefined {
  return loadManifest().find((e) => e.id === id);
}

/** Restore from a snapshot */
export function rollback(id: string): boolean {
  const entry = getVersion(id);
  if (!entry) {
    log.error(`Version not found: ${id}`);
    return false;
  }

  if (!existsSync(entry.snapshotPath)) {
    log.error(`Snapshot path missing: ${entry.snapshotPath}`);
    return false;
  }

  // Snapshot current state first (auto-backup)
  if (existsSync(entry.sourcePath)) {
    snapshot({
      name: entry.name,
      version: `pre-rollback-${Date.now()}`,
      sourcePath: entry.sourcePath,
      metadata: { rolledBackTo: id },
    });
  }

  // Restore
  rmSync(entry.sourcePath, { recursive: true, force: true });
  cpSync(entry.snapshotPath, entry.sourcePath, { recursive: true });

  log.info(`Rolled back ${entry.name} to ${id}`);
  return true;
}

/** Delete old snapshots, keeping the latest N per name */
export function prune(keepPerName = 5): number {
  const manifest = loadManifest();
  const grouped = new Map<string, VersionEntry[]>();

  for (const entry of manifest) {
    const list = grouped.get(entry.name) ?? [];
    list.push(entry);
    grouped.set(entry.name, list);
  }

  const toKeep: VersionEntry[] = [];
  let removed = 0;

  for (const [, entries] of grouped) {
    // Sort newest first
    entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    toKeep.push(...entries.slice(0, keepPerName));

    for (const old of entries.slice(keepPerName)) {
      rmSync(old.snapshotPath, { recursive: true, force: true });
      removed++;
    }
  }

  saveManifest(toKeep);
  if (removed > 0) log.info(`Pruned ${removed} old snapshots`);
  return removed;
}
