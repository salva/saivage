# G22 — APPROVED

**Chosen proposal**: Proposal A (per [02-design-r1.md](02-design-r1.md)) — delete the entire `PROVIDER_TO_OAUTH` constant and its JSDoc header at [src/providers/router.ts](../../../../src/providers/router.ts#L60-L69), and replace the lookup at [src/providers/router.ts](../../../../src/providers/router.ts#L174) (`const oauthId = PROVIDER_TO_OAUTH[providerName] ?? providerName;`) with direct use of `providerName`. Every downstream `oauthId` reference in `resolveApiKey` ([src/providers/router.ts](../../../../src/providers/router.ts#L184-L199)) is renamed back to `providerName`. Bodies stay structurally identical. Proposal B (keep an identity-only map) is explicitly rejected as a "comment in code" that whispers the OAuth id space might diverge from the provider name space when it does not — future drift is best caught by the OAuth profile loader rejecting unknown ids, not by a vestigial rename table.

**Approved by**: GPT-5.5 (copilot) reviewer at round 1 — see [04-review-r1.md](04-review-r1.md).

**Implementation pointer**: [03-plan-r1.md](03-plan-r1.md). Single-file two-edit change in [src/providers/router.ts](../../../../src/providers/router.ts). After G20's deletion of `AnthropicProvider`, `OpenAICodexProvider`, `OpenRouterProvider`, the `"copilot"` row is provably dead and the remaining rows are identity mappings.

**Sequencing**: G22 may land independently of G21. Both touch only [src/providers/router.ts](../../../../src/providers/router.ts), so batch them together to avoid merge churn.

**Daemon impact**: None observable; behaviour unchanged for all canonical callers. Operator-gated saivage-v3 restart not required.
