# F02 implementation plan review

Reviewed plan: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r4.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r4.md)

Binding inputs: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-review-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-review-r3.md)

## Findings

### High — Batch (f) still commits the r3 plan artifact instead of the r4 plan under review

The Fc/Ff split from the prior review has landed, but batch (f)'s file target was not advanced from r3 to r4. The batch table in the reviewed plan says the final evidence commit modifies the r3 plan artifact at [03-plan-r4.md](03-plan-r4.md#L47) rather than the reviewed r4 plan. The detailed batch (f) file list repeats the same stale target at [03-plan-r4.md](03-plan-r4.md#L329), and the commit command stages [03-plan-r4.md](03-plan-r4.md#L356) with `git add SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md`.

An implementer following r4 literally would paste the final audit evidence into the old r3 artifact, commit the wrong file, and leave r4's §9 evidence block empty. That breaks the plan's own batch-(f) acceptance gate and makes the document not implementer-ready. Update every batch-(f) self-reference and command to target [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r4.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r4.md).

## Fix verification

- Fc/Ff split: fixed. The validation legend explicitly separates `Fc` and `Ff` at [03-plan-r4.md](03-plan-r4.md#L27), with `Fc` scoped to `ws`, `qs`, and `protobufjs` at [03-plan-r4.md](03-plan-r4.md#L34) and `Ff` scoped to the final audit contract at [03-plan-r4.md](03-plan-r4.md#L35).
- Batch assignment: fixed. Batch (c) now carries `T+L+A+Fc+W` at [03-plan-r4.md](03-plan-r4.md#L44), while batch (f) carries `T+L+A+Ff+W` at [03-plan-r4.md](03-plan-r4.md#L47).
- Detailed gates: fixed. Batch (c)'s pass criteria state that `happy-dom` is not required to be closed by `Fc` at [03-plan-r4.md](03-plan-r4.md#L223), and batch (f)'s pass criteria require the final `Ff` contract at [03-plan-r4.md](03-plan-r4.md#L393).
- Checklist: fixed. The final checklist distinguishes `Fc` at [03-plan-r4.md](03-plan-r4.md#L606) from `Ff` at [03-plan-r4.md](03-plan-r4.md#L609).

## Axis assessment

A. Required plan shape is present: scope, non-goals, validation legend, batch table, pre-flight, per-batch commands, final audit contract, F01 amendment prose, evidence section, follow-up topics, and checklist.

B. Dependency targets and sequencing match the binding analysis and design: Node 24 relock, safe wanted bumps, transitive audit remediation, `happy-dom`, `node-html-parser`, final evidence, then F01 documentation.

C. Commands are mostly runnable and measurable, and the Fc/Ff audit split is now executable; batch (f)'s stale r3 target is the remaining command-level blocker.

D. Batch (g)'s path-set guard and targeted negative grep remain implementable and match the corrected F01 ownership requirement.

E. The final audit contract is explicit and checkable: zero high/critical, no `ws`/`qs`/`protobufjs`/`happy-dom`, and residuals limited to the vitepress chain.

F. Style is factual and standalone in substance, but the stale r3 self-reference is a prior-artifact leak that must be removed before approval.

Approval bar: not implementer-ready until batch (f) targets the r4 plan artifact consistently.

VERDICT: CHANGES_REQUESTED