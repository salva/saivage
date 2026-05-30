# G24 — Routing resolver re-parses the project routing schema on every call

**Subsystem**: routing
**Category**: bad-design
**Severity**: low
**Transversality**: module

## Summary

`resolve()` invokes `projectRoutingSchema.parse(...)` on the supplied
project routing config on every resolution, even though the caller has
already validated the same object when loading project config. The Zod
parse builds a fresh deep-copied output object per call, which both
adds avoidable allocation pressure and makes the hot path's behaviour
silently depend on whether or not the caller pre-validates.

## Evidence (with line-linked refs)

- First parse during input normalisation: [src/routing/resolver.ts](src/routing/resolver.ts#L95-L100).
- Second parse downstream during chain assembly: [src/routing/resolver.ts](src/routing/resolver.ts#L145-L155).

## Why this matters

The resolver runs once per LLM call. The redundant Zod work is wasted
CPU and produces two parallel "validated" copies of the same payload,
which complicates reasoning about object identity in tests. It also
papers over the fact that the resolver's input contract isn't actually
typed — callers can pass anything because the schema is the only
guard.

## Rough remediation direction (one bullet "one conceptual level up")

- Move the Zod parse into the configuration loader and have `resolve()`
  accept `z.output<typeof projectRoutingSchema>` so the hot path
  trusts its types and the validation runs exactly once at config load
  time.

## Cross-links

- Round 1: F26 (resolver perf / object churn), F18 (resolver contract).
- G23, G25 (other resolver-design issues).
