// F01 B09 — Dataset (per-id facade owning store + provider + chunker).
//
// A `Dataset` is the operator-facing handle for one configured RAG dataset.
// It binds together the three seam implementations (`VectorStore`,
// `EmbeddingProvider`, `Chunker`) plus the per-dataset on-disk layout under
// `<projectRoot>/.saivage/rag/<datasetId>/`. Lifecycle:
//
//   open()    -> open the store, validate the provider stamp on disk
//   ingest()  -> delegate to `pipeline.runIngest`
//   query()   -> delegate to `query/pipeline.runQuery`
//   stats()   -> proxy to the store
//   rebuild() -> ingest into a sibling `.rebuild/` directory; atomic dir
//                swap on success; old data removed
//   drop()    -> close the store and unlink the dataset directory
//   close()   -> close the underlying store
//
// The dataset never reads `.saivage/auth-profiles.json`; the provider is
// instantiated by the manager which is the single place that touches API
// keys.

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Chunker } from "./chunker/index.js";
import { createChunker } from "./chunker/index.js";
import type { EmbeddingProvider } from "./provider/index.js";
import { createEmbeddingProvider, type OpenAIProviderOptions } from "./provider/index.js";
import { runIngest } from "./pipeline.js";
import { runQuery } from "./query/pipeline.js";
import type { VectorStore } from "./store/index.js";
import { createVectorStore } from "./store/index.js";
import type {
  DatasetConfig,
  DatasetStats,
  IngestInput,
  IngestReport,
  QueryHit,
  QueryOptions,
} from "./types.js";

const STORE_FILENAME = "store.db";
const LOCK_FILENAME = ".ingest.lock";

export interface DatasetDirs {
  root: string;
  storePath: string;
  lockPath: string;
}

export function datasetDirs(projectRoot: string, datasetId: string): DatasetDirs {
  const root = path.join(projectRoot, ".saivage", "rag", datasetId);
  return {
    root,
    storePath: path.join(root, STORE_FILENAME),
    lockPath: path.join(root, LOCK_FILENAME),
  };
}

export interface DatasetOpenOptions {
  providerOptions?: OpenAIProviderOptions;
}

export class Dataset {
  readonly id: string;
  readonly config: DatasetConfig;
  readonly dirs: DatasetDirs;
  readonly store: VectorStore;
  readonly provider: EmbeddingProvider;
  readonly chunker: Chunker;

  private constructor(args: {
    config: DatasetConfig;
    dirs: DatasetDirs;
    store: VectorStore;
    provider: EmbeddingProvider;
    chunker: Chunker;
  }) {
    this.id = args.config.id;
    this.config = args.config;
    this.dirs = args.dirs;
    this.store = args.store;
    this.provider = args.provider;
    this.chunker = args.chunker;
  }

  static async open(
    projectRoot: string,
    config: DatasetConfig,
    options: DatasetOpenOptions = {},
  ): Promise<Dataset> {
    const dirs = datasetDirs(projectRoot, config.id);
    await fs.mkdir(dirs.root, { recursive: true });
    const store = await createVectorStore(config.store, dirs.storePath);
    const provider = await createEmbeddingProvider(config.provider, options.providerOptions ?? {});
    await store.open(provider.stamp);
    const chunker = await createChunker(config.chunker);
    return new Dataset({ config, dirs, store, provider, chunker });
  }

  async ingest(input: IngestInput): Promise<IngestReport> {
    return runIngest({
      datasetId: this.id,
      lockfilePath: this.dirs.lockPath,
      store: this.store,
      provider: this.provider,
      chunker: this.chunker,
      input,
    });
  }

  async query(text: string, options?: QueryOptions): Promise<QueryHit[]> {
    return runQuery({ store: this.store, provider: this.provider, text, options });
  }

  async stats(): Promise<DatasetStats> {
    const s = await this.store.stats();
    return {
      chunks: s.chunks,
      files: s.files,
      bytesOnDisk: s.bytesOnDisk,
      provider: this.provider.stamp,
      lastIngestAt: s.lastIngestAt,
      secretsDropped: 0,
    };
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  async drop(): Promise<void> {
    await this.store.drop();
    await fs.rm(this.dirs.root, { recursive: true, force: true });
  }
}
