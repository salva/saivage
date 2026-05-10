import type { ModelProvider, RateLimitStatus, UsageStatus } from "./types.js";

export abstract class BaseProvider implements ModelProvider {
  abstract readonly name: string;

  abstract chat(
    request: import("./types.js").ChatRequest,
  ): Promise<import("./types.js").ChatResponse>;

  supportsTools(): boolean {
    return true;
  }
  supportsImages(): boolean {
    return false;
  }
  supportsStreaming(): boolean {
    return false;
  }
  maxContextTokens(_model: string): number {
    return 200_000;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getRateLimitStatus(): RateLimitStatus {
    return { remaining: null, resetAt: null, limited: false };
  }

  getUsageStatus(): UsageStatus | null {
    return null;
  }
}
