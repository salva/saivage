// F01 B02 — public re-exports for the Saivage RAG subsystem.
// The RagManager factory is filled in by B09; in B02 this file re-exports
// only the type surface and the error hierarchy.

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
