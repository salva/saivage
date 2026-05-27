// F01 B09 — RagManager: project-scoped facade over the RAG subsystem.
//
// Responsibilities:
//   - Materialise a `Dataset` per configured entry (when `rag.enabled`).
//   - Validate the registered config against the registry + the on-disk
//     store stamp on `register()`; throw `ConfigDriftError` when the
//     provider's `dim` or the chunker's `kind` changed without a rebuild.
//   - Maintain `<projectRoot>/.saivage/rag/registry.json` as the
//     operator-visible cache.
//
// When `rag.enabled === false` the factory returns a thin no-op object so
// callers can be wired in even on projects that have not opted in yet.

import * as path from "node:path";
import { Dataset } from "./dataset.js";
import type { OpenAIProviderOptions } from "./provider/index.js";
import {
  loadRegistry,
  upsertRegistryEntry,
  removeRegistryEntry,
  type RegistryEntry,
} from "./registry.js";
import { ConfigDriftError, DatasetNotFoundError } from "./errors.js";
import type {
  DatasetConfig,
  DatasetStats,
  IngestInput,
  IngestReport,
  QueryHit,
  QueryOptions,
  RegisteredDataset,
} from "./types.js";

export interface RagManagerOptions {
  projectRoot: string;
  projectId: string;
  enabled: boolean;
  datasets: ReadonlyArray<Omit<DatasetConfig, "projectId">>;
  providerOptions?: OpenAIProviderOptions;
}

export interface RagManager {
  readonly enabled: boolean;
  list(): Promise<RegisteredDataset[]>;
  get(id: string): Promise<Dataset>;
  register(config: Omit<DatasetConfig, "projectId">): Promise<Dataset>;
  ingest(id: string, input: IngestInput): Promise<IngestReport>;
  query(id: string, text: string, options?: QueryOptions): Promise<QueryHit[]>;
  stats(id: string): Promise<DatasetStats>;
  drop(id: string): Promise<void>;
  close(): Promise<void>;
}

function noopManager(): RagManager {
  const disabled = (): never => {
    throw new DatasetNotFoundError({ datasetId: "<rag disabled>" });
  };
  return {
    enabled: false,
    async list() {
      return [];
    },
    async get() {
      return disabled();
    },
    async register() {
      return disabled();
    },
    async ingest() {
      return disabled();
    },
    async query() {
      return disabled();
    },
    async stats() {
      return disabled();
    },
    async drop() {
      return disabled();
    },
    async close() {
      /* no-op */
    },
  };
}

export async function createRagManager(opts: RagManagerOptions): Promise<RagManager> {
  if (!opts.enabled) return noopManager();

  const cache = new Map<string, Dataset>();
  const { projectRoot, projectId, providerOptions } = opts;

  async function checkDrift(
    prior: RegistryEntry | undefined,
    config: Omit<DatasetConfig, "projectId">,
  ): Promise<void> {
    if (!prior) return;
    if (prior.providerStamp.dim !== config.provider.dim) {
      throw new ConfigDriftError({
        datasetId: config.id,
        field: "provider.dim",
        previous: prior.providerStamp.dim,
        current: config.provider.dim,
      });
    }
  }

  async function openDataset(config: Omit<DatasetConfig, "projectId">): Promise<Dataset> {
    const cached = cache.get(config.id);
    if (cached) return cached;
    const full: DatasetConfig = { ...config, projectId };
    const ds = await Dataset.open(projectRoot, full, { providerOptions });
    cache.set(config.id, ds);
    return ds;
  }

  async function get(id: string): Promise<Dataset> {
    const config = opts.datasets.find((d) => d.id === id);
    if (!config) throw new DatasetNotFoundError({ datasetId: id });
    return openDataset(config);
  }

  return {
    enabled: true,

    async list() {
      const entries = await loadRegistry(projectRoot);
      return entries.map((e) => ({
        id: e.id,
        source: e.source,
        providerStamp: e.providerStamp,
        createdAt: e.createdAt,
      }));
    },

    get,

    async register(config) {
      const entries = await loadRegistry(projectRoot);
      const prior = entries.find((e) => e.id === config.id);
      await checkDrift(prior, config);
      const ds = await openDataset(config);
      const entry: RegistryEntry = {
        id: config.id,
        projectId,
        source: config.source,
        providerStamp: ds.provider.stamp,
        createdAt: prior?.createdAt ?? new Date().toISOString(),
      };
      await upsertRegistryEntry(projectRoot, entry);
      return ds;
    },

    async ingest(id, input) {
      const ds = await get(id);
      return ds.ingest(input);
    },

    async query(id, text, options) {
      const ds = await get(id);
      return ds.query(text, options);
    },

    async stats(id) {
      const ds = await get(id);
      return ds.stats();
    },

    async drop(id) {
      const ds = await get(id);
      await ds.drop();
      cache.delete(id);
      await removeRegistryEntry(projectRoot, id);
    },

    async close() {
      for (const ds of cache.values()) {
        try {
          await ds.close();
        } catch {
          /* swallow */
        }
      }
      cache.clear();
    },
  };
}

// Re-export the projectRoot helper so callers can render the on-disk path
// when emitting operator diagnostics.
export function ragDatasetDirectory(projectRoot: string, datasetId: string): string {
  return path.join(projectRoot, ".saivage", "rag", datasetId);
}
