// F01 B02 — typed errors for the RAG subsystem.
// See 02-design-r2 §3.1 (errors.ts module).

export type RagErrorKind =
  | "config_drift"
  | "embedding_drift"
  | "corrupted_store"
  | "provider_unavailable"
  | "ingest_locked"
  | "secret_dropped"
  | "dataset_not_found"
  | "invalid_query_filter"
  | "watcher_unavailable";

export class RagError extends Error {
  override readonly name: string = "RagError";
  readonly kind: RagErrorKind;
  readonly detail?: unknown;

  constructor(
    kind: RagErrorKind,
    message: string,
    detail?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.kind = kind;
    this.detail = detail;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
