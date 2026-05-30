# F07 — Review (r4)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](../_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F07/04-review-r3.md](04-review-r3.md)
- [SPEC/v2/review-2026-05/F07/01-analysis-r3.md](01-analysis-r3.md)
- [SPEC/v2/review-2026-05/F07/02-design-r3.md](02-design-r3.md)
- [SPEC/v2/review-2026-05/F07/03-plan-r4.md](03-plan-r4.md)

## Findings

### Analysis

- r3 remains authoritative for analysis, per the loop convention for plan-only revisions. The r3 analysis accurately scopes the old `chars / 4` estimator, distinguishes `shouldCompact` from `isMaxCompactionsReached`, and identifies that provider `usage` exists but is not consumed by compaction.
- The active-provider caveat raised in r3 has now been incorporated at the plan level. The current router constructs `PiAiProvider` for `anthropic`, `openai`, `openai-codex`, `opencode`, and `opencode-go` at [src/providers/router.ts](../../../src/providers/router.ts#L720-L760), and `PiAiProvider` is the shared live wrapper at [src/providers/pi-ai.ts](../../../src/providers/pi-ai.ts#L43-L50).

### Design

- r3 remains authoritative for design. Proposal B is still the right direction: token counting becomes a synchronous provider capability, while `BaseAgent` maintains a running input-token count so the loop does not re-count the full conversation every tick.
- The r3 design's missing active-router coverage is corrected by the r4 plan. The implementation path now treats `PiAiProvider.countTokens` as load-bearing for the live OpenAI/Anthropic/Codex/OpenCode registrations rather than relying on direct legacy provider classes.

### Plan

- The prior blocking gap is resolved. Step 5h adds a provider/model-aware `PiAiProvider.countTokens` override keyed by `this.piProvider`, covering `openai`, `openai-codex`, `anthropic`, `opencode`, and `opencode-go`. That matches the actual `ModelRouter.createProvider` registrations at [src/providers/router.ts](../../../src/providers/router.ts#L730-L750).
- The live-path test coverage is now adequate. Step 9h adds direct `PiAiProvider` tests for all five routed `piProvider` values, and step 9i extends `src/providers/router.test.ts` so `ModelRouter.countTokens(...)` is verified through the same runtime resolution path rather than only through direct provider classes.
- The remaining direct-provider overrides are acceptable as interface-compliance coverage while the direct classes remain in-tree. The plan explicitly labels `AnthropicProvider` and `OpenAICodexProvider` as non-live router paths today and keeps `CopilotProvider`, `OllamaProvider`, and `LlamaCppProvider` behavior pinned where they are reachable.
- The `BaseAgent` counter steps are still executable against the current mutation points: `pushMessage` appends at [src/agents/base.ts](../../../src/agents/base.ts#L718-L733), `replaceMessages` replaces the whole array at [src/agents/base.ts](../../../src/agents/base.ts#L734-L742), and compaction flows through `replaceMessages` at [src/agents/base.ts](../../../src/agents/base.ts#L850). The plan's calibration rule remains monotonic, so it cannot delay compaction after a provider reports a lower input count.

## Required changes

None.

## Strengths

- r4 directly addresses the only r3 objection instead of widening the scope.
- The plan now protects the actual runtime path through both `PiAiProvider` and `ModelRouter.countTokens` tests.
- The rollback and validation strategy remain simple and aligned with the no-shim guideline.

VERDICT: APPROVED