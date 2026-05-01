/**
 * OpenAI Codex provider — uses the ChatGPT backend Responses API.
 *
 * The openai-codex OAuth token authenticates against chatgpt.com/backend-api,
 * NOT the standard api.openai.com. This provider uses raw fetch() with SSE
 * to call the Codex Responses endpoint.
 */
import { BaseProvider } from "./base.js";
import type {
  ChatRequest,
  ChatResponse,
  ToolCallResult,
  ToolSchema,
  Message,
  ContentBlock,
} from "./types.js";

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM = "https://api.openai.com/auth";

// ── helpers ─────────────────────────────────────────────

function extractAccountId(token: string): string {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!));
    const aid = payload?.[JWT_CLAIM]?.chatgpt_account_id;
    if (!aid) throw new Error("no chatgpt_account_id in token");
    return aid as string;
  } catch {
    throw new Error("Failed to extract accountId from JWT");
  }
}

function resolveEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  if (normalized.endsWith("/codex/responses")) return normalized;
  if (normalized.endsWith("/codex")) return `${normalized}/responses`;
  return `${normalized}/codex/responses`;
}

// ── request/response types ──────────────────────────────

interface ResponsesInputText {
  type: "input_text";
  text: string;
}

interface ResponsesUserMessage {
  role: "user";
  content: ResponsesInputText[];
}

interface ResponsesAssistantMessage {
  role: "assistant";
  content: Array<{ type: "output_text"; text: string }>;
}

interface ResponsesSystemMessage {
  role: "system" | "developer";
  content: string;
}

type ResponsesMessage =
  | ResponsesUserMessage
  | ResponsesAssistantMessage
  | ResponsesSystemMessage
  | Record<string, unknown>;

interface ResponsesTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// ── provider ────────────────────────────────────────────

export class OpenAICodexProvider extends BaseProvider {
  readonly name = "openai-codex";
  private apiKey = "";
  private baseUrl: string;
  private accountId = "";

  constructor(apiKey?: string, baseUrl?: string) {
    super();
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    if (apiKey) this.setApiKey(apiKey);
  }

  setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
    this.accountId = extractAccountId(apiKey);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (!this.apiKey) throw new Error("OpenAI Codex provider not configured");

    const input = this.convertMessages(request);
    const tools = request.tools?.map((t) => this.convertTool(t));

    const body: Record<string, unknown> = {
      model: request.model,
      store: false,
      stream: true,
      instructions: request.system || "",
      input,
      tool_choice: "auto",
      parallel_tool_calls: true,
    };

    if (tools && tools.length > 0) body.tools = tools;
    if (request.temperature != null) body.temperature = request.temperature;
    if (request.maxTokens) body.max_output_tokens = request.maxTokens;

    const url = resolveEndpoint(this.baseUrl);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${this.apiKey}`,
      "chatgpt-account-id": this.accountId,
      originator: "pi",
      "OpenAI-Beta": "responses=experimental",
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: request.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Codex API ${response.status}: ${text.slice(0, 200)}`);
    }

    return this.parseSSE(response);
  }

  // ── SSE parsing ─────────────────────────────────────

  private async parseSSE(response: Response): Promise<ChatResponse> {
    let content = "";
    const toolCalls: ToolCallResult[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: ChatResponse["finishReason"] = "end_turn";

    // Accumulate function call arguments by call_id
    const pendingCalls = new Map<string, { id: string; name: string; args: string }>();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx = buffer.indexOf("\n\n");
        while (idx !== -1) {
          const chunk = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const dataLines = chunk
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim());

          for (const data of dataLines) {
            if (!data || data === "[DONE]") continue;
            try {
              const event = JSON.parse(data) as Record<string, unknown>;
              this.handleEvent(event, { content: "", toolCalls, pendingCalls, inputTokens: 0, outputTokens: 0 });

              const type = event.type as string | undefined;

              // Text content delta
              if (type === "response.output_text.delta") {
                content += (event.delta as string) ?? "";
              }

              // Function call argument delta
              if (type === "response.function_call_arguments.delta") {
                const itemId = event.item_id as string;
                const callId = event.call_id as string ?? itemId;
                const existing = pendingCalls.get(callId);
                if (existing) {
                  existing.args += (event.delta as string) ?? "";
                }
              }

              // New output item — could be text or function_call
              if (type === "response.output_item.added") {
                const item = event.item as Record<string, unknown> | undefined;
                if (item?.type === "function_call") {
                  const callId = (item.call_id as string) ?? (item.id as string);
                  pendingCalls.set(callId, {
                    id: callId,
                    name: (item.name as string) ?? "",
                    args: "",
                  });
                }
              }

              // Function call done
              if (type === "response.function_call_arguments.done") {
                const callId = (event.call_id as string) ?? (event.item_id as string);
                const pending = pendingCalls.get(callId);
                if (pending) {
                  try {
                    toolCalls.push({
                      id: pending.id,
                      name: pending.name,
                      input: JSON.parse(pending.args || "{}"),
                    });
                  } catch {
                    toolCalls.push({
                      id: pending.id,
                      name: pending.name,
                      input: {},
                    });
                  }
                  pendingCalls.delete(callId);
                }
              }

              // Response completed — extract usage
              if (
                type === "response.completed" ||
                type === "response.done"
              ) {
                const resp = event.response as Record<string, unknown> | undefined;
                const usage = resp?.usage as Record<string, number> | undefined;
                if (usage) {
                  inputTokens = usage.input_tokens ?? 0;
                  outputTokens = usage.output_tokens ?? 0;
                }
                const status = resp?.status as string | undefined;
                if (status === "incomplete") finishReason = "max_tokens";
              }

              // Error event
              if (type === "error") {
                const msg = (event.message as string) ?? JSON.stringify(event);
                throw new Error(`Codex stream error: ${msg}`);
              }

              if (type === "response.failed") {
                const resp = event.response as Record<string, unknown> | undefined;
                const err = resp?.error as Record<string, unknown> | undefined;
                throw new Error(
                  (err?.message as string) ?? "Codex response failed",
                );
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue; // skip non-JSON data lines
              throw e;
            }
          }

          idx = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (toolCalls.length > 0) finishReason = "tool_use";

    return {
      content,
      toolCalls,
      finishReason,
      usage: { inputTokens, outputTokens },
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private handleEvent(
    _event: Record<string, unknown>,
    _ctx: {
      content: string;
      toolCalls: ToolCallResult[];
      pendingCalls: Map<string, { id: string; name: string; args: string }>;
      inputTokens: number;
      outputTokens: number;
    },
  ): void {
    // Event handling is done inline in parseSSE
  }

  // ── message conversion ──────────────────────────────

  private convertMessages(request: ChatRequest): ResponsesMessage[] {
    const result: ResponsesMessage[] = [];

    for (const m of request.messages) {
      if (typeof m.content === "string") {
        if (m.role === "user") {
          result.push({
            role: "user",
            content: [{ type: "input_text", text: m.content }],
          });
        } else if (m.role === "assistant") {
          result.push({
            role: "assistant",
            content: [{ type: "output_text", text: m.content }],
          });
        }
      } else {
        const blocks = m.content as ContentBlock[];
        if (m.role === "user") {
          // Check for tool results
          for (const b of blocks) {
            if (b.type === "tool_result") {
              result.push({
                type: "function_call_output",
                call_id: b.tool_use_id!,
                output: b.content ?? "",
              });
            } else if (b.type === "text" && b.text) {
              result.push({
                role: "user",
                content: [{ type: "input_text", text: b.text }],
              });
            }
          }
        } else if (m.role === "assistant") {
          // Collect text and tool calls
          const textParts = blocks.filter((b) => b.type === "text");
          const toolParts = blocks.filter((b) => b.type === "tool_use");

          if (textParts.length > 0) {
            const text = textParts.map((b) => b.text ?? "").join("");
            if (text) {
              result.push({
                role: "assistant",
                content: [{ type: "output_text", text }],
              });
            }
          }

          for (const tc of toolParts) {
            result.push({
              type: "function_call",
              id: `fc_${tc.id}`,
              call_id: tc.id!,
              name: tc.name!,
              arguments: JSON.stringify(tc.input),
            });
          }
        }
      }
    }

    return result;
  }

  private convertTool(tool: ToolSchema): ResponsesTool {
    return {
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    };
  }

  maxContextTokens(model: string): number {
    if (model.includes("gpt-5")) return 200_000;
    if (model.includes("gpt-4o")) return 128_000;
    if (model.includes("gpt-4")) return 128_000;
    return 128_000;
  }

  async isAvailable(): Promise<boolean> {
    return !!this.apiKey;
  }
}
