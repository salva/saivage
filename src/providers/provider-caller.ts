import { log } from "../log.js";
import { ProviderError, classifyProviderError } from "./error.js";
import { parseModelId } from "./types.js";
import type { ChatRequest, ChatResponse, ModelProvider } from "./types.js";

export type ProviderCallMetrics = (spec: string, data: Record<string, unknown>) => void;

export class ProviderCaller {
  constructor(
    private readonly timeoutMs: number,
    private readonly recordMetrics: ProviderCallMetrics,
  ) {}

  async call(
    spec: string,
    provider: ModelProvider,
    model: string,
    request: ChatRequest & { modelSpec: string },
  ): Promise<{ ok: true; response: ChatResponse } | { ok: false; error: Error; nonRetryable?: boolean }> {
    try {
      const t0 = Date.now();
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const response = await Promise.race([
        provider.chat({ ...request, model, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            controller.abort();
            reject(new Error(`Request timed out after ${this.timeoutMs / 1000}s`));
          }, this.timeoutMs);
        }),
      ]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
      this.recordMetrics(spec, {
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        latencyMs: Date.now() - t0,
      });
      const { provider: providerName } = parseModelId(spec);
      return {
        ok: true,
        response: {
          ...response,
          provider: providerName,
          model,
          modelSpec: spec,
          requestedModelSpec: request.modelSpec,
        },
      };
    } catch (err) {
      const errorRaw = err instanceof Error ? err : new Error(String(err));
      const errMsg = errorRaw.message;
      this.recordMetrics(spec, { error: true, timeout: errMsg.includes("timed out") });
      log.warn(`[router] ${spec} failed: ${errMsg}`);

      const classified = errorRaw instanceof ProviderError
        ? errorRaw
        : classifyProviderError(errorRaw, provider.name);

      const nonRetryable =
        classified.kind === "non_retryable" || classified.kind === "context_overflow";

      return { ok: false, error: classified, nonRetryable };
    }
  }
}
