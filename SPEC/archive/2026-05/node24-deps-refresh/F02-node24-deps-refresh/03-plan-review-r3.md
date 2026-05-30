# F02 implementation plan review

Reviewed plan: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md)

Binding inputs: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-review-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-review-r2.md)

## Findings

### High — Batch (c) is assigned the final audit gate before `happy-dom` is upgraded

The validation legend defines `F` as the final audit gate: zero high, zero critical, and no `ws`, `qs`, `protobufjs`, or `happy-dom` entries in the audit vulnerability map at [03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md#L27-L35). The batch table assigns `T+L+A+F+W` to batch (c) at [03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md#L43), but batch (c) runs before batch (d), where `happy-dom` 15 -> 20 actually closes the critical advisory. Correctly following the table requires batch (c) to satisfy an audit state that is intentionally impossible at that point in the sequence.

The detailed batch (c) script is scoped correctly to `ws`, `qs`, and `protobufjs` at [03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md#L203-L224), so this is a plan consistency defect rather than a dependency-strategy defect. Split the validation codes, for example `C` for the batch-(c) transitive audit check and `F` for the batch-(f) final audit contract, or remove `F` from batch (c) and name its scoped audit script explicitly in the table. As written, the plan is not implementer-ready because the validation table and detailed pass criteria disagree.

## Fix Verification

- Stale evidence target: fixed. Batch (f) now names this plan file in the batch table at [03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md#L46), in the file list at [03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md#L328), and in the `git add` command at [03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md#L355).
- Autonomous-document metadata: fixed. The title is standalone at [03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md#L1), and the plan no longer links to old F02 drafts or review-process artifacts.
- F01 checklist contradiction: fixed. The final checklist now points at batch (g)'s targeted forbidden-phrase grep, not a blanket `engines.node` / `>=24.0.0` grep, at [03-plan-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r3.md#L609).

## Axis Assessment

A. Required plan shape is present: scope, non-goals, validation legend, batch table, pre-flight, per-batch commands, final audit contract, F01 amendment prose, evidence section, follow-up topics, and checklist.

B. Dependency targets and sequencing match the binding analysis and design: Node 24 relock, safe wanted bumps, transitive audit remediation, `happy-dom`, `node-html-parser`, final evidence, then F01 documentation.

C. Commands are mostly runnable and measurable, but the shared `F` validation label makes the batch table impossible to execute at batch (c).

D. Batch (g)'s path-set guard and targeted negative grep are implementable and match the corrected F01 ownership requirement.

E. The final audit contract is explicit and checkable at batch (f): zero high/critical, no `ws`/`qs`/`protobufjs`/`happy-dom`, and residuals limited to the vitepress chain.

F. Style is factual, workspace-relative, and free of F02 draft/review-process backlinks. The quoted source text and replacement prose in §8 are operational instructions, not dance metadata.

Approval bar: not implementer-ready until batch (c)'s validation label is separated from the final audit gate or otherwise made consistent with the scoped audit check.

VERDICT: CHANGES_REQUESTED