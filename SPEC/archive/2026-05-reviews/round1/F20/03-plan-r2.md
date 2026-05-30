# F20 — Plan (r2)

For Proposal B (RECOMMENDED): per-model `ModelCapabilities` record. `BaseProvider.countTokens` (introduced by F07) reads its encoding from `modelCapabilities`; F07's per-provider `countTokens` overrides are deleted. `PiAiProvider.modelCapabilities` preserves F07 step 5h's live encoding switch. `defaultContextWindow` lives on `runtimeProviderConfigSchema`.

## Changes from r1

1. **Step 1**: keep `ModelProvider.countTokens` on the interface; only remove `maxContextTokens`.
2. **Step 2**: `BaseProvider.countTokens` body becomes a one-liner that reads `tokenEncoding` from `modelCapabilities`; the `?? "cl100k_base"` fallback is intentional (hot-loop graceful, in contrast to the boot-time loud failure at the `getMaxContextTokens` boundary). Per-provider `countTokens` overrides from F07 are deleted by Step 3.
3. **Step 3 (PiAiProvider)**: `modelCapabilities` switches on `this.piProvider` first, then on model id — same five-case shape as F07 step 5h, now hosting the encoding selection.
4. **Step 4 (router seam)**: documents the `createProvider` injection of `defaultContextWindow` into `OllamaProvider`/`LlamaCppProvider`.
5. **Step 5 (schema)**: moves `defaultContextWindow` from `[src/config.ts](../../../src/config.ts)` to `[src/routing/resolver.ts](../../../src/routing/resolver.ts)` (`runtimeProviderConfigSchema` + `RuntimeProviderConfigLike`).
6. **Step 6 (tests)**: adds dedicated cases for the live-router PiAi paths (`openai/gpt-5*`, `openai-codex/gpt-5*`, `anthropic/claude-*`, `opencode/*`, `opencode-go/*`) at both the direct-class layer (`pi-ai.test.ts`) and the router layer (`router.test.ts`), pinning both `contextWindow` and the encoding that `BaseProvider.countTokens` selects via `vi.spyOn(tokenCounting, "countWithTiktoken")`.

## Cross-issue ordering

- **F07 (APPROVED, Proposal B)** lands first. It introduces `ModelProvider.countTokens`, `BaseProvider.countTokens` default, per-provider overrides 5a–5h, `ModelRouter.countTokens`, and the `BaseAgent` running-token counter.
- **F20** lands second. It (a) replaces `maxContextTokens` with `modelCapabilities`, (b) rewrites `BaseProvider.countTokens`'s body to read encoding from `modelCapabilities`, and (c) deletes F07's per-provider `countTokens` overrides (5a–5h). Net: encoding selection lives in one place per provider.
- **F04 (APPROVED)** is already landed; F20 preserves its invariant (no model identifiers outside `src/providers/`).

If F20 lands first by accident, F07's plan adapts trivially: skip its steps 5a–5h, keep step 4 (which already reads encoding via `modelCapabilities` once F20 has provided that accessor).

## Edit steps

### Step 1 — Add `ModelCapabilities` to the provider contract

1. Edit [src/providers/types.ts](../../../src/providers/types.ts#L83-L98):
   - Add the exported `ModelCapabilities` interface:
     ```ts
     export interface ModelCapabilities {
       contextWindow: number;
       tokenEncoding: "cl100k_base" | "o200k_base";
     }
     ```
   - On `ModelProvider`: replace `maxContextTokens(model: string): number;` with `modelCapabilities(model: string): ModelCapabilities | undefined;`.
   - **Keep** the F07-added `countTokens(model, messages, system?, tools?): number;` exactly as F07 step 3 specifies.

### Step 2 — Rewrite `BaseProvider`

1. Edit [src/providers/base.ts](../../../src/providers/base.ts#L1-L34):
   - Remove `maxContextTokens(_model)` entirely.
   - Declare `abstract modelCapabilities(model: string): ModelCapabilities | undefined;` (concrete classes implement it; `ModelProvider` already mandates it).
   - Rewrite F07's `BaseProvider.countTokens` default body to:
     ```ts
     countTokens(model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
       const encoding = this.modelCapabilities(model)?.tokenEncoding ?? "cl100k_base";
       return countWithTiktoken(messages, system, tools, encoding);
     }
     ```
   - The `?? "cl100k_base"` fallback is intentional: `countTokens` runs in the hot `pushMessage` loop ([SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md#L173-L203)); throwing here would crash a live conversation on an unknown model. The boot-time loud failure path is the `getMaxContextTokens` boundary (Step 4).

### Step 3 — Rewrite each provider

For each provider, replace `maxContextTokens` with `modelCapabilities`, and **delete F07's `countTokens` override** if F07 has already landed.

1. [src/providers/anthropic.ts](../../../src/providers/anthropic.ts#L109-L114):
   ```ts
   const MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
     [/^claude-(?:3|3-5|3\.5)-/, { contextWindow: 200_000, tokenEncoding: "cl100k_base" }],
     [/^claude-(?:sonnet|opus|haiku)-4/, { contextWindow: 200_000, tokenEncoding: "cl100k_base" }],
   ];
   modelCapabilities(model: string): ModelCapabilities | undefined {
     for (const [pattern, caps] of MODEL_CAPABILITIES) if (pattern.test(model)) return caps;
     return undefined;
   }
   ```
   Delete the four dead `if includes()` branches in `maxContextTokens`. Delete F07's `countTokens` override (5d).

2. [src/providers/openai.ts](../../../src/providers/openai.ts#L148-L153):
   ```ts
   const MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
     [/^gpt-5/, { contextWindow: 400_000, tokenEncoding: "o200k_base" }],
     [/^o[134]/, { contextWindow: 200_000, tokenEncoding: "o200k_base" }],
     [/^gpt-4o/, { contextWindow: 128_000, tokenEncoding: "o200k_base" }],
     [/^gpt-4/, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
     [/^gpt-3\.5/, { contextWindow: 16_385, tokenEncoding: "cl100k_base" }],
   ];
   ```
   Same accessor shape as anthropic. Delete F07's `countTokens` override (5a).

3. [src/providers/openai-codex.ts](../../../src/providers/openai-codex.ts#L374-L379):
   ```ts
   const MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
     [/^gpt-5/, { contextWindow: 200_000, tokenEncoding: "o200k_base" }],
     [/^o[134]/, { contextWindow: 200_000, tokenEncoding: "o200k_base" }],
     [/^gpt-4o/, { contextWindow: 128_000, tokenEncoding: "o200k_base" }],
     [/^gpt-4/, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
   ];
   ```
   Delete F07's `countTokens` override (5b).

4. [src/providers/openrouter.ts](../../../src/providers/openrouter.ts#L16-L18):
   ```ts
   const MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
     [/^openai\/gpt-5/, { contextWindow: 400_000, tokenEncoding: "o200k_base" }],
     [/^openai\/o[134]/, { contextWindow: 200_000, tokenEncoding: "o200k_base" }],
     [/^openai\/gpt-4o/, { contextWindow: 128_000, tokenEncoding: "o200k_base" }],
     [/^anthropic\/claude-/, { contextWindow: 200_000, tokenEncoding: "cl100k_base" }],
     [/^google\/gemini-1\.5/, { contextWindow: 1_000_000, tokenEncoding: "cl100k_base" }],
     [/^google\/gemini-2/, { contextWindow: 2_000_000, tokenEncoding: "cl100k_base" }],
     [/^meta-llama\/llama-3\.1-(?:70b|8b)/, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
   ];
   ```
   `OpenRouterProvider` has no `countTokens` override under F07 (5g says "no file change"); only the `MODEL_CAPABILITIES` table is added here.

5. [src/providers/ollama.ts](../../../src/providers/ollama.ts#L17-L19) and [src/providers/llamacpp.ts](../../../src/providers/llamacpp.ts#L21-L23):
   - Constructors gain an optional `defaultContextWindow?: number` parameter and store it as a private field.
   - `MODEL_CAPABILITIES` table covers upstream-known weights (`llama3.1:70b`, `qwen2.5:32b`, etc.) with `tokenEncoding: "cl100k_base"`.
   - On miss, return `{ contextWindow: this.defaultContextWindow, tokenEncoding: "cl100k_base" }` if `this.defaultContextWindow` is set; otherwise `undefined`.
   - Delete F07's `countTokens` overrides (5e, 5f). The pinned `cl100k_base` choice is preserved by the table and the fallback.

6. [src/providers/copilot.ts](../../../src/providers/copilot.ts#L473-L483):
   ```ts
   modelCapabilities(model: string): ModelCapabilities | undefined {
     const metadata = this.getCachedModelMetadata(model);
     const contextWindow = metadata?.capabilities?.limits?.max_context_window_tokens;
     if (!contextWindow) return undefined;
     const tokenEncoding: "cl100k_base" | "o200k_base" =
       /^(gpt-5|o1|o3|o4)/.test(model) ? "o200k_base" : "cl100k_base";
     return { contextWindow, tokenEncoding };
   }
   ```
   Delete the keyword-fallback `if includes()` branches and F07's `countTokens` override (5c).

7. [src/providers/pi-ai.ts](../../../src/providers/pi-ai.ts#L270-L273):
   - F07 step 5h promotes `private piProvider` to `private readonly piProvider` (no extra visibility change in F20).
   - Delete F07's `countTokens` override and its `encodingFor` helper (5h).
   - Add:
     ```ts
     modelCapabilities(model: string): ModelCapabilities | undefined {
       const resolved = this.resolveModel(model);
       if (!resolved?.contextWindow) return undefined;
       return {
         contextWindow: resolved.contextWindow,
         tokenEncoding: this.encodingFor(model),
       };
     }

     private encodingFor(model: string): "cl100k_base" | "o200k_base" {
       switch (this.piProvider) {
         case "openai":
         case "openai-codex":
           return /^(gpt-5|o1|o3|o4)/.test(model) ? "o200k_base" : "cl100k_base";
         case "anthropic":
         case "opencode":
         case "opencode-go":
         default:
           return "cl100k_base";
       }
     }
     ```
   - Delete the `?? 128_000` fallback from the old `maxContextTokens` body.

### Step 4 — Rewrite the router seam

1. Edit [src/providers/router.ts](../../../src/providers/router.ts#L245-L258) `getMaxContextTokens`:
   ```ts
   getMaxContextTokens(modelSpec: string): number {
     const parsed = tryParseModelId(modelSpec);
     let providerName: string;
     let model: string;
     let candidateAccount: string | undefined;
     if (parsed) {
       providerName = parsed.provider;
       model = parsed.model;
     } else {
       const candidate = this.buildCandidateChain(modelSpec)[0];
       if (!candidate) throw new Error(`router: cannot resolve modelSpec "${modelSpec}"`);
       const parts = parseModelId(candidate.spec);
       providerName = parts.provider;
       model = parts.model;
       candidateAccount = candidate.accountRef;
     }
     const provider = this.getProviderForRequest(
       providerName,
       candidateAccount ? { accountRef: candidateAccount } : undefined,
     );
     const caps = provider?.modelCapabilities(model);
     if (!caps) {
       throw new Error(
         `router: no context window for "${modelSpec}" (provider ${providerName}) — ` +
         `add an entry to MODEL_CAPABILITIES in src/providers/${providerName}.ts or set ` +
         `providers.${providerName}.defaultContextWindow in the runtime config.`,
       );
     }
     return caps.contextWindow;
   }
   ```
   Delete both `?? 200_000` fallbacks.

2. Edit `createProvider` at [src/providers/router.ts](../../../src/providers/router.ts#L720-L757):
   ```ts
   case "ollama":
     return new OllamaProvider(baseUrl, providerConfig?.defaultContextWindow);
   case "llamacpp":
     return new LlamaCppProvider(
       baseUrl ?? process.env["LLAMACPP_BASE_URL"],
       providerConfig?.defaultContextWindow,
     );
   ```
   `providerConfig` is already in scope at [src/providers/router.ts](../../../src/providers/router.ts#L722-L723). No other provider arm changes.

3. F07's `ModelRouter.countTokens` ([SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md#L130-L148)) needs no edit by F20. It continues to call `provider?.countTokens(...)`; `BaseProvider.countTokens` now reads the encoding from `modelCapabilities`.

### Step 5 — Extend the runtime provider schema

1. Edit [src/routing/resolver.ts](../../../src/routing/resolver.ts#L51-L73):
   ```ts
   export const runtimeProviderConfigSchema = runtimeProviderAccountSchema.extend({
     defaultAccount: z.string().optional(),
     accounts: z.record(z.string(), runtimeProviderAccountSchema).default({}),
     defaultContextWindow: z.number().optional(),
   });
   ```
   ```ts
   export interface RuntimeProviderConfigLike extends RuntimeProviderAccountLike {
     defaultAccount?: string;
     accounts?: Record<string, RuntimeProviderAccountLike | undefined>;
     defaultContextWindow?: number;
   }
   ```

2. No change to [src/config.ts](../../../src/config.ts#L51): `providers: z.record(z.string(), runtimeProviderConfigSchema)` already wires the extended schema. The field is implicitly available on every provider entry; the router only reads it for `ollama` / `llamacpp`.

### Step 6 — Update existing tests

1. [src/providers/router.test.ts](../../../src/providers/router.test.ts#L172-L175): rewrite `maxContextTokens: () => 111`/`222` stubs to `modelCapabilities: () => ({ contextWindow: 111, tokenEncoding: "cl100k_base" })` / `222`. `expect(router.getMaxContextTokens("shared-model")).toBe(222);` still holds.
2. [src/providers/router.test.ts](../../../src/providers/router.test.ts#L464): same rewrite for the `200_000` stub.
3. F07's `src/providers/pi-ai.test.ts` (introduced by F07 step 9h): update the eight cases. Each now spies on `countWithTiktoken` from `src/runtime/token-counting.ts` (the same spy F07 step 9 establishes) and asserts that `PiAiProvider("X").countTokens(model, …)` results in the spy seeing the expected encoding — the override is gone, the encoding comes from `modelCapabilities` via `BaseProvider.countTokens`. No assertion text changes; only the comment explaining the path changes.
4. F07's per-provider test files (`openai.test.ts`, `anthropic.test.ts`, `ollama.test.ts`, `llamacpp.test.ts`, `openrouter.test.ts`, `copilot.test.ts`): update the same way as item 3 — the spy point is unchanged; only the override path is.
5. F07's `src/providers/router.test.ts` cases for `router.countTokens(...)` (step 9i): unchanged. They assert end-to-end resolution through the live class; the encoding still arrives at `countWithTiktoken` via the new path.
6. Tests at [src/agents/agents.test.ts](../../../src/agents/agents.test.ts#L95-L310) stub `router.getMaxContextTokens` directly — **no change needed**.
7. [src/agents/base.compaction.test.ts](../../../src/agents/base.compaction.test.ts#L75) and [src/agents/conversation-snapshot.test.ts](../../../src/agents/conversation-snapshot.test.ts#L91): same — stub `getMaxContextTokens` and need no change.

### Step 7 — Add focused unit tests

New file `src/providers/model-capabilities.test.ts`:

1. **Per-provider direct-class table coverage.** For each provider (anthropic, openai, openai-codex, openrouter, ollama, llamacpp, copilot, pi-ai), assert:
   - Known model strings return the expected `{ contextWindow, tokenEncoding }`.
   - Unknown model strings return `undefined` (or, for ollama/llamacpp with a `defaultContextWindow` set, return that window with `cl100k_base`).

2. **Live-router PiAi cases (the load-bearing live-runtime coverage).** With a real router and `PiAiProvider` registrations:
   - `router.getMaxContextTokens("openai/gpt-5-foo")` returns the `gpt-5` window resolved via `PiAiProvider("openai").modelCapabilities("gpt-5-foo")` (sourced from the pi-ai registry).
   - `router.getMaxContextTokens("openai-codex/gpt-5-codex")` returns the codex `gpt-5` window via `PiAiProvider("openai-codex").modelCapabilities`.
   - `router.getMaxContextTokens("anthropic/claude-3.5-sonnet")` returns the Claude window via `PiAiProvider("anthropic").modelCapabilities`.
   - `router.getMaxContextTokens("opencode/moonshotai/kimi-…")` and `router.getMaxContextTokens("opencode-go/zhipuai/glm-…")` return the registry-resolved windows.
   - For each of the above, spy on `countWithTiktoken` from `src/runtime/token-counting.ts` and call `router.countTokens(modelSpec, [{ role: "user", content: "hi" }])`; assert the encoding fourth argument:
     - `openai/gpt-5-foo` → `o200k_base`
     - `openai/gpt-4o-foo` → `cl100k_base`
     - `openai-codex/gpt-5-codex` → `o200k_base`
     - `openai-codex/gpt-4o-codex` → `cl100k_base`
     - `anthropic/claude-3.5-sonnet` → `cl100k_base`
     - `anthropic/claude-sonnet-4-20250514` → `cl100k_base`
     - `opencode/moonshotai/kimi-k2.5` → `cl100k_base`
     - `opencode-go/zhipuai/glm-4` → `cl100k_base`

3. **Router throw test:** construct a router with a provider whose `modelCapabilities` always returns `undefined`. Call `getMaxContextTokens("provider/unknown-model")`. Expect an `Error` whose message includes `"unknown-model"` and `"MODEL_CAPABILITIES"` and `"defaultContextWindow"`.

4. **`countTokens` graceful fallback test:** with the same always-undefined provider, call `router.countTokens("provider/unknown-model", [{ role: "user", content: "hi" }])`. Spy on `countWithTiktoken`; assert it was called with `"cl100k_base"` (no throw).

5. **OpenRouter prefix sensitivity:**
   - `modelCapabilities("openai/gpt-5-2025-09-01")` → `{ contextWindow: 400_000, tokenEncoding: "o200k_base" }`.
   - `modelCapabilities("anthropic/claude-3.5-sonnet-20250514")` → `{ contextWindow: 200_000, tokenEncoding: "cl100k_base" }`.
   - `modelCapabilities("anthropic/claude-9-future")` → `undefined`.

6. **`defaultContextWindow` injection for ollama/llamacpp:**
   - Construct `new OllamaProvider(undefined, 32_768)`. Assert `modelCapabilities("unknown-local-weight")` returns `{ contextWindow: 32_768, tokenEncoding: "cl100k_base" }`.
   - Construct `new OllamaProvider(undefined)`. Assert `modelCapabilities("unknown-local-weight")` returns `undefined`.
   - End-to-end: build a `ModelRouter` with `providerConfigs: { ollama: { defaultContextWindow: 32_768 } }`; assert `router.getMaxContextTokens("ollama/unknown-local-weight")` returns `32_768`.
   - Same two checks for `LlamaCppProvider`.

## Validation commands

Run from `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/providers/model-capabilities.test.ts
npx vitest run src/providers/router.test.ts src/providers/pi-ai.test.ts
npx vitest run src/providers/openai.test.ts src/providers/anthropic.test.ts src/providers/ollama.test.ts src/providers/llamacpp.test.ts src/providers/openrouter.test.ts src/providers/copilot.test.ts
npx vitest run src/agents/agents.test.ts src/agents/base.compaction.test.ts src/agents/conversation-snapshot.test.ts
npx vitest run
```

Expected: zero compile errors; the new test file passes; F07's tests pass with the spy-based encoding assertions unchanged.

## Rollback strategy

Single commit. Revert restores `maxContextTokens` on every provider, F07's per-provider `countTokens` overrides, the `?? 200_000` router fallbacks, and the original `OllamaProvider`/`LlamaCppProvider` one-arg constructors. The `defaultContextWindow` field on `runtimeProviderConfigSchema` is optional and unread by other code, so reverting is safe even if operators wrote it to disk — Zod will accept and the field will simply be ignored.

## Out of scope (deliberately deferred)

- Re-evaluating `compactionConfig.contextWindow` after a router failover swaps the active model. The current code caches the original `modelSpec`'s window for the agent's lifetime; that gap is downstream of F20 and would belong in a follow-up issue.
- Operator UI exposing the resolved context window in the SPA. Not consumed today.
- Vendor-native token counters (Anthropic's `/v1/messages/count_tokens`, OpenAI's tokenizer endpoint). F07 commits to `js-tiktoken` workspace-wide; vendor RTT regressions are not acceptable on the compaction hot path.
