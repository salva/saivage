import { OpenAIProvider } from "./openai.js";
import type { ModelCapabilities } from "./types.js";

const LLAMACPP_MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
  [/^llama3\.1:?70b/i, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
];

/**
 * llama.cpp server exposes an OpenAI-compatible chat completions API.
 * By default it listens on http://localhost:8080.
 */
export class LlamaCppProvider extends OpenAIProvider {
  override readonly name = "llamacpp";

  private serverUrl: string;
  private readonly defaultContextWindow?: number;

  constructor(baseUrl?: string, defaultContextWindow?: number) {
    const url = baseUrl ?? process.env["LLAMACPP_BASE_URL"] ?? "http://localhost:8080";
    super(
      "llamacpp", // llama.cpp doesn't need a real API key but the client requires a non-empty value
      url.endsWith("/v1") ? url : `${url}/v1`,
    );
    this.serverUrl = url.replace(/\/v1$/, "");
    this.defaultContextWindow = defaultContextWindow;
  }

  override modelCapabilities(model: string): ModelCapabilities | undefined {
    for (const [pattern, caps] of LLAMACPP_MODEL_CAPABILITIES) if (pattern.test(model)) return caps;
    if (this.defaultContextWindow) {
      return { contextWindow: this.defaultContextWindow, tokenEncoding: "cl100k_base" };
    }
    return undefined;
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
