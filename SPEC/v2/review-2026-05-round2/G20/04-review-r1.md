# G20 — Review r1

Requested changes: 6

## Summary

The writer correctly refines the inventory issue: `AnthropicProvider`, `OpenAICodexProvider`, and `OpenRouterProvider` are not live router implementations, while `OpenAIProvider` is still live indirectly as the base class for `OllamaProvider` and `LlamaCppProvider`. The recommendation to delete three and keep one is acceptable as the focused G20 fix, but the documents are not yet implementation-ready. The current plan misses a direct test file that imports and constructs all three deleted classes, overclaims what its CLI smoke test proves, and contains a false Design B dependency claim.

## Blocking Findings

1. **The analysis/design/plan miss `model-capabilities.test.ts`, so Design A would break tests immediately.**

   The grep evidence does not support the writer's “own unit tests only” framing in [SPEC/v2/review-2026-05-round2/G20/01-analysis-r1.md](01-analysis-r1.md#L32-L67) or the Design A test-impact statement in [SPEC/v2/review-2026-05-round2/G20/02-design-r1.md](02-design-r1.md#L55-L63). [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L3-L6) imports `OpenAIProvider`, `OpenAICodexProvider`, `AnthropicProvider`, and `OpenRouterProvider`, then directly constructs the three classes Design A deletes at [src/providers/model-capabilities.test.ts](../../../../src/providers/model-capabilities.test.ts#L53-L80). The implementation plan's deletion list names only the three per-class test files in [SPEC/v2/review-2026-05-round2/G20/03-plan-r1.md](03-plan-r1.md#L27-L43), so `npm test -- --run` would fail after the source deletions. Required change: update all three writer docs to include `src/providers/model-capabilities.test.ts`, remove or rewrite the dead direct-class capability cases to exercise `PiAiProvider`/live local providers, and adjust the test LOC/count deltas.

2. **Design B.2 falsely says the `openai` package can be removed.**

   The Design B.2 text claims folding local providers into PiAi lets the `openai` npm dependency be removed from [package.json](../../../../package.json) in [SPEC/v2/review-2026-05-round2/G20/02-design-r1.md](02-design-r1.md#L85-L93) and repeats that benefit at [SPEC/v2/review-2026-05-round2/G20/02-design-r1.md](02-design-r1.md#L120-L124). That is not true today: [src/providers/copilot.ts](../../../../src/providers/copilot.ts#L1) imports `openai`, stores an `OpenAI` client at [src/providers/copilot.ts](../../../../src/providers/copilot.ts#L107-L132), and uses both Responses and Chat Completions APIs at [src/providers/copilot.ts](../../../../src/providers/copilot.ts#L214-L280). Required change: revise B.2 to either keep the package dependency or explicitly include a Copilot provider refactor; otherwise recommend B.1 as the only credible level-up variant.

3. **The selected architecture needs a sharper architecture-first decision.**

   Keeping `OpenAIProvider` is not backward compatibility if it remains load-bearing through [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L1-L13) and [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L1-L12), and Design A is a valid focused deletion. But [SPEC/v2/review-2026-05-round2/G20/02-design-r1.md](02-design-r1.md#L145-L175) currently treats B.1/B.2 as a soft later cleanup even though B.1 is the clean architectural name for the live local-LLM adapter. Required change: either promote B.1 to the recommended implementation, or explicitly scope G20 to dead-code deletion and create a concrete follow-up acceptance criterion for renaming/folding `OpenAIProvider` after G20/G21/G22. Do not leave the level-up path as an indefinite “nice later” note.

4. **The bootstrap smoke test does not test bootstrap or provider construction.**

   The validation section says `node dist/cli.js --version` verifies the `knownProviders` loop at [src/providers/router.ts](../../../../src/providers/router.ts#L105-L120), but Commander handles `--version` from [src/server/cli.ts](../../../../src/server/cli.ts#L11-L16) without invoking `bootstrap` or constructing `ModelRouter`. The CLI paths that actually create runtime/router state are commands like `start`, `inspect`, `models`, and `serve` at [src/server/cli.ts](../../../../src/server/cli.ts#L61-L72), [src/server/cli.ts](../../../../src/server/cli.ts#L222-L230), [src/server/cli.ts](../../../../src/server/cli.ts#L260-L276), and [src/server/cli.ts](../../../../src/server/cli.ts#L290-L299). Required change: replace the `--version` smoke with a command or focused test that constructs `ModelRouter` from a real config, such as the `models` command against a safe project config or a dedicated router/bootstrap test asserting the registered provider set after the deletions.

5. **The implementation plan does not name every active file affected by stale `openrouter` references.**

   If G20's desired operator-facing state is “`openrouter` is unsupported and should fail loudly,” then leaving active tests that use `openrouter` as the exemplar weakens that signal. [src/providers/types.test.ts](../../../../src/providers/types.test.ts#L11-L13) still names `openrouter` as the nested-model parse example. This may be a generic parser test rather than provider support, but the plan in [SPEC/v2/review-2026-05-round2/G20/03-plan-r1.md](03-plan-r1.md#L55-L64) only greps specs/docs for prose and does not call out active tests with stale provider vocabulary. Required change: add `src/providers/types.test.ts` to the audit and either replace the example with a live nested model string or explicitly justify why the parser test remains provider-agnostic.

6. **Live validation covers only one of the three affected daemon hosts.**

   The rollback section correctly identifies the bind-mounted hosts `saivage` (`10.0.3.111`), `diedrico` (`10.0.3.113`), and `saivage-v3` (`10.0.3.112`) at [SPEC/v2/review-2026-05-round2/G20/03-plan-r1.md](03-plan-r1.md#L142-L154), and it correctly excludes `saivage-v3-getrich-v2` (`10.0.3.170`). The validation section, however, only asks for a `saivage-v3` health check at [SPEC/v2/review-2026-05-round2/G20/03-plan-r1.md](03-plan-r1.md#L112-L118). Required change: either add post-build health checks for all three affected daemon hosts or explicitly state that live daemon validation is operator-gated and list all three host probes as the required verification when the build is deployed.

## Non-Blocking Notes

- The core dead/live claim is otherwise verified: the router constructs `PiAiProvider` for `anthropic`, `openai`, and `openai-codex` at [src/providers/router.ts](../../../../src/providers/router.ts#L779-L790), and constructs the live local providers at [src/providers/router.ts](../../../../src/providers/router.ts#L804-L809). There are no production `new AnthropicProvider`, `new OpenAICodexProvider`, `new OpenRouterProvider`, or `new OpenAIProvider` sites; constructor hits are tests only.
- The `extends OpenAIProvider` evidence is handled correctly: [src/providers/ollama.ts](../../../../src/providers/ollama.ts#L13), [src/providers/llamacpp.ts](../../../../src/providers/llamacpp.ts#L12), and the dead [src/providers/openrouter.ts](../../../../src/providers/openrouter.ts#L17) are the inheritance edges.
- The rollback guidance satisfies the “no `git reset --hard`” requirement by explicitly using `git restore <file>` and forbidding `git reset --hard` in [SPEC/v2/review-2026-05-round2/G20/03-plan-r1.md](03-plan-r1.md#L123-L128).
- Cross-finding coordination is adequately stated for G21, G22, and G26 in [SPEC/v2/review-2026-05-round2/G20/03-plan-r1.md](03-plan-r1.md#L158-L178).

VERDICT: CHANGES_REQUESTED