import { describe, it, expect } from "vitest";
import { embeddingCacheKey, stampFingerprint } from "./embedding-cache.js";

const stamp = {
  provider: "openai",
  model: "text-embedding-3-small",
  dim: 256,
  releaseFingerprint: "abc123",
};

describe("embeddingCacheKey", () => {
  it("is deterministic for identical inputs", () => {
    expect(embeddingCacheKey(stamp, "hash1")).toBe(embeddingCacheKey(stamp, "hash1"));
  });

  it("changes when contentHash changes", () => {
    expect(embeddingCacheKey(stamp, "h1")).not.toBe(embeddingCacheKey(stamp, "h2"));
  });

  it("changes when stamp changes", () => {
    const other = { ...stamp, model: "text-embedding-3-large" as never };
    expect(embeddingCacheKey(stamp, "h")).not.toBe(embeddingCacheKey(other, "h"));
  });

  it("changes when releaseFingerprint changes", () => {
    const other = { ...stamp, releaseFingerprint: "deadbeef" };
    expect(embeddingCacheKey(stamp, "h")).not.toBe(embeddingCacheKey(other, "h"));
  });

  it("changes when dim changes", () => {
    const other = { ...stamp, dim: 1024 as const };
    expect(embeddingCacheKey(stamp, "h")).not.toBe(embeddingCacheKey(other, "h"));
  });
});

describe("stampFingerprint", () => {
  it("renders provider:model:dim:releaseFingerprint", () => {
    expect(stampFingerprint(stamp)).toBe("openai:text-embedding-3-small:256:abc123");
  });
});
