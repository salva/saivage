import { describe, it, expect } from "vitest";
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
import { mapRagError } from "./errors.js";

describe("mapRagError", () => {
  it("maps DatasetNotFoundError → RAG_DATASET_NOT_FOUND", () => {
    const m = mapRagError(new DatasetNotFoundError({ datasetId: "x" }));
    expect(m.code).toBe("RAG_DATASET_NOT_FOUND");
    expect(m.details).toEqual({ datasetId: "x" });
  });

  it("maps ProviderUnavailableError → RAG_PROVIDER_UNAVAILABLE", () => {
    const m = mapRagError(new ProviderUnavailableError({ provider: "openai", attempts: 3 }));
    expect(m.code).toBe("RAG_PROVIDER_UNAVAILABLE");
    expect(m.details).toEqual({ provider: "openai", attempts: 3 });
  });

  it("maps EmbeddingDriftError → RAG_EMBEDDING_DRIFT", () => {
    const stamp = { provider: "openai", model: "m", dim: 256, releaseFingerprint: "x" };
    const m = mapRagError(new EmbeddingDriftError({ expected: stamp, actual: stamp }));
    expect(m.code).toBe("RAG_EMBEDDING_DRIFT");
  });

  it("maps ConfigDriftError → RAG_CONFIG_DRIFT", () => {
    const m = mapRagError(
      new ConfigDriftError({ datasetId: "x", field: "dim", previous: 256, current: 512 }),
    );
    expect(m.code).toBe("RAG_CONFIG_DRIFT");
    expect(m.details).toMatchObject({ datasetId: "x", field: "dim" });
  });

  it("maps CorruptedStoreError → RAG_CORRUPTED_STORE", () => {
    const m = mapRagError(new CorruptedStoreError({ path: "/x", reason: "bad" }));
    expect(m.code).toBe("RAG_CORRUPTED_STORE");
  });

  it("maps IngestLockedError → RAG_INGEST_LOCKED", () => {
    const m = mapRagError(new IngestLockedError({ datasetId: "x", lockPath: "/y" }));
    expect(m.code).toBe("RAG_INGEST_LOCKED");
  });

  it("maps WatcherUnavailableError → RAG_WATCHER_UNAVAILABLE", () => {
    const m = mapRagError(new WatcherUnavailableError("boom"));
    expect(m.code).toBe("RAG_WATCHER_UNAVAILABLE");
  });

  it("maps InvalidQueryFilterError → RAG_INVALID_QUERY_FILTER", () => {
    const m = mapRagError(new InvalidQueryFilterError({ filter: {}, reason: "bad" }));
    expect(m.code).toBe("RAG_INVALID_QUERY_FILTER");
  });

  it("maps SaivagePersistError → RAG_PERSIST_FAILED with stage", () => {
    const m = mapRagError(new SaivagePersistError("bad", { stage: "write" }));
    expect(m.code).toBe("RAG_PERSIST_FAILED");
    expect(m.details).toEqual({ stage: "write" });
  });

  it("maps unknown → RAG_INTERNAL", () => {
    const m = mapRagError(new Error("mystery"));
    expect(m.code).toBe("RAG_INTERNAL");
    expect(m.message).toBe("mystery");
  });
});
