# F15 — Bootstrap's `injectOAuthTokens` overlaps with router's lazy `resolveApiKey`

**Category">: duplication
**Severity**: low
**Transversality**: module

## Summary

Two independent paths can resolve an OAuth token for a provider call: `bootstrap.injectOAuthTokens` runs at startup and pushes resolved tokens into the provider registry, and `ModelRouter.resolveApiKey` resolves on first use if the registry entry is empty. The two paths can disagree about which profile is the right one for an account (auth-profile selection depends on `accountRef` which only the router knows about).

## Evidence

- Eager injection at bootstrap: see `injectOAuthTokens` in [src/server/bootstrap.ts](src/server/bootstrap.ts).
- Lazy resolution: `ModelRouter.resolveApiKey` and its callers in [src/providers/router.ts](src/providers/router.ts).
- Auth profile resolution itself uses `Object.entries().find()` per lookup: [src/auth/store.ts](src/auth/store.ts) (`oauthToProviderName` mapping + the lookup helpers).

## Why this matters

Eager injection means startup must touch every auth profile (latency on cold start), and the cached token is then used for every subsequent chat call regardless of which account the agent's `ctx.accountRef` selected. Lazy resolution alone would honour the account ref and avoid the startup cost; eager + lazy together cause the system to silently use the first cached token when an agent wanted a specific account.

## Related

- F27 (OAuth client IDs embedded in source)
