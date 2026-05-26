import { describe, it, expect, vi, afterEach } from "vitest";
import { refreshGitHubCopilotToken } from "./github-copilot.js";

describe("refreshGitHubCopilotToken header override", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("applies header override to the copilot_internal/v2/token exchange", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      token: "copilot-tok", expires_at: 9999999999,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshGitHubCopilotToken("ghp-test", {
      headers: { "Editor-Version": "vscode/9.99.0", "User-Agent": "GitHubCopilotChat/9.99.0" },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init!.headers as HeadersInit);
    expect(headers.get("Editor-Version")).toBe("vscode/9.99.0");
    expect(headers.get("User-Agent")).toBe("GitHubCopilotChat/9.99.0");
    expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
  });
});
