# F32 — Review (r2)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md](SPEC/v2/review-2026-05/_LOOP-CONVENTIONS.md)
- [SPEC/v2/review-2026-05/F32-saivage-config-undocumented-blocks.md](SPEC/v2/review-2026-05/F32-saivage-config-undocumented-blocks.md)
- [SPEC/v2/review-2026-05/F32/04-review-r1.md](SPEC/v2/review-2026-05/F32/04-review-r1.md)
- [SPEC/v2/review-2026-05/F32/01-analysis-r2.md](SPEC/v2/review-2026-05/F32/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F32/02-design-r1.md](SPEC/v2/review-2026-05/F32/02-design-r1.md) (still authoritative)
- [SPEC/v2/review-2026-05/F32/03-plan-r2.md](SPEC/v2/review-2026-05/F32/03-plan-r2.md)
- Spot checks: [package.json](package.json#L12-L25), [src/config.ts](src/config.ts#L74-L145), [src/config.test.ts](src/config.test.ts#L19-L57), [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L9-L21), [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L157-L236)

## Findings

### Analysis

The r1 analysis blockers are fixed. The revised analysis now describes [src/config.test.ts](src/config.test.ts#L19-L57) as loader/defaults/provider-account smoke coverage, not as schema-shape or prose-parity coverage. That matches the file's actual tests closely enough for implementation planning.

The promoted-guide mismatch is also captured correctly. [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L9-L21) still documents a `${HOME}/.saivage/saivage.json` fallback, while [src/config.ts](src/config.ts#L119-L145) resolves through `PROJECT_ROOT`, `SAIVAGE_ROOT`, an upward `.saivage/config.json` marker, or `cwd`. r2 explicitly brings that mismatch into F32 scope and correctly plans to fix the doc rather than changing runtime behavior.

### Design

[SPEC/v2/review-2026-05/F32/02-design-r1.md](SPEC/v2/review-2026-05/F32/02-design-r1.md) remains a sound design. Proposal B is still the right choice: delete the stale SPEC mirror, make [src/config.ts](src/config.ts#L34-L113) the schema source, and make the operator guide the prose source. The r2 analysis and plan fill the only missing piece from r1 by treating the guide as something that must be made source-accurate before it is promoted.

### Plan

The validation-command blocker is fixed. [package.json](package.json#L12-L25) has `typecheck`, `build`, and `docs:build`, but no `docs:verify`; [SPEC/v2/review-2026-05/F32/03-plan-r2.md](SPEC/v2/review-2026-05/F32/03-plan-r2.md) now uses the real commands and explicit `rg` checks instead of a nonexistent docs script.

The config-test blocker is fixed. The plan keeps `npx vitest run src/config.test.ts` only as a smoke regression check for [src/config.test.ts](src/config.test.ts#L19-L57), and explicitly says it is not schema-shape parity coverage.

The promoted-guide blocker is fixed. Step 4a requires replacing the inaccurate location section in [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L9-L21) with prose matching [src/config.ts](src/config.ts#L119-L145), including deletion of the home-directory fallback claim. That is a concrete, implementable edit and closes the r1 concern.

## Required changes

None.

## Strengths

- r2 narrows the implementation to documentation consolidation without source churn.
- The plan now distinguishes executable validation from manual parity review cleanly.
- Cross-issue ordering remains explicit, which matters because F02, F04, F11, and F33 can otherwise make the guide stale immediately after F32 lands.

VERDICT: APPROVED