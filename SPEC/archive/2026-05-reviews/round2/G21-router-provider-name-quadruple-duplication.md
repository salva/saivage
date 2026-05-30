# G21 — Provider-name list duplicated four times inside `router.ts`

**Subsystem**: providers
**Category**: inconsistency
**Severity**: medium
**Transversality**: module

## Summary

The set of supported provider names is hard-coded in four independent
spots inside the same file: a `knownProviders` array, a switch in
`shouldRegisterProvider`, a switch in `createProvider`, and a fallback
list in `isProviderName`. Adding a provider therefore requires editing
all four; forgetting any one yields silent partial registration with no
type-system or test signal.

## Evidence (with line-linked refs)

- `knownProviders` literal array: [src/providers/router.ts](src/providers/router.ts#L196-L205).
- `shouldRegisterProvider` switch: [src/providers/router.ts](src/providers/router.ts#L703-L722).
- `createProvider` switch: [src/providers/router.ts](src/providers/router.ts#L741-L789).
- `isProviderName` runtime guard list: [src/providers/router.ts](src/providers/router.ts#L862-L872).

## Why this matters

Each duplicate is a separate truth source for "what counts as a provider".
A new provider added only to `createProvider` will compile and pass
provider-construction tests yet silently fail the
`shouldRegisterProvider` gate, leaving roster lookups broken. The
divergence is exactly the kind of inconsistency that hides until a
runtime "unknown provider" error surfaces in production.

## Rough remediation direction (one bullet "one conceptual level up")

- Introduce one canonical `PROVIDERS` const (TypeScript `as const` tuple
  or a `Record<ProviderName, ProviderDescriptor>`) and derive the
  `ProviderName` type, the registration gate, the factory dispatch, and
  the runtime guard from it; the literal list disappears from
  `router.ts` everywhere except that one declaration.

## Cross-links

- G20 (dead concrete provider classes — same file).
- G22 (dead `copilot` OAuth mapping — same pattern).
- Round 1: F33 (provider naming drift).
