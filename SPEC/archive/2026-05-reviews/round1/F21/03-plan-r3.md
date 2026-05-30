# F21 r3 — Plan (Proposal A)

## Changes from r2

- **Fixed Step 5 `resolveApiKey` precedence.** The r2 wording said to compute the OAuth-refresh `headers` as "`accountConfig?.headers ?? undefined` (preferred) else `providerConfig?.headers ?? undefined`", which would drop provider-level overrides whenever an account supplied a partial override. r3 replaces this with the same shallow merge used for `createProvider`: `{ ...(providerConfig?.headers ?? {}), ...(accountConfig?.headers ?? {}) }`, computed once, applied to **every** `getOAuthApiKey` call in `resolveApiKey` (explicit profile path, account-profile path, and provider fallback path). The chat and token-exchange paths now send the same impersonation triple by construction.
- **Fixed Step 8 router-level test (new test 2).** Two executable defects from r2 are corrected:
  1. The stubbed response was OpenAI Chat Completions-shaped (`{ choices: [...] }`) but the test routed `claude-sonnet-4.6`, which takes the Anthropic messages path in [src/providers/copilot.ts](src/providers/copilot.ts#L407-L444). r3 returns an Anthropic-messages-shaped body matching the existing `copilot.test.ts` fixture so the test fails only on the intended header-wiring regression.
  2. `Parameters<typeof ModelRouter>[0]` is not a valid way to type a class constructor argument. r3 imports `SaivageConfig` from `../config.js` (the actual constructor parameter type — see [src/providers/router.ts](src/providers/router.ts#L94)) and casts the fixture as `SaivageConfig`.

Steps 1-4, 6, 7, 9, and 10 are unchanged from r2 (Step 5 and the new-test-2 block of Step 8 are the only edits). Single commit, easy revert. Implements Proposal A from [02-design-r2.md](SPEC/v2/review-2026-05/F21/02-design-r2.md) end-to-end.

## Cross-issue ordering

- **Independent of F11** (magic constants generally). F11 may reuse the "shared defaults module" pattern; F21 does not block or get blocked by it.
- **Independent of F19** (provider barrel). The new `copilot-client-headers.ts` is imported directly, not from the barrel.
- **Independent of F15** (OAuth token resolution overlap). F15 will rework how the auth store is invoked. F21 only edits function bodies and widens `OAuthProviderDef`; whatever F15 does next composes cleanly with the wider signature.
- **Independent of F32** (saivage-config undocumented blocks). F32 will document the schema; F21 adds one new optional field that F32 picks up.

## Step-by-step edits

### Step 1 — Create the shared header module

New file `src/providers/copilot-client-headers.ts`:

```ts
export const DEFAULT_COPILOT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
  "Openai-Intent": "conversation-edits",
});

export function resolveCopilotHeaders(
  override?: Record<string, string>,
): Record<string, string> {
  if (!override) return { ...DEFAULT_COPILOT_HEADERS };
  return { ...DEFAULT_COPILOT_HEADERS, ...override };
}
```

No new docstrings on existing code; only this new file documents itself.

### Step 2 — Extend the provider-account schema

In [src/routing/resolver.ts](src/routing/resolver.ts#L38-L52), add one field to `runtimeProviderAccountSchema`:

```ts
export const runtimeProviderAccountSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  authProfile: z.string().optional(),
  priority: z.number().default(100),
  models: z.array(z.string()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  quota: z.object({ /* unchanged */ }).optional(),
});
```

And add `headers?: Record<string, string>;` to `RuntimeProviderAccountLike` at [src/routing/resolver.ts](src/routing/resolver.ts#L59-L70). `runtimeProviderConfigSchema` and `RuntimeProviderConfigLike` inherit it.

### Step 3 — Refactor `src/providers/copilot.ts`

1. **Remove** the local `COPILOT_HEADERS` literal at [src/providers/copilot.ts](src/providers/copilot.ts#L33-L39).
2. **Remove** the `ANTHROPIC_API_MODELS` Set and its docstring at [src/providers/copilot.ts](src/providers/copilot.ts#L57-L70).
3. **Simplify** `isAnthropicModel` at [src/providers/copilot.ts](src/providers/copilot.ts#L72-L74) to `return model.startsWith("claude-");`.
4. **Import** `import { resolveCopilotHeaders } from "./copilot-client-headers.js";` at the top.
5. **Rewire** `createCopilotFetch` to close over a passed `headers` set instead of the module-level constant. Signature: `createCopilotFetch(apiKey: string, headers: Record<string, string>)`. Inside, replace `Object.entries(COPILOT_HEADERS)` at [src/providers/copilot.ts](src/providers/copilot.ts#L102-L106) with `Object.entries(headers)`.
6. **Add a stored `headers` field** to `CopilotProvider`:

   ```ts
   private headers: Record<string, string> = resolveCopilotHeaders();
   ```

7. **Widen the constructor**:

   ```ts
   constructor(apiKey?: string, headerOverride?: Record<string, string>) {
     super();
     this.headers = resolveCopilotHeaders(headerOverride);
     if (apiKey) this.setApiKey(apiKey);
   }
   ```

8. **Add a setter** `setHeaderOverrides(override?: Record<string, string>): void` that does `this.headers = resolveCopilotHeaders(override)` and then rebuilds `this.openaiClient` / `this.anthropicClient` if `this.apiKey` is non-empty (reuses the same client-construction code path as `setApiKey`).
9. **Keep `setApiKey(apiKey: string): void` single-argument.** Replace `COPILOT_HEADERS` with `this.headers` at:
   - OpenAI client `defaultHeaders` ([src/providers/copilot.ts](src/providers/copilot.ts#L142)).
   - Anthropic client `defaultHeaders` ([src/providers/copilot.ts](src/providers/copilot.ts#L149)).
   - Both `createCopilotFetch(apiKey, this.headers)` calls ([src/providers/copilot.ts](src/providers/copilot.ts#L143) and [src/providers/copilot.ts](src/providers/copilot.ts#L150)).
10. **Rewire `fetchModels`** at [src/providers/copilot.ts](src/providers/copilot.ts#L193-L197) to spread `...this.headers` instead of `...COPILOT_HEADERS`.

### Step 4 — Refactor `src/auth/github-copilot.ts`

1. **Remove** the local `COPILOT_HEADERS` literal at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L17-L22).
2. **Import** `import { resolveCopilotHeaders } from "../providers/copilot-client-headers.js";` at the top.
3. **Widen `startDeviceFlow`** to `startDeviceFlow(domain: string, headers: Record<string, string>): Promise<DeviceCodeResponse>`. Replace the inline `"User-Agent": "GitHubCopilotChat/0.35.0"` at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L80) with `"User-Agent": headers["User-Agent"]!`.
4. **Widen `pollForAccessToken`** to take a trailing `headers: Record<string, string>` argument. Replace the inline `"User-Agent": "GitHubCopilotChat/0.35.0"` at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L134) with `"User-Agent": headers["User-Agent"]!`.
5. **Widen `refreshGitHubCopilotToken`** to:

   ```ts
   export async function refreshGitHubCopilotToken(
     githubToken: string,
     options: { enterpriseDomain?: string; headers?: Record<string, string> } = {},
   ): Promise<OAuthCredentials>
   ```

   Inside, compute `const headers = resolveCopilotHeaders(options.headers);` and spread `...headers` into the `copilot_internal/v2/token` fetch at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L175-L181). Replace the `enterpriseDomain` reference with `options.enterpriseDomain`.

6. **Widen `loginGitHubCopilot`** to:

   ```ts
   export async function loginGitHubCopilot(
     callbacks: OAuthLoginCallbacks,
     options: { headers?: Record<string, string> } = {},
   ): Promise<OAuthCredentials>
   ```

   Compute `const headers = resolveCopilotHeaders(options.headers);` once and pass to `startDeviceFlow`, `pollForAccessToken`, and `refreshGitHubCopilotToken({ headers })`.

7. **Update `githubCopilotOAuthProvider`** at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L228-L243) to forward the new options through:

   ```ts
   async login(callbacks, options) {
     return loginGitHubCopilot(callbacks, options);
   },
   async refreshToken(credentials, options) {
     return refreshGitHubCopilotToken(credentials.refresh, options);
   },
   ```

### Step 5 — Router wiring (provider construction + lazy OAuth refresh)

In [src/providers/router.ts](src/providers/router.ts#L720-L728), update the `github-copilot` arm of `createProvider`:

```ts
case "github-copilot": {
  const mergedHeaders = { ...(providerConfig?.headers ?? {}), ...(accountConfig?.headers ?? {}) };
  const override = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;
  return new CopilotProvider(apiKey, override);
}
```

In [src/providers/router.ts](src/providers/router.ts#L174-L199), update `resolveApiKey`. Compute the merged header override **once** at the top of the body, using the same shallow-merge rule as `createProvider` so the chat-path provider and the OAuth token-exchange path always send the same impersonation triple:

```ts
async resolveApiKey(
  providerName: string,
  options: { authProfileKey?: string; accountRef?: string } = {},
): Promise<string | null> {
  const oauthId = PROVIDER_TO_OAUTH[providerName] ?? providerName;
  const providerConfig = this.providerConfigs[providerName];
  const accountConfig = this.getRequestedAccountConfig(providerName, options);
  const mergedHeaders = {
    ...(providerConfig?.headers ?? {}),
    ...(accountConfig?.headers ?? {}),
  };
  const headers = Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined;

  if (options.authProfileKey) {
    const explicitProfile = getProfileByKey(options.authProfileKey);
    if (explicitProfile?.provider === oauthId) {
      const key = await getOAuthApiKey(oauthId, { profileKey: options.authProfileKey, headers });
      if (key) return key;
    }
  }

  if (accountConfig?.authProfile) {
    const profiledKey = await getOAuthApiKey(oauthId, { profileKey: accountConfig.authProfile, headers });
    if (profiledKey) return profiledKey;
  }

  if (accountConfig?.apiKey) return accountConfig.apiKey;
  if (providerConfig?.apiKey) return providerConfig.apiKey;

  return getOAuthApiKey(oauthId, { headers });
}
```

Notes on the rewrite:

- `providerConfig` is now looked up once at the top instead of only on the fallback branch. This is the single structural change; behavior on the static-`apiKey` branches is unchanged.
- Every `getOAuthApiKey` call receives the **same** `headers` value, so the token-exchange `User-Agent`/`Editor-Version`/`Editor-Plugin-Version` triple matches whatever `createProvider("github-copilot", ...)` was constructed with.
- `headers` is `undefined` when both provider- and account-level overrides are absent, so callers that haven't opted in stay on the baked defaults via `resolveCopilotHeaders(undefined)` inside `refreshGitHubCopilotToken`.

The six existing `provider.setApiKey(key)` call sites at [src/providers/router.ts](src/providers/router.ts#L238), [src/providers/router.ts](src/providers/router.ts#L299), [src/providers/router.ts](src/providers/router.ts#L640), [src/providers/router.ts](src/providers/router.ts#L731), [src/providers/router.ts](src/providers/router.ts#L736), [src/providers/router.ts](src/providers/router.ts#L741), [src/providers/router.ts](src/providers/router.ts#L746), [src/providers/router.ts](src/providers/router.ts#L751), plus [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L113) and [src/server/bootstrap.ts](src/server/bootstrap.ts#L754), are **deliberately not modified** — the provider preserves `this.headers` across `setApiKey(apiKey)` calls.

For the bootstrap-level `injectOAuthTokens` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L741-L760), update only the `getOAuthApiKey` call to look up the router's provider config and pass `headers` (no account context exists at this site, so the merge degenerates to provider headers):

```ts
const providerCfg = router.getProviderConfig?.(providerName);
const headers = providerCfg?.headers;
const key = await getOAuthApiKey(oauthId, { headers });
```

If `ModelRouter` does not already expose `getProviderConfig`, add the small public accessor `getProviderConfig(name: string): RuntimeProviderConfigLike | undefined { return this.providerConfigs[name]; }`. This is the single minimal addition to the router's surface; no other consumer needs it.

### Step 6 — OAuth interface widening

In [src/auth/types.ts](src/auth/types.ts#L29-L36), widen `OAuthProviderDef`:

```ts
export interface OAuthProviderOptions {
  headers?: Record<string, string>;
}

export interface OAuthProviderDef {
  readonly id: string;
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks, options?: OAuthProviderOptions): Promise<OAuthCredentials>;
  refreshToken(credentials: OAuthCredentials, options?: OAuthProviderOptions): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
}
```

Update the other two `OAuthProviderDef` implementations to accept the new options argument as an unused second parameter:

- [src/auth/openai-codex.ts](src/auth/openai-codex.ts) — add `, _options` to the `login` / `refreshToken` parameter lists.
- [src/auth/anthropic.ts](src/auth/anthropic.ts) — same.

In [src/auth/store.ts](src/auth/store.ts#L88-L122), widen `getOAuthApiKey`:

```ts
export async function getOAuthApiKey(
  providerId: string,
  options: { profileKey?: string; headers?: Record<string, string> } = {},
): Promise<string | null>
```

Pass `{ headers: options.headers }` to `provider.refreshToken(profile, ...)` at [src/auth/store.ts](src/auth/store.ts#L113).

In [src/server/cli.ts](src/server/cli.ts#L437-L470), for the `login` subcommand: after the project root is resolved and before `provider.login(callbacks)`, when `providerId === "github-copilot"`, load the active `SaivageConfig` via the same loader the runtime uses, read `config.providers?.["github-copilot"]?.headers`, and pass `{ headers }` as the second argument to `provider.login(callbacks, { headers })`.

### Step 7 — Remove dead code (final sweep)

After Steps 3-4 land, search the repo for any remaining `COPILOT_HEADERS`, `ANTHROPIC_API_MODELS`, or inline `"GitHubCopilotChat/0.35.0"` literal and confirm only `DEFAULT_COPILOT_HEADERS` in `src/providers/copilot-client-headers.ts` remains. No `@deprecated` aliases. No re-export shims.

```bash
rg 'COPILOT_HEADERS|ANTHROPIC_API_MODELS|"GitHubCopilotChat/0\.35\.0"' src/
# expected: zero matches outside src/providers/copilot-client-headers.ts
```

### Step 8 — Tests

#### Existing tests as regression gates

- [src/providers/copilot.test.ts](src/providers/copilot.test.ts) — existing assertions on `Authorization` and `X-Initiator` must remain green.
- [src/config.test.ts](src/config.test.ts#L54-L55) — the existing `providers["github-copilot"]` access path must keep parsing; the new optional `headers` field is absent from the fixture and must not break.

#### New test 1: constructor + setter (in `src/providers/copilot.test.ts`)

Two new `it(...)` cases in the existing `describe("CopilotProvider", ...)`:

1. **"sends default Copilot client headers when no override is configured"** — `vi.stubGlobal("fetch", fetchMock)`; build `new CopilotProvider("tid=test;proxy-ep=proxy.example.test;exp=9999999999;")`; dispatch a `claude-sonnet-4.6` chat; assert the captured `init.headers` matches:
   - `User-Agent` matches `/^GitHubCopilotChat\//`
   - `Editor-Version` matches `/^vscode\//`
   - `Editor-Plugin-Version` matches `/^copilot-chat\//`
   - `Copilot-Integration-Id === "vscode-chat"`
   - `Openai-Intent === "conversation-edits"`

   Regex match (not exact) so future default-version bumps don't churn the test.

2. **"applies constructor header overrides on top of defaults"** — build `new CopilotProvider("tid=...;proxy-ep=proxy.example.test;...", { "Editor-Version": "vscode/9.99.0", "User-Agent": "GitHubCopilotChat/9.99.0" })`; dispatch a chat; assert `init.headers["Editor-Version"] === "vscode/9.99.0"`, `init.headers["User-Agent"] === "GitHubCopilotChat/9.99.0"`, `init.headers["Copilot-Integration-Id"] === "vscode-chat"` (default preserved).

#### New test 2: router-level end-to-end (new file `src/providers/copilot-router.test.ts`)

This is the **critical wiring test** the reviewer required. The fetch stub now returns an Anthropic-messages-shaped body (matching the existing `copilot.test.ts` fixture) because `claude-sonnet-4.6` routes through the Anthropic messages path at [src/providers/copilot.ts](src/providers/copilot.ts#L407-L444). The config fixture is typed against the actual `ModelRouter` constructor parameter `SaivageConfig` (see [src/providers/router.ts](src/providers/router.ts#L94)).

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
      messages: [{ role: "user", content: "hi" }],
    });

    const calls = fetchMock.mock.calls.filter(([url]) => String(url).includes("proxy.example.test"));
    expect(calls.length).toBeGreaterThan(0);
    const headers = new Headers(calls[0]![1]!.headers as HeadersInit);
    expect(headers.get("Editor-Version")).toBe("vscode/9.99.0");
    expect(headers.get("User-Agent")).toBe("GitHubCopilotChat/9.99.0");
    expect(headers.get("Copilot-Integration-Id")).toBe("vscode-chat");
  });
});
```

This test fails if `createProvider("github-copilot", ...)` does not read `providerConfig.headers`, or if the override is erased by the lazy `setApiKey` call in the chat path. The Anthropic-shaped response body ensures the test cannot fail on response-parsing concerns unrelated to header wiring.

If the implementer prefers a tighter narrowing than the `as unknown as SaivageConfig` cast (for example, because `SaivageConfig` has many required nested fields beyond what this fixture supplies), an equivalent option is to use `ConstructorParameters<typeof ModelRouter>[0]` instead; both compile against the actual constructor signature.

#### New test 3: auth-level (new file `src/auth/github-copilot.test.ts`)

```ts
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
```

This test fails if `refreshGitHubCopilotToken` does not propagate the override into the token-exchange `fetch` headers.

### Step 9 — Validation commands

Run in `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/providers/copilot.test.ts
npx vitest run src/providers/copilot-router.test.ts
npx vitest run src/auth/github-copilot.test.ts
npx vitest run src/config.test.ts
npx vitest run                # full suite as the final gate
```

All seven are expected green. `npm run build` is required because `tsup` produces `dist/` consumed by deployed runtimes.

### Step 10 — Manual smoke (optional, only if a Copilot account is configured)

With a valid Copilot auth profile in `.saivage/`:

```bash
node dist/cli.js model-test github-copilot/claude-sonnet-4.6 "say hi"
```

If upstream still accepts baked defaults, this returns a normal response. To exercise the override path, edit `.saivage/saivage.json`:

```jsonc
{
  "providers": {
    "github-copilot": {
      "headers": {
        "User-Agent": "GitHubCopilotChat/<new>",
        "Editor-Version": "vscode/<new>",
        "Editor-Plugin-Version": "copilot-chat/<new>"
      }
    }
  }
}
```

…restart the runtime and re-run. No source change required — that is the substantive F21 deliverable, and it now covers both the chat path and the OAuth refresh path.

## Rollback

Single commit. `git revert <sha>` restores both `COPILOT_HEADERS` literals, the `ANTHROPIC_API_MODELS` Set, the two inline User-Agent strings, the original `OAuthProviderDef` signature, the original `getOAuthApiKey` signature, the original `refreshGitHubCopilotToken(token, enterpriseDomain?)` signature, and removes the new `copilot-client-headers.ts`, the new schema field, and the three new test cases. No data migration. No config migration — the new `headers` field is optional and silently ignored on revert.
