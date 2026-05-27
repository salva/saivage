// F01 B04 — OpenAI embedding provider.
// See 02-design-r2 §3.1.2 (interface) and 03-plan-r2 §6/B04 (contract).

import { createHash } from "node:crypto";
import OpenAI from "openai";

import { ProviderUnavailableError } from "../errors.js";
import type { EmbeddingProviderRef, ProviderStamp } from "../types.js";
import type {
  EmbeddingProvider,
  EmbeddingsClient,
  OpenAIProviderOptions,
} from "./index.js";

const DEFAULT_BATCH_SIZE = 96;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_DELAY_MS = 200;

function deriveReleaseFingerprint(model: string, dim: number): string {
  return createHash("sha256")
    .update(`openai:${model}:${dim}`)
    .digest("hex")
    .slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseRetryAfter(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const headers = (err as { headers?: Record<string, string> }).headers;
  const raw = headers && (headers["retry-after"] ?? headers["Retry-After"]);
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

function isRetriable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: number }).status;
  if (status === 429) return true;
  if (typeof status === "number" && status >= 500 && status < 600) return true;
  // Network-layer errors from the openai SDK surface as instances of Error
  // with no status; treat as retriable.
  if (status === undefined && err instanceof Error) return true;
  return false;
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly stamp: ProviderStamp;
  private readonly client: EmbeddingsClient;
  private readonly model: string;
  private readonly dim: number;
  private readonly batchSize: number;
  private readonly maxAttempts: number;

  constructor(ref: EmbeddingProviderRef, opts: OpenAIProviderOptions = {}) {
    this.model = ref.model;
    this.dim = ref.dim;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    if (opts.client) {
      this.client = opts.client;
    } else {
      const sdk = new OpenAI({
        apiKey: opts.apiKey ?? process.env["OPENAI_API_KEY"],
        ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      });
      this.client = {
        create: (args) => sdk.embeddings.create(args) as unknown as ReturnType<EmbeddingsClient["create"]>,
      };
    }
    this.stamp = {
      provider: "openai",
      model: this.model,
      dim: this.dim,
      releaseFingerprint: deriveReleaseFingerprint(this.model, this.dim),
    };
  }

  async embedDocuments(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const out: Float32Array[] = new Array(texts.length);
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const vectors = await this.embedOnce(batch);
      for (let j = 0; j < vectors.length; j++) {
        const v = vectors[j];
        if (!v) throw new Error("unreachable: missing vector");
        out[i + j] = v;
      }
    }
    return out;
  }

  async embedQuery(text: string): Promise<Float32Array> {
    const [v] = await this.embedDocuments([text]);
    if (!v) {
      throw new ProviderUnavailableError({
        provider: "openai",
        attempts: 1,
        message: "openai embeddings returned no vector for query",
      });
    }
    return v;
  }

  private async embedOnce(batch: string[]): Promise<Float32Array[]> {
    let lastErr: unknown = undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const args: { model: string; input: string[]; dimensions?: number } = {
          model: this.model,
          input: batch,
        };
        if (this.dim !== 1536) args.dimensions = this.dim;
        const response = await this.client.create(args);
        if (!Array.isArray(response.data) || response.data.length !== batch.length) {
          throw new Error(
            `openai embeddings returned ${response.data?.length ?? "unknown"} vectors for ${batch.length} inputs`,
          );
        }
        return response.data.map((d) => {
          if (!Array.isArray(d.embedding)) {
            throw new Error("openai embeddings: embedding is not an array");
          }
          if (d.embedding.length !== this.dim) {
            throw new Error(
              `openai embeddings: expected dim ${this.dim}, got ${d.embedding.length}`,
            );
          }
          return new Float32Array(d.embedding);
        });
      } catch (err) {
        lastErr = err;
        if (!isRetriable(err) || attempt === this.maxAttempts) break;
        const retryAfter = parseRetryAfter(err);
        const backoff = retryAfter ?? DEFAULT_BASE_DELAY_MS * 2 ** (attempt - 1);
        await sleep(backoff);
      }
    }
    throw new ProviderUnavailableError({
      provider: "openai",
      attempts: this.maxAttempts,
      cause: lastErr,
    });
  }
}
