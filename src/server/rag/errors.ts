/**
 * F02 B04 — Map `RagError` kinds (and `SaivagePersistError`) to the
 * canonical RAG envelope codes (analysis §5).
 *
 * `RAG_WATCH_DISABLED` and `RAG_DISABLED` are produced exclusively by
 * pre-checks in the handler / `rag_admin` tool; this mapper never returns
 * them. `RAG_SECRET_DROPPED` is reserved for future per-ingest reporting.
 */

import { RagError } from "../../rag/errors.js";
import { SaivagePersistError } from "./persist.js";

export interface MappedRagError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function detailRecord(err: RagError): Record<string, unknown> {
  return err.detail && typeof err.detail === "object" && !Array.isArray(err.detail)
    ? (err.detail as Record<string, unknown>)
    : {};
}

export function mapRagError(err: unknown): MappedRagError {
  if (err instanceof RagError && err.kind) {
    const details = detailRecord(err);
    switch (err.kind) {
      case "dataset_not_found":
        return {
          code: "RAG_DATASET_NOT_FOUND",
          message: err.message,
          details: { datasetId: details.datasetId },
        };
      case "provider_unavailable":
        return {
          code: "RAG_PROVIDER_UNAVAILABLE",
          message: err.message,
          details: { provider: details.provider, attempts: details.attempts },
        };
      case "embedding_drift":
        return {
          code: "RAG_EMBEDDING_DRIFT",
          message: err.message,
          details: { expected: details.expected, actual: details.actual },
        };
      case "config_drift":
        return {
          code: "RAG_CONFIG_DRIFT",
          message: err.message,
          details: {
            datasetId: details.datasetId,
            field: details.field,
            previous: details.previous,
            current: details.current,
          },
        };
      case "corrupted_store":
        return {
          code: "RAG_CORRUPTED_STORE",
          message: err.message,
          details: { path: details.path, reason: details.reason },
        };
      case "ingest_locked":
        return {
          code: "RAG_INGEST_LOCKED",
          message: err.message,
          details: { datasetId: details.datasetId, lockPath: details.lockPath },
        };
      case "watcher_unavailable":
        return {
          code: "RAG_WATCHER_UNAVAILABLE",
          message: err.message,
        };
      case "invalid_query_filter":
        return {
          code: "RAG_INVALID_QUERY_FILTER",
          message: err.message,
          details: { reason: details.reason },
        };
    }
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
