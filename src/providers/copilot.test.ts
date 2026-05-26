import { afterEach, describe, expect, it, vi } from "vitest";
import { CopilotProvider } from "./copilot.js";

describe("CopilotProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes Claude requests to the Copilot Anthropic messages endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CopilotProvider("tid=test;proxy-ep=proxy.example.test;exp=9999999999;");
    const response = await provider.chat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "Reply ok." }],
    });

    expect(response.content).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe("https://api.example.test/v1/messages");

    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer tid=test;proxy-ep=proxy.example.test;exp=9999999999;");
    expect(headers.has("x-api-key")).toBe(false);
    expect(headers.get("X-Initiator")).toBe("user");
  });

  it("sends default Copilot client headers when no override is configured", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CopilotProvider("tid=test;proxy-ep=proxy.example.test;exp=9999999999;");
    await provider.chat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "hi" }],
    });

    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers as HeadersInit);
    expect(headers.get("User-Agent")).toMatch(/^GitHubCopilotChat\//);
    expect(headers.get("Editor-Version")).toMatch(/^vscode\//);
    expect(headers.get("Editor-Plugin-Version")).toMatch(/^copilot-chat\//);
    expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
    expect(headers.get("Openai-Intent")).toBe("conversation-edits");
  });

  it("applies constructor header overrides on top of defaults", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new CopilotProvider(
      "tid=test;proxy-ep=proxy.example.test;exp=9999999999;",
      { "Editor-Version": "vscode/9.99.0", "User-Agent": "GitHubCopilotChat/9.99.0" },
    );
    await provider.chat({
      model: "claude-sonnet-4.6",
      messages: [{ role: "user", content: "hi" }],
    });

    const headers = new Headers(fetchMock.mock.calls[0]![1]!.headers as HeadersInit);
    expect(headers.get("Editor-Version")).toBe("vscode/9.99.0");
    expect(headers.get("User-Agent")).toBe("GitHubCopilotChat/9.99.0");
    expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
  });
});