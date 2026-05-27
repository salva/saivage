// F01 B09 — public re-exports for the Saivage RAG subsystem.

export * from "./types.js";
export {
  RagError,
  ConfigDriftError,
  EmbeddingDriftError,
  CorruptedStoreError,
  ProviderUnavailableError,
  IngestLockedError,
  SecretDroppedError,
  DatasetNotFoundError,
  InvalidQueryFilterError,
} from "./errors.js";
export { createRagManager, type RagManager, type RagManagerOptions } from "./manager.js";
export { Dataset, datasetDirs } from "./dataset.js";
