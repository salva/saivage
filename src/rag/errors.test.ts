import { describe, it, expect } from "vitest";
import { RagError, type RagErrorKind } from "./errors.js";
import type { ProviderStamp } from "./types.js";

describe("rag errors — instanceof, name, fields", () => {
  it("RagError is an Error and exposes cause when supplied", () => {
    const cause = new Error("boom");
    const e = new RagError("provider_unavailable", "top", { provider: "openai" }, { cause });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(RagError);
    expect(e.name).toBe("RagError");
    expect(e.kind).toBe("provider_unavailable");
    expect(e.detail).toEqual({ provider: "openai" });
    expect((e as { cause?: unknown }).cause).toBe(cause);
  });

  it("config drift carries field/previous/current", () => {
    const detail = { datasetId: "docs", field: "provider.dim", previous: 1536, current: 1024 };
    const e = new RagError(
      "config_drift",
      `dataset ${detail.datasetId}: config field "${detail.field}" drifted ` +
        `(previous=${JSON.stringify(detail.previous)} current=${JSON.stringify(detail.current)})`,
      detail,
    );
    expect(e).toBeInstanceOf(RagError);
    expect(e.kind).toBe("config_drift");
    expect(e.detail).toMatchObject(detail);
    expect(e.message).toMatch(/provider\.dim/);
  });

  it("embedding drift carries expected and actual stamps", () => {
    const expected: ProviderStamp = { provider: "openai", model: "text-embedding-3-small", dim: 1536, releaseFingerprint: "a" };
    const actual: ProviderStamp = { provider: "openai", model: "text-embedding-3-small", dim: 1024, releaseFingerprint: "b" };
    const e = new RagError("embedding_drift", "embedding provider stamp drift", { expected, actual });
    expect(e).toBeInstanceOf(RagError);
    expect(e.detail).toMatchObject({ expected, actual });
    expect(e.message).toMatch(/drift/i);
  });

  it("corrupted store carries path + reason and cause", () => {
    const cause = new Error("integrity");
    const detail = { path: "/x/store.db", reason: "integrity_check failed" };
    const e = new RagError(
      "corrupted_store",
      `corrupted vector store at ${detail.path}: ${detail.reason}`,
      detail,
      { cause },
    );
    expect(e.detail).toMatchObject(detail);
    expect((e as { cause?: unknown }).cause).toBe(cause);
  });

  it("provider unavailable carries provider + attempts", () => {
    const e = new RagError(
      "provider_unavailable",
      'embedding provider "openai" unavailable after 5 attempts',
      { provider: "openai", attempts: 5 },
    );
    expect(e.detail).toMatchObject({ provider: "openai", attempts: 5 });
    expect(e.message).toMatch(/5 attempts/);
  });

  it("ingest locked carries datasetId + lockPath", () => {
    const e = new RagError(
      "ingest_locked",
      "dataset docs: ingest is locked (/x/.ingest.lock)",
      { datasetId: "docs", lockPath: "/x/.ingest.lock" },
    );
    expect(e.detail).toMatchObject({ datasetId: "docs", lockPath: "/x/.ingest.lock" });
  });

  it("secret dropped carries reason and optional path", () => {
    const e = new RagError(
      "secret_dropped",
      "secret-shaped content rejected: openai-key (x.md)",
      { reason: "openai-key", path: "x.md" },
    );
    expect(e.detail).toMatchObject({ reason: "openai-key", path: "x.md" });
  });

  it("dataset not found carries datasetId", () => {
    const e = new RagError("dataset_not_found", "dataset not found: docs", { datasetId: "docs" });
    expect(e.detail).toMatchObject({ datasetId: "docs" });
  });

  it("invalid query filter carries filter + reason", () => {
    const e = new RagError(
      "invalid_query_filter",
      "invalid query filter: unknown discriminant",
      { filter: { bogus: true }, reason: "unknown discriminant" },
    );
    expect(e.detail).toMatchObject({ reason: "unknown discriminant" });
  });

  it("every kind is detectable via instanceof RagError and kind", () => {
    const kinds: RagErrorKind[] = [
      "config_drift",
      "embedding_drift",
      "corrupted_store",
      "provider_unavailable",
      "ingest_locked",
      "secret_dropped",
      "dataset_not_found",
      "invalid_query_filter",
      "watcher_unavailable",
    ];
    for (const kind of kinds) {
      const e = new RagError(kind, `${kind} message`);
      expect(e).toBeInstanceOf(RagError);
      expect(e).toBeInstanceOf(Error);
      expect(e.kind).toBe(kind);
      expect(typeof e.message).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});
