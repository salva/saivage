import { OpenAIProvider } from "./openai.js";

/**
 * llama.cpp server exposes an OpenAI-compatible chat completions API.
 * By default it listens on http://localhost:8080.
 */
export class LlamaCppProvider extends OpenAIProvider {
  override readonly name = "llamacpp";

  private serverUrl: string;

  constructor(baseUrl?: string) {
    const url = baseUrl ?? process.env["LLAMACPP_BASE_URL"] ?? "http://localhost:8080";
    super(
      "llamacpp", // llama.cpp doesn't need a real API key but the client requires a non-empty value
      url.endsWith("/v1") ? url : `${url}/v1`,
    );
    this.serverUrl = url.replace(/\/v1$/, "");
  }

  override maxContextTokens(_model: string): number {
    return 128_000; // Varies by model; safe default
  }

  override async isAvailable(): Promise<boolean> {
    try {
      // llama.cpp server health endpoint
      const res = await fetch(`${this.serverUrl}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
