# F02 implementation plan review

Reviewed plan: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md)

Binding inputs: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md), [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md)

## Findings

### High — Batch (g) has an impossible validation gate

The exact F01 replacement prose intentionally contains `>=24.0.0` and `engines.node` in all three inserted blocks: [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L509), [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L521), and [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L541). The validation then requires a negative grep for those same tokens to return zero hits across both F01 files: [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L439-L445), with the same rule restated at [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L551-L553). Correctly applying the plan makes the validation fail, so batch (g) is not implementable. Replace the negative grep with a targeted check for the old ownership claim, or permit the F02-owned prerequisite text while forbidding only F01 ownership language.

### Medium — Exact F01 prose violates the workspace-relative markdown link rule

The replacement prose for F01 uses document-relative links to F02: [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L509), [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L521), and [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L541). The critique axis requires workspace-relative markdown links. Those targets should be expressed as `saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md` in the replacement prose, not `../node24-deps-refresh/...` or `../../node24-deps-refresh/...`.

### Medium — Command file paths are not consistently workspace-relative

Several commands and evidence references use absolute workspace paths for temporary artifacts: [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L209-L211), [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L355), [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L367-L369), and [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L559). The requested implementability axis says every file path must be workspace-relative. From [saivage/](saivage/), these should use workspace-local relative paths such as `../tmp/f02-c-audit.json`, `../tmp/f02-f-audit.json`, and `../tmp/f02-evidence.txt`.

### Low — Scope summary mislabels `node-html-parser` as CVE-driven

The plan summary calls both major upgrades “CVE-driven”: [03-plan-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/03-plan-r1.md#L13). The binding analysis says `node-html-parser` has no CVE driver and is chosen because the import surface is simple: [01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L98) and [01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L121). The binding design calls it a low-impact major with one import site: [02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md#L34). This is easy to fix by calling only `happy-dom` CVE-driven and `node-html-parser` opportunistic / low-impact.

## Axis assessment

A. Required plan sections are present: scope, non-goals, validation legend, batch table, per-batch details, final audit contract, F01 cross-reference impact, follow-up topics.

B. The seven-batch structure, dependency targets, rollback model, final audit gate, and step (c) closure requirement for `ws`, `qs`, and `protobufjs` are mostly consistent with the binding design. The `node-html-parser` rationale label needs correction.

C. Commands are runnable in shape, and pass criteria are mostly measurable. The absolute temp paths violate the workspace-relative path requirement.

D. Batch (g) does specify exact prose for both F01 files and has rollback. Its validation guard is self-contradictory and must be fixed before implementation.

E. The final audit contract is checkable. It names `metadata.vulnerabilities.high === 0`, `metadata.vulnerabilities.critical === 0`, forbids `ws`, `qs`, `protobufjs`, and `happy-dom`, and explicitly permits only `esbuild`, `vite`, `vitepress`, and `vitepress-plugin-mermaid` with `moderate <= 4` / `total <= 4`.

F. The plan is factual and avoids marketing language. The remaining style blockers are the workspace-relative link/path violations above.

Approval bar: not implementer-ready until the batch (g) validation and link/path issues are corrected.

VERDICT: CHANGES_REQUESTED