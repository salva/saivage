# G20 — APPROVED

**Chosen proposal**: Design A (per [02-design-r2.md](02-design-r2.md)) — delete `AnthropicProvider`, `OpenAICodexProvider`, `OpenRouterProvider` and their unit tests; surgically prune `model-capabilities.test.ts`. Keep `OpenAIProvider` (live inheritance base for `OllamaProvider`/`LlamaCppProvider`).

**Approved by**: GPT-5.5 (copilot) reviewer at round 2 — see [04-review-r2.md](04-review-r2.md). 6 changes from r1 all addressed.

**Follow-up tickets** (filed in design): F-G20-RENAME (rename `OpenAIProvider` to `OpenAICompatProvider` after G21/G22), F-G20-OPENAI-PKG (audit whether `openai` package is still needed post-Copilot work).

**Implementation pointer**: [03-plan-r2.md](03-plan-r2.md).

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount. `saivage-v3-getrich-v2` unaffected.
