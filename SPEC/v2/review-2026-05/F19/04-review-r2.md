# F19 Review r2

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F19/01-analysis-r2.md](SPEC/v2/review-2026-05/F19/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F19/02-design-r2.md](SPEC/v2/review-2026-05/F19/02-design-r2.md)
- [SPEC/v2/review-2026-05/F19/03-plan-r2.md](SPEC/v2/review-2026-05/F19/03-plan-r2.md)
- Prior critique: [SPEC/v2/review-2026-05/F19/04-review-r1.md](SPEC/v2/review-2026-05/F19/04-review-r1.md)
- Spot-checks: [src/providers/index.ts](src/providers/index.ts#L1-L7), [src/providers/router.ts](src/providers/router.ts#L9-L12), [src/providers/router.ts](src/providers/router.ts#L720-L760), [tsup.config.ts](tsup.config.ts#L4-L20), [package.json](package.json#L1-L45), [src/index.ts](src/index.ts#L60-L88)

## Findings

### Analysis

No blocking findings. The r2 analysis fixes the r1 factual errors: [src/providers/router.ts](src/providers/router.ts#L9-L12) imports only `PiAiProvider`, `CopilotProvider`, `OllamaProvider`, and `LlamaCppProvider`, and the construction switch at [src/providers/router.ts](src/providers/router.ts#L720-L760) constructs those implementations rather than all eight provider classes.

The package/build contract is now accurately represented. [package.json](package.json#L1-L45) has no `main`, `module`, `exports`, or `types` field and exposes only the CLI bin at [package.json](package.json#L9-L11). [tsup.config.ts](tsup.config.ts#L4-L20) has a single `src/server/cli.ts` entry, so the providers barrel is not a configured build entry. The spot-check search also supported the no-importer claim: direct barrel scans returned no hits, while the broader provider-reference scan found only deep imports such as [src/server/bootstrap.ts](src/server/bootstrap.ts#L9), [src/server/cli.ts](src/server/cli.ts#L300), and [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L8).

### Design

No blocking findings. Proposal A now correctly states that completing [src/providers/index.ts](src/providers/index.ts#L1-L7) would only make dead code internally consistent unless paired with a real `package.json` exports map and `tsup` entry. Proposal B is the appropriate recommendation under the project rule to remove unused abstractions: delete the barrel and leave existing consumers on the deep imports they already use.

The design does not preserve a transitional alias, introduce a compatibility shim, or invent a future public library surface ahead of need. That matches the loop conventions and the architecture-first project guideline.

### Plan

No blocking findings. The revised pre-flight checks now cover static imports, re-exports, side-effect imports, dynamic imports, arbitrary relative depth, and `providers/index` literals across `src/` and `web/`. I also spot-checked the test layout: there is no top-level `tests/` directory, and provider/agent tests are colocated under `src/`, so the scan scope is sufficient for this repository.

The edit plan is executable and appropriately narrow: remove [src/providers/index.ts](src/providers/index.ts#L1-L7) only. The validation commands use this repo's Vitest setup via [package.json](package.json#L17-L18), and the rollback strategy is correctly single-file/single-commit.

## Required changes

## Strengths

The r2 documents cleanly separate the literal incompleteness from the architectural fact that the barrel has no consumers. The recommendation deletes accidental surface area instead of polishing it, and the implementation plan is small enough for an engineer to execute without ambiguity.

VERDICT: APPROVED