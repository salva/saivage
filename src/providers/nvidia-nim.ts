import { OpenAIProvider } from "./openai.js";
import type { ModelCapabilities } from "./types.js";

/**
 * NVIDIA NIM (NVIDIA Inference Microservices) exposes an OpenAI-compatible
 * chat completions API at https://integrate.api.nvidia.com/v1.
 *
 * We reuse OpenAIProvider with a custom base URL.  Auth uses a bearer token
 * (the standard "nvapi-…" key) supplied either via the saivage.json provider
 * config (`apiKey`) or via the `NVIDIA_API_KEY` / `NVIDIA_NIM_API_KEY`
 * environment variables.
 */
const NVIDIA_NIM_DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

const NVIDIA_NIM_MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
  [/nemotron.*340b/i, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
  [/nemotron/i, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
  [/llama-?3\.[13]/i, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
  [/deepseek/i, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
  [/qwen/i, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
];

export class NvidiaNimProvider extends OpenAIProvider {
  override readonly name = "nvidia-nim";
  private readonly defaultContextWindow?: number;
  private readonly hasConfiguredKey: boolean;

  constructor(apiKey?: string, baseUrl?: string, defaultContextWindow?: number) {
    const resolvedKey = apiKey
      ?? process.env["NVIDIA_API_KEY"]
      ?? process.env["NVIDIA_NIM_API_KEY"];
    super(
      resolvedKey ?? "nvidia-nim", // OpenAI client requires a non-empty value
      baseUrl ?? process.env["NVIDIA_NIM_BASE_URL"] ?? NVIDIA_NIM_DEFAULT_BASE_URL,
    );
    this.hasConfiguredKey = !!resolvedKey;
    this.defaultContextWindow = defaultContextWindow;
  }

  override modelCapabilities(model: string): ModelCapabilities | undefined {
    for (const [pattern, caps] of NVIDIA_NIM_MODEL_CAPABILITIES) {
      if (pattern.test(model)) return caps;
    }
    if (this.defaultContextWindow) {
      return { contextWindow: this.defaultContextWindow, tokenEncoding: "cl100k_base" };
    }
    return undefined;
  }

  override async isAvailable(): Promise<boolean> {
    return this.hasConfiguredKey;
  }
}
