# G22 — Analysis (round 1)

**Writer**: Claude Opus 4.7.
**Finding**: [G22-router-dead-copilot-oauth-mapping.md](../G22-router-dead-copilot-oauth-mapping.md).
**Subsystem**: providers (see [00-SUBSYSTEM-MAP.md](../00-SUBSYSTEM-MAP.md)).

## 1. What the finding asserts

`PROVIDER_TO_OAUTH` in [src/providers/router.ts](../../../../src/providers/router.ts#L62-L69) carries a `"copilot" -> "github-copilot"` row that no production caller ever exercises. The canonical Saivage provider name is `"github-copilot"`; the orphan key is leftover from an earlier rename.

## 2. Verification on disk

### 2.1 The map, today

[src/providers/router.ts](../../../../src/providers/router.ts#L62-L69):

```
const PROVIDER_TO_OAUTH: Record<string, string> = {
  "openai-codex": "openai-codex",
  "anthropic": "anthropic",
  "github-copilot": "github-copilot",
  "copilot": "github-copilot",
};
```

It is read in exactly one place, [src/providers/router.ts](../../../../src/providers/router.ts#L174):

```
const oauthId = PROVIDER_TO_OAUTH[providerName] ?? providerName;
```

The fallback `?? providerName` is the identity. Of the four declared rows, **three are identity mappings** (`openai-codex`, `anthropic`, `github-copilot`) and **one is the dead rename** (`copilot -> github-copilot`). Removing the `copilot` row makes the entire map equivalent to the identity function — i.e. the whole map is dead code, not just one row.

### 2.2 Callers of `resolveApiKey` only ever pass canonical names

Static call sites in [src/providers/router.ts](../../../../src/providers/router.ts):

- L154 (self-call inside `chat` / failover) uses the provider name parsed from the model spec via `parseModelId`, which originates from `knownProviders` literals at [src/providers/router.ts](../../../../src/providers/router.ts#L105-L114) — none of which is `"copilot"`.
- L174 reads the map; same caller passes the canonical name.

Existing tests already canonicalise to `"github-copilot"`:

- [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L441-L442) — `router.resolveApiKey("github-copilot", …)`.
- [src/providers/router.test.ts](../../../../src/providers/router.test.ts#L471-L472) — anthropic identity branch (also identity-mapped today).

A workspace-wide grep for the bare string `"copilot"` returns exactly two production hits:

- [src/providers/router.ts](../../../../src/providers/router.ts#L68) — the dead map row.
- [src/providers/copilot.ts](../../../../src/providers/copilot.ts#L104) — `readonly name = "copilot"` on `CopilotProvider`. **This is the `BaseProvider.name` display string used by `classifyProviderError(errorRaw, provider.name)` ([src/providers/router.ts](../../../../src/providers/router.ts#L457)) and by the CLI login banner ([src/server/cli.ts](../../../../src/server/cli.ts#L426)).** It does not flow into `resolveApiKey`'s keying. Inconsistency with the canonical `"github-copilot"` routing name is real but out of scope for G22 (see §5).

### 2.3 OAuth backend does not require the rename

[src/auth/store.ts](../../../../src/auth/store.ts#L92) (`getOAuthApiKey`) accepts an OAuth provider id; profiles are keyed by the same canonical ids that `knownProviders` already uses (`anthropic`, `openai-codex`, `github-copilot`). Removing the indirection does not change what string `getOAuthApiKey` receives in practice — every callsite already passes the canonical name into `resolveApiKey`.

## 3. Why the finding is correct

- The `"copilot"` row is unreachable. No production code path produces the literal `"copilot"` as the input to `resolveApiKey`.
- The remaining three rows are identity, so the map's only behavioural effect today is to rename a string that is never produced. That is, by definition, dead code.
- The constant misleads readers into believing both spellings are supported (e.g. that the `BaseProvider.name = "copilot"` from [src/providers/copilot.ts](../../../../src/providers/copilot.ts#L104) might somehow flow back through this map). It does not, and a future drift would be a silent bug — the `?? providerName` fallback would resolve a profile under whatever string was passed in.

## 4. Adjacent in-flight work (deconflict surface)

Three round-2 findings touch the exact same file/lines:

- **G21** (round 1 only, not yet approved) — refactors `initProviders`/`shouldRegisterProvider` into a `PROVIDER_DESCRIPTORS` table. G21's plan ([G21/03-plan-r1.md](../G21/03-plan-r1.md)) explicitly carves out `PROVIDER_TO_OAUTH` for G22 ([G21/03-plan-r1.md](../G21/03-plan-r1.md) §1.1 sidebar). G22's edits land at distinct lines from G21's edits (L62-L69 vs L102-L121 / L731-L754).
- **G36** ([G36/03-plan-r1.md](../G36/03-plan-r1.md)) — proposes moving `PROVIDER_TO_OAUTH` out of `router.ts` into an auth-adjacent module. If G22 deletes the map first, G36 has nothing to move; G36 will need its dependency re-checked once G22 lands.
- **G20** (APPROVED, [G20/APPROVED.md](../G20/APPROVED.md)) — already deleted `AnthropicProvider`, `OpenAICodexProvider`, `OpenRouterProvider`. Confirms the four rows in `PROVIDER_TO_OAUTH` are the only legitimate surface for OAuth-bearing providers (Anthropic, OpenAI-Codex, GitHub-Copilot); after G20 there is no other provider whose name might diverge from its OAuth id.

## 5. Out of scope (separate followups)

- **`CopilotProvider.name = "copilot"` vs canonical `"github-copilot"`** ([src/providers/copilot.ts](../../../../src/providers/copilot.ts#L104)). Same conceptual smell as G22, but on the provider's display string used in error classification and the CLI login banner. Worth a dedicated finding (suggested followup: F-G22-COPILOT-PROVIDER-NAME, "align `CopilotProvider.name` with the routing key").
- The `ProviderName` union envisioned in the finding's remediation is G21's deliverable; G22 must not depend on a not-yet-approved seam.

## 6. Risk and blast radius

- **Severity**: low — pure dead-code removal; behaviour for canonical names is unchanged.
- **Transversality**: local — single file, single map, single read site.
- **Operator impact**: none. No on-disk schema, no config key, no CLI surface, no API contract.
- **Daemon impact**: same bind-mount fleet as G20 (`saivage`, `diedrico`, `saivage-v3`); `saivage-v3-getrich-v2` unaffected. A restart is only required if the operator wants the cleaned binary live; functional behaviour does not change.
