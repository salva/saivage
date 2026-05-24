import { OpenAIProvider } from "./openai.js";
import type { ModelCapabilities } from "./types.js";

const OLLAMA_MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
  [/^llama3\.1:?70b/i, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
  [/^qwen2\.5:?32b/i, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
];

/**
 * Ollama exposes an OpenAI-compatible API, so we reuse OpenAIProvider
 * with a custom base URL.
 */
export class OllamaProvider extends OpenAIProvider {
  override readonly name = "ollama";
  private readonly defaultContextWindow?: number;

  constructor(baseUrl?: string, defaultContextWindow?: number) {
    super(
      "ollama", // Ollama doesn't need a real API key
      baseUrl ?? process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1",
    );
    this.defaultContextWindow = defaultContextWindow;
  }

  override modelCapabilities(model: string): ModelCapabilities | undefined {
    for (const [pattern, caps] of OLLAMA_MODEL_CAPABILITIES) if (pattern.test(model)) return caps;
    if (this.defaultContextWindow) {
      return { contextWindow: this.defaultContextWindow, tokenEncoding: "cl100k_base" };
    }
    return undefined;
  }

  override async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(
        (process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434") + "/api/tags",
      );
      return res.ok;
    } catch {
      return false;
    }
  }
}
