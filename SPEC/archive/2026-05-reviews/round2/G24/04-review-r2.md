# G24 - Review of round 2

## Findings

No blocking findings.

Round 2 resolves all three required changes from [SPEC/v2/review-2026-05-round2/G24/04-review-r1.md](SPEC/v2/review-2026-05-round2/G24/04-review-r1.md#L27-L29). The validation gate now matches the chosen fixture strategy: [SPEC/v2/review-2026-05-round2/G24/02-design-r2.md](SPEC/v2/review-2026-05-round2/G24/02-design-r2.md#L138-L150) scopes zero projectRoutingSchema.parse hits to production code and allows one test helper, while [SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md#L223-L235) gives separate production and test grep gates. That is consistent with the actual target: delete the resolver parses at [src/routing/resolver.ts](src/routing/resolver.ts#L96-L100) and [src/routing/resolver.ts](src/routing/resolver.ts#L145-L148), not ban test data normalization.

The omitted fixture gap is closed. The analysis names the allowed_models-only regression at [SPEC/v2/review-2026-05-round2/G24/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G24/01-analysis-r2.md#L125-L131), the design lists it with the other resolver fixture sites at [SPEC/v2/review-2026-05-round2/G24/02-design-r2.md](SPEC/v2/review-2026-05-round2/G24/02-design-r2.md#L110-L130), and the plan explicitly wraps it with routing(...) at [SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md#L168-L173). That covers the live fixture in [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L121-L127) that relies on schema defaults today.

The working-directory mismatch is fixed. The plan declares cwd saivage/ at [SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md#L24-L31), and its grep commands consistently target src paths from that cwd at [SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md#L125-L127), [SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md#L223-L235), and [SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md#L243-L255). I do not see a remaining saivage/src command in the round-2 plan.

## Verification Notes

The current source still matches the finding: the duplicate parses under review are in [src/routing/resolver.ts](src/routing/resolver.ts#L96-L100) and [src/routing/resolver.ts](src/routing/resolver.ts#L145-L148). Production bootstrap passes loadProject output directly into the resolver at [src/server/bootstrap.ts](src/server/bootstrap.ts#L120-L130); loadProject validates the config via ProjectConfigSchema in [src/store/project.ts](src/store/project.ts#L66-L70); and ProjectConfigSchema embeds projectRoutingSchema at [src/types.ts](src/types.ts#L12-L17). The proposed architecture-first fix therefore has the right validation boundary: config load validates, resolver trusts the typed shape.

The plan stays scoped to G24. It avoids runtime provider/account schemas, load-order changes, and resolver sub-refactors in line with the non-goals in [SPEC/v2/review-2026-05-round2/G24/02-design-r2.md](SPEC/v2/review-2026-05-round2/G24/02-design-r2.md#L35-L47), keeping G23/G25/G26 work out of this low-risk cleanup.

## Residual Risk

The only residual projectRoutingSchema.parse call intentionally remains in the resolver test helper. That is acceptable because [SPEC/v2/review-2026-05-round2/G24/02-design-r2.md](SPEC/v2/review-2026-05-round2/G24/02-design-r2.md#L138-L150) and [SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G24/03-plan-r2.md#L223-L235) make it an explicit test-only gate rather than a production fallback. If implementation later adds another test parse outside [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L1-L2), Step 8 tells the implementer to stop and remove it.

VERDICT: APPROVED