# F20 — Design (r2)

## Changes from r1

1. **`ModelProvider.countTokens` and `ModelRouter.countTokens` stay.** r1's Proposal B removed `countTokens` from `ModelProvider` and replaced it with a helper that consumed `modelCapabilities(model).tokenEncoding`. The reviewer correctly pointed out that F07's APPROVED r4 plan adds router pass-through calls to `provider.countTokens(...)` ([SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md#L130-L148)) and BaseAgent calls to `router.countTokens(...)` ([SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md#L173-L203)). Removing those would stop compiling. r2 keeps both methods and rewrites only `BaseProvider.countTokens`'s body, deleting F07's per-provider `countTokens` overrides because the encoding is now derivable from each provider's `modelCapabilities`.
2. **`PiAiProvider.modelCapabilities` preserves F07's live encoding logic.** The piProvider-switch + model-id regex that F07 step 5h installs on `PiAiProvider.countTokens` moves into `PiAiProvider.modelCapabilities`. The default `BaseProvider.countTokens` (rewritten in this proposal) then reads `tokenEncoding` from there, so `PiAiProvider("openai").countTokens("gpt-5", …)` still routes through `o200k_base` end-to-end. F07's tests in `src/providers/pi-ai.test.ts` (9h) and the live-router cases in `src/providers/router.test.ts` (9i) keep passing after the test stubs are updated.
3. **`defaultContextWindow` lives on the runtime provider schema, not on `configSchema`.** Adds an optional `defaultContextWindow: z.number().optional()` field to `runtimeProviderConfigSchema` and the `RuntimeProviderConfigLike` interface in [src/routing/resolver.ts](../../../src/routing/resolver.ts#L51-L73). `ModelRouter.createProvider` ([src/providers/router.ts](../../../src/providers/router.ts#L720-L757)) reads it from `this.providerConfigs[providerName]?.defaultContextWindow` and passes it into the `OllamaProvider`/`LlamaCppProvider` constructors. `[src/config.ts](../../../src/config.ts#L51)` already wires `providers: z.record(z.string(), runtimeProviderConfigSchema)`, so no change in that file.

---

## Proposal A — Per-provider data table, no abstraction (unchanged from r1)

**Scope (files touched):**

- [src/providers/anthropic.ts](../../../src/providers/anthropic.ts#L109-L114), [src/providers/openai.ts](../../../src/providers/openai.ts#L148-L153), [src/providers/openai-codex.ts](../../../src/providers/openai-codex.ts#L374-L379), [src/providers/openrouter.ts](../../../src/providers/openrouter.ts#L16-L18), [src/providers/ollama.ts](../../../src/providers/ollama.ts#L17-L19), [src/providers/llamacpp.ts](../../../src/providers/llamacpp.ts#L21-L23) — replace each `maxContextTokens` body with a per-model `Array<[RegExp, number]>` lookup.
- [src/providers/base.ts](../../../src/providers/base.ts#L19-L21) — `BaseProvider.maxContextTokens` becomes `abstract`. No silent default.
- [src/providers/router.ts](../../../src/providers/router.ts#L245-L258) — remove the `?? 200_000` fallbacks in `getMaxContextTokens`; throw when the provider returns `undefined` for an unknown model.
- [src/routing/resolver.ts](../../../src/routing/resolver.ts#L51-L73) — add `defaultContextWindow: z.number().optional()` to `runtimeProviderConfigSchema` + the same field to `RuntimeProviderConfigLike`. `OllamaProvider`/`LlamaCppProvider` consult it via constructor injection.
- Untouched by Proposal A: F07's `countTokens` per-provider overrides; they continue to carry their own model-name encoding switch.

**Risk:** Keeps F07's `countTokens` encoding switch and a new `maxContextTokens` table side-by-side in the OpenAI-style provider files — two per-model lookups instead of one. Acceptable but redundant once F07 is approved.

**Recommendation note:** Cheapest fix. Workable, but Proposal B avoids the duplicate per-model switch.

---

## Proposal B (RECOMMENDED) — `ModelProvider.modelCapabilities(model)` returns a per-model capability record; `BaseProvider.countTokens` reads its encoding from there

**Scope (files touched):**

- [src/providers/types.ts](../../../src/providers/types.ts#L83-L98) — `ModelProvider` keeps `countTokens` from F07 and gains:

  ```ts
  export interface ModelCapabilities {
    /** Maximum input+output context window in tokens. */
    contextWindow: number;
    /** Token-counter encoding tag consumed by countTokens. */
    tokenEncoding: "cl100k_base" | "o200k_base";
  }

  /** Synchronous, local-only. No network. Returns undefined for unknown models. */
  modelCapabilities(model: string): ModelCapabilities | undefined;
  ```

  `maxContextTokens(model): number` is **removed** from the interface; its single consumer (`ModelRouter.getMaxContextTokens`) calls `modelCapabilities(model)?.contextWindow` instead.
  `countTokens(model, messages, system?, tools?): number` **stays** on the interface (F07 surface).

- [src/providers/base.ts](../../../src/providers/base.ts#L1-L34):
  - Remove `maxContextTokens` entirely.
  - Declare `modelCapabilities(model: string): ModelCapabilities | undefined` as `abstract` (concrete classes must implement it; the interface already mandates it).
  - **Rewrite F07's `BaseProvider.countTokens` default body** to:

    ```ts
    countTokens(model: string, messages: Message[], system?: string, tools?: ToolSchema[]): number {
      const encoding = this.modelCapabilities(model)?.tokenEncoding ?? "cl100k_base";
      return countWithTiktoken(messages, system, tools, encoding);
    }
    ```

    The `?? "cl100k_base"` fallback handles the edge case of an unknown model string passing through `countTokens` while `maxContextTokens`'s call site is *still* the boot-time loud failure for unknown models (see router seam below). `countTokens` runs in the hot loop on every `pushMessage`; making it throw would crash conversations on an unrecognised model after the boot-time check passed. The router-level throw at the `getMaxContextTokens` boundary remains the loud failure path.

  - **Delete F07 steps 5a–5h's per-provider `countTokens` overrides.** Every provider now inherits `BaseProvider.countTokens`, which reads the encoding from `modelCapabilities`. The encoding lives in exactly one place per provider (the `MODEL_CAPABILITIES` table or, for `PiAiProvider`/`CopilotProvider`/`PiAiProvider`, derived in `modelCapabilities`'s body).

- All eight provider files — each rewrites `maxContextTokens` as a per-model `MODEL_CAPABILITIES` table or accessor returning `ModelCapabilities | undefined`. Encoding decisions move from F07's `countTokens` overrides into here.

  **`PiAiProvider.modelCapabilities`** (load-bearing live-router path; replaces F07 step 5h's encoding switch):

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

  The five `case`s mirror the live-router registrations at [src/providers/router.ts](../../../src/providers/router.ts#L728-L750). `this.piProvider` is `private` today at [src/providers/pi-ai.ts](../../../src/providers/pi-ai.ts#L45); F07 step 5h already promotes it to `private readonly` — F20 inherits that, no further visibility change. `resolveModel`'s registry lookup at [src/providers/pi-ai.ts](../../../src/providers/pi-ai.ts#L77-L110) supplies the per-model `contextWindow`.

  **`CopilotProvider.modelCapabilities`** preserves the metadata-driven path:

  ```ts
  modelCapabilities(model: string): ModelCapabilities | undefined {
    const metadata = this.getCachedModelMetadata(model);
    const contextWindow = metadata?.capabilities?.limits?.max_context_window_tokens;
    if (!contextWindow) return undefined;
    const tokenEncoding = /^(gpt-5|o1|o3|o4)/.test(model) ? "o200k_base" : "cl100k_base";
    return { contextWindow, tokenEncoding };
  }
  ```

  **`AnthropicProvider`, `OpenAIProvider`, `OpenAICodexProvider`, `OpenRouterProvider`, `OllamaProvider`, `LlamaCppProvider`** each carry a `MODEL_CAPABILITIES: Array<[RegExp, ModelCapabilities]>` table plus an accessor. `OllamaProvider` and `LlamaCppProvider` additionally accept an optional `defaultContextWindow` via constructor; when their table misses, they return `{ contextWindow: defaultContextWindow, tokenEncoding: "cl100k_base" }` if set, otherwise `undefined`.

- [src/routing/resolver.ts](../../../src/routing/resolver.ts#L51-L73) — extend `runtimeProviderConfigSchema` and `RuntimeProviderConfigLike`:

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

  The field is provider-config-wide (not per-account); operators set it under `providers.ollama` / `providers.llamacpp` in the runtime config. It is silently ignored for every other provider — it has no schema in the provider classes that do not consult it.

- [src/providers/router.ts](../../../src/providers/router.ts#L720-L757) — in `createProvider`:

  ```ts
  case "ollama": {
    const defaultContextWindow = providerConfig?.defaultContextWindow;
    return new OllamaProvider(baseUrl, defaultContextWindow);
  }
  case "llamacpp": {
    const defaultContextWindow = providerConfig?.defaultContextWindow;
    return new LlamaCppProvider(baseUrl ?? process.env["LLAMACPP_BASE_URL"], defaultContextWindow);
  }
  ```

  And `getMaxContextTokens` becomes (no `?? 200_000`):

  ```ts
  getMaxContextTokens(modelSpec: string): number {
    const parsed = tryParseModelId(modelSpec);
    let providerName: string, model: string, candidateAccount: string | undefined;
    if (parsed) {
      ({ provider: providerName, model } = parsed);
    } else {
      const candidate = this.buildCandidateChain(modelSpec)[0];
      if (!candidate) throw new Error(`router: cannot resolve modelSpec "${modelSpec}"`);
      ({ provider: providerName, model } = parseModelId(candidate.spec));
      candidateAccount = candidate.accountRef;
    }
    const provider = this.getProviderForRequest(providerName, candidateAccount ? { accountRef: candidateAccount } : undefined);
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

- [src/agents/base.ts](../../../src/agents/base.ts#L187) — call site unchanged in shape; the throw bubbles to the agent constructor exactly like F04's `MissingModelForRoleError`.

- [src/runtime/token-counting.ts](../../../src/runtime/token-counting.ts) — the file F07 creates is *unchanged* by F20. Encoding remains an explicit argument to `countWithTiktoken`; F20 only changes *who* picks it (now `BaseProvider.countTokens` reading from `modelCapabilities`).

**What gets added:**

- `ModelCapabilities` type + `modelCapabilities(model)` accessor on every provider.
- Per-provider `MODEL_CAPABILITIES` table (data) inside each provider file, except `PiAiProvider` and `CopilotProvider` which derive capabilities from their existing registries.
- Optional `defaultContextWindow` field on `runtimeProviderConfigSchema` + `RuntimeProviderConfigLike`.
- `OllamaProvider`/`LlamaCppProvider` constructors gain a second `defaultContextWindow?: number` parameter.

**What gets removed:**

- `maxContextTokens(model): number` from the `ModelProvider` interface, `BaseProvider`, and every provider implementation.
- F07's per-provider `countTokens` overrides at steps 5a (OpenAI), 5b (OpenAICodex), 5c (Copilot), 5d (Anthropic), 5e (Ollama), 5f (LlamaCpp), 5h (PiAi). The encoding selection they encoded moves into `modelCapabilities`; `BaseProvider.countTokens` reads it.
- The router's `?? 200_000` silent fallback at [src/providers/router.ts](../../../src/providers/router.ts#L249) / [src/providers/router.ts](../../../src/providers/router.ts#L252-L257).
- The `BaseProvider.maxContextTokens` default at [src/providers/base.ts](../../../src/providers/base.ts#L19-L21).

**Risk:**

- F07's tests at `src/providers/{openai,anthropic,ollama,llamacpp,openrouter,copilot,pi-ai}.test.ts` and `src/providers/router.test.ts` were written against per-provider `countTokens` overrides. Their assertions on the **observable result** (which `encoding` argument is passed into `countWithTiktoken`) remain valid — the spying point is the same `vi.spyOn` over the `token-counting` module that F07 step 9 establishes. What changes is that the spy now records a call originating from `BaseProvider.countTokens` reading from `modelCapabilities`, not from a per-provider override. Test updates are limited to renaming a couple of describe-blocks; no assertions change.
- Existing `router.test.ts` stubs at [src/providers/router.test.ts](../../../src/providers/router.test.ts#L172-L175) and [src/providers/router.test.ts](../../../src/providers/router.test.ts#L464) currently stub `maxContextTokens: () => 222`. They become `modelCapabilities: () => ({ contextWindow: 222, tokenEncoding: "cl100k_base" })`. ~10 lines of rewrite.
- Sequencing with F07: cleanest order is **F07 first, then F20**. F07's per-provider `countTokens` overrides are installed; F20 deletes them and rewires the encoding selection. If F20 lands first, F07's plan trivially adapts (skip steps 5a–5h, keep step 4's default body but read encoding from `modelCapabilities`).
- `tokenEncoding` is OpenAI-tokenizer terminology. Acceptable because F07 commits to `js-tiktoken`; future vendor-native counters extend the union.
- `defaultContextWindow` lives on the *runtime provider config*, not on `SaivageConfig.models`. This means an operator can set it via the runtime config layer that already exists in `RuntimeRoutingConfigLike.providers` ([src/routing/resolver.ts](../../../src/routing/resolver.ts#L80-L86)) and the schema in [src/config.ts](../../../src/config.ts#L51) that wires it. No new top-level config block; no new schema file.

**What it enables:**

- A single per-model record consumed by both the compaction-trigger numerator (count) and denominator (window). Future fields (max output tokens, image-token surcharge, reasoning budget) land as additional capability fields.
- F07 cleanup: removes the per-model encoding switch that F07's plan plants in each provider that needs one (now exactly one place per provider — its `modelCapabilities` accessor or table).
- Boot-time loud failure for unknown models on the `maxContextTokens` path; hot-loop graceful fallback (`?? "cl100k_base"`) on the `countTokens` path — both correctness-preserving.

**What it forbids:**

- Drift between "what context window does this model have?" and "which tokenizer does this model use?" — both live in the same row of the same table (or are derived together in the same accessor body).
- Re-introducing `maxContextTokens` as a separate provider method.
- Silent `?? 200_000` substitutions anywhere downstream of `modelCapabilities`.

**Recommendation note:** The right shape. One accessor returns one record; F07's `countTokens` interface stays intact and its surface contract for the router pass-through and BaseAgent counter holds; the per-provider encoding switch consolidates into the same per-model table that supplies the context window. F20 piggy-backs on F07's `countTokens` surface rather than replacing it.

---

## Proposal C — Move per-model windows into a static JSON registry under `src/providers/model-registry.json` (unchanged from r1)

**Scope:** New `src/providers/model-registry.json` and `src/providers/model-registry.ts`; all providers read from the registry. Router `?? 200_000` removed.

**Risk:** Adds a file that becomes a magnet for unrelated per-model data (display names, deprecation tags, latency tiers). Decouples the data from the provider that owns the rest of that model's behaviour (chat conversion, tool conversion, encoding choice). Violates "no abstractions used once".

**Recommendation note:** Not recommended.

---

## Recommendation

**Proposal B.** It preserves F07's `countTokens` surface verbatim (interface, router pass-through, BaseAgent counter), collapses F07's per-provider encoding switches into the same `modelCapabilities` accessor that owns the context window, and preserves `PiAiProvider`'s live-router encoding logic by moving F07 step 5h's switch into `PiAiProvider.modelCapabilities`. The `defaultContextWindow` escape hatch for operator-loaded Ollama/llama.cpp weights lives on the runtime provider schema where Saivage's other operator-tunable per-provider knobs already live.

Cross-links:
- **F07** (APPROVED, Proposal B) — F20 sits on top of F07's `countTokens` surface; the per-provider overrides F07 installs (5a–5h) are deleted by F20 step 3 because `BaseProvider.countTokens` now reads encoding from `modelCapabilities`. Preferred order: F07 first, then F20.
- **F04** (APPROVED) — preserved: all model identifiers F20 introduces live inside `src/providers/*.ts`. The one operator-tunable escape (`defaultContextWindow`) carries no model identifier.
- **F11** (operational constants in config) — `defaultContextWindow` is an operator-tunable knob, not a vendor fact; it lives on `runtimeProviderConfigSchema`, not on `SaivageConfig.models`. No collision.
