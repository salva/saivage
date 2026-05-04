// --- Provider types ---

export interface Message {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
}

export interface ContentBlock {
  type: "text" | "thinking" | "tool_use" | "tool_result" | "image";
  text?: string;
  thinking?: string;
  thinking_signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string; // Model ID without provider prefix
  system: string;
  messages: Message[];
  tools?: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
  signal?: AbortSignal;
  authProfileKey?: string;
  accountRef?: string;
}

export interface ToolCallResult {
  id: string;
  name: string;
  input: unknown;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCallResult[];
  finishReason: "end_turn" | "tool_use" | "max_tokens" | "stop";
  /** Model reasoning/thinking content (if the model supports it). */
  reasoning?: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface ChatChunk {
  type: "text" | "tool_call_start" | "tool_call_delta" | "tool_call_end" | "done";
  text?: string;
  toolCall?: Partial<ToolCallResult>;
}

export interface RateLimitStatus {
  remaining: number | null;
  resetAt: Date | null;
  limited: boolean;
}

export interface ModelProvider {
  readonly name: string;

  chat(request: ChatRequest): Promise<ChatResponse>;
  streamChat?(request: ChatRequest): AsyncIterable<ChatChunk>;

  supportsTools(): boolean;
  supportsImages(): boolean;
  supportsStreaming(): boolean;
  maxContextTokens(model: string): number;
  listModels?(): Promise<string[]> | string[];

  isAvailable(): Promise<boolean>;
  getRateLimitStatus(): RateLimitStatus;

  /** Update the API key at runtime (e.g., from OAuth token refresh). */
  setApiKey?(apiKey: string): void;
}

export function parseModelId(modelSpec: string): { provider: string; model: string } {
  const slash = modelSpec.indexOf("/");
  if (slash === -1) throw new Error(`Invalid model spec "${modelSpec}": expected "provider/model"`);
  return {
    provider: modelSpec.slice(0, slash),
    model: modelSpec.slice(slash + 1),
  };
}
