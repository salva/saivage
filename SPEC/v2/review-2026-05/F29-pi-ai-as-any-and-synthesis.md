# F29 — `pi-ai.ts` uses `as any` / `as unknown as` and synthesises missing models by cloning siblings

**Category**: unsafe-pattern
**Severity**: medium
**Transversality**: local

## Summary

`PiAiProvider` is the thinnest adapter in the codebase but the most fragile. It calls into the upstream `pi-ai` package via repeated `as any` and `as unknown as <Some>` casts to bypass type errors, and when the upstream model catalogue doesn't include a model the user asked for, the adapter clones a sibling model entry and renames it on the fly.

## Evidence

- Heavy `as any` usage in the provider body: [src/providers/pi-ai.ts](src/providers/pi-ai.ts#L1-L289).
- The clone-a-sibling synthesis (search for "synthetic" / model-spec fall-through in the same file).

## Why this matters

The cast pattern hides upstream library breaking changes — a future `pi-ai` update will compile cleanly and crash at runtime. The synthetic-model fall-through hides bad operator configuration (a typo in `modelSpec` is silently routed to an unrelated working model). Both should fail loudly: the casts should be replaced with a small wrapper type definition; the synthetic fall-through should be removed entirely.

## Related

- F19 (pi-ai is not in the public barrel either)
- F02 (roster-style drift between what providers/config promise and what actually works)
