// F01 B04 — EmbeddingProvider seam.
//
// Plan §B04 open question resolution: `@mariozechner/pi-ai` does NOT expose an
// embeddings entry point in the version installed at B01, so the v1 OpenAI
// embedding provider uses the `openai` SDK directly. Authentication never
// touches `.saivage/auth-profiles.json`; the provider accepts an apiKey +
// baseUrl, defaulting to `process.env.OPENAI_API_KEY` (same path the existing
// chat-completions OpenAI provider uses at src/providers/openai.ts).

import type { EmbeddingProviderRef, ProviderStamp } from "../types.js";

export interface EmbeddingProvider {
  readonly stamp: ProviderStamp;
  embedDocuments(texts: string[]): Promise<Float32Array[]>;
  embedQuery(text: string): Promise<Float32Array>;
}

export interface ProviderRegistry {
  resolve(ref: EmbeddingProviderRef): Promise<EmbeddingProvider>;
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  // Test seam: inject a minimal embeddings client. Production callers leave
  // this undefined so the real `openai` SDK is constructed.
  client?: EmbeddingsClient;
  // Per-request input-array cap. Default 96 per OpenAI's documented batch
  // limit on /v1/embeddings.
  batchSize?: number;
  // Retry policy.
  maxAttempts?: number;
}

export interface EmbeddingsClient {
  create(args: { model: string; input: string[]; dimensions?: number }): Promise<{
    data: Array<{ embedding: number[] }>;
  }>;
}

export async function createEmbeddingProvider(
  ref: EmbeddingProviderRef,
  opts: OpenAIProviderOptions = {},
): Promise<EmbeddingProvider> {
  switch (ref.kind) {
    case "openai": {
      const { OpenAIEmbeddingProvider } = await import("./openai.js");
      return new OpenAIEmbeddingProvider(ref, opts);
    }
    default: {
      const exhaustive: never = ref.kind;
      throw new Error(`unknown embedding provider kind: ${exhaustive as string}`);
    }
  }
}
