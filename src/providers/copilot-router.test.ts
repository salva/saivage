import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ModelRouter } from "./router.js";
import type { SaivageConfig } from "../config.js";

describe("ModelRouter github-copilot header wiring", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(JSON.stringify({
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
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("applies providers['github-copilot'].headers to outgoing chat requests after lazy setApiKey", async () => {
    const config = {
      models: {},
      failover: {},
      modelEquivalents: {},
      providers: {
        "github-copilot": {
          apiKey: "tid=test;proxy-ep=proxy.example.test;exp=9999999999;",
          headers: {
            "Editor-Version": "vscode/9.99.0",
            "User-Agent": "GitHubCopilotChat/9.99.0",
          },
        },
      },
    } as unknown as SaivageConfig;
    const router = new ModelRouter(config);

    await router.chat({
      modelSpec: "github-copilot/claude-sonnet-4.6",
      model: "claude-sonnet-4.6",
      system: "system",
      messages: [{ role: "user", content: "hi" }],
    });

    const calls = fetchMock.mock.calls.filter(([url]) => {
      const s = String(url);
      return s.startsWith("https://api.example.test/") && s.includes("/v1/messages");
    });
    expect(calls.length).toBeGreaterThan(0);
    const headers = new Headers(calls[0]![1]!.headers as HeadersInit);
    expect(headers.get("Editor-Version")).toBe("vscode/9.99.0");
    expect(headers.get("User-Agent")).toBe("GitHubCopilotChat/9.99.0");
    expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
  });
});
