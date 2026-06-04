import { describe, it, expect } from "vitest";
import { RagError } from "../../rag/errors.js";
import { SaivagePersistError } from "./persist.js";
import { mapRagError } from "./errors.js";

describe("mapRagError", () => {
  it("maps dataset not found → RAG_DATASET_NOT_FOUND", () => {
    const m = mapRagError(new RagError("dataset_not_found", "dataset not found: x", { datasetId: "x" }));
    expect(m.code).toBe("RAG_DATASET_NOT_FOUND");
    expect(m.details).toEqual({ datasetId: "x" });
  });

  it("maps provider unavailable → RAG_PROVIDER_UNAVAILABLE", () => {
    const m = mapRagError(
      new RagError(
        "provider_unavailable",
        'embedding provider "openai" unavailable after 3 attempts',
        { provider: "openai", attempts: 3 },
      ),
    );
    expect(m.code).toBe("RAG_PROVIDER_UNAVAILABLE");
    expect(m.details).toEqual({ provider: "openai", attempts: 3 });
  });

  it("maps embedding drift → RAG_EMBEDDING_DRIFT", () => {
    const stamp = { provider: "openai", model: "m", dim: 256, releaseFingerprint: "x" };
    const m = mapRagError(new RagError("embedding_drift", "embedding provider stamp drift", { expected: stamp, actual: stamp }));
    expect(m.code).toBe("RAG_EMBEDDING_DRIFT");
  });

  it("maps config drift → RAG_CONFIG_DRIFT", () => {
    const m = mapRagError(
      new RagError("config_drift", "dataset x: config field dim drifted", {
        datasetId: "x",
        field: "dim",
        previous: 256,
        current: 512,
      }),
    );
    expect(m.code).toBe("RAG_CONFIG_DRIFT");
    expect(m.details).toMatchObject({ datasetId: "x", field: "dim" });
  });

  it("maps corrupted store → RAG_CORRUPTED_STORE", () => {
    const m = mapRagError(new RagError("corrupted_store", "corrupted vector store at /x: bad", { path: "/x", reason: "bad" }));
    expect(m.code).toBe("RAG_CORRUPTED_STORE");
  });

  it("maps ingest locked → RAG_INGEST_LOCKED", () => {
    const m = mapRagError(new RagError("ingest_locked", "dataset x: ingest is locked (/y)", { datasetId: "x", lockPath: "/y" }));
    expect(m.code).toBe("RAG_INGEST_LOCKED");
  });

  it("maps watcher unavailable → RAG_WATCHER_UNAVAILABLE", () => {
    const m = mapRagError(new RagError("watcher_unavailable", "boom"));
    expect(m.code).toBe("RAG_WATCHER_UNAVAILABLE");
  });

  it("maps invalid query filter → RAG_INVALID_QUERY_FILTER", () => {
    const m = mapRagError(new RagError("invalid_query_filter", "invalid query filter: bad", { filter: {}, reason: "bad" }));
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
