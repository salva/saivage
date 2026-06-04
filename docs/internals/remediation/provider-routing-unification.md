# Provider Routing Unification Design

## Problem

Provider routing currently has overlapping concepts in two layers:

- `ModelRoutingResolver` resolves role model/auth/account preferences.
- `ModelRouter` re-parses provider/model specs, account refs, default accounts, auth profiles, model eligibility, credentials, usage ranking, failover, health, sticky failover, provider registration, and provider calls.

The first simplification pass extracted some helpers, but ownership is still split enough that provider/account behavior is hard to change safely.

## Goals

- One canonical representation of a resolved model/provider/account route.
- Keep `ModelRouter` as the public facade while shrinking its policy ownership.
- Make credential lookup testable without provider calls.
- Make candidate planning testable without OAuth or provider instances.
- Preserve existing failover, usage ordering, and account behavior unless tests deliberately change it.

## Non-Goals

- Do not remove support for provider-independent model names.
- Do not remove failover or sticky failover behavior.
- Do not introduce a global provider registry service outside the runtime process.
- Do not read or expose provider secrets in tests or logs.

## Canonical Route Object

Evolve the existing `ResolvedModelRoute` type in `src/routing/resolver.ts` rather than introducing a second conflicting type with the same name. If implementation needs a router-internal shape, name it differently, such as `ProviderExecutionRoute`, and provide an explicit mapping from the existing resolver output.

```ts
interface ResolvedModelRoute {
  role: string;
  requestedModelSpec: string;
  provider: string | null;
  model: string;
  authProfileKey?: string;
  accountRef?: string;
  preferredAccountRefs?: string[];
  allowedAccountRefs?: string[];
  source?: string;
}
```

Rules:

- If `requestedModelSpec` is provider-qualified, `provider` and `model` are set directly.
- If it is provider-independent, `provider` is `null` until candidate planning expands it.
- `accountRef` is normalized to `provider.account` when provider is known.
- Provider-independent routes must preserve raw account constraints until provider expansion. Carry `accountRef`, `preferredAccountRefs`, and `allowedAccountRefs` even when `provider` is `null`; candidate planning applies only refs matching each expanded provider.
- A route may carry `authProfileKey` or `accountRef`; explicit auth profile wins over default account selection.
- Explicit auth profile must also suppress account candidate expansion. The candidate chain should contain a single provider/model candidate with provider/model health key because provider lookup ignores account-specific instances when `authProfileKey` is present.
- Existing `resolve(role)` consumers must continue receiving the current scalar fields until `AgentContext` and router calls migrate.

## Proposed Components

### `ProviderRegistry`

Owns provider descriptors and provider/account instances.

Responsibilities:

- Decide which providers register at startup.
- Create base provider instances.
- Create account-specific provider instances.
- List providers and models.
- Expose provider capabilities and token counting.

### `CredentialResolver`

Owns all auth-store and API-key lookup.

Responsibilities:

- Merge provider/account headers.
- Resolve explicit auth profile key.
- Resolve account auth profile.
- Resolve account static key.
- Resolve provider static key.
- Resolve default OAuth key.

### `CandidatePlanner`

Owns pure candidate expansion.

Inputs:

- Resolved route.
- Provider names.
- Provider/account model eligibility callbacks.
- Failover chains.
- Model equivalents.
- Sticky failover state snapshot.
- Usage/account ordering callbacks.

Output:

- Ordered `ChatCandidate[]` with `spec`, optional `accountRef`, and `healthKey`.

Candidate planning should consume an immutable provider/account model-eligibility snapshot. Current callbacks can inspect provider instances through `listModels()`; snapshotting after provider registration and cache warmup removes hidden provider-instance coupling from pure candidate planning.

### `ProviderCaller`

Owns a single provider request.

Responsibilities:

- Apply timeout.
- Set request model.
- Call provider.
- Classify provider errors.
- Attach response source metadata.
- Record lightweight metrics/logging.

### `RoutingState`

Owns mutable failover policy state.

Responsibilities:

- Health cooldowns.
- Sticky failover primary retry windows.
- Startup usage snapshots and candidate ranking.

This can start as current `ModelHealthTracker`, `StickyFailoverManager`, and usage helpers; do not combine them unless coordination becomes clearer.

## Migration Plan

### Step 1 — Add route-object tests

Before moving code, add tests for:

- Role model assignment with default fallback.
- Provider-qualified model route.
- Provider-independent model route.
- Explicit account ref.
- Default account selection.
- Explicit auth profile suppressing default account selection.
- Provider-independent model with raw account constraints preserved until provider expansion.

### Step 2 — Extend `ModelRoutingResolver`

- Evolve the existing `ResolvedModelRoute` or add a differently named execution-route type; do not create two incompatible `ResolvedModelRoute` interfaces.
- Keep existing `resolve(role)` API as a compatibility wrapper.
- Use the new method in agent context construction first.
- Specify the `AgentContext` migration: initially keep `modelSpec`, `authProfileKey`, and `accountRef` scalar fields and derive them from the route object; only add a route object to `AgentContext` after `LlmClient.chat()`, `getMaxContextTokens()`, `countTokens()`, and `resetModelHealth()` accept it or have compatibility overloads.

### Step 3 — Extract `CredentialResolver`

- Move `resolveApiKey()` and account/provider header merge logic.
- Keep `ModelRouter.resolveApiKey()` as a delegating compatibility method until call sites migrate.

### Step 4 — Extract `ProviderRegistry`

- Move provider descriptors and provider/account instance cache.
- Move provider creation and provider/account lookup.
- Keep `ModelRouter.listProviders()`, `listModels()`, `getMaxContextTokens()`, and `countTokens()` as facade methods.
- Preserve startup ordering: register providers, run usage/credential inspection that may call `setApiKey()`, then warm model caches, then expose synchronous capability lookups. This ordering currently protects Copilot model caches from being reset after warmup.

### Step 4.5 — Snapshot provider/account model eligibility

- After provider registration and cache warmup, build a snapshot of provider/account model eligibility.
- Pass that snapshot to candidate planning instead of callbacks that call provider instances.
- Refresh the snapshot only through explicit registry/model-list refresh paths.
- Rebuild model-equivalence discovery after warmup, or derive equivalence from the same post-warmup eligibility snapshot, so async/cache-backed providers are not skipped.

### Step 5 — Thin `ModelRouter.chat()`

- `ModelRouter.chat()` should become: resolve route, build candidates, execute candidates, update routing state.
- Move timeout/error classification into `ProviderCaller`.
- Keep health/sticky behavior semantically identical.

## Design Constraints

- Candidate planning cannot call OAuth or mutate provider instances.
- Credential resolution cannot call model providers.
- Provider registry cannot know role names.
- Usage ranking can inspect providers at startup, but must not affect credential ownership.
- Provider/account keys must not be logged.
- Explicit-auth requests must not expand into account-specific candidates or account-specific health keys.

## Validation

- Existing `src/providers/*` tests.
- Existing `src/routing/*` tests.
- New focused tests for `ResolvedModelRoute`.
- New focused tests for `CredentialResolver` with fake auth functions.
- New focused tests for `ProviderRegistry` using fake descriptors.
- End-to-end router tests covering failover and account ordering.

## Expected Result

After this design is implemented, adding a provider or changing account selection should not require editing a large router method. The public `ModelRouter` remains stable, but most behavior is tested through smaller units.
