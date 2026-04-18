import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { BaseProvider } from "./base.js";
import type {
  ChatRequest,
  ChatResponse,
  ToolCallResult,
  ToolSchema,
  Message,
  ContentBlock,
} from "./types.js";
import { getGitHubCopilotBaseUrl } from "../auth/github-copilot.js";

const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

/**
 * Models that use the Anthropic Messages API via Copilot.
 * All others default to the OpenAI Chat Completions API.
 */
const ANTHROPIC_API_MODELS = new Set([
  "claude-haiku-4.5",
  "claude-opus-4.5",
  "claude-opus-4.6",
  "claude-sonnet-4",
  "claude-sonnet-4.5",
  "claude-sonnet-4.6",
]);

function isAnthropicModel(model: string): boolean {
  return ANTHROPIC_API_MODELS.has(model) || model.startsWith("claude-");
}

/**
 * GitHub Copilot provider.
 *
 * Routes requests through the GitHub Copilot API, which provides access to
 * both Anthropic and OpenAI models. The base URL is extracted from the
 * Copilot token's proxy-ep field.
 */
export class CopilotProvider extends BaseProvider {
  readonly name = "copilot";
  private apiKey: string = "";
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;

  constructor(apiKey?: string) {
    super();
    if (apiKey) this.setApiKey(apiKey);
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    const baseUrl = getGitHubCopilotBaseUrl(apiKey);

    this.openaiClient = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      defaultHeaders: COPILOT_HEADERS,
    });

    this.anthropicClient = new Anthropic({
      apiKey,
      baseURL: `${baseUrl}/anthropic`,
      defaultHeaders: COPILOT_HEADERS,
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (isAnthropicModel(request.model)) {
      return this.chatAnthropic(request);
    }
    return this.chatOpenAI(request);
  }

  // ── OpenAI-compatible path ────────────────────────────

  private async chatOpenAI(request: ChatRequest): Promise<ChatResponse> {
    if (!this.openaiClient) throw new Error("Copilot provider not configured");

    const messages = this.convertMessagesOpenAI(request);
    const tools = request.tools?.map((t) => this.convertToolOpenAI(t));

    const response = await this.openaiClient.chat.completions.create({
      model: request.model,
      messages,
      max_tokens: request.maxTokens ?? 8192,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.stopSequences ? { stop: request.stopSequences } : {}),
    });

    const choice = response.choices[0];
    if (!choice) throw new Error("No choices returned");

    const content = choice.message.content ?? "";
    const toolCalls: ToolCallResult[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments),
    }));

    let finishReason: ChatResponse["finishReason"] = "end_turn";
    if (choice.finish_reason === "tool_calls") finishReason = "tool_use";
    else if (choice.finish_reason === "length") finishReason = "max_tokens";

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

  private convertMessagesOpenAI(request: ChatRequest): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];
    if (request.system) result.push({ role: "system", content: request.system });

    for (const m of request.messages) {
      if (typeof m.content === "string") {
        result.push({ role: m.role as "user" | "assistant", content: m.content });
      } else {
        const blocks = m.content as ContentBlock[];
        if (m.role === "assistant") {
          const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
          const tc = blocks.filter((b) => b.type === "tool_use").map((b) => ({
            id: b.id!, type: "function" as const,
            function: { name: b.name!, arguments: JSON.stringify(b.input) },
          }));
          result.push({ role: "assistant", content: text || null, ...(tc.length > 0 ? { tool_calls: tc } : {}) });
        } else if (m.role === "user") {
          for (const b of blocks) {
            if (b.type === "tool_result") {
              result.push({ role: "tool", tool_call_id: b.tool_use_id!, content: b.content ?? "" });
            } else {
              result.push({ role: "user", content: b.text ?? "" });
            }
          }
        }
      }
    }
    return result;
  }

  private convertToolOpenAI(tool: ToolSchema): OpenAI.ChatCompletionTool {
    return {
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
    };
  }

  // ── Anthropic Messages path ───────────────────────────

  private async chatAnthropic(request: ChatRequest): Promise<ChatResponse> {
    if (!this.anthropicClient) throw new Error("Copilot provider not configured");

    const messages = this.convertMessagesAnthropic(request.messages);
    const tools = request.tools?.map((t) => this.convertToolAnthropic(t));

    const response = await this.anthropicClient.messages.create({
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      system: request.system,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(request.temperature != null ? { temperature: request.temperature } : {}),
      ...(request.stopSequences ? { stop_sequences: request.stopSequences } : {}),
    });

    let content = "";
    const toolCalls: ToolCallResult[] = [];

    for (const block of response.content) {
      if (block.type === "text") content += block.text;
      else if (block.type === "tool_use") {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
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

  private convertMessagesAnthropic(messages: Message[]): Anthropic.MessageParam[] {
    return messages.map((m) => {
      if (typeof m.content === "string") {
        return { role: m.role as "user" | "assistant", content: m.content };
      }
      const blocks = (m.content as ContentBlock[]).map((b) => {
        if (b.type === "tool_use") return { type: "tool_use" as const, id: b.id!, name: b.name!, input: b.input! };
        if (b.type === "tool_result") {
          return {
            type: "tool_result" as const, tool_use_id: b.tool_use_id!,
            content: b.content ?? "", ...(b.is_error ? { is_error: true } : {}),
          };
        }
        return { type: "text" as const, text: b.text ?? "" };
      });
      return { role: m.role as "user" | "assistant", content: blocks };
    });
  }

  private convertToolAnthropic(tool: ToolSchema): Anthropic.Messages.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
    };
  }

  maxContextTokens(model: string): number {
    if (model.includes("claude")) return 200_000;
    if (model.includes("gpt-5")) return 200_000;
    if (model.includes("gpt-4")) return 128_000;
    if (model.includes("gemini")) return 1_000_000;
    return 128_000;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }
}
