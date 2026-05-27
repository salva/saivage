# F02 implementation plan review

Reviewed plan: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md)

Binding inputs: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-review-r4.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-review-r4.md)

## Findings

No blocking findings. The plan is implementer-ready.

## Verification

- Batch (f) now targets the reviewed r5 artifact consistently: the batch table names [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md#L47), the detailed file list names the same artifact at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md#L329), and the batch-(f) commit command stages [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r5.md#L356).
- No stale [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md) or [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r4.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r4.md) artifact target remains in the r5 plan.
- The Fc/Ff split remains executable: Fc is scoped to `ws`, `qs`, and `protobufjs`, while Ff enforces the final-state contract of zero high/critical, no `ws`/`qs`/`protobufjs`/`happy-dom`, and residuals limited to the vitepress chain.

## Axis assessment

A. Required plan shape is present: scope, non-goals, validation legend, batch table, pre-flight, per-batch commands, final audit contract, F01 amendment prose, evidence section, follow-up topics, and checklist.

B. Dependency targets and sequencing match the binding analysis and design: Node 24 relock, safe wanted bumps, transitive audit remediation, `happy-dom`, `node-html-parser`, final evidence, then F01 documentation.

C. Commands are runnable and measurable enough for implementation. Batch (f)'s artifact target is corrected, and the audit checks use machine-readable JSON gates for both the scoped transitive closure and final contract.

D. Batch (g)'s path-set guard and targeted forbidden-phrase grep remain implementable and match the corrected F01 ownership requirement.

E. The final audit contract is explicit and checkable: zero high/critical, no `ws`/`qs`/`protobufjs`/`happy-dom`, and residuals limited to the vitepress chain.

F. Style is factual and standalone for an implementation plan. The stale artifact-target leak identified by the binding review is removed.

Approval bar: implementer-ready.

VERDICT: APPROVED