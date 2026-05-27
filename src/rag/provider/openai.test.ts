import { describe, it, expect } from "vitest";

import { createEmbeddingProvider, type EmbeddingsClient } from "./index.js";
import { OpenAIEmbeddingProvider } from "./openai.js";
import { ProviderUnavailableError } from "../errors.js";
import type { EmbeddingProviderRef } from "../types.js";

const REF: EmbeddingProviderRef = { kind: "openai", model: "text-embedding-3-small", dim: 4 };
const REF_1536: EmbeddingProviderRef = { kind: "openai", model: "text-embedding-3-small", dim: 1536 };

function fakeClient(impl: EmbeddingsClient["create"]): EmbeddingsClient {
  return { create: impl };
}

function genEmbedding(dim: number): number[] {
  return Array.from({ length: dim }, (_, i) => i / dim);
}

describe("OpenAIEmbeddingProvider — stamp + batching + retry", () => {
  it("stamp populates with deterministic releaseFingerprint", () => {
    const p = new OpenAIEmbeddingProvider(REF, { client: fakeClient(async () => ({ data: [] })) });
    expect(p.stamp.provider).toBe("openai");
    expect(p.stamp.model).toBe("text-embedding-3-small");
    expect(p.stamp.dim).toBe(4);
    expect(p.stamp.releaseFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const p2 = new OpenAIEmbeddingProvider(REF, { client: fakeClient(async () => ({ data: [] })) });
    expect(p2.stamp.releaseFingerprint).toBe(p.stamp.releaseFingerprint);
    const p3 = new OpenAIEmbeddingProvider({ ...REF, dim: 512 }, { client: fakeClient(async () => ({ data: [] })) });
    expect(p3.stamp.releaseFingerprint).not.toBe(p.stamp.releaseFingerprint);
  });

  it("batches at the 96-input cap by default", async () => {
    const calls: number[] = [];
    const client = fakeClient(async ({ input }) => {
      calls.push(input.length);
      return { data: input.map(() => ({ embedding: genEmbedding(4) })) };
    });
    const p = new OpenAIEmbeddingProvider(REF, { client });
    const texts = Array.from({ length: 200 }, (_, i) => `t${i}`);
    const out = await p.embedDocuments(texts);
    expect(out.length).toBe(200);
    expect(calls).toEqual([96, 96, 8]);
  });

  it("honours custom batchSize", async () => {
    const calls: number[] = [];
    const client = fakeClient(async ({ input }) => {
      calls.push(input.length);
      return { data: input.map(() => ({ embedding: genEmbedding(4) })) };
    });
    const p = new OpenAIEmbeddingProvider(REF, { client, batchSize: 5 });
    await p.embedDocuments(Array.from({ length: 12 }, (_, i) => `t${i}`));
    expect(calls).toEqual([5, 5, 2]);
  });

  it("sends `dimensions` only when ref.dim differs from 1536", async () => {
    const seen: Array<{ model: string; input: string[]; dimensions?: number }> = [];
    const client = fakeClient(async (args) => {
      seen.push({ ...args });
      return { data: args.input.map(() => ({ embedding: genEmbedding(args.dimensions ?? 1536) })) };
    });
    await new OpenAIEmbeddingProvider(REF_1536, { client }).embedDocuments(["a"]);
    expect(seen[0]?.dimensions).toBeUndefined();
    seen.length = 0;
    await new OpenAIEmbeddingProvider({ ...REF_1536, dim: 256 }, { client }).embedDocuments(["a"]);
    expect(seen[0]?.dimensions).toBe(256);
  });

  it("retries 429 honouring Retry-After (numeric seconds)", async () => {
    let n = 0;
    const client = fakeClient(async ({ input }) => {
      n++;
      if (n < 3) {
        const err = Object.assign(new Error("rate limited"), { status: 429, headers: { "retry-after": "0" } });
        throw err;
      }
      return { data: input.map(() => ({ embedding: genEmbedding(4) })) };
    });
    const p = new OpenAIEmbeddingProvider(REF, { client });
    const out = await p.embedDocuments(["a"]);
    expect(out.length).toBe(1);
    expect(n).toBe(3);
  });

  it("retries 5xx with exponential backoff (capped attempts)", async () => {
    let n = 0;
    const client = fakeClient(async () => {
      n++;
      throw Object.assign(new Error("server"), { status: 503 });
    });
    const p = new OpenAIEmbeddingProvider(REF, { client, maxAttempts: 3 });
    await expect(p.embedDocuments(["a"])).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(n).toBe(3);
  });

  it("does NOT retry 4xx other than 429", async () => {
    let n = 0;
    const client = fakeClient(async () => {
      n++;
      throw Object.assign(new Error("bad request"), { status: 400 });
    });
    const p = new OpenAIEmbeddingProvider(REF, { client, maxAttempts: 5 });
    await expect(p.embedDocuments(["a"])).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(n).toBe(1);
  });

  it("surfaces ProviderUnavailableError after persistent failure", async () => {
    const client = fakeClient(async () => { throw Object.assign(new Error("net"), { code: "ECONNRESET" }); });
    const p = new OpenAIEmbeddingProvider(REF, { client, maxAttempts: 2 });
    const err = await p.embedDocuments(["a"]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderUnavailableError);
    expect((err as ProviderUnavailableError).attempts).toBe(2);
  });

  it("embedQuery routes through embedDocuments and returns one vector", async () => {
    const client = fakeClient(async ({ input }) => ({ data: input.map(() => ({ embedding: genEmbedding(4) })) }));
    const p = new OpenAIEmbeddingProvider(REF, { client });
    const v = await p.embedQuery("hello");
    expect(v).toBeInstanceOf(Float32Array);
    expect(v.length).toBe(4);
  });

  it("createEmbeddingProvider factory returns an OpenAIEmbeddingProvider for kind 'openai'", async () => {
    const client = fakeClient(async ({ input }) => ({ data: input.map(() => ({ embedding: genEmbedding(4) })) }));
    const p = await createEmbeddingProvider(REF, { client });
    expect(p).toBeInstanceOf(OpenAIEmbeddingProvider);
    expect(p.stamp.dim).toBe(4);
  });

  it("rejects when the SDK returns a wrong-dim vector", async () => {
    const client = fakeClient(async ({ input }) => ({ data: input.map(() => ({ embedding: genEmbedding(8) })) }));
    const p = new OpenAIEmbeddingProvider(REF, { client, maxAttempts: 1 });
    await expect(p.embedDocuments(["a"])).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});
