/**
 * F02 B05 — rag_register
 *
 * Config-first persist ordering with best-effort manager-failure rollback.
 * See design 02-design-r6.md §A.5 and analysis 01-analysis-r7.md §4.4.
 */
import * as path from "node:path";
import { promises as fs } from "node:fs";
import type { RagService, RuntimeRagDatasetConfig } from "../service.js";
import type { IngestReport, ChunkerRef, WatchConfig } from "../../../rag/types.js";
import { saveSaivageConfig } from "../persist.js";
import { shouldSkipPath } from "../../../rag/security/secrets.js";
import { WatcherUnavailableError } from "../../../rag/errors.js";
import { ragErr, type RagErrEnvelope } from "../envelope.js";
import { log } from "../../../log.js";
import { isProtected } from "./list.js";

export interface RagRegisterInput {
  collection_id: string;
  source: "doc" | "code";
  provider?: { model?: "text-embedding-3-small"; dim?: 256 | 512 | 1024 | 1536 };
  chunker: ChunkerRef;
  exclusions?: string[];
  sources: Array<{ root: string; include?: string[]; exclude?: string[] }>;
  watch?: WatchConfig;
  persist?: boolean;
}

export interface RagRegisterOutput {
  collection: { id: string; source: string };
  persisted: boolean;
  watch: "off" | "armed";
  initialIngestReport: IngestReport;
}

async function resolveRootContained(
  projectRoot: string,
  rawRoot: string,
): Promise<string | RagErrEnvelope> {
  const abs = path.isAbsolute(rawRoot) ? rawRoot : path.resolve(projectRoot, rawRoot);
  let real: string;
  try {
    real = await fs.realpath(abs);
  } catch (err) {
    return ragErr("RAG_BLOCKED_PATH", `cannot resolve root ${rawRoot}: ${(err as Error).message}`);
  }
  let projectReal: string;
  try {
    projectReal = await fs.realpath(projectRoot);
  } catch (err) {
    return ragErr("RAG_INTERNAL", (err as Error).message);
  }
  const rel = path.relative(projectReal, real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return ragErr("RAG_BLOCKED_PATH", `root ${real} escapes project ${projectReal}`);
  }
  if (shouldSkipPath(rel || ".")) {
    return ragErr("RAG_BLOCKED_PATH", `root ${rel} is secret-bearing`);
  }
  return real;
}

export async function ragRegister(
  service: RagService,
  input: RagRegisterInput,
): Promise<RagRegisterOutput | RagErrEnvelope> {
  if (isProtected(input.collection_id)) {
    return ragErr("RAG_PROTECTED_DATASET", `dataset ${input.collection_id} is protected`);
  }
  if (input.sources.length !== 1) {
    return ragErr("RAG_INVALID_ARGS", "sources must contain exactly one entry");
  }
  const [firstSource] = input.sources;
  if (!firstSource) {
    return ragErr("RAG_INVALID_ARGS", "sources[0] is required");
  }
  const resolved = await resolveRootContained(service.projectRoot, firstSource.root);
  if (typeof resolved !== "string") return resolved;

  const sourceEntry: { root: string; include?: string[]; exclude?: string[] } = { root: resolved };
  if (firstSource.include) sourceEntry.include = firstSource.include;
  if (firstSource.exclude) sourceEntry.exclude = firstSource.exclude;

  const newConfig: RuntimeRagDatasetConfig = {
    id: input.collection_id,
    source: input.source,
    provider: {
      kind: "openai",
      model: input.provider?.model ?? "text-embedding-3-small",
      dim: input.provider?.dim ?? 1536,
    },
    store: { kind: "sqlite-vec" },
    chunker: input.chunker,
    exclusions: input.exclusions ?? [],
    sources: [sourceEntry],
    watch: input.watch ?? false,
  };

  const persist = input.persist === true;
  const beforeDatasets = persist ? null : null;

  if (persist) {
    await saveSaivageConfig(service.projectRoot, (cfg) => ({
      ...cfg,
      rag: {
        ...cfg.rag,
        datasets: [...cfg.rag.datasets, newConfig as (typeof cfg.rag.datasets)[number]],
      },
    }));
  }

  // Push to the shared array BEFORE manager.register so that
  // manager.register's lookup of the dataset succeeds. Snapshot it for
  // rollback.
  const arraySnapshot = [...service.datasets];
  service.datasets.push(newConfig);

  try {
    await service.manager.register(newConfig);
  } catch (err) {
    // Rollback array push.
    service.datasets.length = 0;
    service.datasets.push(...arraySnapshot);
    if (persist) {
      await saveSaivageConfig(service.projectRoot, (cfg) => ({
        ...cfg,
        rag: { ...cfg.rag, datasets: cfg.rag.datasets.filter((d) => d.id !== newConfig.id) },
      })).catch((rb) =>
        log.warn(
          "rag.register.rollback-failed " +
            JSON.stringify({ id: newConfig.id, err: (rb as Error).message }),
        ),
      );
    }
    throw err;
  }

  void beforeDatasets;

  // Initial ingest using the resolved root.
  const ingestInput: Parameters<typeof service.manager.ingest>[1] = {
    kind: "fs",
    root: resolved,
    include: sourceEntry.include ?? ["**/*"],
    ...(sourceEntry.exclude ? { exclude: sourceEntry.exclude } : {}),
  };
  const initialIngestReport = await service.manager.ingest(input.collection_id, ingestInput);

  service.watchStatus.set(input.collection_id, "off");
  let watchState: "off" | "armed" = "off";
  if (newConfig.watch !== false) {
    try {
      const dataset = await service.manager.get(input.collection_id);
      await dataset.watch();
      watchState = "armed";
      service.watchStatus.set(input.collection_id, "armed");
    } catch (err) {
      if (err instanceof WatcherUnavailableError) {
        return ragErr("RAG_WATCHER_UNAVAILABLE", err.message);
      }
      throw err;
    }
  }

  return {
    collection: { id: input.collection_id, source: input.source },
    persisted: persist,
    watch: watchState,
    initialIngestReport,
  };
}
