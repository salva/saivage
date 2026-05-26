import { OpenAIProvider } from "./openai.js";
import type { ModelCapabilities } from "./types.js";

const MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
  [/^openai\/gpt-5/, { contextWindow: 400_000, tokenEncoding: "o200k_base" }],
  [/^openai\/o[134]/, { contextWindow: 200_000, tokenEncoding: "o200k_base" }],
  [/^openai\/gpt-4o/, { contextWindow: 128_000, tokenEncoding: "o200k_base" }],
  [/^anthropic\/claude-/, { contextWindow: 200_000, tokenEncoding: "cl100k_base" }],
  [/^google\/gemini-1\.5/, { contextWindow: 1_000_000, tokenEncoding: "cl100k_base" }],
  [/^google\/gemini-2/, { contextWindow: 2_000_000, tokenEncoding: "cl100k_base" }],
  [/^meta-llama\/llama-3\.1-(?:70b|8b)/, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
];

/**
 * OpenRouter uses the OpenAI API format with a different base URL.
 */
export class OpenRouterProvider extends OpenAIProvider {
  override readonly name = "openrouter";

  constructor(apiKey?: string) {
    super(
      apiKey ?? process.env["OPENROUTER_API_KEY"],
      "https://openrouter.ai/api/v1",
    );
  }

  override modelCapabilities(model: string): ModelCapabilities | undefined {
    for (const [pattern, caps] of MODEL_CAPABILITIES) if (pattern.test(model)) return caps;
    return undefined;
  }

  override async isAvailable(): Promise<boolean> {
    return !!(process.env["OPENROUTER_API_KEY"]);
  }
}
