# G26 - Review (round 5, GPT-5.5)

## Findings

1. The proposed preprocess guard does not actually produce the clean typed rejection contract the round now claims. Both the design and plan add a custom issue and then `return z.NEVER` without marking the issue fatal ([02-design-r5.md](02-design-r5.md#L94-L99), [03-plan-r5.md](03-plan-r5.md#L163-L168)). Under the installed Zod 3.x runtime ([package.json](../../../../package.json#L39)), a non-fatal preprocess issue does not abort the inner object parse; the returned `z.NEVER` is still handed to `projectConfigObjectSchema`, so an otherwise valid config containing the legacy key receives the desired custom issue at `model_overrides` plus misleading required-field errors for fields that were actually present. That contradicts the targeted contract in the analysis ([01-analysis-r5.md](01-analysis-r5.md#L296-L301)) and the design's operator-facing promise of a single, unambiguous `model_overrides` error ([02-design-r5.md](02-design-r5.md#L120-L123)). The planned rejection test would not catch this because it only checks that some issue path equals the runtime-built key ([03-plan-r5.md](03-plan-r5.md#L389-L390)). Required change: mark the custom issue fatal before returning `z.NEVER`, and strengthen the test to assert the otherwise-valid legacy fixture produces exactly the custom Zod issue at path `[LEGACY_KEY]` with no spurious inner-schema required-field errors.

## Required Change Coverage

Round-4 required change 1 is mostly addressed but still needs the fatal-abort fix above. The switch from `.passthrough()` to a preprocess-wrapped plain `z.object` preserves the current strip behavior for unrelated unknown keys, and the new positive regression explicitly asserts that `notifications` and `provider` parse successfully and are absent from the parsed output ([03-plan-r5.md](03-plan-r5.md#L416-L436)). The remaining gap is only the exact rejection surface for the legacy key.

Round-4 required change 2 is addressed. The daemon-impact language now says known configs still load and their unrelated unknown keys remain stripped from parsed project config, not passed through ([01-analysis-r5.md](01-analysis-r5.md#L240-L250)).

Round-4 required change 3 is addressed. The stale `.passthrough()` implementation is moved to a rejected proposal, and the live proposal shows one runtime-built-key implementation for the production schema ([02-design-r5.md](02-design-r5.md#L67-L103), [02-design-r5.md](02-design-r5.md#L419-L437)). The final grep gates are scoped so the production source, docs guide, resolver test, and schema-rejection test all stay clean for the bare `model_overrides` token after implementation ([03-plan-r5.md](03-plan-r5.md#L510-L524)).

## Anchor Check

No regression found in the r4 anchor inventory. The live schema still has the current plain `ProjectConfigSchema` and legacy field at the cited range ([src/types.ts](../../../../src/types.ts#L12-L30)); the resolver anchors for the input member, source union, fallback call, preferred-model fallback, runtime/legacy helpers, and source classifier still match the r5 inventory ([src/routing/resolver.ts](../../../../src/routing/resolver.ts#L54-L57), [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L66-L77), [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L106-L131), [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L204-L220), [src/routing/resolver.ts](../../../../src/routing/resolver.ts#L247-L269)); and the legacy resolver test still occupies the cited body ([src/routing/resolver.test.ts](../../../../src/routing/resolver.test.ts#L5-L28)).

## What Holds

The architectural direction is sound: delete `model_overrides` from the schema, stop seeding it, remove `resolveLegacyModels`, narrow `ResolvedModelRoute.source`, replace the legacy-source regression, and drop guide references. The strip-semantics regression and production grep-gate plan are now in the right shape. Once the preprocess rejection is made fatal and the test pins the exact custom issue surface, this should be approvable.

VERDICT: CHANGES_REQUESTED