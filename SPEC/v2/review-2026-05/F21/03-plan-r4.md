# F21 r4 — Plan (Proposal A)

## Changes from r3

- **Fixed router-level regression test selector (new test 2 in Step 8).** The r3 fixture sets `proxy-ep=proxy.example.test`, but `getBaseUrlFromToken` in [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L44-L49) rewrites `proxy.` to `api.`, so the outgoing Anthropic request URL is `https://api.example.test/v1/messages` (verified by the existing fixture's URL assertion in [src/providers/copilot.test.ts](src/providers/copilot.test.ts#L25-L35)). The r3 filter `String(url).includes("proxy.example.test")` therefore matched zero calls and would have failed for the wrong reason. r4 changes the selector to filter on `api.example.test` and additionally narrows to the `/v1/messages` path so the assertion is unambiguous even if upstream adds an unrelated probe request.
- **Added the required `system` field to the `router.chat` fixture call.** `ModelRouter.chat` is typed as `ChatRequest & { modelSpec: string }` at [src/providers/router.ts](src/providers/router.ts#L272), and `ChatRequest.system` is `string` (not optional) at [src/providers/types.ts](src/providers/types.ts#L27-L38). r4 adds `system: "system"` to the fixture so the test compiles under strict mode.

No other steps are modified. Steps 1-7, 9, and 10 remain as written in [03-plan-r3.md](SPEC/v2/review-2026-05/F21/03-plan-r3.md). Only the new-test-2 code block in Step 8 changes; the surrounding prose and the other test blocks (new test 1, new test 3) are unchanged. Single commit, easy revert. Implements Proposal A from [02-design-r2.md](SPEC/v2/review-2026-05/F21/02-design-r2.md) end-to-end.

## Cross-issue ordering

Unchanged from r3: independent of F11, F19, F15, and F32.

## Step-by-step edits

Steps 1 through 7 are identical to [03-plan-r3.md](SPEC/v2/review-2026-05/F21/03-plan-r3.md) — refer to that file. Only Step 8's new test 2 block is reproduced here in full to make the corrected version unambiguous to the implementer.

### Step 8 — Tests (revised new test 2 only)

#### Existing tests as regression gates

Unchanged from r3:

- [src/providers/copilot.test.ts](src/providers/copilot.test.ts) — existing assertions on `Authorization` and `X-Initiator` must remain green. The existing URL assertion (`https://api.example.test/v1/messages`) is the load-bearing reference for the new test 2 selector below.
- [src/config.test.ts](src/config.test.ts#L54-L55) — must keep parsing.

#### New test 1: constructor + setter (in `src/providers/copilot.test.ts`)

Unchanged from r3. Two `it(...)` cases asserting default headers and constructor-override headers.

#### New test 2: router-level end-to-end (new file `src/providers/copilot-router.test.ts`)

This is the critical wiring test. The fetch stub returns an Anthropic-messages-shaped body because `claude-sonnet-4.6` routes through the Anthropic messages path at [src/providers/copilot.ts](src/providers/copilot.ts#L407-L444). The `proxy-ep` host in the test token is `proxy.example.test`, which `getBaseUrlFromToken` in [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L44-L49) normalizes to `api.example.test`; the request URL is therefore `https://api.example.test/v1/messages` as already asserted by [src/providers/copilot.test.ts](src/providers/copilot.test.ts#L34). The fixture is typed against the actual `ModelRouter` constructor parameter `SaivageConfig` (see [src/providers/router.ts](src/providers/router.ts#L94)).

```ts
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
```

This test fails if `createProvider("github-copilot", ...)` does not read `providerConfig.headers`, or if the override is erased by the lazy `setApiKey` call in the chat path. The Anthropic-shaped response body ensures the test cannot fail on response-parsing concerns unrelated to header wiring. The selector matches the production-normalized host (`api.example.test`) plus the Anthropic messages path, so it cannot accidentally match an unrelated probe even if one is added later.

If the implementer prefers a tighter narrowing than the `as unknown as SaivageConfig` cast, an equivalent option is `ConstructorParameters<typeof ModelRouter>[0]`; both compile against the actual constructor signature.

#### New test 3: auth-level (new file `src/auth/github-copilot.test.ts`)

Unchanged from r3.

### Step 9 — Validation commands

Unchanged from r3. Run in `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/providers/copilot.test.ts
npx vitest run src/providers/copilot-router.test.ts
npx vitest run src/auth/github-copilot.test.ts
npx vitest run src/config.test.ts
npx vitest run
```

### Step 10 — Manual smoke (optional)

Unchanged from r3.

## Rollback strategy

Unchanged from r3: single commit, `git revert <sha>`.
