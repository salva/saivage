import Anthropic from "@anthropic-ai/sdk";
import { BaseProvider } from "./base.js";
import { classifyProviderError } from "./error.js";
import type {
  ChatRequest,
  ChatResponse,
  ToolCallResult,
  ToolSchema,
  Message,
  ContentBlock,
  ModelCapabilities,
} from "./types.js";

const MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
  [/^claude-(?:3|3-5|3\.5)-/, { contextWindow: 200_000, tokenEncoding: "cl100k_base" }],
  [/^claude-(?:sonnet|opus|haiku)-4/, { contextWindow: 200_000, tokenEncoding: "cl100k_base" }],
];

export class AnthropicProvider extends BaseProvider {
  readonly name = "anthropic";
  private client: Anthropic;

  constructor(apiKey?: string) {
    super();
    this.client = new Anthropic({
      apiKey: apiKey || process.env["ANTHROPIC_API_KEY"],
    });
  }

  setApiKey(apiKey: string): void {
    this.client = new Anthropic({ apiKey });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = this.convertMessages(request.messages);
    const tools = request.tools?.map((t) => this.convertTool(t));

    let response;
    try {
      response = await this.client.messages.create({
        model: request.model,
        max_tokens: request.maxTokens ?? 8192,
        system: request.system,
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(request.temperature != null
          ? { temperature: request.temperature }
          : {}),
        ...(request.stopSequences
          ? { stop_sequences: request.stopSequences }
          : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
      );
    } catch (err) {
      throw classifyProviderError(err, this.name);
    }

    let content = "";
    const toolCalls: ToolCallResult[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        content += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      }
    }

    return {
      content,
      toolCalls,
      finishReason: response.stop_reason === "tool_use" ? "tool_use" : "end_turn",
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private convertMessages(
    messages: Message[],
  ): Anthropic.MessageParam[] {
    return messages.map((m) => {
      if (typeof m.content === "string") {
        return { role: m.role as "user" | "assistant", content: m.content };
      }
      // Content blocks
      const blocks = (m.content as ContentBlock[]).map((b) => {
        if (b.type === "tool_use") {
          return { type: "tool_use" as const, id: b.id!, name: b.name!, input: b.input! };
        }
        if (b.type === "tool_result") {
          return {
            type: "tool_result" as const,
            tool_use_id: b.tool_use_id!,
            content: b.content ?? "",
            ...(b.is_error ? { is_error: true } : {}),
          };
        }
        return { type: "text" as const, text: b.text ?? "" };
      });
      return { role: m.role as "user" | "assistant", content: blocks };
    });
  }

  private convertTool(
    tool: ToolSchema,
  ): Anthropic.Messages.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
    };
  }

  modelCapabilities(model: string): ModelCapabilities | undefined {
    for (const [pattern, caps] of MODEL_CAPABILITIES) if (pattern.test(model)) return caps;
    return undefined;
  }

  async isAvailable(): Promise<boolean> {
    try {
      return !!(
        this.client.apiKey || process.env["ANTHROPIC_API_KEY"]
      );
    } catch {
      return false;
    }
  }
}
