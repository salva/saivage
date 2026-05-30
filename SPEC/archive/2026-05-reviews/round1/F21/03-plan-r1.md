# F21 r1 — Plan (Proposal A)

Single-commit, easy revert. Implements the focused fix: one `DEFAULT_COPILOT_HEADERS` source, optional `providers["github-copilot"].headers` override, deletes the duplicate constants and the dead `ANTHROPIC_API_MODELS` Set.

## Cross-issue ordering

- **Independent of F11** (magic constants generally). F11 may later move other constants into a shared module; F21 does not block or get blocked by it.
- **Independent of F19** (provider barrel). The new `copilot-client-headers.ts` is imported directly from `copilot.ts` and `github-copilot.ts`, not from the barrel.
- **Independent of F15** (OAuth token resolution overlap). F15 will rework how `auth/github-copilot.ts` is invoked; this plan only edits the *bodies* of `refreshGitHubCopilotToken`, `loginGitHubCopilot`, `startDeviceFlow`, `pollForAccessToken`, leaving their invocation contracts compatible with whatever F15 does next.
- **Independent of F32** (saivage-config undocumented blocks). F32 will document `SaivageConfig` shape; F21 adds one new optional field that F32 can pick up.

## Step-by-step edits

### Step 1 — Create the shared header module

New file `src/providers/copilot-client-headers.ts`:

```ts
// Default impersonation headers presented to GitHub Copilot endpoints.
// These can be overridden per-deployment via
//   .saivage/saivage.json -> providers["github-copilot"].headers
// to recover from upstream client-version tightening without rebuilding.

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

In [src/routing/resolver.ts](src/routing/resolver.ts#L37-L52), add one field to `runtimeProviderAccountSchema`:

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

And add the matching field to `RuntimeProviderAccountLike` interface:

```ts
export interface RuntimeProviderAccountLike {
  apiKey?: string;
  baseUrl?: string;
  authProfile?: string;
  priority?: number;
  models?: string[];
  headers?: Record<string, string>;
  quota?: { /* unchanged */ };
}
```

`runtimeProviderConfigSchema` and `RuntimeProviderConfigLike` inherit the field automatically (they extend the account schema/interface).

### Step 3 — Refactor `src/providers/copilot.ts`

1. **Remove** the local `COPILOT_HEADERS` literal at [src/providers/copilot.ts](src/providers/copilot.ts#L33-L39).
2. **Remove** the `ANTHROPIC_API_MODELS` Set at [src/providers/copilot.ts](src/providers/copilot.ts#L60-L70) (including its preceding docstring).
3. **Simplify** `isAnthropicModel` at [src/providers/copilot.ts](src/providers/copilot.ts#L72-L74) to:
   ```ts
   function isAnthropicModel(model: string): boolean {
     return model.startsWith("claude-");
   }
   ```
4. **Import** at the top of the file:
   ```ts
   import { resolveCopilotHeaders } from "./copilot-client-headers.js";
   ```
5. **Rewire** `createCopilotFetch` to close over a resolved header set instead of the module-level constant. Change its signature from `createCopilotFetch(apiKey: string)` to `createCopilotFetch(apiKey: string, headers: Record<string, string>)`. Inside, replace `Object.entries(COPILOT_HEADERS)` (around [L102-L106](src/providers/copilot.ts#L102-L106)) with `Object.entries(headers)`.
6. **Rewire** `CopilotProvider.setApiKey`:
   - Add a `private headers: Record<string, string> = { ...DEFAULT_COPILOT_HEADERS }`-style field (resolved lazily in `setApiKey`).
   - Change signature to `setApiKey(apiKey: string, headerOverride?: Record<string, string>): void`.
   - Compute `this.headers = resolveCopilotHeaders(headerOverride)` first thing.
   - Use `this.headers` for the OpenAI client `defaultHeaders` ([L142](src/providers/copilot.ts#L142)), the Anthropic client `defaultHeaders` ([L149](src/providers/copilot.ts#L149)), and the `createCopilotFetch(apiKey, this.headers)` calls ([L143](src/providers/copilot.ts#L143) and [L150](src/providers/copilot.ts#L150)).
7. **Rewire** `fetchModels` at [src/providers/copilot.ts](src/providers/copilot.ts#L193-L197): replace `...COPILOT_HEADERS` with `...this.headers`.
8. **Wire the constructor** so the route layer can pass overrides through. Change the constructor from `constructor(apiKey?: string)` to `constructor(apiKey?: string, headerOverride?: Record<string, string>)` and forward both to `setApiKey`.

### Step 4 — Refactor `src/auth/github-copilot.ts`

1. **Remove** the local `COPILOT_HEADERS` literal at [src/auth/github-copilot.ts](src/auth/github-copilot.ts#L17-L22).
2. **Replace** the two inline `"User-Agent": "GitHubCopilotChat/0.35.0"` strings at [L80](src/auth/github-copilot.ts#L80) and [L134](src/auth/github-copilot.ts#L134) with a `headers.["User-Agent"]` lookup against a resolved set.
3. **Thread overrides** through:
   - `startDeviceFlow(domain: string, headers: Record<string, string>)`.
   - `pollForAccessToken(domain, deviceCode, intervalSeconds, expiresIn, headers)`.
   - `refreshGitHubCopilotToken(githubToken: string, options?: { enterpriseDomain?: string; headerOverride?: Record<string, string> })`.
   - `loginGitHubCopilot(callbacks: OAuthLoginCallbacks, options?: { headerOverride?: Record<string, string> })`.
4. **Inside each** of those functions, compute `const headers = resolveCopilotHeaders(options?.headerOverride)` once, then pass to inner helpers. The two device-flow URL-encoded `POST`s only need `headers["User-Agent"]` plus their explicit `Content-Type`/`Accept`; the token-exchange `fetch` at [L175-L181](src/auth/github-copilot.ts#L175-L181) spreads the full `headers` object.
5. **`githubCopilotOAuthProvider`** at the bottom of the file: its `login` and `refreshToken` continue to take no extra parameters; the caller wraps it with a closure if overrides are needed. The body simply does `loginGitHubCopilot(callbacks)` / `refreshGitHubCopilotToken(credentials.refresh)` with no overrides (i.e. defaults). Production wiring can pass overrides in a follow-up pass once F15 lands.

> Note: per Proposal A's wiring decision, the OAuth `Def` interface signature stays unchanged. The `auth` functions themselves accept optional overrides for testability and for the eventual F15 caller, but `githubCopilotOAuthProvider` itself is a thin wrapper that omits them. This keeps the OAuth registry shape stable.

### Step 5 — Tests

#### Existing tests that already cover this code path

- [src/providers/copilot.test.ts](src/providers/copilot.test.ts) — must continue to pass unchanged. The current assertions on `Authorization` and `X-Initiator` remain valid. Re-run as a regression gate.
- [src/config.test.ts](src/config.test.ts#L54-L55) — exercises `config.providers["github-copilot"]`. Add no new assertions here; the new `headers` field is optional and absent from the existing fixture, so the schema must continue to parse the same fixture without it.

#### New tests (in `src/providers/copilot.test.ts`)

Add two new `it(...)` cases in the same `describe("CopilotProvider", ...)`:

1. **"sends default Copilot client headers when no override is configured"** — `vi.stubGlobal("fetch", fetchMock)`, build a `new CopilotProvider("tid=test;proxy-ep=proxy.example.test;exp=9999999999;")`, dispatch a `claude-sonnet-4.6` chat, then assert the captured `init.headers` has `User-Agent` matching `/^GitHubCopilotChat\//`, `Editor-Version` matching `/^vscode\//`, `Editor-Plugin-Version` matching `/^copilot-chat\//`, `Copilot-Integration-Id === "vscode-chat"`, `Openai-Intent === "conversation-edits"`. Use regex / non-exact equality so this test does not need to be updated when the baked default version strings bump.
2. **"applies operator header overrides on top of defaults"** — same setup but construct with `new CopilotProvider("tid=...;proxy-ep=proxy.example.test;...", { "Editor-Version": "vscode/9.99.0", "User-Agent": "GitHubCopilotChat/9.99.0" })`. Assert the captured `init.headers` has those exact two override values and that `Copilot-Integration-Id` is still the default `vscode-chat`.

No new test file is needed for `auth/github-copilot.ts`: those code paths are exercised only at OAuth login time and currently have no unit tests; adding one is out of scope for F21 (a separate concern would be F15-OAuth-token-resolution-overlap). The functions are simple enough that the type system + the new `resolveCopilotHeaders` helper covers correctness, and the regression risk reduces to "do the imports compile".

### Step 6 — Validation commands

Run in `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/providers/copilot.test.ts
npx vitest run src/config.test.ts
npx vitest run                # full suite as the final gate
```

All four are expected green. The build step is required because `tsup` produces `dist/` consumed by the deployed runtime.

### Step 7 — Manual smoke (optional, only if a Copilot account is configured)

Optional, not part of CI. With a valid Copilot auth profile present in `.saivage/`:

```bash
node dist/cli.js model-test github-copilot/claude-sonnet-4.6 "say hi"
```

If the upstream still accepts our baked defaults, this returns a normal response. If it has tightened, the operator can now edit `.saivage/saivage.json`:

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

…restart the runtime, and re-run the smoke. No source change required — which is the substantive F21 deliverable.

## Rollback

Single commit. `git revert <sha>` restores both `COPILOT_HEADERS` literals, the `ANTHROPIC_API_MODELS` Set, the two inline User-Agent strings, and removes the new `copilot-client-headers.ts`, the new schema field, and the two new tests. No data migration. No config migration (the new `headers` field is optional and silently ignored on revert).
