# G22 — Router carries a dead `copilot` entry in PROVIDER_TO_OAUTH

**Subsystem**: providers
**Category**: dead-code
**Severity**: low
**Transversality**: local

## Summary

`PROVIDER_TO_OAUTH` maps a `copilot` provider name to the
`github-copilot` OAuth profile family, but no production code path ever
passes the string `"copilot"`. The canonical name everywhere else
(`knownProviders`, `createProvider`, `isProviderName`) is
`github-copilot`. The entry is a leftover from an earlier renaming pass
that misleads readers into believing both spellings are supported.

## Evidence (with line-linked refs)

- Dead mapping entry: [src/providers/router.ts](src/providers/router.ts#L262-L266).
- Canonical names elsewhere in the same file:
  [src/providers/router.ts](src/providers/router.ts#L196-L205),
  [src/providers/router.ts](src/providers/router.ts#L741-L789).

## Why this matters

The map is the source of truth for which OAuth flow to fire for a
provider; the orphaned key invites someone to type `"copilot"` and
quietly get partial behaviour (OAuth resolves, registration does not).
It also obscures whether the routing table is intentionally lenient or
just stale.

## Rough remediation direction (one bullet "one conceptual level up")

- Remove the `copilot` key and type `PROVIDER_TO_OAUTH` against the
  canonical `ProviderName` union proposed in G21 so the compiler
  rejects any future drift between provider names and OAuth wiring.

## Cross-links

- G21 (provider name list duplication, same file).
- Round 1: F08, F33.
