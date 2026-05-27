# F02 — design review

Under review: [02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md).

Binding analysis: [01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md).

Binding critique: [02-design-review-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-review-r2.md).

## Required-change status

1. Step (a) rollback contract: landed. The design states that every step is a single commit and that rollback for any step is `git revert <hash>` followed by `npm install` at [02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md#L16). It then makes the rule uniform across steps at [02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md#L40). The step (a) detail gives the same recovery command and treats mid-stack conflicts as ordinary git conflict handling rather than as a special exception for the engine-pin batch at [02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md#L79).
2. Step (c) advisory-root gate: landed. The pass criterion requires `ws`, `qs`, and `protobufjs` to be absent from the audit vulnerability map, removes the same-count escape hatch, and permits only the documented vitepress-chain residuals at [02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md#L138). The risk matrix also blocks F02 completion if `protobufjs` remains open at [02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md#L350).
3. Autonomous-document wording: landed. A literal sweep of the design for the five prohibited process tokens returned no narrative matches; filename tokens such as `r2` and `r3` remain where expected.

## A. Coverage

Complete. The design covers ordering rationale, per-step change sets, validation gates, rollback actions, containerization boundaries, F01 cross-topic impact, follow-up topic ownership, and the end-state contract. The design also includes the F01 amendment as an explicit step with path guards and a doc-only rollback path at [02-design-r3.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r3.md#L232).

## B. Consistency With Binding Analysis

Consistent. Dependency targets match the binding analysis: `happy-dom@^20.9.0`, `node-html-parser@^7.1.0`, `@anthropic-ai/sdk@^0.95.2`, wanted-column safe bumps, `zod` deferral, and residual vitepress-chain advisories only. The container note also preserves the analysis snapshot: `saivage` and `saivage-v3` satisfy `>=24.0.0`, while `saivage-v3-getrich-v2` needs a separate Node 24 provisioning topic before redeploying a build that adopts the engine pin.

## C. Sequencing And Revertability

Implementer-ready. The order isolates the engine pin, safe direct bumps, transitive CVE cleanup, critical `happy-dom` bump, low-impact `node-html-parser` bump, final evidence capture, and F01 docs. The rollback model now applies uniformly across all steps. The note about ordinary git conflicts after later batches is practical guidance, not a narrowed rollback contract.

## D. Gating Thresholds

Implementer-ready. Runtime steps consistently require typecheck, lint, and test success. Targeted checks are present for `happy-dom` and `node-html-parser`; step (c) now requires closure of the three named advisory roots; step (f) constrains final residual advisories to the documented vitepress chain. The web package guard prevents accidental edits to [saivage/web/package.json](saivage/web/package.json) and [saivage/web/package-lock.json](saivage/web/package-lock.json).

## E. Risk Table Completeness

Complete enough for implementation. The matrix covers the engine re-baseline, safe bumps, audit-fix drift, `protobufjs` fallback failure, `happy-dom` API drift, `node-html-parser` fixture drift, final audit evidence, F01 amendment path scope, and VS Code buffer drift. The `protobufjs` path is correctly stop-the-line unless the operator changes the topic's final audit contract.

## F. Style

Factual and self-contained. The document uses implementer-facing commands and clear thresholds, avoids marketing language, and does not rely on process back-references. The literal prohibited-token sweep is clean for narrative text.

## Required Changes

None.

VERDICT: APPROVED
