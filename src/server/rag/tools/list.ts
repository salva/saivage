/**
 * F02 B05 — rag_list
 */
import type { RagService } from "../service.js";

export async function ragList(service: RagService): Promise<{
  collections: Array<{
    id: string;
    source: string;
    providerStamp: unknown;
    createdAt: string;
    protected: boolean;
  }>;
}> {
  const registered = await service.manager.list();
  return {
    collections: registered.map((r) => ({
      id: r.id,
      source: r.source,
      providerStamp: r.providerStamp,
      createdAt: r.createdAt,
      protected: isProtected(r.id),
    })),
  };
}

/**
 * Protected datasets are owned by F01 (skill / memory). F02 surfaces
 * the marker; mutation guards live in the tool implementations.
 */
export function isProtected(id: string): boolean {
  return id === "knowledge.skills" || id === "knowledge.memory";
}
