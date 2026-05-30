# G36 - Review r3

## Findings

No blocking findings.

## Required Change Verification

The one r2 required change is addressed. R2 flagged that the deterministic child-process tests and scratch-container probe referenced non-existent `dist/auth` artifacts. R3 now explicitly records the actual build shape (`tsup` has the single `src/server/cli.ts` entry, and `tsx` is already a dev dependency) in [01-analysis-r3.md](01-analysis-r3.md#L309-L316), matching [tsup.config.ts](../../../../tsup.config.ts#L4-L9) and [package.json](../../../../package.json#L47).

The design and plan now use the source TypeScript fixture through the existing `tsx` loader instead of requiring fixture emission into `dist/`: [02-design-r3.md](02-design-r3.md#L27), [03-plan-r3.md](03-plan-r3.md#L28), and the concrete fork call in [03-plan-r3.md](03-plan-r3.md#L164-L180) all specify `child_process.fork(..., { execArgv: ["--import", "tsx"] })` against `src/auth/__fixtures__/concurrent-writer.ts`. The plan also explicitly says not to add a `tsup` fixture entry and that the fixture never reaches `dist/` ([03-plan-r3.md](03-plan-r3.md#L242-L254)).

The scratch-container validation path is fixed too. The r3 plan replaces the r2 `/opt/saivage/dist/auth/index.js` import with `npx tsx -e` commands importing from `./src/auth/index.ts` ([03-plan-r3.md](03-plan-r3.md#L354-L383)), and it explicitly warns that `/opt/saivage/dist/auth/index.js` does not exist because `tsup` bundles only `dist/cli.js` ([03-plan-r3.md](03-plan-r3.md#L383-L385)).

## Notes

No auth-profile secret values are quoted in this review.

## Required change count

0

VERDICT: APPROVED