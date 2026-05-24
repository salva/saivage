# F32 — Review (r1)

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- [SPEC/v2/review-2026-05/F32/01-analysis-r1.md](SPEC/v2/review-2026-05/F32/01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F32/02-design-r1.md](SPEC/v2/review-2026-05/F32/02-design-r1.md)
- [SPEC/v2/review-2026-05/F32/03-plan-r1.md](SPEC/v2/review-2026-05/F32/03-plan-r1.md)
- Spot checks: [src/config.ts](src/config.ts#L34-L113), [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L7-L52), [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L1-L211)

## Findings

### Analysis

The core analysis is correct: [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L7-L52) is a stale hand-maintained `RuntimeConfig` mirror, while the live `SaivageConfig` schema includes `runtime.continuousImprovement`, `security`, `supervisor`, daemon-level `notifications`, and `mcpServers` in [src/config.ts](src/config.ts#L34-L113). The analysis also correctly keeps model-roster/default drift assigned to sibling issues rather than expanding F32.

One caveat needs to be captured before Proposal B can be handed to an implementer: [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L9-L20) is current for the missing config blocks, but it is not fully source-accurate for config location. It documents an implicit `${HOME}/.saivage/saivage.json` fallback and shared global config, while `configPath()` currently resolves through `SAIVAGE_ROOT` or project/CWD `.saivage` via [src/config.ts](src/config.ts#L119-L146). Because Proposal B makes this guide the operator-facing source of truth, the round 2 plan must either include correcting that guide text or explicitly defer that source/doc mismatch to a named issue. Given this workspace's project-local Saivage-state rule, correcting the guide as part of F32 is the cleaner option.

### Design

Proposal B is architecturally sound and better matches the no-drift goal than re-copying the Zod shape into the SPEC. Deleting the stale mirror and making the SPEC point to `SaivageConfig` plus the operator guide removes the exact maintenance failure that produced F32.

The design does not violate the no-backward-compatibility rule and does not invent extra source abstractions. It should, however, be paired with a plan that treats the guide as a maintained source, not merely as a link target.

### Plan

The plan has one blocking executability error: it requires `npm run docs:verify` and says the repo has that script, but [package.json](package.json#L12-L25) defines `docs:build` and `docs:preview`, not `docs:verify`. A required validation command that cannot run is enough to block approval under the loop conventions. Replace this with `npm run docs:build` plus the existing manual link checks, or make the command conditional only if the script is later added.

The test strategy also overstates what `npx vitest run src/config.test.ts` proves. The file exists, but it covers `expandHome`, default loading, and provider-account parsing in [src/config.test.ts](src/config.test.ts#L17-L52); it does not assert schema/prose parity or the missing top-level blocks. Keeping it as a smoke test is fine, but the r2 plan should describe it accurately or remove the schema-shape wording.

## Required changes

1. Revise [SPEC/v2/review-2026-05/F32/03-plan-r1.md](SPEC/v2/review-2026-05/F32/03-plan-r1.md) for r2 so all validation commands actually exist in this repo. In particular, remove the required `npm run docs:verify` step and the claim that it exists; use `npm run docs:build` and manual link checks unless a real `docs:verify` script is added separately.
2. Expand Step 4 in the plan to verify the promoted operator guide against [src/config.ts](src/config.ts) beyond top-level schema keys. At minimum, include the existing location mismatch in [docs/guide/config-runtime.md](docs/guide/config-runtime.md#L9-L20) versus [src/config.ts](src/config.ts#L119-L146), and make the implementation update the guide or explicitly defer it to a named issue.
3. Correct the `src/config.test.ts` validation wording. It is acceptable as a loader/defaults smoke test, but it should not be presented as proving schema-shape parity unless the plan also adds or points to a real parity assertion.

## Strengths

- The issue is scoped well: F32 fixes the SPEC/config documentation boundary without trying to solve F02/F04/F11/F33 inline.
- Proposal B is the right architectural direction for this repo: schema in source, operational prose in docs, SPEC as a stable pointer instead of a duplicate type body.
- The cross-issue ordering notes are useful and should be preserved in r2.

VERDICT: CHANGES_REQUESTED