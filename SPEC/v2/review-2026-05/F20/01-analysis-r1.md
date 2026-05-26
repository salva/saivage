# F20 — Analysis (r1)

## Problem restated

`ModelProvider.maxContextTokens(model)` is contracted to vary per model (see [src/providers/types.ts](src/providers/types.ts#L91)), but four of the eight implementations collapse to a single hardcoded number regardless of the `model` argument, and two more do so through coarse keyword heuristics that ignore real per-model differences. The single number this method returns is the only input that compaction uses to convert `thresholdPct` into an absolute token budget at [src/agents/base.ts](src/agents/base.ts#L187-L194), so every wrong number translates directly into "compaction fires at a wildly wrong point in the conversation".

Concretely, the offenders:

- [src/providers/anthropic.ts](src/providers/anthropic.ts#L109-L114): four `if` branches (`haiku` / `sonnet` / `opus` / fallback) all return `200_000`. The branching looks intentional but every branch is dead — a reader has to diff the values to discover that nothing is differentiated. Claude Sonnet 4 and Opus 4 both ship a 200k window, but Haiku 3.5 is 200k while Haiku 3 is 200k — so the "Anthropic = 200k" approximation happens to be true for current shipping models, but the dead branching falsely advertises per-model awareness that does not exist.
- [src/providers/openai.ts](src/providers/openai.ts#L148-L153): `gpt-4o` → `128_000`, `gpt-4` → `128_000`, `gpt-3.5` → `16_385`, fallback `128_000`. `gpt-4o`/`gpt-4` returning the same number is fine; the genuinely wrong case is any future or current OpenAI model not matched by `gpt-3.5`/`gpt-4`/`gpt-4o`. `o1` (200k), `o3` (200k), `o4` (200k), `gpt-5` family (commonly advertised 400k–1M depending on tier) all fall through to `128_000`, so a `gpt-5` run is compacted at `80% × 128_000 ≈ 102k` tokens instead of `80% × 400_000 ≈ 320k`.
- [src/providers/openai-codex.ts](src/providers/openai-codex.ts#L374-L379): same shape; `gpt-5` family is hardcoded to `200_000`, which is itself an underestimate for the codex-side GPT-5 variants that ship a larger window.
- [src/providers/base.ts](src/providers/base.ts#L19-L21): default `200_000`. This default is what every provider without its own override inherits and what the `?? 200_000` fallback at [src/providers/router.ts](src/providers/router.ts#L249) and [src/providers/router.ts](src/providers/router.ts#L252-L257) hands out when a provider lookup fails — silently masking a misconfigured router entry as "200k probably fine".
- [src/providers/ollama.ts](src/providers/ollama.ts#L17-L19): `_model` deliberately ignored, fixed `128_000`. Ollama lets the operator load any model with any `num_ctx` setting; the runtime cannot guess.
- [src/providers/llamacpp.ts](src/providers/llamacpp.ts#L21-L23): same pattern, fixed `128_000`.
- [src/providers/openrouter.ts](src/providers/openrouter.ts#L16-L18): fixed `200_000`. OpenRouter routes to dozens of vendors with windows ranging from 8k (older models) to 2M (Gemini 1.5/2.0), and the comment "Varies; OpenRouter handles it" is incorrect — OpenRouter does not handle compaction. Saivage does, and Saivage uses this number to do it.

Two implementations are *not* offenders and are reference behaviour:

- [src/providers/copilot.ts](src/providers/copilot.ts#L473-L483): reads `metadata.capabilities.limits.max_context_window_tokens` from the cached `/models` payload, falls back to keyword heuristics only when the metadata is missing. This is the model the rest of the codebase should follow when an API source is available.
- [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L270-L273): reads `model.contextWindow` from the `pi-ai` runtime's `getModels()` registry. Provider-level registry lookup; same pattern as copilot from a different source.

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

A reader scanning this code naturally assumes the three branches were inserted to record three different limits, then collapsed by an editing accident or by a refactor that did not finish. The next contributor adding a fourth Claude family will most likely follow the same pattern and append another no-op branch. The "dead branching" is itself a maintenance hazard regardless of whether the values are correct.

## Contract

`maxContextTokens(model: string): number` on `ModelProvider` ([src/providers/types.ts](src/providers/types.ts#L91)).

- Input: the model id portion of `provider/model` after `parseModelId` strips the provider prefix, e.g. `"claude-sonnet-4-20250514"`, `"gpt-5"`, `"llama3.1:70b"`, `"openai/gpt-4o"` (yes — OpenRouter ids re-embed a slash). No `tools`, no `messages`, no `system` argument.
- Output: number of tokens. Single source of truth for the conversation budget.
- Error mode: none defined. There is no documented behaviour for "unknown model"; the router silently substitutes `200_000` via `?? 200_000` at [src/providers/router.ts](src/providers/router.ts#L249) / [src/providers/router.ts](src/providers/router.ts#L252-L257), so a wrong-keyed lookup is indistinguishable from a healthy one. The fallback is invisible to operators.
- Lifecycle: called once per agent at construction time inside [src/agents/base.ts](src/agents/base.ts#L187), reused as `compactionConfig.contextWindow` for the agent's lifetime. Not re-evaluated when the router fails over to a different model (the failover keeps the *original* `modelSpec`'s context window even though a different model is now being called) — that is a related correctness gap that this issue exposes but does not own; it is downstream of any fix that makes the per-model number correct.

## Call sites & dependencies

- Sole consumer is [src/agents/base.ts](src/agents/base.ts#L187-L194), where it is fed into `compactionConfig.contextWindow`.
- Tests stub `getMaxContextTokens` directly at [src/providers/router.test.ts](src/providers/router.test.ts#L172-L175), [src/providers/router.test.ts](src/providers/router.test.ts#L464), [src/agents/agents.test.ts](src/agents/agents.test.ts#L95), and [src/agents/base.compaction.test.ts](src/agents/base.compaction.test.ts#L75); none of them exercise the provider implementations.
- No web/UI consumer — the SPA never displays the context window.
- F07 (token estimation; APPROVED, Proposal B) introduces a sibling provider method `countTokens(model, messages, system?, tools?): number` that handles the *numerator* of the compaction trigger. F20 owns the *denominator*. The two methods are natural neighbours on `ModelProvider` and should be designed to live together.
- F04 (hardcoded default models; APPROVED, Proposal A) removed all hardcoded model identifiers from production source outside provider implementations. F20 must not re-introduce model identifiers anywhere except inside provider implementations — and the tables it adds inside providers must be data, not defaults that the router silently substitutes.
- F11 (operational constants not in config) explicitly does *not* cover per-model context windows; those belong with the provider, not in `SaivageConfig`.

## Constraints any solution must respect

1. **No backward compatibility.** Per project guideline #1, delete the dead `if` branches and any "approximate / will refine later" fallbacks rather than leaving them as transitional shims.
2. **No model identifiers in non-provider production source.** Per F04 APPROVED, the `models` block in `SaivageConfig` no longer carries defaults; F20 must keep that invariant. Per-model context windows live in `src/providers/*.ts` only.
3. **Synchronous, no network.** `maxContextTokens` is called from the `BaseAgent` constructor at [src/agents/base.ts](src/agents/base.ts#L187), and the constructor cannot await. Anything sourced from a remote API (the copilot case) must come from an already-cached registry, exactly as copilot does today; first-call must not block.
4. **No new abstractions used once.** Per guideline #2: do not introduce a `ContextWindowRegistry` or similar if a per-provider table inside the provider file would do.
5. **Silent fallbacks are a documented harm.** The router's `?? 200_000` at [src/providers/router.ts](src/providers/router.ts#L249) / [src/providers/router.ts](src/providers/router.ts#L252-L257) and the `BaseProvider.maxContextTokens` default at [src/providers/base.ts](src/providers/base.ts#L19-L21) currently hide misconfiguration. Any fix must either remove the silent fallback or make "unknown model" loud at boot.
6. **Tests stub `router.getMaxContextTokens` directly today.** That seam stays; the per-provider implementation underneath it changes. Tests at [src/agents/agents.test.ts](src/agents/agents.test.ts#L95) / [src/agents/agents.test.ts](src/agents/agents.test.ts#L153) etc. need no changes.
7. **F07 lands first or in parallel.** F07 already adds `countTokens` as a provider capability and edits `BaseProvider` / each provider file. F20 touches the same files; the cleaner ordering is "F07 first, F20 follows", but the two are independent enough to land either order. Note the dependency in the plan's ordering section.
8. **Out of scope: `src/skills/`, memory-related code.** Per loop conventions. None of F20's edits touch those directories.
9. **`openrouter` model strings re-embed a slash.** Any per-model lookup logic that re-parses `model` to strip a vendor prefix must be explicit about doing so (current code does not parse — it just `includes()`-matches, which works by accident).
