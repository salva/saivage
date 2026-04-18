import { OpenAIProvider } from "./openai.js";

/**
 * Ollama exposes an OpenAI-compatible API, so we reuse OpenAIProvider
 * with a custom base URL.
 */
export class OllamaProvider extends OpenAIProvider {
  override readonly name = "ollama";

  constructor(baseUrl?: string) {
    super(
      "ollama", // Ollama doesn't need a real API key
      baseUrl ?? process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434/v1",
    );
  }

  override maxContextTokens(_model: string): number {
    return 128_000; // Varies by model; a safe default
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
