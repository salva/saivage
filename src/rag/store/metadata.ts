import type { ChunkMetadata } from "../types.js";

type MetadataType = "TEXT" | "INTEGER";

interface ChunkMetadataColumn<K extends keyof ChunkMetadata = keyof ChunkMetadata> {
  key: K;
  column: K;
  type: MetadataType;
  required?: boolean;
  preFilterEligible?: boolean;
}

export const CHUNK_METADATA_COLUMNS = [
  { key: "path", column: "path", type: "TEXT", required: true, preFilterEligible: true },
  { key: "source", column: "source", type: "TEXT", required: true, preFilterEligible: true },
  { key: "chunkIndex", column: "chunkIndex", type: "INTEGER", required: true },
  { key: "startLine", column: "startLine", type: "INTEGER" },
  { key: "endLine", column: "endLine", type: "INTEGER" },
  { key: "contentHash", column: "contentHash", type: "TEXT", required: true, preFilterEligible: true },
  { key: "sourceHash", column: "sourceHash", type: "TEXT", required: true },
  { key: "mtimeMs", column: "mtimeMs", type: "INTEGER", required: true },
  { key: "language", column: "language", type: "TEXT", preFilterEligible: true },
  { key: "headingPath", column: "headingPath", type: "TEXT" },
  { key: "symbolName", column: "symbolName", type: "TEXT" },
  { key: "symbolKind", column: "symbolKind", type: "TEXT" },
  { key: "scope", column: "scope", type: "TEXT", preFilterEligible: true },
  { key: "scopeRef", column: "scopeRef", type: "TEXT", preFilterEligible: true },
  { key: "role", column: "role", type: "TEXT", preFilterEligible: true },
  { key: "lifecycleStatus", column: "lifecycleStatus", type: "TEXT" },
  { key: "createdAt", column: "createdAt", type: "INTEGER", preFilterEligible: true },
  { key: "supersedes", column: "supersedes", type: "TEXT" },
] as const satisfies readonly ChunkMetadataColumn[];

export const CHUNK_METADATA_SELECT_COLUMNS = CHUNK_METADATA_COLUMNS.map((col) => col.column);
export const CHUNK_METADATA_DDL = CHUNK_METADATA_COLUMNS.map(
  (col) => `${col.column.padEnd(15)} ${col.type}${"required" in col && col.required === true ? " NOT NULL" : ""}`,
);
export const CHUNK_METADATA_INSERT_COLUMNS = CHUNK_METADATA_COLUMNS.map((col) => col.column);
export const CHUNK_METADATA_INSERT_BINDINGS = CHUNK_METADATA_COLUMNS.map((col) => `@${col.column}`);
export const CHUNK_METADATA_UPDATE_ASSIGNMENTS = CHUNK_METADATA_COLUMNS.map(
  (col) => `${col.column}=excluded.${col.column}`,
);
export const ALLOWED_FILTER_COLUMNS = ["id", ...CHUNK_METADATA_COLUMNS.map((col) => col.column)] as const;
export const PREFILTER_ELIGIBLE_COLUMNS = CHUNK_METADATA_COLUMNS
  .filter((col) => "preFilterEligible" in col && col.preFilterEligible === true)
  .map((col) => col.column);

export function metadataToSqlParams(metadata: ChunkMetadata): Record<string, string | number | null> {
  const params: Record<string, string | number | null> = {};
  for (const col of CHUNK_METADATA_COLUMNS) {
    params[col.column] = metadata[col.key] ?? null;
  }
  return params;
}

export function rowToMetadata(row: Record<string, unknown>): ChunkMetadata {
  const metadata: Partial<ChunkMetadata> = {};
  for (const col of CHUNK_METADATA_COLUMNS) {
    const value = row[col.column];
    if (value !== null && value !== undefined) {
      (metadata as Record<string, unknown>)[col.key] = value;
    }
  }
  return metadata as ChunkMetadata;
}
