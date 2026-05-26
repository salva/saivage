# G10 - Review r2

## Findings

No blocking issues found.

## Verification

Proposal C remains the right direction. The live production surface still has only the dead export at [src/store/documents.ts](src/store/documents.ts#L107), and a production-source search excluding that definition and test files returns no callers. The test-file lexical surface is exactly the corrected five matches: the import at [src/store/documents.test.ts](src/store/documents.test.ts#L15), the suite header at [src/store/documents.test.ts](src/store/documents.test.ts#L135), and the three calls at [src/store/documents.test.ts](src/store/documents.test.ts#L146), [src/store/documents.test.ts](src/store/documents.test.ts#L158), and [src/store/documents.test.ts](src/store/documents.test.ts#L409). That matches the r2 analysis inventory in [SPEC/v2/review-2026-05-round2/G10/01-analysis-r2.md](SPEC/v2/review-2026-05-round2/G10/01-analysis-r2.md#L28-L34) and the r2 plan baseline in [SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md#L217-L223).

The r1 required change is addressed. R2 promotes `npm run docs:api` from optional follow-up to required implementation work in the design sketch at [SPEC/v2/review-2026-05-round2/G10/02-design-r2.md](SPEC/v2/review-2026-05-round2/G10/02-design-r2.md#L68-L91), makes it Edit 5 in the plan at [SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md#L203-L211), includes it as mandatory validation at [SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md#L257-L263), and includes it in done criteria at [SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md#L289-L296). The referenced script exists at [package.json](package.json#L22), and the development guide supports this workflow at [docs/internals/development.md](docs/internals/development.md#L68-L73).

The generated-doc expectations are also complete enough for implementation: the stale function page currently exists at [docs/api/store/documents/functions/appendDoc.md](docs/api/store/documents/functions/appendDoc.md#L1-L6), and the sidebar currently advertises the same API at [docs/api/typedoc-sidebar.json](docs/api/typedoc-sidebar.json#L1). R2 explicitly requires both to disappear through generation at [SPEC/v2/review-2026-05-round2/G10/02-design-r2.md](SPEC/v2/review-2026-05-round2/G10/02-design-r2.md#L84-L90) and [SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md#L207-L211), with a post-change zero-match check at [SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md](SPEC/v2/review-2026-05-round2/G10/03-plan-r2.md#L265-L271). That closes the stale-doc gap called out in r1.

The implementation plan stays aligned with the architecture-first rule: it deletes the attractive-nuisance API, deletes the self-preserving tests, rewrites the PlanHistory round-trip test through `writeDoc`, adds no compatibility shim, and avoids a generic lock abstraction that would conflict with the already-approved module-private lock decisions for adjacent consistency boundaries. The public API impact is correctly framed as intentional deep-import breakage rather than something to preserve at [SPEC/v2/review-2026-05-round2/G10/02-design-r2.md](SPEC/v2/review-2026-05-round2/G10/02-design-r2.md#L94-L96).

## Residual Risk

The only residual risk is operational: TypeDoc must actually clean stale generated files when the export disappears. R2 handles that with explicit file-level expectations and a zero-match done criterion, so this is an implementation-time validation concern rather than a design or plan blocker.

VERDICT: APPROVED