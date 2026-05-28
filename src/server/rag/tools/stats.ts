/**
 * F02 B05 — rag_stats
 */
import type { RagService } from "../service.js";
import { isProtected } from "./list.js";

export interface RagStatsInput {
  collection_id: string;
}

export async function ragStats(
  service: RagService,
  input: RagStatsInput,
): Promise<{
  chunks: number;
  files: number;
  bytesOnDisk: number;
  provider: unknown;
  lastIngestAt: string | null;
  secretsDropped: number;
  protected: boolean;
  watch: "off" | "armed";
}> {
  const stats = await service.manager.stats(input.collection_id);
  return {
    chunks: stats.chunks,
    files: stats.files,
    bytesOnDisk: stats.bytesOnDisk,
    provider: stats.provider,
    lastIngestAt: stats.lastIngestAt,
    secretsDropped: stats.secretsDropped,
    protected: isProtected(input.collection_id),
    watch: service.watchStatus.get(input.collection_id) ?? "off",
  };
}
