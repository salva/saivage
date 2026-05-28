/**
 * F02 B05 — rag_query
 *
 * Hit text is truncated to 2 KiB per analysis §4.3.
 */
import type { RagService } from "../service.js";
import type { QueryFilter, QueryHit } from "../../../rag/types.js";

export interface RagQueryInput {
  collection_id: string;
  text: string;
  topK?: number;
  filter?: QueryFilter;
}

const MAX_TEXT_BYTES = 2 * 1024;

function truncate(text: string): string {
  if (Buffer.byteLength(text, "utf-8") <= MAX_TEXT_BYTES) return text;
  // Truncate by codepoints to avoid splitting multibyte UTF-8.
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const w = Buffer.byteLength(ch, "utf-8");
    if (bytes + w > MAX_TEXT_BYTES) break;
    out += ch;
    bytes += w;
  }
  return out;
}

export async function ragQuery(
  service: RagService,
  input: RagQueryInput,
): Promise<{
  hits: Array<Pick<QueryHit, "chunkId" | "score" | "metadata"> & { text: string }>;
}> {
  const opts: { topK?: number; filter?: QueryFilter } = {};
  if (input.topK !== undefined) opts.topK = input.topK;
  if (input.filter !== undefined) opts.filter = input.filter;
  const hits = await service.manager.query(input.collection_id, input.text, opts);
  return {
    hits: hits.map((h) => ({
      chunkId: h.chunkId,
      score: h.score,
      metadata: h.metadata,
      text: truncate(h.text),
    })),
  };
}
