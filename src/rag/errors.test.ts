import { describe, it, expect } from "vitest";
import {
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
import type { ProviderStamp } from "./types.js";

describe("rag errors — instanceof, name, fields", () => {
  it("RagError is an Error and exposes cause when supplied", () => {
    const cause = new Error("boom");
    const e = new RagError("top", { cause });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(RagError);
    expect(e.name).toBe("RagError");
    expect((e as { cause?: unknown }).cause).toBe(cause);
  });

  it("ConfigDriftError carries field/previous/current", () => {
    const e = new ConfigDriftError({ datasetId: "docs", field: "provider.dim", previous: 1536, current: 1024 });
    expect(e).toBeInstanceOf(RagError);
    expect(e.name).toBe("ConfigDriftError");
    expect(e.datasetId).toBe("docs");
    expect(e.field).toBe("provider.dim");
    expect(e.previous).toBe(1536);
    expect(e.current).toBe(1024);
    expect(e.message).toMatch(/provider\.dim/);
  });

  it("EmbeddingDriftError carries expected and actual stamps", () => {
    const expected: ProviderStamp = { provider: "openai", model: "text-embedding-3-small", dim: 1536, releaseFingerprint: "a" };
    const actual: ProviderStamp = { provider: "openai", model: "text-embedding-3-small", dim: 1024, releaseFingerprint: "b" };
    const e = new EmbeddingDriftError({ expected, actual });
    expect(e).toBeInstanceOf(RagError);
    expect(e.expected.dim).toBe(1536);
    expect(e.actual.dim).toBe(1024);
    expect(e.message).toMatch(/drift/i);
  });

  it("CorruptedStoreError carries path + reason and cause", () => {
    const cause = new Error("integrity");
    const e = new CorruptedStoreError({ path: "/x/store.db", reason: "integrity_check failed", cause });
    expect(e.path).toBe("/x/store.db");
    expect(e.reason).toMatch(/integrity/);
    expect((e as { cause?: unknown }).cause).toBe(cause);
  });

  it("ProviderUnavailableError carries provider + attempts", () => {
    const e = new ProviderUnavailableError({ provider: "openai", attempts: 5 });
    expect(e.provider).toBe("openai");
    expect(e.attempts).toBe(5);
    expect(e.message).toMatch(/5 attempts/);
  });

  it("IngestLockedError carries datasetId + lockPath", () => {
    const e = new IngestLockedError({ datasetId: "docs", lockPath: "/x/.ingest.lock" });
    expect(e.datasetId).toBe("docs");
    expect(e.lockPath).toMatch(/ingest\.lock/);
  });

  it("SecretDroppedError carries reason and optional path", () => {
    const e = new SecretDroppedError({ reason: "openai-key", path: "x.md" });
    expect(e.reason).toBe("openai-key");
    expect(e.path).toBe("x.md");
  });

  it("DatasetNotFoundError carries datasetId", () => {
    const e = new DatasetNotFoundError({ datasetId: "docs" });
    expect(e.datasetId).toBe("docs");
  });

  it("InvalidQueryFilterError carries filter + reason", () => {
    const e = new InvalidQueryFilterError({ filter: { bogus: true }, reason: "unknown discriminant" });
    expect(e.reason).toMatch(/discriminant/);
  });

  it("every subclass is detectable via instanceof RagError", () => {
    const errs: RagError[] = [
      new ConfigDriftError({ datasetId: "d", field: "f", previous: 1, current: 2 }),
      new EmbeddingDriftError({
        expected: { provider: "openai", model: "text-embedding-3-small", dim: 1536, releaseFingerprint: "a" },
        actual:   { provider: "openai", model: "text-embedding-3-small", dim: 1024, releaseFingerprint: "b" },
      }),
      new CorruptedStoreError({ path: "/x", reason: "r" }),
      new ProviderUnavailableError({ provider: "openai", attempts: 1 }),
      new IngestLockedError({ datasetId: "d", lockPath: "/p" }),
      new SecretDroppedError({ reason: "r" }),
      new DatasetNotFoundError({ datasetId: "d" }),
      new InvalidQueryFilterError({ filter: {}, reason: "r" }),
    ];
    for (const e of errs) {
      expect(e).toBeInstanceOf(RagError);
      expect(e).toBeInstanceOf(Error);
      expect(typeof e.message).toBe("string");
      expect(e.message.length).toBeGreaterThan(0);
    }
  });
});
