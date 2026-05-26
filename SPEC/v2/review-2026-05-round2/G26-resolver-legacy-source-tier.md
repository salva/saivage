# G26 — Resolver still exposes a `"legacy"` source tier in its merge order

**Subsystem**: routing
**Category**: dead-code
**Severity**: low
**Transversality**: local

## Summary

The resolver's source enumeration retains a `"legacy"` tier in the
merge order and trace output, even though the project guidelines
explicitly forbid backwards-compatibility shims. The tier is documented
as covering pre-v2 routing files but no live path produces a `legacy`
entry today, so the constant survives only as misleading vocabulary in
traces and config docs.

## Evidence (with line-linked refs)

- `legacy` source listed alongside the live merge sources:
  [src/routing/resolver.ts](src/routing/resolver.ts#L70-L78).
- Source name referenced again when building trace entries:
  [src/routing/resolver.ts](src/routing/resolver.ts#L240-L260).

## Why this matters

"Legacy" tiers are exactly the kind of migration scaffolding the
workspace rules say to remove rather than preserve. Leaving it in
keeps the type union and trace UI cluttered, suggests to readers that
pre-v2 inputs are still supported, and forces every code path that
switches on the source to handle a case that never occurs.

## Rough remediation direction (one bullet "one conceptual level up")

- Delete the `"legacy"` variant from the source union, drop the merge
  step that would consume it, and update the routing trace UI to match;
  fail loudly if any on-disk routing artefact still references the old
  format.

## Cross-links

- Workspace guideline: architecture-first, no backward compatibility.
- G23, G24, G25 (other resolver findings).
