# G21 — Analysis (round 3)

**Writer**: Claude Opus 4.7. **Scope**: provider-name list duplicated in [src/providers/router.ts](../../../../src/providers/router.ts). Supersedes [01-analysis-r2.md](01-analysis-r2.md) — same evidence and "fixed state", with the test-coverage articulation in §6 corrected to match what the live tests actually assert and what the post-r3 implementation will actually observe.

## 1. What the finding says

The same 8-name provider list ("github-copilot", "anthropic", "openai", "openai-codex", "opencode", "opencode-go", "ollama", "llamacpp") is hard-coded in four independent sites inside one file. Adding a provider therefore requires four synchronised edits; forgetting any one yields a silent partial state with no `tsc` or test signal.

## 2. Verified evidence (unchanged vs r2)

Snapshot after G20. Router imports only `CopilotProvider`, `PiAiProvider`, `OllamaProvider`, `LlamaCppProvider` — [src/providers/router.ts](../../../../src/providers/router.ts#L15-L18).

Four duplication sites in [src/providers/router.ts](../../../../src/providers/router.ts):

1. `knownProviders` literal array driving `initProviders` iteration — [src/providers/router.ts](../../../../src/providers/router.ts#L102-L119).
2. `shouldRegisterProvider` switch — registration predicate per provider — [src/providers/router.ts](../../../../src/providers/router.ts#L731-L754).
3. `createProvider` switch — factory per provider — [src/providers/router.ts](../../../../src/providers/router.ts#L766-L815).
4. `isProviderName` runtime guard — [src/providers/router.ts](../../../../src/providers/router.ts#L871-L881). Two authorities OR'd: `providerConfigs`-key fallback via `Object.prototype.hasOwnProperty.call`, and the hard-coded 8-name literal array.

The single read-side consumer of `isProviderName` is the failover expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556). That call decides whether a failover entry like `"openai-codex"` should be expanded to `openai-codex/<model>` (provider-only failover) or left as a literal candidate spec.

Out of scope for G21: `PROVIDER_TO_OAUTH` ([src/providers/router.ts](../../../../src/providers/router.ts#L64-L69)) — G22.

External string-typed references (continue to work because `ProviderName` is a subtype of `string`): [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L65), [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L73-L122), [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283), [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L416-L442), [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts#L25-L43), [src/server/cli.ts](../../../../src/server/cli.ts#L399), [src/server/cli.ts](../../../../src/server/cli.ts#L429-L434), [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L37-L98), [src/config.test.ts](../../../../src/config.test.ts#L71-L84), [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L9-L25).

## 3. Failure mode (unchanged)

- Forget site (1): provider never instantiated at boot, but registration predicate still says yes.
- Forget site (2): `default` branch silently returns `!!cfg || hasAccounts`, so the provider only registers if explicitly configured.
- Forget site (3): registers, but `createProvider` returns `undefined`, so `this.providers.set` silently drops the entry.
- Forget site (4): a failover entry containing the new name is *not* expanded with the requesting spec's model.

None caught by TypeScript today because every site uses `string` rather than a literal-union type.

## 4. Reviewer findings absorbed (cumulative)

- **R-1 round 1 (reviewer §1)** — drop the `default` branch in `shouldRegisterProvider` and the `providerConfigs`-key OR in `isProviderName`. r2 absorbed this; r3 keeps it.
- **R-2 round 1 (reviewer §2)** — `ProviderName` literal union must be derivable in the landed implementation, not deferred. r2 absorbed this via `as const satisfies readonly ProviderDescriptor[]` plus the generic `makePiAiDescriptor` helper. r3 keeps it.
- **R-1 round 2 (reviewer §1)** — the proposed arbitrary-key regression in r2 asserted `buildChain()` would still contain the raw fallback string `"not-a-real-provider"`. Under the desired implementation (descriptor-only `isProviderName`) the raw fallback never reaches the chain as a literal: `appendCandidatesForModelSpec` at [src/providers/router.ts](../../../../src/providers/router.ts#L561) parses the fallback with `tryParseModelId`, which returns `null` for a non-slashed string, so the code falls into `expandProviderIndependentCandidates` at [src/providers/router.ts](../../../../src/providers/router.ts#L578) and only emits *registered providers that can serve a model id "not-a-real-provider"* — none of the descriptor providers do. The chain therefore contains *neither* `"not-a-real-provider/claude-sonnet-4.6"` *nor* the raw string `"not-a-real-provider"`. r3 rewrites the test body so the assertion matches the observable contract.
- **R-2 round 2 (reviewer §2)** — the existing test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) is a *suppression* case (no expansion when `modelEquivalents` exists), not positive built-in provider-only expansion. r2 mis-described it as preservation coverage. r3 adds an explicit positive test that exercises descriptor-name expansion through [src/providers/router.ts](../../../../src/providers/router.ts#L556) with **no** `modelEquivalents`, and updates the r3 prose to describe the legacy test correctly.

## 5. Refined "fixed" state (unchanged from r2)

1. **Single source of truth.** Exactly one place in `router.ts` — `PROVIDER_DESCRIPTORS` — enumerates provider names and pairs each with its registration predicate and factory closure.
2. **Descriptor membership is the only provider-name predicate.** `isProviderName(value)` is true iff `value` is a key in `PROVIDER_DESCRIPTORS_BY_NAME`. The OR with `providerConfigs` keys is removed.
3. **No unknown-provider fallback in registration.** `shouldRegisterProvider` has no `default` branch returning truthy for unknown names. Either the descriptor decides, or the name is not a provider.
4. **`ProviderName` is derivable now.** The descriptor table is declared with `as const satisfies readonly ProviderDescriptor[]` and a generic helper for the pi-ai entries so each entry's `name` keeps its literal type. `typeof PROVIDER_DESCRIPTORS[number]["name"]` yields the literal union of all 8 names.
5. **Adding a 9th provider is one edit.** Append one descriptor row.

## 6. Observable behavioural delta and test articulation (corrected in r3)

Removing the `default` branch and the `providerConfigs`-key OR has two observable effects compared to head:

- **Boot.** No delta. `createProvider` already returned `undefined` for unknown names ([src/providers/router.ts](../../../../src/providers/router.ts#L811)), so unknown configured keys never instantiated even today.
- **Failover expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556).** After r3:
  - **Descriptor names still expand.** Given no `modelEquivalents` and `failover: { "github-copilot": ["openai-codex"] }`, building `"github-copilot/claude-sonnet-4.6"` still produces `"openai-codex/claude-sonnet-4.6"` in the chain. The descriptor map answers `true` for `"openai-codex"`, so the expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556) fires exactly as before. This is the *positive preservation* contract the implementation must keep.
  - **Arbitrary `providerConfigs` keys no longer expand.** A user-supplied `providerConfigs["not-a-real-provider"] = {...}` paired with `failover["github-copilot/x"] = ["not-a-real-provider"]` previously expanded to `"not-a-real-provider/x"` because the `providerConfigs`-key OR in `isProviderName` returned `true`. After r3 the descriptor map answers `false`, the fallback is passed as a literal candidate spec, `appendCandidatesForModelSpec` parses it with no slash, `expandProviderIndependentCandidates` filters registered providers that can serve model id `"not-a-real-provider"`, and none can — so neither `"not-a-real-provider/x"` nor the raw string ever appears in the chain.

Test-coverage articulation (corrected from r2):

- The existing test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) is a **suppression** test, not positive built-in provider-only expansion. It configures `modelEquivalents["github-copilot/claude-sonnet-4.6"] = ["openai-codex/gpt-5.3-codex"]` *and* `failover["github-copilot"] = ["openai-codex"]`, and asserts the chain is exactly `["github-copilot/claude-sonnet-4.6", "openai-codex/gpt-5.3-codex"]` — explicitly *not* including `"openai-codex/claude-sonnet-4.6"`. The suppression is driven by the guard at [src/providers/router.ts](../../../../src/providers/router.ts#L555) (`this.modelEquivalents.has(modelSpec)` skips provider-only expansion). It does **not** exercise the descriptor-name expansion path at [src/providers/router.ts](../../../../src/providers/router.ts#L556).
- r3 adds a new **positive** test: no `modelEquivalents`, `failover: { "github-copilot": ["openai-codex"] }`, `buildChain("github-copilot/claude-sonnet-4.6")` must contain `"openai-codex/claude-sonnet-4.6"`. This is the only direct coverage of descriptor-name expansion through [src/providers/router.ts](../../../../src/providers/router.ts#L556).
- r3 keeps the arbitrary-key regression but corrects the assertion: the only stable contract is that `"not-a-real-provider/claude-sonnet-4.6"` is **not** in the chain.

This is permitted by the project rule against backward-compatibility shims. There is no documented or tested user scenario relying on the arbitrary-key expansion — the only test using arbitrary `providerConfigs` keys ([src/providers/router.test.ts](../../../../src/providers/router.test.ts#L416-L442)) supplies a `gateway` key and only ever references full `provider/model` specs in failover.

## 7. Constraints from approved adjacent work (unchanged)

- G20 APPROVED — keep working with `CopilotProvider`, `PiAiProvider`, `OllamaProvider`, `LlamaCppProvider`. F-G20-RENAME comes *after* G21/G22.
- G22 (pending) — owns `PROVIDER_TO_OAUTH`. G21 stays out.
- G23-G26 — unrelated.

## 8. Project-rule alignment (unchanged)

- Single source of truth; no 5th wrapping table; no migration shims (including no `default` branch).
- `ProviderName` is a subtype of `string`, so external string-typed references continue to work.
- No new docstrings or comments in untouched code; new symbols may carry minimal doc.
- No over-engineering: no plugin API, no dynamic discovery, no external descriptor file.

## 9. Risk surface (unchanged)

Read-only side of router (failover chain construction, account expansion, usage snapshots, OAuth resolution) is untouched except for the one behavioural delta in §6 (failover expansion only fires for descriptor names). Constructor args verified line-by-line against [src/providers/router.ts](../../../../src/providers/router.ts#L766-L815) in r2.

## 10. Out of scope (unchanged)

- Renaming `OpenAIProvider` (F-G20-RENAME).
- OAuth-name mapping cleanup (G22).
- A real provider-plugin API or hot-loadable descriptors.
- Web/SPA — no provider-name enumerations on the UI side.

## 11. r3 deltas vs r2

- §4 — adds the two round-2 reviewer findings: arbitrary-key regression assertion was wrong; the legacy test at [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) is a suppression test, not positive expansion coverage.
- §6 — rewritten:
  - Splits the failover-expansion delta into a *preservation* clause (descriptor names still expand) and a *removal* clause (arbitrary keys no longer expand).
  - Describes [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L267-L283) explicitly as a suppression test driven by [src/providers/router.ts](../../../../src/providers/router.ts#L555), not as positive built-in expansion coverage.
  - States the new positive expansion test (no `modelEquivalents`, descriptor-name expansion observed) and the corrected arbitrary-key regression assertion.
- §1, §2, §3, §5, §7, §8, §9, §10 — unchanged in substance from r2.
