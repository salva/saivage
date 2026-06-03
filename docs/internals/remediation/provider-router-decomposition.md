# Provider Router Decomposition

## Problem

`ModelRouter` currently owns provider registration, OAuth/static credential
resolution, account selection, model assignment, model equivalent expansion,
failover chains, sticky failover, usage inspection, provider health, token
counting, capabilities, and provider request timeout.

This makes model-routing behavior hard to reason about and hard to test in
isolation.

## Goal

Keep one public router facade. Split policies and providers only where doing so
clearly improves testability or removes real change risk. This is lower priority
than the agent loop, runtime factory, built-ins, persistence, and server
boundaries.

## Target Components

### `ProviderRegistry`

- Registers available provider descriptors.
- Creates provider instances.
- Owns provider/account instance cache.
- Exposes provider capabilities and model lists.

### `CredentialResolver`

- Resolves auth profile, account API key, provider API key, and default OAuth.
- Applies provider/account headers where needed.
- Contains all auth-store coupling.

### `ModelAssignmentResolver`

- Resolves role to requested model spec.
- Handles default model assignment.
- Reports missing role models.

### `CandidatePlanner`

- Expands provider-independent models.
- Expands accounts.
- Applies model equivalents.
- Applies failover chain expansion.
- Produces ordered `ChatCandidate[]`.

### `UsageRanker`

- Inspects startup usage.
- Normalizes provider/account quota snapshots.
- Sorts provider/account candidates.

### `FailoverState`

- Tracks per-candidate health.
- Tracks sticky failover and primary retry windows.
- Decides skip/try/mark-failed/mark-success.

### `ProviderCaller`

- Applies request timeout.
- Calls provider.
- Classifies provider errors.
- Records lightweight call metrics/logging.

## Public Facade

`ModelRouter` can remain the public facade initially:

- `init()`
- `chat()`
- `resolveModelForRole()`
- `getMaxContextTokens()`
- `countTokens()`
- `listProviders()`
- `listModels()`
- `resetModelHealth()`

The facade should delegate to the components above.

## Migration Strategy

1. Add focused tests around the behavior that is currently hard to change.
2. Prefer pure helper extraction before adding classes.
3. Extract credential resolution into `CredentialResolver` if auth coupling is
   the active pain point.
4. Extract candidate-chain construction into `CandidatePlanner` with golden
   tests for existing failover/equivalence/account behavior.
5. Extract sticky failover and health maps into `FailoverState` if failover
   changes are risky.
6. Extract request timeout and error classification into `ProviderCaller` if
   provider-call behavior needs isolated tests.
7. Extract usage snapshot normalization and ordering into `UsageRanker` only if
   quota ranking needs active changes.
8. Shrink `ModelRouter` gradually; do not introduce all components at once.

## Validation

- Existing router tests pass unchanged.
- Add focused tests for each extracted policy.
- Ensure no provider call happens during pure candidate planning tests.
- Ensure OAuth lookup is only in `CredentialResolver` tests.

## Expected Result

Routing behavior becomes inspectable. Provider additions, account weighting,
OAuth fixes, and failover tuning can be changed without editing a 1000-line
class.
