import type { ModelProvider, RateLimitStatus, UsageStatus, Message, ToolSchema, ModelCapabilities } from "./types.js";
import { countWithTiktoken } from "../runtime/token-counting.js";

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

  abstract modelCapabilities(model: string): ModelCapabilities | undefined;

  countTokens(model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
    const encoding = this.modelCapabilities(model)?.tokenEncoding ?? "cl100k_base";
    return countWithTiktoken(messages, system, tools, encoding);
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
