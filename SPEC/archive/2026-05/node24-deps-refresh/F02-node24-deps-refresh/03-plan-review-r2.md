# F02 implementation plan review

Reviewed plan: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md)

Binding inputs: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-review-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-review-r1.md)

## Findings

### High — Batch (f) writes final evidence to the stale r1 plan

Batch (f) is supposed to populate this plan's §9 evidence block, but the batch table points the evidence commit at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L50)'s linked [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md) target, the batch detail repeats the same stale file at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L332), and the `git add` command stages [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md) at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L359). Correctly following the plan leaves r2's evidence section empty and modifies a prior draft. Replace all three references with [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md) so batch (f) updates the artifact under review.

### Medium — The plan violates the literal autonomous-document rule

The document title is revision-numbered at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L1), and the header links to the prior draft and prior review at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L6-L7). The autonomous-document rule forbids revision-numbered titles, back-references to prior revisions, and references to the review process inside the implementer-facing document. Remove those lines, rename the title without `(r2)`, and keep any dance metadata outside this implementation plan.

### Medium — The final checklist restates the old impossible batch-(g) condition

The main batch-(g) validation was corrected to target only removed ownership phrases at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L436-L466), and §8.3 correctly explains that blanket grepping for `engines.node` / `>=24.0.0` is wrong at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L573). The final hard checklist still says the negative grep must find "zero engines-pin references in F01" at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L613). That contradicts the required replacement prose, which intentionally keeps F02-owned engine-pin prerequisite text in F01. Rewrite the checklist item to say "zero F01 ownership phrases" or "the targeted negative grep passes."

## Prior-fix verification

- Prior High: mostly fixed. Batch (g)'s actual validation now uses path-set guards plus a targeted forbidden-phrase grep instead of a blanket `engines.node` / `>=24.0.0` grep, but the final checklist still needs the correction above.
- Prior Medium: fixed. The F01 replacement prose uses workspace-relative links to the F02 topic, for example at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L529) and [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L541).
- Prior Medium: fixed. Temporary evidence/audit captures use workspace-local relative paths such as `../tmp/f02-c-audit.json`, `../tmp/f02-evidence.txt`, and `../tmp/f02-f-audit.json` at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L211), [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L357), and [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L369).
- Prior Low: fixed. The scope summary now correctly calls only `happy-dom` CVE-driven and labels `node-html-parser` as opportunistic / low-impact with no CVE driver at [03-plan-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r2.md#L15).

## Axis assessment

A. Required plan shape is present: scope, non-goals, validation legend, batch table, pre-flight, per-batch details, final audit contract, F01 cross-reference prose, evidence section, follow-up topics, and checklist.

B. Dependency targets and sequencing match the binding analysis/design: Node 24 relock first, wanted bumps, non-force audit fix, `happy-dom`, `node-html-parser`, final evidence, then F01 doc amendment.

C. Most commands are runnable and measurable, but batch (f)'s stale [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md) target makes that batch not implementer-ready.

D. Batch (g)'s executable validation is now targeted and implementable, but its final checklist summary still contradicts the corrected gate.

E. The final audit contract is explicit and checkable: zero high/critical, no `ws`/`qs`/`protobufjs`/`happy-dom`, residuals limited to the vitepress chain.

F. Style is mostly factual and workspace-relative, but the autonomous-document rule is not satisfied because the plan contains revision and review-process backlinks.

Approval bar: not implementer-ready until the stale r1 evidence target, autonomous-document backlinks, and final checklist wording are corrected.

VERDICT: CHANGES_REQUESTED