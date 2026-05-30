# G21 — Analysis (round 1)

**Writer**: Claude Opus 4.7. **Scope**: provider-name list duplicated in [src/providers/router.ts](../../../../src/providers/router.ts).

## 1. What the finding says

The same 8-name provider list ("github-copilot", "anthropic", "openai", "openai-codex", "opencode", "opencode-go", "ollama", "llamacpp") is hard-coded in four independent sites inside one file. The original finding cites stale line ranges; the actual current locations are listed below.

## 2. Verified evidence

Snapshot taken after G20 (concrete provider class deletion) landed, i.e. router.ts imports only `CopilotProvider`, `PiAiProvider`, `OllamaProvider`, `LlamaCppProvider` ([src/providers/router.ts](../../../../src/providers/router.ts#L15-L18)).

Duplication sites in [src/providers/router.ts](../../../../src/providers/router.ts):

1. `knownProviders` literal driving `initProviders` iteration — [src/providers/router.ts](../../../../src/providers/router.ts#L105-L114).
2. `shouldRegisterProvider` switch — registration predicate per provider — [src/providers/router.ts](../../../../src/providers/router.ts#L731-L754).
3. `createProvider` switch — factory per provider — [src/providers/router.ts](../../../../src/providers/router.ts#L766-L815).
4. Fallback literal inside the module-level `isProviderName` guard — [src/providers/router.ts](../../../../src/providers/router.ts#L871-L881).

Adjacent but separately-tracked tables that also reference provider names (not in scope here — owned by other findings):

- `PROVIDER_TO_OAUTH` OAuth-id map — [src/providers/router.ts](../../../../src/providers/router.ts#L64-L69). The dead `"copilot"` row is the subject of G22; G21 does not touch this map.
- The `case "github-copilot"` headers branch inside `createProvider` consults [src/providers/copilot-client-headers.ts](../../../../src/providers/copilot-client-headers.ts) indirectly via merged `providerConfig.headers`. No duplication here, just one branch.

External references to provider names that must keep working (string-typed, no symbol coupling):

- Router unit tests — [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L65), [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L73-L122), [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L416-L442), [src/providers/copilot-router.test.ts](../../../../src/providers/copilot-router.test.ts#L25-L43).
- CLI OAuth subcommand — [src/server/cli.ts](../../../../src/server/cli.ts#L399), [src/server/cli.ts](../../../../src/server/cli.ts#L429-L434).
- Config / routing test fixtures — [src/config-validation.test.ts](../../../../src/config-validation.test.ts#L37-L98), [src/config.test.ts](../../../../src/config.test.ts#L71-L84), [src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L9-L25).

`grep -rn "knownProviders\|isProviderName\|shouldRegisterProvider" src/ web/src/` confirms the four sites are the only references; no other module imports them — they are all private to router.ts (`isProviderName` is module-private, the two methods are `private`, `knownProviders` is function-local).

## 3. Functional impact

The finding's failure mode is real and easy to trigger: adding a 9th provider requires four synchronized edits. Forgetting any single one yields a silent partial state:

- Forget (1): provider never instantiated at boot, but registration predicate still says yes.
- Forget (2): default branch returns `!!cfg || hasAccounts`, so the provider only registers if explicitly configured — opaque to anyone reading (2) alone.
- Forget (3): registers, but `createProvider` returns `undefined`, so `this.providers.set` silently drops the entry — only a runtime "Provider 'X' not registered" log surfaces.
- Forget (4): failover entry `"X"` (provider-only) inside `failover.<spec>` is treated as a literal model id instead of being expanded with the requesting spec's model — the chain becomes wrong without any type error.

None of these are caught by TypeScript today because every site uses `string` rather than a literal-union type.

## 4. Constraints from approved adjacent work

- G20 APPROVED (per [../G20/APPROVED.md](../G20/APPROVED.md)) — concrete-class deletions already in tree. G21 must keep working with the post-G20 set of constructors: `CopilotProvider`, `PiAiProvider("anthropic"|"openai"|"openai-codex"|"opencode"|"opencode-go")`, `OllamaProvider`, `LlamaCppProvider`. The follow-up F-G20-RENAME (rename `OpenAIProvider` → `OpenAICompatProvider`) explicitly says it should happen after G21/G22 — so G21 must not introduce new churn around `OpenAIProvider` either.
- G22 (pending) — will delete the `"copilot"` row in `PROVIDER_TO_OAUTH`. G21 stays out of that map.
- G23-G26 (resolver findings, pending) — unrelated to provider-name tables; resolver consults `providerConfigs` keys, not the router's internal tables.

## 5. Project-rule alignment

Architecture-first / no backward compatibility:

- The fix must remove the duplicate sources, not merely add a 5th table that "wraps" them.
- No migration shims. Tests using string literals like "github-copilot" still work because the union type is still a subtype of `string`.
- No new docstrings or comments in untouched code; new symbols may carry minimal doc.
- No over-engineering: there is no need to invent a plugin-registration API, dynamic discovery, or external descriptor file — the descriptor table can live inside `router.ts` next to the constructors it references.

## 6. What "fixed" means

After the fix:

- There is exactly one place in `router.ts` that enumerates provider names.
- That single source drives boot iteration, the registration predicate, the factory, and the runtime guard.
- The `ProviderName` type is derivable from the same source so future call-sites can opt in to literal typing without a second edit.
- A 9th provider is added by appending one entry; `tsc` flags any forgotten branch via exhaustiveness on the descriptor type (no switch fallthrough left to silently default).

## 7. Risk surface

Read-only side of router (failover chain, account expansion, usage snapshots, OAuth resolution) is untouched by either proposal: it already operates on `providerConfigs` keys and on whatever names are present in `this.providers`. The two switches are the only behavioural-divergence vector, so collapsing them is low-risk provided the resulting factory preserves the exact constructor calls present today.

## 8. Out of scope

- Renaming `OpenAIProvider` (F-G20-RENAME — deferred).
- OAuth-name mapping cleanup (G22).
- Adding a real provider-plugin API or hot-loadable descriptors.
- Web/SPA — no provider-name enumerations on the UI side ([web/src/](../../../../web/src/) grep clean).
