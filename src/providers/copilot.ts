import OpenAI from "openai";
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
import { getGitHubCopilotBaseUrl } from "../auth/github-copilot.js";
import { responsesFunctionCallItemId } from "./responses-ids.js";
import { resolveCopilotHeaders } from "./copilot-client-headers.js";

type ResponsesInputItem =
  | { role: "user"; content: Array<{ type: "input_text"; text: string }> }
  | { role: "assistant"; content: Array<{ type: "output_text"; text: string }> }
  | { type: "function_call"; id: string; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface CopilotModelMetadata {
  id: string;
  model_picker_enabled?: boolean;
  supported_endpoints?: string[];
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
    };
  };
}

const RESPONSES_API_AGENT_INPUT_TYPES = new Set([
  "file_search_call",
  "computer_call",
  "computer_call_output",
  "web_search_call",
  "function_call",
  "function_call_output",
  "image_generation_call",
  "code_interpreter_call",
  "local_shell_call",
  "local_shell_call_output",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
  "mcp_call",
  "reasoning",
]);

function isAnthropicModel(model: string): boolean {
  return model.startsWith("claude-");
}

function isAgentCall(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const candidate = body as { messages?: Array<{ role?: string }>; input?: Array<{ role?: string; type?: string }> };

  if (candidate.messages && candidate.messages.length > 0) {
    const lastMessage = candidate.messages[candidate.messages.length - 1];
    return lastMessage?.role === "tool" || lastMessage?.role === "assistant";
  }

  if (candidate.input && candidate.input.length > 0) {
    const lastInput = candidate.input[candidate.input.length - 1];
    return lastInput?.role === "assistant" || !!(lastInput?.type && RESPONSES_API_AGENT_INPUT_TYPES.has(lastInput.type));
  }

  return false;
}

function createCopilotFetch(apiKey: string, headers: Record<string, string>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    let parsedBody: unknown;
    try {
      if (typeof init.body === "string") parsedBody = JSON.parse(init.body);
    } catch {
      parsedBody = undefined;
    }

    const merged = new Headers(init.headers);
    for (const [key, value] of Object.entries(headers)) {
      merged.set(key, value);
    }
    merged.set("Authorization", `Bearer ${apiKey}`);
    merged.set("X-Initiator", isAgentCall(parsedBody) ? "agent" : "user");
    merged.delete("x-api-key");

    return fetch(input, { ...init, headers: merged });
  }) as typeof fetch;
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
  private baseUrl: string = "https://api.githubcopilot.com";
  private openaiClient?: OpenAI;
  private anthropicClient?: Anthropic;
  private modelsCache: { expiresAt: number; models: CopilotModelMetadata[] } | null = null;
  private headers: Record<string, string> = resolveCopilotHeaders();

  constructor(apiKey?: string, headerOverride?: Record<string, string>) {
    super();
    this.headers = resolveCopilotHeaders(headerOverride);
    if (apiKey) this.setApiKey(apiKey);
  }

  setHeaderOverrides(override?: Record<string, string>): void {
    this.headers = resolveCopilotHeaders(override);
    if (this.apiKey) this.rebuildClients();
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.baseUrl = getGitHubCopilotBaseUrl(apiKey);
    this.modelsCache = null;
    this.rebuildClients();
  }

  private rebuildClients(): void {
    if (!this.apiKey) return;
    this.openaiClient = new OpenAI({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      defaultHeaders: this.headers,
      fetch: createCopilotFetch(this.apiKey, this.headers),
    } as unknown as ConstructorParameters<typeof OpenAI>[0]);

    this.anthropicClient = new Anthropic({
      apiKey: this.apiKey,
      baseURL: this.baseUrl,
      defaultHeaders: this.headers,
      fetch: createCopilotFetch(this.apiKey, this.headers),
    } as unknown as ConstructorParameters<typeof Anthropic>[0]);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (isAnthropicModel(request.model)) {
      return this.chatAnthropic(request);
    }

    if (await this.shouldUseResponsesApi(request.model)) {
      return this.chatResponses(request);
    }

    return this.chatOpenAI(request);
  }

  private async shouldUseResponsesApi(model: string): Promise<boolean> {
    const metadata = await this.getModelMetadata(model);
    if (metadata?.supported_endpoints?.includes("/responses")) return true;
    if (metadata?.supported_endpoints && !metadata.supported_endpoints.includes("/chat/completions")) return true;
    return model === "gpt-5.5" || model.startsWith("gpt-5.5-");
  }

  private async getModelMetadata(model: string): Promise<CopilotModelMetadata | undefined> {
    const models = await this.fetchModels();
    return models.find((candidate) => candidate.id === model || model.startsWith(`${candidate.id}-`));
  }

  private getCachedModelMetadata(model: string): CopilotModelMetadata | undefined {
    const models = this.modelsCache?.models ?? [];
    return models.find((candidate) => candidate.id === model || model.startsWith(`${candidate.id}-`));
  }

  private isChatCapableModel(model: CopilotModelMetadata): boolean {
    if (model.model_picker_enabled === false) return false;
    const endpoints = model.supported_endpoints ?? [];
    return endpoints.includes("/responses") || endpoints.includes("/chat/completions") || endpoints.includes("/v1/messages");
  }

  private async fetchModels(): Promise<CopilotModelMetadata[]> {
    if (!this.apiKey) return [];
    if (this.modelsCache && this.modelsCache.expiresAt > Date.now()) return this.modelsCache.models;

    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        ...this.headers,
        Authorization: `Bearer ${this.apiKey}`,
        "X-Initiator": "agent",
      },
    });
    if (!response.ok) return [];

    const payload = await response.json() as { data?: CopilotModelMetadata[] };
    const models = Array.isArray(payload.data) ? payload.data : [];
    this.modelsCache = { expiresAt: Date.now() + 10 * 60 * 1000, models };
    return models;
  }

  private async chatResponses(request: ChatRequest): Promise<ChatResponse> {
    if (!this.openaiClient) throw new Error("Copilot provider not configured");

    const input = this.convertMessagesResponses(request);
    const tools = request.tools?.map((tool) => ({
      type: "function" as const,
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    }));

    const response = await (async () => {
      try {
        return await this.openaiClient!.responses.create({
          model: request.model,
          instructions: request.system || undefined,
          input,
          max_output_tokens: request.maxTokens ?? 8192,
          ...(tools && tools.length > 0 ? { tools } : {}),
          ...(request.temperature != null ? { temperature: request.temperature } : {}),
        } as OpenAI.Responses.ResponseCreateParamsNonStreaming,
        request.signal ? { signal: request.signal } : undefined,
        );
      } catch (err) {
        throw classifyProviderError(err, this.name);
      }
    })();

    let content = response.output_text ?? "";
    const toolCalls: ToolCallResult[] = [];

    for (const item of response.output ?? []) {
      if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id,
          name: item.name,
          input: JSON.parse(item.arguments || "{}"),
        });
      } else if (item.type === "message" && !content) {
        content = item.content
          ?.filter((part) => part.type === "output_text")
          .map((part) => part.text)
          .join("") ?? "";
      }
    }

    let finishReason: ChatResponse["finishReason"] = "end_turn";
    if (toolCalls.length > 0) finishReason = "tool_use";
    else if (response.status === "incomplete") finishReason = "max_tokens";

    return {
      content,
      toolCalls,
      finishReason,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    };
  }

  // ── OpenAI-compatible path ────────────────────────────

  private async chatOpenAI(request: ChatRequest): Promise<ChatResponse> {
    if (!this.openaiClient) throw new Error("Copilot provider not configured");

    const messages = this.convertMessagesOpenAI(request);
    const tools = request.tools?.map((t) => this.convertToolOpenAI(t));

    const tokenLimitKey = request.model.startsWith("gpt-5") ? "max_completion_tokens" : "max_tokens";
    const response = await (async () => {
      try {
        return await this.openaiClient!.chat.completions.create({
          model: request.model,
          messages,
          [tokenLimitKey]: request.maxTokens ?? 8192,
          ...(tools && tools.length > 0 ? { tools } : {}),
          ...(request.temperature != null ? { temperature: request.temperature } : {}),
          ...(request.stopSequences ? { stop: request.stopSequences } : {}),
        } as OpenAI.ChatCompletionCreateParamsNonStreaming,
        request.signal ? { signal: request.signal } : undefined,
        );
      } catch (err) {
        throw classifyProviderError(err, this.name);
      }
    })();

    const choice = response.choices[0];
    if (!choice) throw new Error("No choices returned");

    const content = choice.message.content ?? "";
    const toolCalls: ToolCallResult[] = (choice.message.tool_calls ?? [])
      .filter((tc) => tc.type === "function")
      .map((tc) => ({
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

  private convertMessagesResponses(request: ChatRequest): ResponsesInputItem[] {
    const result: ResponsesInputItem[] = [];

    for (const message of request.messages) {
      if (typeof message.content === "string") {
        if (message.role === "assistant") {
          result.push({
            role: "assistant",
            content: [{ type: "output_text", text: message.content }],
          });
        } else {
          result.push({
            role: "user",
            content: [{ type: "input_text", text: message.content }],
          });
        }
        continue;
      }

      const blocks = message.content as ContentBlock[];
      const textParts: string[] = [];

      for (const block of blocks) {
        if (block.type === "tool_result") {
          result.push({
            type: "function_call_output",
            call_id: block.tool_use_id ?? "",
            output: block.content ?? "",
          });
        } else if (block.type === "tool_use" && block.id && block.name) {
          result.push({
            type: "function_call",
            id: responsesFunctionCallItemId(block.id),
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
        } else if (block.type === "text" && block.text) {
          textParts.push(block.text);
        }
      }

      if (textParts.length > 0) {
        if (message.role === "assistant") {
          result.push({
            role: "assistant",
            content: [{ type: "output_text", text: textParts.join("") }],
          });
        } else {
          result.push({
            role: "user",
            content: [{ type: "input_text", text: textParts.join("") }],
          });
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

    const response = await (async () => {
      try {
        return await this.anthropicClient!.messages.create({
          model: request.model,
          max_tokens: request.maxTokens ?? 8192,
          system: request.system,
          messages,
          ...(tools && tools.length > 0 ? { tools } : {}),
          ...(request.temperature != null ? { temperature: request.temperature } : {}),
          ...(request.stopSequences ? { stop_sequences: request.stopSequences } : {}),
        },
        request.signal ? { signal: request.signal } : undefined,
        );
      } catch (err) {
        throw classifyProviderError(err, this.name);
      }
    })();

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

  modelCapabilities(model: string): ModelCapabilities | undefined {
    const metadata = this.getCachedModelMetadata(model);
    const contextWindow = metadata?.capabilities?.limits?.max_context_window_tokens;
    if (!contextWindow) return undefined;
    const tokenEncoding: "cl100k_base" | "o200k_base" =
      /^(gpt-5|o1|o3|o4)/.test(model) ? "o200k_base" : "cl100k_base";
    return { contextWindow, tokenEncoding };
  }

  async listModels(): Promise<string[]> {
    const models = await this.fetchModels();
    return [...new Set(models.filter((model) => this.isChatCapableModel(model)).map((model) => model.id))].sort();
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }
}
