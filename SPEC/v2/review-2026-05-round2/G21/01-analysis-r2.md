# G21 — Analysis (round 2)

**Writer**: Claude Opus 4.7. **Scope**: provider-name list duplicated in [src/providers/router.ts](../../../../src/providers/router.ts). Supersedes [01-analysis-r1.md](01-analysis-r1.md) — same evidence section, tightened "fixed state" to match the round-1 reviewer's required changes.

## 1. What the finding says

The same 8-name provider list ("github-copilot", "anthropic", "openai", "openai-codex", "opencode", "opencode-go", "ollama", "llamacpp") is hard-coded in four independent sites inside one file. Adding a provider therefore requires four synchronised edits; forgetting any one yields a silent partial state with no `tsc` or test signal.

## 2. Verified evidence (re-checked against current router.ts)

Snapshot after G20 (concrete provider classes deleted). Router imports only `CopilotProvider`, `PiAiProvider`, `OllamaProvider`, `LlamaCppProvider` — [src/providers/router.ts](../../../../src/providers/router.ts#L15-L18).

Four duplication sites in [src/providers/router.ts](../../../../src/providers/router.ts):

1. `knownProviders` literal array driving `initProviders` iteration — [src/providers/router.ts](../../../../src/providers/router.ts#L102-L119).
2. `shouldRegisterProvider` switch — registration predicate per provider — [src/providers/router.ts](../../../../src/providers/router.ts#L731-L754).
3. `createProvider` switch — factory per provider — [src/providers/router.ts](../../../../src/providers/router.ts#L766-L815).
4. `isProviderName` runtime guard — [src/providers/router.ts](../../../../src/providers/router.ts#L871-L881). Note this site has **two** authorities OR'd together: a fallback to `providerConfigs` keys via `Object.prototype.hasOwnProperty.call`, and the hard-coded 8-name literal array.

The single read-side consumer of `isProviderName` is the failover expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556). That call decides whether a failover entry like `"openai-codex"` should be expanded to `openai-codex/<model>` (provider-only failover) or left as a literal model id.

Adjacent name table not in scope for G21:

- `PROVIDER_TO_OAUTH` OAuth-id map — [src/providers/router.ts](../../../../src/providers/router.ts#L64-L69). G22 owns this map.

External string-typed references to provider names (no symbol coupling, continue to work because `ProviderName` is a subtype of `string`):

- Router tests — [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L65), [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L73-L122), [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L268-L283), [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L416-L442), [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts#L25-L43).
- CLI OAuth subcommand — [src/server/cli.ts](../../../../src/server/cli.ts#L399), [src/server/cli.ts](../../../../src/server/cli.ts#L429-L434).
- Config / routing test fixtures — [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L37-L98), [src/config.test.ts](../../../../src/config.test.ts#L71-L84), [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L9-L25).

## 3. Failure mode (unchanged)

- Forget site (1): provider never instantiated at boot, but registration predicate still says yes.
- Forget site (2): `default` branch silently returns `!!cfg || hasAccounts`, so the provider only registers if explicitly configured — opaque to anyone reading (2) alone.
- Forget site (3): registers, but `createProvider` returns `undefined`, so `this.providers.set` silently drops the entry — only a runtime "Provider 'X' not registered" log surfaces.
- Forget site (4): a failover entry containing the new name is *not* expanded with the requesting spec's model — failover chain is wrong, no type error.

None of these are caught by TypeScript today because every site uses `string` rather than a literal-union type.

## 4. Round-1 reviewer findings absorbed

The r1 reviewer ([04-review-r1.md](04-review-r1.md)) flagged two CHANGES_REQUESTED items that this r2 analysis treats as load-bearing:

- **R-1 (reviewer §1)** — r1 plan kept a `default` branch in `shouldRegisterProvider` returning `!!cfg || hasAccounts`, and OR'd `providerConfigs`-key membership into `isProviderName`. That re-introduces a *second* truth source: an arbitrary string in `providerConfigs` would still pass `isProviderName` and trigger provider-only failover expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556), even though `createProvider` cannot instantiate such a name and the boot loop never registers it. That is the same silent partial state the finding objects to.
- **R-2 (reviewer §2)** — r1 plan typed descriptor names as `string` and filed the literal `ProviderName` union as a follow-up. That throws away one of the main architectural gains: with `name: string`, `typeof PROVIDER_DESCRIPTORS[number]["name"]` is just `string`, so the canonical source cannot supply a real literal union for future tightening.

## 5. Refined "fixed" state (r2)

After the fix:

1. **Single source of truth.** Exactly one place in `router.ts` — `PROVIDER_DESCRIPTORS` — enumerates provider names and pairs each with its registration predicate and factory closure.
2. **Descriptor membership is the only provider-name predicate.** `isProviderName(value)` is true iff `value` is a key in `PROVIDER_DESCRIPTORS_BY_NAME`. The OR with `providerConfigs` keys is removed. `providerConfigs` keys that are not in the descriptor table are not provider names — they are unknown configuration, not a parallel registry.
3. **No unknown-provider fallback in registration.** `shouldRegisterProvider` has no `default` branch returning truthy for unknown names. Either the descriptor decides, or the name is not a provider. Concretely, `initProviders` iterates `PROVIDER_DESCRIPTORS` directly (no string-name re-lookup) and `shouldRegisterProvider` is reduced to a descriptor-lookup that returns `false` for unknown names — or removed if no remaining caller needs it.
4. **`ProviderName` is derivable now, not later.** The descriptor table is declared with `as const satisfies readonly ProviderDescriptor[]` and a generic helper for the pi-ai-backed entries so each entry's `name` keeps its literal type. `typeof PROVIDER_DESCRIPTORS[number]["name"]` yields the literal union `"github-copilot" | "anthropic" | "openai" | "openai-codex" | "opencode" | "opencode-go" | "ollama" | "llamacpp"`. The type does not need to be exported in G21, but the implementation must make it derivable.
5. **Adding a 9th provider is one edit.** Append one descriptor row. `tsc` rules out forgetting a branch because there are no parallel branches left.

## 6. Behavioural consequences of removing the unknown-provider fallback

Removing the `default` branch and the `providerConfigs`-key OR has two observable effects compared to head:

- **Boot.** `initProviders` no longer iterates a hard-coded literal; it iterates `PROVIDER_DESCRIPTORS`. An entry in `config.providers` with a key not in the descriptor table is silently ignored at registration, exactly as it is today — `createProvider` already returns `undefined` for unknown names ([src/providers/router.ts](../../../../src/providers/router.ts#L811)), so the `this.providers.set` call would already have been skipped. No behavioural delta on the boot path.
- **Failover expansion.** The expansion at [src/providers/router.ts](../../../../src/providers/router.ts#L556) currently treats *any* key present in `providerConfigs` as a provider for the purpose of expanding `failover.<spec>: ["X"]` into `X/<model>`. After r2, that expansion only fires for descriptor names. A user-supplied `providerConfigs["bogus"] = {...}` paired with `failover["github-copilot/x"] = ["bogus"]` will now leave `"bogus"` as a literal candidate spec instead of expanding to `"bogus/x"` — which then fails at the registration check anyway because there is no `bogus` provider. The new behaviour matches the boot path (only descriptor names ever instantiate) and removes the "manufacture a candidate that will later skip as unregistered" branch the reviewer called out.

This is intentional: it collapses two divergent name oracles to one. It is permitted by the project rule against backward-compatibility shims. There is no documented or tested user scenario relying on the current behaviour — the only test using arbitrary `providerConfigs` keys ([src/providers/router.test.ts](../../../../src/providers/router.test.ts#L416-L442)) supplies a `gateway` key and never relies on `"gateway"` being expanded as provider-only failover; it always references full `provider/model` specs in failover.

If custom provider names ever become a real surface, that needs an explicit plugin/descriptor design — not the current accidental "any key in `providers` is a provider" coupling.

## 7. Constraints from approved adjacent work (unchanged)

- G20 APPROVED — concrete-class deletions already in tree. G21 must keep working with the constructors at [src/providers/router.ts](../../../../src/providers/router.ts#L15-L18): `CopilotProvider`, `PiAiProvider`, `OllamaProvider`, `LlamaCppProvider`. F-G20-RENAME (rename `OpenAIProvider` → `OpenAICompatProvider`) explicitly comes *after* G21/G22 — so G21 must not introduce churn around `OpenAIProvider`.
- G22 (pending) — will delete the `"copilot"` row in `PROVIDER_TO_OAUTH`. G21 stays out of that map.
- G23-G26 — unrelated to provider-name tables.

## 8. Project-rule alignment (unchanged direction, tightened)

Architecture-first / no backward compatibility:

- Fix removes the duplicate sources; no 5th table that "wraps" them.
- **No migration shims** — including no `default` branch in the predicate to keep the old "any configured key registers" behaviour. The r1 design kept that shim; r2 removes it.
- Tests using string literals like `"github-copilot"` still work because the union `ProviderName` is a subtype of `string`.
- No new docstrings or comments in untouched code; new symbols may carry minimal doc.
- No over-engineering: no plugin API, no dynamic discovery, no external descriptor file. Descriptor table lives in `router.ts` next to the constructors it references.

## 9. Risk surface (unchanged)

Read-only side of router (failover chain construction, account expansion, usage snapshots, OAuth resolution) is untouched. The only behavioural delta is the one called out in §6: provider-only failover via arbitrary `providerConfigs` keys is removed. The two switches are the only behavioural-divergence vector, and collapsing them into descriptor closures preserves per-provider semantics exactly (constructor args verified line-by-line against [src/providers/router.ts](../../../../src/providers/router.ts#L766-L815)).

## 10. Out of scope (unchanged)

- Renaming `OpenAIProvider` (F-G20-RENAME — deferred).
- OAuth-name mapping cleanup (G22).
- A real provider-plugin API or hot-loadable descriptors.
- Web/SPA — no provider-name enumerations on the UI side.

## 11. r2 deltas vs r1

- §1, §2 (evidence), §3, §7, §8, §9, §10 — unchanged in substance; line numbers re-verified against current [src/providers/router.ts](../../../../src/providers/router.ts).
- §4 (new) — explicitly absorbs the two reviewer-mandated changes from [04-review-r1.md](04-review-r1.md).
- §5 (was §6 in r1) — "fixed state" tightened: descriptor membership is now the only `isProviderName` answer; `shouldRegisterProvider` no longer has an unknown-provider fallback; `ProviderName` literal union must be derivable in the landed implementation, not deferred.
- §6 (new) — documents the observable behavioural delta (failover expansion no longer fires for arbitrary `providerConfigs` keys) and explains why no real user scenario regresses.
