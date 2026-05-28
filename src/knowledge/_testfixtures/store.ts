/**
 * Test fixtures for knowledge lifecycle suites. Provides a minimal
 * KnowledgeStore wired against a real sidecar and a stub RAG manager
 * that records reingest invocations.
 */
import { vi } from "vitest";
import { openSidecar } from "../sidecar.js";
import type { KnowledgeStore } from "../init.js";

export function stubRag(): KnowledgeStore["ragManager"] {
  return {
    upsertDataset: vi.fn(async () => undefined),
    ingestDataset: vi.fn(async () => undefined),
    removeDataset: vi.fn(async () => undefined),
    listDatasets: vi.fn(async () => []),
  } as unknown as KnowledgeStore["ragManager"];
}

export async function makeTestStore(projectRoot: string): Promise<KnowledgeStore> {
  const sidecar = await openSidecar(projectRoot);
  return {
    sidecar,
    ragManager: stubRag(),
    ragDatasets: [],
    projectRoot,
    reingestKind: async () => { /* best-effort no-op in tests */ },
  };
}
