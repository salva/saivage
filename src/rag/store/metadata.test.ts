import { describe, expect, it } from "vitest";
import {
  ALLOWED_FILTER_COLUMNS,
  CHUNK_METADATA_COLUMNS,
  CHUNK_METADATA_DDL,
  CHUNK_METADATA_INSERT_BINDINGS,
  CHUNK_METADATA_SELECT_COLUMNS,
  PREFILTER_ELIGIBLE_COLUMNS,
  metadataToSqlParams,
  rowToMetadata,
} from "./metadata.js";

describe("chunk metadata descriptor", () => {
  it("preserves the current persisted chunk metadata column order", () => {
    expect(CHUNK_METADATA_SELECT_COLUMNS).toEqual([
      "path", "source", "chunkIndex", "startLine", "endLine",
      "contentHash", "sourceHash", "mtimeMs", "language", "headingPath",
      "symbolName", "symbolKind", "scope", "scopeRef", "role",
      "lifecycleStatus", "createdAt", "supersedes",
    ]);
    expect(CHUNK_METADATA_DDL).toContain("chunkIndex      INTEGER NOT NULL");
    expect(CHUNK_METADATA_DDL).toContain("scopeRef        TEXT");
  });

  it("derives SQL filter allowlists from metadata", () => {
    expect(ALLOWED_FILTER_COLUMNS).toEqual(["id", ...CHUNK_METADATA_COLUMNS.map((col) => col.column)]);
    expect(PREFILTER_ELIGIBLE_COLUMNS).toEqual([
      "path", "source", "contentHash", "language", "scope", "scopeRef", "role", "createdAt",
    ]);
  });

  it("round-trips SQL row hydration and insert parameters", () => {
    const metadata = rowToMetadata({
      path: "a.md",
      source: "doc",
      chunkIndex: 1,
      startLine: null,
      contentHash: "c",
      sourceHash: "s",
      mtimeMs: 10,
      scopeRef: "scope-1",
    });
    expect(metadata).toMatchObject({ path: "a.md", source: "doc", chunkIndex: 1, scopeRef: "scope-1" });
    expect(metadata.startLine).toBeUndefined();
    const params = metadataToSqlParams(metadata);
    expect(params.path).toBe("a.md");
    expect(params.startLine).toBeNull();
    expect(CHUNK_METADATA_INSERT_BINDINGS).toContain("@scopeRef");
  });
});
