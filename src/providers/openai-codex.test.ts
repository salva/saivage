import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICodexProvider } from "./openai-codex.js";

function fakeJwt(): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
  })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function sseResponse(): Response {
  return new Response(
    'data: {"type":"response.output_text.delta","delta":"ok"}\n\n' +
    'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

describe("OpenAICodexProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits unsupported token limit parameters for the ChatGPT Codex backend", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return sseResponse();
    }));

    const provider = new OpenAICodexProvider(fakeJwt());

    await provider.chat({
      model: "gpt-5.4",
      system: "You are concise.",
      messages: [{ role: "user", content: "Reply ok" }],
      maxTokens: 600,
    });

    expect(requestBody).toBeDefined();
    expect(requestBody).not.toHaveProperty("max_output_tokens");
    expect(requestBody).not.toHaveProperty("max_completion_tokens");
    expect(requestBody).not.toHaveProperty("max_tokens");
  });
});