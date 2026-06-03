import type { ChatRequest, ChatResponse } from "../../providers/types.js";

export interface StubModel {
  readonly calls: ChatRequest[];
  chat(request: ChatRequest): Promise<ChatResponse>;
}

export function makeStubModel(responses: ChatResponse[]): StubModel {
  const calls: ChatRequest[] = [];
  let index = 0;

  return {
    calls,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      calls.push(request);
      const response = responses[index++];
      if (!response) throw new Error(`stub model exhausted after ${calls.length} call(s)`);
      return response;
    },
  };
}

export function stubText(content: string): ChatResponse {
  return {
    content,
    toolCalls: [],
    finishReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}

export function stubTool(
  name: string,
  input: Record<string, unknown> = {},
  content = `calling ${name}`,
  id = `tool-${name}`,
): ChatResponse {
  return {
    content,
    toolCalls: [{ id, name, input }],
    finishReason: "tool_use",
    usage: { inputTokens: 1, outputTokens: 1 },
  };
}
