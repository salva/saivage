// F01 B07 — Ingest pipeline.
//
// `runIngest` coordinates the per-dataset ingest cycle:
//   1. acquire the cross-process lock
//   2. enumerate inputs (fs walker | record list)
//   3. diff against `file_state` to find new / changed / removed sources
//   4. chunk + scan-for-secrets + cache-aware embed + upsert per batch
//   5. delete chunks for files that disappeared
//   6. update `file_state`, lastIngestAt, secretsDropped counters
//   7. release the lock
//
// The pipeline drives ONE batch of file/record work per upsert transaction.
// Embedding-cache lookups happen up front per batch; cache misses are
// embedded with `provider.embedDocuments` honouring the provider's internal
// batch size cap.

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Chunker } from "./chunker/index.js";
import type { EmbeddingProvider } from "./provider/index.js";
import { scanChunk } from "./security/secrets.js";
import type { VectorStore } from "./store/index.js";
import type {
  IngestInput,
  IngestReport,
  RawChunk,
  StoredChunk,
} from "./types.js";
import { acquireIngestLock } from "./lock.js";
import { embeddingCacheKey } from "./cache/embedding-cache.js";
import { walk, type WalkedFile } from "./walker.js";
import { countTokens } from "./chunker/tokens.js";

const UPSERT_BATCH = 64; // files (or records) per upsert transaction

export interface RunIngestArgs {
  datasetId: string;
  lockfilePath: string;
  store: VectorStore;
  provider: EmbeddingProvider;
  chunker: Chunker;
  input: IngestInput;
}

interface InputItem {
  path: string;
  text: string;
  mtimeMs: number;
  sourceHash: string;
  /** Only set for `records` input. */
  metadataOverlay?: RawChunk["metadata"] extends infer M
    ? M extends { path: infer _ }
      ? Partial<Omit<RawChunk["metadata"], "path" | "source" | "chunkIndex" | "contentHash" | "sourceHash" | "mtimeMs">>
      : never
    : never;
  /** For records input, the caller-supplied `id` (used as `path`). */
  recordId?: string;
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function chunkId(contentNormalized: string, p: string, startLine: number | undefined, endLine: number | undefined): string {
  return createHash("sha256")
    .update(contentNormalized)
    .update("\0")
    .update(p)
    .update("\0")
    .update(String(startLine ?? ""))
    .update("\0")
    .update(String(endLine ?? ""))
    .digest("hex");
}

function normalize(text: string): string {
  // Normalise line endings and strip trailing whitespace per line so
  // semantically identical content produces the same contentHash.
  return text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
}

async function loadFsItems(
  input: Extract<IngestInput, { kind: "fs" }>,
): Promise<InputItem[]> {
  const items: InputItem[] = [];
  for await (const wf of walk({ root: input.root, include: input.include, exclude: input.exclude })) {
    const text = await readFileSafe(wf);
    if (text === null) continue;
    items.push({
      path: wf.relPath,
      text,
      mtimeMs: wf.mtimeMs,
      sourceHash: sha256Hex(text),
    });
  }
  return items;
}

async function readFileSafe(wf: WalkedFile): Promise<string | null> {
  try {
    return await fs.readFile(wf.absPath, "utf8");
  } catch {
    return null;
  }
}

function buildRecordItems(
  input: Extract<IngestInput, { kind: "records" }>,
): InputItem[] {
  return input.items.map((it) => {
    const text = it.text;
    return {
      path: it.metadata.path,
      text,
      mtimeMs: it.metadata.mtimeMs ?? Date.now(),
      sourceHash: sha256Hex(text),
      recordId: it.id,
      metadataOverlay: {
        language: it.metadata.language,
        headingPath: it.metadata.headingPath,
        symbolName: it.metadata.symbolName,
        symbolKind: it.metadata.symbolKind,
        scope: it.metadata.scope,
        scopeRef: it.metadata.scopeRef,
        role: it.metadata.role,
        lifecycleStatus: it.metadata.lifecycleStatus,
        createdAt: it.metadata.createdAt,
        supersedes: it.metadata.supersedes,
        startLine: it.metadata.startLine,
        endLine: it.metadata.endLine,
      },
    };
  });
}

function inferSource(p: string): "doc" | "code" | "memory" | "skill" {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".md" || ext === ".mdx" || ext === ".txt" || ext === ".rst") return "doc";
  return "code";
}

async function ensureLockDir(lockfilePath: string): Promise<void> {
  await fs.mkdir(path.dirname(lockfilePath), { recursive: true });
  // proper-lockfile needs the target file to exist as a real path target;
  // touch it so first-ever lock succeeds.
  try {
    await fs.access(lockfilePath);
  } catch {
    await fs.writeFile(lockfilePath, "", { flag: "wx" }).catch(() => undefined);
  }
}

export async function runIngest(args: RunIngestArgs): Promise<IngestReport> {
  const { store, provider, chunker, input, datasetId, lockfilePath } = args;
  await ensureLockDir(lockfilePath);
  const lock = await acquireIngestLock({ datasetId, lockfilePath });

  const report: IngestReport = {
    filesScanned: 0,
    filesChanged: 0,
    chunksUpserted: 0,
    chunksDeleted: 0,
    chunksDroppedSecrets: 0,
    tokensEmbedded: 0,
    embeddingMs: 0,
    storeMs: 0,
  };

  try {
    await store.open(provider.stamp);

    const items: InputItem[] =
      input.kind === "fs" ? await loadFsItems(input) : buildRecordItems(input);
    report.filesScanned = items.length;

    const priorState = await store.getFileState();
    const seenPaths = new Set<string>();
    const fileStateUpdates: Array<{ path: string; sourceHash: string; mtimeMs: number; lastIngestAt: number }> = [];
    const changedItems: InputItem[] = [];

    for (const it of items) {
      seenPaths.add(it.path);
      const prior = priorState.get(it.path);
      if (prior && prior.sourceHash === it.sourceHash) continue;
      changedItems.push(it);
    }
    report.filesChanged = changedItems.length;

    // Process changed items in batches.
    for (let i = 0; i < changedItems.length; i += UPSERT_BATCH) {
      const batch = changedItems.slice(i, i + UPSERT_BATCH);
      const batchChunks: StoredChunk[] = [];
      const needsEmbedding: Array<{ idx: number; text: string }> = [];

      for (const item of batch) {
        const source = item.metadataOverlay?.scope === "memory" ? "memory" : inferSource(item.path);
        const language = item.metadataOverlay?.language;
        const chunks: RawChunk[] = [];
        for await (const ch of chunker.chunk({
          text: item.text,
          path: item.path,
          source,
          sourceHash: item.sourceHash,
          mtimeMs: item.mtimeMs,
          language,
          metadataOverlay: item.metadataOverlay,
        })) {
          chunks.push(ch);
        }

        for (const ch of chunks) {
          if (scanChunk(ch.text)) {
            report.chunksDroppedSecrets += 1;
            continue;
          }
          const normalized = normalize(ch.text);
          const contentHash = sha256Hex(normalized);
          const id = chunkId(normalized, item.path, ch.metadata.startLine, ch.metadata.endLine);
          const meta = { ...ch.metadata, contentHash, sourceHash: item.sourceHash, mtimeMs: item.mtimeMs };
          const stored: StoredChunk = { id, text: ch.text, metadata: meta, embedding: new Float32Array(provider.stamp.dim) };
          const cacheKey = embeddingCacheKey(provider.stamp, contentHash);
          const cached = await store.getCachedEmbedding(cacheKey);
          if (cached) {
            stored.embedding = cached;
          } else {
            needsEmbedding.push({ idx: batchChunks.length, text: ch.text });
          }
          batchChunks.push(stored);
        }
      }

      if (needsEmbedding.length > 0) {
        const t0 = Date.now();
        const vectors = await provider.embedDocuments(needsEmbedding.map((n) => n.text));
        report.embeddingMs += Date.now() - t0;
        for (let j = 0; j < needsEmbedding.length; j++) {
          const slot = needsEmbedding[j];
          const vec = vectors[j];
          if (!slot || !vec) throw new Error("unreachable");
          const target = batchChunks[slot.idx];
          if (!target) throw new Error("unreachable");
          target.embedding = vec;
          report.tokensEmbedded += countTokens(slot.text);
          await store.putCachedEmbedding(
            embeddingCacheKey(provider.stamp, target.metadata.contentHash),
            vec,
          );
        }
      }

      // Replace prior chunks for changed paths in this batch.
      const t1 = Date.now();
      const changedPaths = batch.map((b) => b.path);
      for (const p of changedPaths) {
        const removed = await store.deleteByFilter({ eq: { path: p } });
        report.chunksDeleted += removed;
      }
      if (batchChunks.length > 0) {
        await store.upsert(batchChunks);
        report.chunksUpserted += batchChunks.length;
      }
      report.storeMs += Date.now() - t1;

      for (const item of batch) {
        fileStateUpdates.push({
          path: item.path,
          sourceHash: item.sourceHash,
          mtimeMs: item.mtimeMs,
          lastIngestAt: Date.now(),
        });
      }
    }

    // Delete chunks for files that disappeared.
    const removedPaths: string[] = [];
    for (const [p] of priorState) {
      if (!seenPaths.has(p)) removedPaths.push(p);
    }
    for (const p of removedPaths) {
      const removed = await store.deleteByFilter({ eq: { path: p } });
      report.chunksDeleted += removed;
    }
    if (removedPaths.length > 0) {
      await store.deleteFileState(removedPaths);
    }
    if (fileStateUpdates.length > 0) {
      await store.putFileState(fileStateUpdates);
    }
    await store.setLastIngestAt(Date.now());
    if (report.chunksDroppedSecrets > 0) {
      await store.bumpSecretsDropped(report.chunksDroppedSecrets);
    }
    return report;
  } finally {
    await lock.release();
  }
}
