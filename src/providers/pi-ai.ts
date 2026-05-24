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
  getProviders,
} from "@mariozechner/pi-ai";
import { piGetModel, piGetModels, UnknownModelError } from "./pi-ai-types.js";
import { classifyProviderError } from "./error.js";
import type {
  Model,
  Api,
  Context,
  Message as PiMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  Tool,
} from "@mariozechner/pi-ai";
import { BaseProvider } from "./base.js";
import type {
  ChatRequest,
  ChatResponse,
  ToolCallResult,
  ModelCapabilities,
} from "./types.js";

/**
 * A single ModelProvider that wraps any pi-ai provider/model.
 * One instance per pi-ai provider (e.g., "openai-codex", "github-copilot", "anthropic").
 */
export class PiAiProvider extends BaseProvider {
  readonly name: string;
  private readonly piProvider: string;
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
      throw new UnknownModelError(
        this.piProvider,
        request.model,
        piGetModels(this.piProvider).map((m) => m.id),
      );
    }

    const context = this.buildContext(request);

    let result;
    try {
      result = await complete(model, context, {
        apiKey: this.apiKey || undefined,
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      });
    } catch (err) {
      throw classifyProviderError(err, this.name);
    }

    if (result.stopReason === "error") {
      const message = `LLM error: ${result.errorMessage ?? "unknown"}`;
      throw classifyProviderError(new Error(message), this.name);
    }

    return this.convertResponse(result);
  }

  private resolveModel(modelId: string): Model<Api> | undefined {
    const exact = piGetModel(this.piProvider, modelId);
    if (exact) return this.withProviderCompat(exact);
    const byId = piGetModels(this.piProvider).find((m) => m.id === modelId);
    return byId ? this.withProviderCompat(byId) : undefined;
  }

  private withProviderCompat(model: Model<Api>): Model<Api> {
    if (!this.isOpenCodeKimi(model)) return model;
    if (model.api !== "openai-completions") return model;
    // Discriminant narrows model to Model<"openai-completions">; its compat
    // is OpenAICompletionsCompat, which declares
    // requiresReasoningContentOnAssistantMessages.
    return {
      ...model,
      compat: {
        ...model.compat,
        requiresReasoningContentOnAssistantMessages: true,
      },
    };
  }

  private isOpenCodeKimi(model: Model<Api>): boolean {
    return (
      (this.piProvider === "opencode" || this.piProvider === "opencode-go") &&
      /kimi-k2/i.test(model.id)
    );
  }

  // ── Saivage → pi-ai conversion ───────────────────────

  private buildContext(request: ChatRequest): Context {
    const messages: PiMessage[] = [];
    const now = Date.now();
    const piProvider = this.piProvider;

    const userMsg = (content: UserMessage["content"]): UserMessage => ({
      role: "user",
      content,
      timestamp: now,
    });

    const assistantMsg = (
      content: AssistantMessage["content"],
    ): AssistantMessage => ({
      role: "assistant",
      content,
      api: "openai-completions",
      provider: piProvider,
      model: "",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: now,
    });

    const toolResultMsg = (
      toolCallId: string,
      text: string,
      isError: boolean,
    ): ToolResultMessage => ({
      role: "toolResult",
      toolCallId,
      toolName: "",
      content: [{ type: "text", text }],
      isError,
      timestamp: now,
    });

    for (const m of request.messages) {
      if (typeof m.content === "string") {
        if (m.role === "user") {
          messages.push(userMsg(m.content));
        } else if (m.role === "assistant") {
          messages.push(
            assistantMsg([{ type: "text", text: m.content }]),
          );
        }
      } else {
        const blocks = m.content;
        if (m.role === "user") {
          for (const b of blocks) {
            if (b.type === "tool_result") {
              messages.push(
                toolResultMsg(
                  b.tool_use_id!,
                  b.content ?? "",
                  b.is_error ?? false,
                ),
              );
            } else if (b.type === "text" && b.text) {
              messages.push(userMsg(b.text));
            }
          }
        } else if (m.role === "assistant") {
          const content: (TextContent | ThinkingContent | ToolCall)[] = [];
          for (const b of blocks) {
            if (b.type === "text" && b.text) {
              content.push({ type: "text", text: b.text });
            } else if (b.type === "thinking") {
              const thinking = b.thinking ?? b.text ?? b.content ?? "";
              if (thinking) {
                content.push({
                  type: "thinking",
                  thinking,
                  thinkingSignature: b.thinking_signature ?? "reasoning_content",
                });
              }
            } else if (b.type === "tool_use") {
              // ContentBlock.input is unknown by design (provider-agnostic);
              // pi-ai's ToolCall.arguments is Record<string, unknown>.
              content.push({
                type: "toolCall",
                id: b.id!,
                name: b.name!,
                arguments: b.input as Record<string, unknown>,
              });
            }
          }
          messages.push(assistantMsg(content));
        }
      }
    }

    // pi-ai types Tool.parameters as a typebox TSchema; Saivage hand-writes
    // JSON Schema objects. pi-ai serialises parameters as JSON without
    // consulting typebox metadata, so the runtime is sound.
    const tools: Tool[] | undefined = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as unknown as Tool["parameters"],
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
    let reasoning = "";
    const toolCalls: ToolCallResult[] = [];

    for (const block of result.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "thinking") {
        reasoning += block.thinking;
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
      reasoning: reasoning || undefined,
      usage: {
        inputTokens: result.usage.input,
        outputTokens: result.usage.output,
      },
    };
  }

  modelCapabilities(model: string): ModelCapabilities | undefined {
    const resolved = this.resolveModel(model);
    if (!resolved?.contextWindow) return undefined;
    return {
      contextWindow: resolved.contextWindow,
      tokenEncoding: this.encodingFor(model),
    };
  }

  private encodingFor(model: string): "cl100k_base" | "o200k_base" {
    switch (this.piProvider) {
      case "openai":
      case "openai-codex":
        return /^(gpt-5|o1|o3|o4)/.test(model) ? "o200k_base" : "cl100k_base";
      case "anthropic":
      case "opencode":
      case "opencode-go":
      default:
        return "cl100k_base";
    }
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }

  /** List model IDs available under this pi-ai provider */
  listModels(): string[] {
    return piGetModels(this.piProvider).map((m) => m.id);
  }

  /** List all available pi-ai providers */
  static listPiProviders(): string[] {
    return getProviders();
  }
}
