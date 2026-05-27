// F01 B09 — Dataset registry.
//
// `<projectRoot>/.saivage/rag/registry.json` is the operator-visible cache of
// "what datasets exist on this project" with their identity and the provider
// stamp that was in effect at registration time. The authoritative stamp
// lives in each `store.db` `meta` table; this file only mirrors it so that
// `RagManager.list()` does not have to open every store.
//
// All writes are atomic (tmp file + rename) so a crash mid-write never leaves
// a half-formed registry.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ProviderStamp, RagSource } from "./types.js";

export interface RegistryEntry {
  id: string;
  projectId: string;
  source: RagSource;
  providerStamp: ProviderStamp;
  createdAt: string;
}

export interface RegistryFile {
  entries: RegistryEntry[];
}

export function registryPath(projectRoot: string): string {
  return path.join(projectRoot, ".saivage", "rag", "registry.json");
}

export async function loadRegistry(projectRoot: string): Promise<RegistryEntry[]> {
  const file = registryPath(projectRoot);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (!Array.isArray(parsed.entries)) return [];
    return parsed.entries;
  } catch {
    return [];
  }
}

export async function saveRegistry(projectRoot: string, entries: RegistryEntry[]): Promise<void> {
  const file = registryPath(projectRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload: RegistryFile = { entries };
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2));
  await fs.rename(tmp, file);
}

export async function upsertRegistryEntry(
  projectRoot: string,
  entry: RegistryEntry,
): Promise<void> {
  const entries = await loadRegistry(projectRoot);
  const idx = entries.findIndex((e) => e.id === entry.id);
  if (idx >= 0) {
    entries[idx] = entry;
  } else {
    entries.push(entry);
  }
  await saveRegistry(projectRoot, entries);
}

export async function removeRegistryEntry(projectRoot: string, id: string): Promise<void> {
  const entries = await loadRegistry(projectRoot);
  const next = entries.filter((e) => e.id !== id);
  if (next.length !== entries.length) await saveRegistry(projectRoot, next);
}
