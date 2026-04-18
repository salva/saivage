/**
 * PiAiProvider — thin adapter between Saivage's ModelProvider interface and
 * @mariozechner/pi-ai's streaming LLM access layer.
 *
 * Instead of reimplementing each provider's API format, auth headers, SSE
 * parsing, and retry logic, we delegate everything to pi-ai which already
 * supports 23 providers / 850+ models.
 */
import {
  complete,
  getModel,
  getModels,
  getProviders,
} from "@mariozechner/pi-ai";
import type {
  Model,
  Api,
  KnownProvider,
  Context,
  Message as PiMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ToolCall,
  Tool,
} from "@mariozechner/pi-ai";
import { BaseProvider } from "./base.js";
import type {
  ChatRequest,
  ChatResponse,
  ToolCallResult,
  Message,
  ContentBlock,
  ToolSchema,
} from "./types.js";

/**
 * A single ModelProvider that wraps any pi-ai provider/model.
 * One instance per pi-ai provider (e.g., "openai-codex", "github-copilot", "anthropic").
 */
export class PiAiProvider extends BaseProvider {
  readonly name: string;
  private piProvider: string;
  private apiKey: string = "";

  constructor(piProvider: string, displayName?: string) {
    super();
    this.piProvider = piProvider;
    this.name = displayName ?? piProvider;
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const model = this.resolveModel(request.model);
    if (!model) {
      throw new Error(`Model "${request.model}" not found for provider "${this.piProvider}"`);
    }

    const context = this.buildContext(request);

    const result = await complete(model, context, {
      apiKey: this.apiKey || undefined,
      temperature: request.temperature,
      maxTokens: request.maxTokens,
    });

    if (result.stopReason === "error") {
      throw new Error(`LLM error: ${result.errorMessage ?? "unknown"}`);
    }

    return this.convertResponse(result);
  }

  private resolveModel(modelId: string): Model<Api> | undefined {
    // pi-ai's getModel/getModels have strict generic constraints for compile-time
    // safety, but we use dynamic strings at runtime. Cast via any.
    const _getModel = getModel as (provider: string, modelId: string) => Model<Api> | undefined;
    const _getModels = getModels as (provider: string) => Model<Api>[];

    // Try exact match first
    let model = _getModel(this.piProvider, modelId);
    if (model) return model;

    // Search by ID in case the key doesn't match exactly
    const models = _getModels(this.piProvider);
    model = models.find((m) => m.id === modelId);
    if (model) return model;

    // Fuzzy prefix match (e.g., "gpt-4o" matches "gpt-4o-2024-11-20")
    model = models.find((m) => modelId.startsWith(m.id) || m.id.startsWith(modelId));
    return model;
  }

  // ── Saivage → pi-ai conversion ───────────────────────

  private buildContext(request: ChatRequest): Context {
    const messages: PiMessage[] = [];
    const now = Date.now();

    for (const m of request.messages) {
      if (typeof m.content === "string") {
        if (m.role === "user") {
          messages.push({
            role: "user",
            content: m.content,
            timestamp: now,
          } as UserMessage);
        } else if (m.role === "assistant") {
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: m.content }],
            api: "openai-completions",
            provider: this.piProvider,
            model: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: now,
          } as AssistantMessage);
        }
      } else {
        const blocks = m.content as ContentBlock[];
        if (m.role === "user") {
          for (const b of blocks) {
            if (b.type === "tool_result") {
              messages.push({
                role: "toolResult",
                toolCallId: b.tool_use_id!,
                toolName: "",
                content: [{ type: "text", text: b.content ?? "" }],
                isError: b.is_error ?? false,
                timestamp: now,
              } as ToolResultMessage);
            } else if (b.type === "text" && b.text) {
              messages.push({
                role: "user",
                content: b.text,
                timestamp: now,
              } as UserMessage);
            }
          }
        } else if (m.role === "assistant") {
          const content: (TextContent | ToolCall)[] = [];
          for (const b of blocks) {
            if (b.type === "text" && b.text) {
              content.push({ type: "text", text: b.text });
            } else if (b.type === "tool_use") {
              content.push({
                type: "toolCall",
                id: b.id!,
                name: b.name!,
                arguments: b.input as Record<string, unknown>,
              });
            }
          }
          messages.push({
            role: "assistant",
            content,
            api: "openai-completions",
            provider: this.piProvider,
            model: "",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            stopReason: "stop",
            timestamp: now,
          } as AssistantMessage);
        }
      }
    }

    const tools: Tool[] | undefined = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Tool["parameters"],
    }));

    return {
      systemPrompt: request.system || undefined,
      messages,
      tools,
    };
  }

  // ── pi-ai → Saivage conversion ───────────────────────

  private convertResponse(result: AssistantMessage): ChatResponse {
    let content = "";
    const toolCalls: ToolCallResult[] = [];

    for (const block of result.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "toolCall") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.arguments,
        });
      }
    }

    let finishReason: ChatResponse["finishReason"] = "end_turn";
    if (result.stopReason === "toolUse") finishReason = "tool_use";
    else if (result.stopReason === "length") finishReason = "max_tokens";
    else if (result.stopReason === "stop") finishReason = "end_turn";

    return {
      content,
      toolCalls,
      finishReason,
      usage: {
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
      },
    };
  }

  maxContextTokens(model: string): number {
    const m = this.resolveModel(model);
    return m?.contextWindow ?? 128_000;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  /** List model IDs available under this pi-ai provider */
  listModels(): string[] {
    const _getModels = getModels as (provider: string) => Model<Api>[];
    return _getModels(this.piProvider).map((m) => m.id);
  }

  /** List all available pi-ai providers */
  static listPiProviders(): string[] {
    return getProviders();
  }
}
