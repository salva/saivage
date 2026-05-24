# F20 - Review r1

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F20-max-context-tokens-hardcoded.md](SPEC/v2/review-2026-05/F20-max-context-tokens-hardcoded.md)
- [SPEC/v2/review-2026-05/F20/01-analysis-r1.md](SPEC/v2/review-2026-05/F20/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F20/02-design-r1.md](SPEC/v2/review-2026-05/F20/02-design-r1.md)
- [SPEC/v2/review-2026-05/F20/03-plan-r1.md](SPEC/v2/review-2026-05/F20/03-plan-r1.md)
- Cross-checks: [src/providers/types.ts](src/providers/types.ts), [src/providers/base.ts](src/providers/base.ts), [src/providers/router.ts](src/providers/router.ts), [src/config.ts](src/config.ts), [src/routing/resolver.ts](src/routing/resolver.ts), [SPEC/v2/review-2026-05/F07/APPROVED.md](SPEC/v2/review-2026-05/F07/APPROVED.md), [SPEC/v2/review-2026-05/F07/03-plan-r4.md](SPEC/v2/review-2026-05/F07/03-plan-r4.md)

## Findings

### Analysis

The problem statement is materially correct. The current contract still exposes `maxContextTokens(model)` on [src/providers/types.ts](src/providers/types.ts#L91), `BaseProvider` still returns a silent `200_000` default at [src/providers/base.ts](src/providers/base.ts#L19-L21), and the router still falls back to `200_000` when provider lookup or provider metadata is missing at [src/providers/router.ts](src/providers/router.ts#L245-L258). The analysis also correctly identifies the provider-level variants: fixed returns in Anthropic/OpenRouter/Ollama/llama.cpp, heuristic returns in OpenAI/OpenAI Codex/Copilot, and registry-backed behaviour in Pi AI.

The cross-issue premise is now true in this review tree: [SPEC/v2/review-2026-05/F07/APPROVED.md](SPEC/v2/review-2026-05/F07/APPROVED.md) approves Proposal B with [SPEC/v2/review-2026-05/F07/03-plan-r4.md](SPEC/v2/review-2026-05/F07/03-plan-r4.md) as the final plan. F20 is right to design against that neighbour.

### Design

Proposal B has a contract contradiction around `countTokens`. It says the F07-introduced `countTokens(model, messages, system?, tools?)` accessor is removed from `ModelProvider` and replaced by `modelCapabilities` plus a helper at [SPEC/v2/review-2026-05/F20/02-design-r1.md](SPEC/v2/review-2026-05/F20/02-design-r1.md#L59-L77). Immediately after, it rewrites a `BaseProvider.countTokens` default that derives from `modelCapabilities` at [SPEC/v2/review-2026-05/F20/02-design-r1.md](SPEC/v2/review-2026-05/F20/02-design-r1.md#L79-L89). The plan repeats the same split: remove `countTokens` from the interface at [SPEC/v2/review-2026-05/F20/03-plan-r1.md](SPEC/v2/review-2026-05/F20/03-plan-r1.md#L24-L25), then keep a `BaseProvider.countTokens` body at [SPEC/v2/review-2026-05/F20/03-plan-r1.md](SPEC/v2/review-2026-05/F20/03-plan-r1.md#L31-L40). That is not executable against F07 as approved: F07 adds router pass-through calls to `provider?.countTokens(...)` at [SPEC/v2/review-2026-05/F07/03-plan-r4.md](SPEC/v2/review-2026-05/F07/03-plan-r4.md#L130-L148), and then BaseAgent paths call `router.countTokens(...)` for static/running/stash accounting at [SPEC/v2/review-2026-05/F07/03-plan-r4.md](SPEC/v2/review-2026-05/F07/03-plan-r4.md#L173-L203). If `countTokens` disappears from `ModelProvider`, those provider calls stop compiling; if it stays, Proposal B is not replacing both provider accessors as currently worded.

The recommended design also loses F07's live-router tokenizer distinction for Pi AI. F20's Pi AI step returns `tokenEncoding: "cl100k_base"` for every resolved Pi AI model at [SPEC/v2/review-2026-05/F20/03-plan-r1.md](SPEC/v2/review-2026-05/F20/03-plan-r1.md#L108-L111). But the live router constructs `PiAiProvider` for `anthropic`, `openai`, `openai-codex`, `opencode`, and `opencode-go` at [src/providers/router.ts](src/providers/router.ts#L729-L750), and F07's approved r4 plan explicitly made `PiAiProvider.countTokens` inspect `this.piProvider` so `openai`/`openai-codex` GPT-5/o-family models use `o200k_base` at [SPEC/v2/review-2026-05/F07/03-plan-r4.md](SPEC/v2/review-2026-05/F07/03-plan-r4.md#L9) and [SPEC/v2/review-2026-05/F07/03-plan-r4.md](SPEC/v2/review-2026-05/F07/03-plan-r4.md#L115-L121). F20's direct `OpenAIProvider` table assigns GPT-5 to `o200k_base` at [SPEC/v2/review-2026-05/F20/03-plan-r1.md](SPEC/v2/review-2026-05/F20/03-plan-r1.md#L60-L65), but that direct class is not the live router path for `openai`. Proposal B's stated goal is to prevent context-window/tokenizer drift; the Pi AI row currently preserves that drift on the runtime path that matters most.

### Plan

The Ollama/llama.cpp config addition is aimed at the wrong schema file. The plan says to add `providers.{ollama,llamacpp}.defaultContextWindow` in [src/config.ts](src/config.ts) at [SPEC/v2/review-2026-05/F20/03-plan-r1.md](SPEC/v2/review-2026-05/F20/03-plan-r1.md#L89-L90), but [src/config.ts](src/config.ts#L5) imports `runtimeProviderConfigSchema` and wires it into `providers` at [src/config.ts](src/config.ts#L51). The actual provider/account shape lives in [src/routing/resolver.ts](src/routing/resolver.ts#L38-L56), with the public type at [src/routing/resolver.ts](src/routing/resolver.ts#L59-L69). Adding the field only in [src/config.ts](src/config.ts) would either be a no-op or leave the field stripped/untyped before the router constructs `OllamaProvider`/`LlamaCppProvider` at [src/providers/router.ts](src/providers/router.ts#L724-L757). The plan needs to update the runtime provider schema/types and specify how that parsed value reaches the two provider instances.

The validation command set is otherwise appropriate for this repo: typecheck, build, focused Vitest suites, then full Vitest.

## Required changes

1. Make Proposal B choose one executable `countTokens` contract and update design/plan wording consistently. Either keep F07's `ModelProvider.countTokens`/`ModelRouter.countTokens` surface and make the implementation derive from `modelCapabilities`, or remove provider-level `countTokens` entirely and explicitly rewrite all F07 router/BaseAgent call sites to call the shared helper from a capability record.
2. Make `PiAiProvider.modelCapabilities` preserve F07's live-path encoding logic. At minimum, `PiAiProvider("openai")` and `PiAiProvider("openai-codex")` need GPT-5/o-family models to return `o200k_base`, and the plan should add tests for those direct Pi AI cases plus router-resolved `openai/...` and `openai-codex/...` cases.
3. Move the Ollama/llama.cpp `defaultContextWindow` schema work to the actual runtime provider schema/types in [src/routing/resolver.ts](src/routing/resolver.ts), then route that parsed value into [src/providers/router.ts](src/providers/router.ts) and the two provider constructors or provider instances. Update the plan's file references and tests accordingly.

## Strengths

- Correctly rejects silent context-window fallbacks instead of preserving them as compatibility behaviour.
- Proposal B is the right conceptual direction once the contract is made internally consistent: one per-model capability record is cleaner than separate context-window and encoding switches.
- The analysis does a good job distinguishing vendor facts from operator-tunable config and keeps model identifiers out of non-provider production source except for the local-provider escape hatch.

VERDICT: CHANGES_REQUESTED