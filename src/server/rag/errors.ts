/**
 * F02 B04 — Map `RagError` subclasses (and `SaivagePersistError`) to the
 * canonical RAG envelope codes (analysis §5).
 *
 * `RAG_WATCH_DISABLED` and `RAG_DISABLED` are produced exclusively by
 * pre-checks in the handler / `rag_admin` tool; this mapper never returns
 * them. `RAG_SECRET_DROPPED` is reserved for future per-ingest reporting.
 */

import {
  ConfigDriftError,
  CorruptedStoreError,
  DatasetNotFoundError,
  EmbeddingDriftError,
  IngestLockedError,
  InvalidQueryFilterError,
  ProviderUnavailableError,
  WatcherUnavailableError,
} from "../../rag/errors.js";
import { SaivagePersistError } from "./persist.js";

export interface MappedRagError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export function mapRagError(err: unknown): MappedRagError {
  if (err instanceof DatasetNotFoundError) {
    return {
      code: "RAG_DATASET_NOT_FOUND",
      message: err.message,
      details: { datasetId: err.datasetId },
    };
  }
  if (err instanceof ProviderUnavailableError) {
    return {
      code: "RAG_PROVIDER_UNAVAILABLE",
      message: err.message,
      details: { provider: err.provider, attempts: err.attempts },
    };
  }
  if (err instanceof EmbeddingDriftError) {
    return {
      code: "RAG_EMBEDDING_DRIFT",
      message: err.message,
      details: { expected: err.expected, actual: err.actual },
    };
  }
  if (err instanceof ConfigDriftError) {
    return {
      code: "RAG_CONFIG_DRIFT",
      message: err.message,
      details: {
        datasetId: err.datasetId,
        field: err.field,
        previous: err.previous,
        current: err.current,
      },
    };
  }
  if (err instanceof CorruptedStoreError) {
    return {
      code: "RAG_CORRUPTED_STORE",
      message: err.message,
      details: { path: err.path, reason: err.reason },
    };
  }
  if (err instanceof IngestLockedError) {
    return {
      code: "RAG_INGEST_LOCKED",
      message: err.message,
      details: { datasetId: err.datasetId, lockPath: err.lockPath },
    };
  }
  if (err instanceof WatcherUnavailableError) {
    return {
      code: "RAG_WATCHER_UNAVAILABLE",
      message: err.message,
    };
  }
  if (err instanceof InvalidQueryFilterError) {
    return {
      code: "RAG_INVALID_QUERY_FILTER",
      message: err.message,
      details: { reason: err.reason },
    };
  }
  if (err instanceof SaivagePersistError) {
    return {
      code: "RAG_PERSIST_FAILED",
      message: err.message,
      details: { stage: err.details.stage },
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: "RAG_INTERNAL", message };
}
