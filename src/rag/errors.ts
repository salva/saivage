// F01 B02 — typed error hierarchy for the RAG subsystem.
// See 02-design-r2 §3.1 (errors.ts module).

import type { ProviderStamp, QueryFilter } from "./types.js";

export class RagError extends Error {
  override readonly name: string = "RagError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export class ConfigDriftError extends RagError {
  override readonly name = "ConfigDriftError";
  readonly datasetId: string;
  readonly field: string;
  readonly previous: unknown;
  readonly current: unknown;
  constructor(args: {
    datasetId: string;
    field: string;
    previous: unknown;
    current: unknown;
    message?: string;
  }) {
    super(
      args.message ??
        `dataset ${args.datasetId}: config field "${args.field}" drifted ` +
          `(previous=${JSON.stringify(args.previous)} current=${JSON.stringify(args.current)})`,
    );
    this.datasetId = args.datasetId;
    this.field = args.field;
    this.previous = args.previous;
    this.current = args.current;
  }
}

export class EmbeddingDriftError extends RagError {
  override readonly name = "EmbeddingDriftError";
  readonly expected: ProviderStamp;
  readonly actual: ProviderStamp;
  constructor(args: { expected: ProviderStamp; actual: ProviderStamp; message?: string }) {
    super(
      args.message ??
        `embedding provider stamp drift: expected ${stampToString(args.expected)} ` +
          `actual ${stampToString(args.actual)}`,
    );
    this.expected = args.expected;
    this.actual = args.actual;
  }
}

export class CorruptedStoreError extends RagError {
  override readonly name = "CorruptedStoreError";
  readonly path: string;
  readonly reason: string;
  constructor(args: { path: string; reason: string; cause?: unknown }) {
    super(`corrupted vector store at ${args.path}: ${args.reason}`, { cause: args.cause });
    this.path = args.path;
    this.reason = args.reason;
  }
}

export class ProviderUnavailableError extends RagError {
  override readonly name = "ProviderUnavailableError";
  readonly provider: string;
  readonly attempts: number;
  constructor(args: { provider: string; attempts: number; cause?: unknown; message?: string }) {
    super(
      args.message ??
        `embedding provider "${args.provider}" unavailable after ${args.attempts} attempts`,
      { cause: args.cause },
    );
    this.provider = args.provider;
    this.attempts = args.attempts;
  }
}

export class IngestLockedError extends RagError {
  override readonly name = "IngestLockedError";
  readonly datasetId: string;
  readonly lockPath: string;
  constructor(args: { datasetId: string; lockPath: string }) {
    super(`dataset ${args.datasetId}: ingest is locked (${args.lockPath})`);
    this.datasetId = args.datasetId;
    this.lockPath = args.lockPath;
  }
}

export class SecretDroppedError extends RagError {
  override readonly name = "SecretDroppedError";
  readonly reason: string;
  readonly path?: string;
  constructor(args: { reason: string; path?: string }) {
    super(`secret-shaped content rejected: ${args.reason}${args.path ? ` (${args.path})` : ""}`);
    this.reason = args.reason;
    this.path = args.path;
  }
}

export class DatasetNotFoundError extends RagError {
  override readonly name = "DatasetNotFoundError";
  readonly datasetId: string;
  constructor(args: { datasetId: string }) {
    super(`dataset not found: ${args.datasetId}`);
    this.datasetId = args.datasetId;
  }
}

export class InvalidQueryFilterError extends RagError {
  override readonly name = "InvalidQueryFilterError";
  readonly filter: QueryFilter | unknown;
  readonly reason: string;
  constructor(args: { filter: QueryFilter | unknown; reason: string }) {
    super(`invalid query filter: ${args.reason}`);
    this.filter = args.filter;
    this.reason = args.reason;
  }
}

export class WatcherUnavailableError extends RagError {
  override readonly name = "WatcherUnavailableError";
  readonly datasetId: string;
  readonly sourceCount: number;
  readonly fileCountApprox: number;
  constructor(args: {
    datasetId: string;
    sourceCount: number;
    fileCountApprox: number;
    cause?: unknown;
    message?: string;
  }) {
    super(
      args.message ??
        `watcher unavailable for dataset ${args.datasetId}: inotify watch limit ` +
          `reached (see /proc/sys/fs/inotify/max_user_watches) — ` +
          `${args.sourceCount} source roots, ~${args.fileCountApprox} files`,
      { cause: args.cause },
    );
    this.datasetId = args.datasetId;
    this.sourceCount = args.sourceCount;
    this.fileCountApprox = args.fileCountApprox;
  }
}

function stampToString(s: ProviderStamp): string {
  return `${s.provider}/${s.model}@dim=${s.dim}#${s.releaseFingerprint}`;
}
