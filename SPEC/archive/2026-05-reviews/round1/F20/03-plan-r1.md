# F20 — Plan (r1)

For Proposal B (RECOMMENDED): per-model `ModelCapabilities` record, replacing both `maxContextTokens` and F07's `countTokens` per-provider model-name switch.

## Cross-issue ordering note

- **F07 (APPROVED, Proposal B)** introduces `ModelProvider.countTokens` and `src/runtime/token-counting.ts`. F20 *replaces* F07's per-provider model-name encoding switch with a shared `modelCapabilities` record.
- **Preferred order**: land F07 first, then F20. F20's step 2 then becomes "collapse the encoding switch that F07 just planted in each provider".
- **If F20 lands first**: F07's plan trivially adapts — F07 keeps `countTokens` as a provider method but its body simply calls `this.modelCapabilities(model)?.tokenEncoding` directly. Either order is workable.
- **F04 (APPROVED)** is already landed; F20 preserves its invariant (no model identifiers outside `src/providers/`).

## Edit steps

### Step 1 — Add `ModelCapabilities` to the provider contract

1. Edit [src/providers/types.ts](src/providers/types.ts#L83-L98):
   - Add the exported `ModelCapabilities` interface:
     ```ts
     export interface ModelCapabilities {
       contextWindow: number;
       tokenEncoding: "cl100k_base" | "o200k_base";
     }
     ```
   - On `ModelProvider`: replace `maxContextTokens(model: string): number;` with `modelCapabilities(model: string): ModelCapabilities | undefined;`.
   - If F07 has already landed, remove the `countTokens(...)` method from the interface signature here too — its implementation in `BaseProvider` now derives encoding from `modelCapabilities`.

### Step 2 — Rewrite `BaseProvider`

1. Edit [src/providers/base.ts](src/providers/base.ts#L1-L34):
   - Remove `maxContextTokens(_model)` entirely.
   - Make `modelCapabilities(model: string): ModelCapabilities | undefined` `abstract` (or remove from `BaseProvider`; concrete classes are mandated to declare it by `ModelProvider`).
   - If F07 already provided a `countTokens` default body, rewrite it to:
     ```ts
     countTokens(model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
       const caps = this.modelCapabilities(model);
       if (!caps) throw new Error(`unknown model "${this.name}/${model}"`);
       return countWithTiktoken(messages, system, tools, caps.tokenEncoding);
     }
     ```

### Step 3 — Rewrite each provider's per-model table

For each of the eight provider files, replace `maxContextTokens` (and the per-model encoding switch F07 planted in OpenAI-style providers, if F07 already landed) with a single `MODEL_CAPABILITIES` table + `modelCapabilities(model)` accessor. Patterns:

1. [src/providers/anthropic.ts](src/providers/anthropic.ts#L109-L114):
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
   Delete the four dead `if includes()` branches.

2. [src/providers/openai.ts](src/providers/openai.ts#L148-L153):
   ```ts
   const MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
     [/^gpt-5/, { contextWindow: 400_000, tokenEncoding: "o200k_base" }],
     [/^o[134]/, { contextWindow: 200_000, tokenEncoding: "o200k_base" }],
     [/^gpt-4o/, { contextWindow: 128_000, tokenEncoding: "o200k_base" }],
     [/^gpt-4/, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
     [/^gpt-3\.5/, { contextWindow: 16_385, tokenEncoding: "cl100k_base" }],
   ];
   ```
   Delete `maxContextTokens` body. Delete F07's encoding switch if present.

3. [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L374-L379): mirror Proposal-A's table, but `gpt-5*` → `200_000` (codex tier is genuinely capped lower than vanilla OpenAI for the codex SKU at time of writing) + `o200k_base`; `gpt-4o*` → `128_000` + `o200k_base`; `gpt-4*` → `128_000` + `cl100k_base`. Delete the fallthrough `return 128_000`.

4. [src/providers/openrouter.ts](src/providers/openrouter.ts#L16-L18):
   ```ts
   const MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]> = [
     // Model strings are vendor-prefixed: "openai/gpt-4o", "anthropic/claude-3.5-sonnet", "google/gemini-1.5-pro", ...
     [/^openai\/gpt-5/, { contextWindow: 400_000, tokenEncoding: "o200k_base" }],
     [/^openai\/o[134]/, { contextWindow: 200_000, tokenEncoding: "o200k_base" }],
     [/^openai\/gpt-4o/, { contextWindow: 128_000, tokenEncoding: "o200k_base" }],
     [/^anthropic\/claude-/, { contextWindow: 200_000, tokenEncoding: "cl100k_base" }],
     [/^google\/gemini-1\.5/, { contextWindow: 1_000_000, tokenEncoding: "cl100k_base" }],
     [/^google\/gemini-2/, { contextWindow: 2_000_000, tokenEncoding: "cl100k_base" }],
     [/^meta-llama\/llama-3\.1-(?:70b|8b)/, { contextWindow: 128_000, tokenEncoding: "cl100k_base" }],
   ];
   ```
   Add additional rows as the project adds models to its routing config — the throw in step 6 makes the requirement loud at boot.

5. [src/providers/ollama.ts](src/providers/ollama.ts#L17-L19) and [src/providers/llamacpp.ts](src/providers/llamacpp.ts#L21-L23):
   - Operator-loadable arbitrary weights. The table only covers the upstream-known model strings (`llama3.1:70b`, `qwen2.5:32b`, ...).
   - For unknown model strings, return a capabilities record derived from an optional `SaivageConfig.providers.{ollama,llamacpp}.defaultContextWindow` field. When unset, `modelCapabilities` returns `undefined` and the router throws.
   - This is the *only* config-side addition for F20. Add the field to [src/config.ts](src/config.ts) inside the `providers` block, optional, no default. Two providers, one field — under the "abstraction used once" threshold.

6. [src/providers/copilot.ts](src/providers/copilot.ts#L473-L483):
   - Body becomes:
     ```ts
     modelCapabilities(model: string): ModelCapabilities | undefined {
       const metadata = this.getCachedModelMetadata(model);
       const contextWindow = metadata?.capabilities?.limits?.max_context_window_tokens;
       if (!contextWindow) return undefined;
       const tokenEncoding = /^gpt-5|^o[134]/.test(model) ? "o200k_base" : "cl100k_base";
       return { contextWindow, tokenEncoding };
     }
     ```
   - Delete the keyword-fallback `if includes()` branches. If metadata is missing, the throw at the router boundary is the correct failure.

7. [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L270-L273):
   - Body becomes:
     ```ts
     modelCapabilities(model: string): ModelCapabilities | undefined {
       const m = this.resolveModel(model);
       if (!m?.contextWindow) return undefined;
       return { contextWindow: m.contextWindow, tokenEncoding: "cl100k_base" };
     }
     ```
   - Delete the `?? 128_000` fallback.

### Step 4 — Rewrite the router seam

1. Edit [src/providers/router.ts](src/providers/router.ts#L245-L258):
   - Rename the seam: `getMaxContextTokens(modelSpec: string): number` stays (it is what `BaseAgent` consumes; do not rename, that would be churn). Its body becomes:
     ```ts
     getMaxContextTokens(modelSpec: string): number {
       const parsed = tryParseModelId(modelSpec);
       const candidate = parsed ? null : this.buildCandidateChain(modelSpec)[0];
       const spec = parsed ? modelSpec : candidate?.spec;
       if (!spec) throw new Error(`router: cannot resolve modelSpec "${modelSpec}"`);
       const { provider: providerName, model } = parseModelId(spec);
       const provider = this.getProviderForRequest(providerName, candidate ? { accountRef: candidate.accountRef } : undefined);
       const caps = provider?.modelCapabilities(model);
       if (!caps) throw new Error(`router: no contextWindow for "${modelSpec}" (provider ${providerName}) — add an entry to MODEL_CAPABILITIES`);
       return caps.contextWindow;
     }
     ```
   - Delete both `?? 200_000` fallbacks.

### Step 5 — Update tests

1. [src/providers/router.test.ts](src/providers/router.test.ts#L172-L175): replace `maxContextTokens: () => 111` / `222` with `modelCapabilities: () => ({ contextWindow: 111, tokenEncoding: "cl100k_base" })` / `222`. `expect(router.getMaxContextTokens("shared-model")).toBe(222);` still holds.
2. [src/providers/router.test.ts](src/providers/router.test.ts#L464): same rewrite for the `200_000` stub.
3. Tests at [src/agents/agents.test.ts](src/agents/agents.test.ts#L95-L310) stub `router.getMaxContextTokens` directly — *no change needed*. They were always one level above the provider seam.
4. [src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts#L75) and [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L91): same — they stub `getMaxContextTokens` and need no change.

### Step 6 — Add focused unit tests

New file `src/providers/model-capabilities.test.ts` (~120 lines):

1. For each of the eight providers, a small table-driven test:
   - Known model strings return the expected `{ contextWindow, tokenEncoding }`.
   - Unknown model strings return `undefined`.
2. Router throw test:
   - Construct a router with a provider whose `modelCapabilities` always returns `undefined`. Call `getMaxContextTokens("provider/unknown-model")`. Expect an `Error` whose message includes `"unknown-model"` and `"MODEL_CAPABILITIES"`.
3. OpenRouter prefix sensitivity test:
   - `modelCapabilities("openai/gpt-5-2025-09-01")` → `{ contextWindow: 400_000, tokenEncoding: "o200k_base" }`.
   - `modelCapabilities("anthropic/claude-3.5-sonnet-20250514")` → `{ contextWindow: 200_000, tokenEncoding: "cl100k_base" }`.
   - `modelCapabilities("anthropic/claude-9-future")` → `undefined`.

## Validation commands

Run from `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build
npx vitest run src/providers/model-capabilities.test.ts
npx vitest run src/providers/router.test.ts
npx vitest run src/agents/base.compaction.test.ts src/agents/agents.test.ts src/agents/conversation-snapshot.test.ts
npx vitest run
```

Expected: zero compile errors; the new test file passes; existing router/agent tests pass unchanged because they stubbed at the right seam.

## Rollback strategy

Single commit. Revert restores `maxContextTokens` on every provider and the `?? 200_000` router fallbacks. No on-disk state or schema is changed by F20 other than the one optional `providers.{ollama,llamacpp}.defaultContextWindow` field; absent values continue to be absent post-revert. No migration needed.

## Out of scope (deliberately deferred)

- Re-evaluating `compactionConfig.contextWindow` after a router failover swaps the active model. The current code caches the original `modelSpec`'s window for the agent's lifetime; that gap exists today and is not F20's responsibility. It would belong in a follow-up issue once the per-model number is correct.
- Operator UI exposing the resolved context window in the SPA. Not consumed today; do not add.
- Vendor-native token counters (Anthropic's `/v1/messages/count_tokens`, OpenAI's tokenizer endpoint). F07 commits to `js-tiktoken` workspace-wide; adding a vendor RTT to every compaction check would regress latency.
