# F20 — Analysis (r2)

## Changes from r1

- **F07 contract surface reconciled.** r1 said `ModelProvider.countTokens` would be removed from the interface when F20 lands; that contradicts F07's APPROVED r4 plan, which adds `ModelProvider.countTokens` ([SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md)) and a router pass-through `ModelRouter.countTokens` ([src/providers/router.ts](../../../src/providers/router.ts#L245-L258) after F07's step 6) consumed by `BaseAgent`'s static / running / stash counting ([SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md#L173-L203)). r2 keeps both methods on `ModelProvider`; F20's contribution is to make `BaseProvider.countTokens` derive its encoding from `modelCapabilities(model).tokenEncoding`, collapsing F07's per-provider encoding overrides into the same per-model capability record. The interface keeps its two accessors; the duplication is removed below them.
- **PiAiProvider live-path encoding preserved.** r1's `pi-ai.ts` row in the design returned `tokenEncoding: "cl100k_base"` for every model, which would silently regress F07 step 5h. r2's `PiAiProvider.modelCapabilities` switches on `this.piProvider` first (matching the five live-router cases in [src/providers/router.ts](../../../src/providers/router.ts#L728-L750)) and then on the model id, so `PiAiProvider("openai").modelCapabilities("gpt-5-foo").tokenEncoding === "o200k_base"` and similarly for `openai-codex`, while `anthropic`/`opencode`/`opencode-go` stay on `cl100k_base`. The default `BaseProvider.countTokens` then picks up the right encoding without a separate per-provider `countTokens` override on `pi-ai.ts`.
- **`defaultContextWindow` moved to the runtime provider schema.** r1 added a `providers.{ollama,llamacpp}.defaultContextWindow` field in [src/config.ts](../../../src/config.ts), but that file delegates the `providers` shape to `runtimeProviderConfigSchema` imported from [src/routing/resolver.ts](../../../src/routing/resolver.ts#L51-L57). r2 puts the new optional field on `runtimeProviderConfigSchema` and on `RuntimeProviderConfigLike`, then has `ModelRouter.createProvider` read it from `this.providerConfigs[providerName]` and pass it into the `OllamaProvider`/`LlamaCppProvider` constructors.

## Problem restated

`ModelProvider.maxContextTokens(model)` is contracted to vary per model (see [src/providers/types.ts](../../../src/providers/types.ts#L91)), but four of the eight implementations collapse to a single hardcoded number regardless of the `model` argument, and two more do so through coarse keyword heuristics that ignore real per-model differences. The single number this method returns is the only input that compaction uses to convert `thresholdPct` into an absolute token budget at [src/agents/base.ts](../../../src/agents/base.ts#L187-L194), so every wrong number translates directly into "compaction fires at a wildly wrong point in the conversation".

Concretely, the offenders:

- [src/providers/anthropic.ts](../../../src/providers/anthropic.ts#L109-L114): four `if` branches (`haiku` / `sonnet` / `opus` / fallback) all return `200_000`. The branching looks intentional but every branch is dead — a reader has to diff the values to discover that nothing is differentiated. Claude Sonnet 4 / Opus 4 / Haiku 3.5 all ship 200k today, so the "Anthropic = 200k" approximation happens to be true for current shipping models, but the dead branching falsely advertises per-model awareness that does not exist.
- [src/providers/openai.ts](../../../src/providers/openai.ts#L148-L153): `gpt-4o` → `128_000`, `gpt-4` → `128_000`, `gpt-3.5` → `16_385`, fallback `128_000`. The genuinely wrong case is any future or current OpenAI model not matched by `gpt-3.5`/`gpt-4`/`gpt-4o`. `o1` (200k), `o3` (200k), `o4` (200k), `gpt-5` family (commonly advertised 400k) all fall through to `128_000`, so a `gpt-5` run is compacted at `80% × 128_000 ≈ 102k` tokens instead of `80% × 400_000 = 320k`.
- [src/providers/openai-codex.ts](../../../src/providers/openai-codex.ts#L374-L379): same shape; `gpt-5` family is hardcoded to `200_000`.
- [src/providers/base.ts](../../../src/providers/base.ts#L19-L21): default `200_000`. This default is what every provider without its own override inherits and what the `?? 200_000` fallback at [src/providers/router.ts](../../../src/providers/router.ts#L249) and [src/providers/router.ts](../../../src/providers/router.ts#L252-L257) hands out when a provider lookup fails — silently masking a misconfigured router entry as "200k probably fine".
- [src/providers/ollama.ts](../../../src/providers/ollama.ts#L17-L19): `_model` deliberately ignored, fixed `128_000`. Ollama lets the operator load any model with any `num_ctx` setting; the runtime cannot guess.
- [src/providers/llamacpp.ts](../../../src/providers/llamacpp.ts#L21-L23): same pattern, fixed `128_000`.
- [src/providers/openrouter.ts](../../../src/providers/openrouter.ts#L16-L18): fixed `200_000`. OpenRouter routes to dozens of vendors with windows ranging from 8k to 2M, and the comment "Varies; OpenRouter handles it" is incorrect — OpenRouter does not handle compaction, Saivage does.

Two implementations are *not* offenders and are reference behaviour:

- [src/providers/copilot.ts](../../../src/providers/copilot.ts#L473-L483): reads `metadata.capabilities.limits.max_context_window_tokens` from the cached `/models` payload.
- [src/providers/pi-ai.ts](../../../src/providers/pi-ai.ts#L270-L273): reads `model.contextWindow` from the `pi-ai` runtime registry.

## Actual differences (the "looks-intentional, all-identical" wart)

```ts
// src/providers/anthropic.ts:109-114
maxContextTokens(model: string): number {
  if (model.includes("haiku")) return 200_000;
  if (model.includes("sonnet")) return 200_000;
  if (model.includes("opus")) return 200_000;
  return 200_000;
}
```

A reader naturally assumes the three branches were inserted to record three different limits, then collapsed by an editing accident. The next contributor adding a fourth Claude family will most likely follow the same pattern and append another no-op branch. The "dead branching" is itself a maintenance hazard regardless of whether the values are correct.

## Contract

`maxContextTokens(model: string): number` on `ModelProvider` ([src/providers/types.ts](../../../src/providers/types.ts#L91)).

- Input: the model id portion of `provider/model` after `parseModelId` strips the provider prefix, e.g. `"claude-sonnet-4-20250514"`, `"gpt-5"`, `"llama3.1:70b"`, `"openai/gpt-4o"` (OpenRouter ids re-embed a slash). No `tools`, no `messages`, no `system` argument.
- Output: number of tokens. Single source of truth for the conversation budget.
- Error mode: none defined. The router silently substitutes `200_000` via `?? 200_000` at [src/providers/router.ts](../../../src/providers/router.ts#L249) / [src/providers/router.ts](../../../src/providers/router.ts#L252-L257), so a wrong-keyed lookup is indistinguishable from a healthy one.
- Lifecycle: called once per agent at construction time inside [src/agents/base.ts](../../../src/agents/base.ts#L187), reused as `compactionConfig.contextWindow` for the agent's lifetime. Not re-evaluated when the router fails over to a different model.

F07 also adds (APPROVED, [SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md)):

- `ModelProvider.countTokens(model, messages, system?, tools?): number` — synchronous, no network, default in `BaseProvider` delegates to `countWithTiktoken(... , "cl100k_base")`, with overrides on `OpenAIProvider`, `OpenAICodexProvider`, `CopilotProvider`, `AnthropicProvider`, `OllamaProvider`, `LlamaCppProvider`, and (load-bearing) `PiAiProvider`. The `PiAiProvider` override switches on `this.piProvider` and then on model id ([SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md#L105-L130)).
- `ModelRouter.countTokens(modelSpec, messages, system?, tools?): number` — same resolution chain as `getMaxContextTokens`.
- Two `BaseAgent` fields `runningInputTokens` and `staticInputTokens`, used by `pushMessage`, `replaceMessages`, the compaction guard, and `maybeStash` ([SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md#L155-L203)).

F20 inherits this surface: it does not remove `countTokens` from the interface or from `ModelRouter`. It collapses the *encoding switch* duplicated across F07's provider overrides into the new per-model `modelCapabilities` accessor and re-points `BaseProvider.countTokens` at it.

## Call sites & dependencies

- `maxContextTokens` consumer: [src/agents/base.ts](../../../src/agents/base.ts#L187-L194) via `ctx.router.getMaxContextTokens`.
- `countTokens` consumers (post-F07): `BaseAgent.pushMessage`, `replaceMessages`, `maybeStash`, and the compaction-trigger guard ([SPEC/v2/review-2026-05/F07/03-plan-r4.md](../F07/03-plan-r4.md#L173-L203)), all via `ctx.router.countTokens`.
- Tests stub `getMaxContextTokens` at [src/providers/router.test.ts](../../../src/providers/router.test.ts#L172-L175), [src/providers/router.test.ts](../../../src/providers/router.test.ts#L464), [src/agents/agents.test.ts](../../../src/agents/agents.test.ts#L95), [src/agents/base.compaction.test.ts](../../../src/agents/base.compaction.test.ts#L75); none of them exercise the provider implementations of `maxContextTokens` directly.
- F07's added tests at `src/providers/pi-ai.test.ts` (9h) and the new router cases in `src/providers/router.test.ts` (9i) pin the live-path encoding selection through `PiAiProvider`. F20 must keep those tests green — after F20, the encoding selection moves from `PiAiProvider.countTokens` into `PiAiProvider.modelCapabilities`, but the observable behaviour at `router.countTokens` is identical.
- No web/UI consumer — the SPA never displays the context window or token count.
- F04 (hardcoded default models; APPROVED, Proposal A) removed hardcoded model identifiers from production source outside provider implementations. F20 must not re-introduce model identifiers anywhere except inside provider implementations.
- F11 (operational constants not in config) explicitly does *not* cover per-model context windows; those belong with the provider. The one exception — `defaultContextWindow` for `ollama` / `llamacpp` — is an operator-loaded-weights escape hatch, not a per-model lookup, so it lives in the runtime provider config (see Constraint 5 below).

## Constraints any solution must respect

1. **No backward compatibility.** Delete dead `if` branches and silent fallbacks rather than leaving transitional shims.
2. **No model identifiers in non-provider production source.** Per F04 APPROVED, model strings live in `src/providers/*.ts` only.
3. **Synchronous, no network.** `maxContextTokens` and `countTokens` are called from the `BaseAgent` constructor and from `pushMessage` ([src/agents/base.ts](../../../src/agents/base.ts#L187), [src/agents/base.ts](../../../src/agents/base.ts#L718-L734)). The constructor cannot await; `pushMessage` runs in the hot loop.
4. **No new abstractions used once.** No `ContextWindowRegistry` or similar — a per-provider table inside the provider file is enough.
5. **Silent fallbacks are a documented harm.** The router's `?? 200_000` at [src/providers/router.ts](../../../src/providers/router.ts#L249) / [src/providers/router.ts](../../../src/providers/router.ts#L252-L257) and the `BaseProvider.maxContextTokens` default at [src/providers/base.ts](../../../src/providers/base.ts#L19-L21) currently hide misconfiguration. Any fix must remove the silent fallback and make "unknown model" loud at boot.
6. **Tests stub `router.getMaxContextTokens` directly today.** That seam stays.
7. **F07 lands first (preferred).** F07's surface — `ModelProvider.countTokens`, `ModelRouter.countTokens`, the running counter on `BaseAgent` — must remain after F20. F20 only edits `BaseProvider.countTokens`'s body (so it reads `modelCapabilities(model).tokenEncoding`) and deletes the per-provider `countTokens` overrides F07 introduces (steps 5a–5h) because their encoding choice is now derivable from each provider's `modelCapabilities` table.
8. **`PiAiProvider` is the live runtime path for five provider names.** Any change must preserve F07 step 5h's live encoding selection ([src/providers/router.ts](../../../src/providers/router.ts#L728-L750)); the equivalent logic moves into `PiAiProvider.modelCapabilities`.
9. **Out of scope: `src/skills/`, memory-related code.** Per loop conventions.
10. **`openrouter` model strings re-embed a slash.** Any per-model lookup must be explicit about parsing or pattern-matching the vendor-prefixed form.
11. **Ollama / llama.cpp accept arbitrary operator-loaded weights.** The provider cannot enumerate models. A single optional `defaultContextWindow` on the *runtime provider config* (`runtimeProviderConfigSchema` in [src/routing/resolver.ts](../../../src/routing/resolver.ts#L51-L57)) provides the escape hatch without re-introducing model identifiers into `SaivageConfig.models`.
