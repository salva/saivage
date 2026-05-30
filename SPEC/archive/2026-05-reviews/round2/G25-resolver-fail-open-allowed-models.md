# G25 — Resolver fails open when `allowed_models` filters out every candidate

**Subsystem**: routing
**Category**: short-sighted
**Severity**: medium
**Transversality**: module

## Summary

After applying the per-role `allowed_models` allow-list, the resolver
checks whether any candidate survived. If none did, it returns the
original `[...allowed]` list instead of failing the resolution. Net
effect: an allow-list intersection that matches nothing degrades to
"use the allow-list as-is", which is the opposite of what an allow-list
should mean.

## Evidence (with line-linked refs)

- Fallback that returns the raw allow-list when intersection is empty:
  [src/routing/resolver.ts](src/routing/resolver.ts#L215-L225).

## Why this matters

`allowed_models` exists so operators can pin a stage or role to a
specific safe subset. When the configured candidate set drifts and no
longer intersects with the allow-list, the resolver should surface that
mismatch loudly (or fail closed) rather than silently bypass the filter.
Today an operator who tightens the allow-list could find the resolver
quietly handing requests to models that match neither the upstream
candidate list nor the operator's restriction.

## Rough remediation direction (one bullet "one conceptual level up")

- Treat an empty intersection as a resolution failure with a clear
  `NoAllowedModelMatched` error surfaced via the `RoutingTrace`; if
  graceful degradation is needed it should be an explicit, opt-in
  policy ("fall back to the allow-list") rather than the default.

## Cross-links

- Round 1: F18 (resolver fail-modes).
- G23, G24 (other resolver findings).
