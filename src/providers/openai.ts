import OpenAI from "openai";
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

export const OPENAI_MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
  [/^gpt-5/, { contextWindow: 400_000, tokenEncoding: "o200k_base" }],
  [/^o[134]/, { contextWindow: 200_000, tokenEncoding: "o200k_base" }],
  [/^gpt-4o/, { contextWindow: 128_000, tokenEncoding: "o200k_base" }],
  [/^gpt-4/, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
  [/^gpt-3\.5/, { contextWindow: 16_385, tokenEncoding: "cl100k_base" }],
];

export class OpenAIProvider extends BaseProvider {
  readonly name: string = "openai";
  private client: OpenAI;

  private baseUrl?: string;

  constructor(apiKey?: string, baseUrl?: string) {
    super();
    this.baseUrl = baseUrl;
    this.client = new OpenAI({
      apiKey: apiKey || process.env["OPENAI_API_KEY"],
      ...(baseUrl ? { baseURL: baseUrl } : {}),
    });
  }

  setApiKey(apiKey: string): void {
    this.client = new OpenAI({
      apiKey,
      ...(this.baseUrl ? { baseURL: this.baseUrl } : {}),
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const messages = this.convertMessages(request);
    const tools = request.tools?.map((t) => this.convertTool(t));

    let response;
    try {
      response = await this.client.chat.completions.create({
        model: request.model,
        messages,
        max_tokens: request.maxTokens ?? 8192,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(request.temperature != null
          ? { temperature: request.temperature }
          : {}),
        ...(request.stopSequences
          ? { stop: request.stopSequences }
          : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
      );
    } catch (err) {
      throw classifyProviderError(err, this.name);
    }

    const choice = response.choices[0];
    if (!choice) throw new Error("No choices returned from OpenAI");

    const content = choice.message.content ?? "";
    const toolCalls: ToolCallResult[] = (
      choice.message.tool_calls ?? []
    ).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments),
    }));

    let finishReason: ChatResponse["finishReason"] = "end_turn";
    if (choice.finish_reason === "tool_calls") finishReason = "tool_use";
    else if (choice.finish_reason === "length") finishReason = "max_tokens";
    else if (choice.finish_reason === "stop") finishReason = "end_turn";

    return {
      content,
      toolCalls,
      finishReason,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  private convertMessages(
    request: ChatRequest,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (request.system) {
      result.push({ role: "system", content: request.system });
    }

    for (const m of request.messages) {
      if (typeof m.content === "string") {
        result.push({
          role: m.role as "user" | "assistant",
          content: m.content,
        });
      } else {
        // Handle content blocks
        const blocks = m.content as ContentBlock[];
        if (m.role === "assistant") {
          const text = blocks
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("");
          const toolCalls = blocks
            .filter((b) => b.type === "tool_use")
            .map((b) => ({
              id: b.id!,
              type: "function" as const,
              function: { name: b.name!, arguments: JSON.stringify(b.input) },
            }));
          result.push({
            role: "assistant",
            content: text || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          });
        } else if (m.role === "user") {
          // Tool results
          for (const b of blocks) {
            if (b.type === "tool_result") {
              result.push({
                role: "tool",
                tool_call_id: b.tool_use_id!,
                content: b.content ?? "",
              });
            } else {
              result.push({ role: "user", content: b.text ?? "" });
            }
          }
        }
      }
    }
    return result;
  }

  private convertTool(
    tool: ToolSchema,
  ): OpenAI.ChatCompletionTool {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    };
  }

  modelCapabilities(model: string): ModelCapabilities | undefined {
    for (const [pattern, caps] of OPENAI_MODEL_CAPABILITIES) if (pattern.test(model)) return caps;
    return undefined;
  }

  async isAvailable(): Promise<boolean> {
    return !!(this.client.apiKey || process.env["OPENAI_API_KEY"]);
  }
}
