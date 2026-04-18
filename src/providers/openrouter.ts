import { OpenAIProvider } from "./openai.js";

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

  override maxContextTokens(_model: string): number {
    return 200_000; // Varies; OpenRouter handles it
  }

  override async isAvailable(): Promise<boolean> {
    return !!(process.env["OPENROUTER_API_KEY"]);
  }
}
