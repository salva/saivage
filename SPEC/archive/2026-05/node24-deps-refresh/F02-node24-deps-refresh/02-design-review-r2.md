# F02 — design review

Under review: [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md).

Binding analysis: [01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md).

Binding critique: [02-design-review-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-review-r1.md).

## Required-change status

1. `@anthropic-ai/sdk` target alignment: landed. The design now limits F02 to `0.95.1 → 0.95.2`, installs `@anthropic-ai/sdk@^0.95.2`, and defers the `0.99.x` jump to F05 at [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L87), [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L94), and [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L327).
2. Step (a) rollback exception: not landed. The design still makes standalone rollback of step (a) conditional on no later runtime steps being in place, and it still directs the implementer to unwind later steps first at [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L42) and [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L81). That does not satisfy the topic's per-batch rollback contract.
3. F01 amendment step: landed. Step (g) is now present in the sequence table, has its own command block, validation guard, rollback action, and risk rows at [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L26), [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L234), [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L260), [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L358), and [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L359).
4. `protobufjs` residual handling: landed in the risk row. The step (c) row now blocks F02 completion unless `protobufjs` is remediated or the topic's final audit contract is renegotiated by the operator at [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L352).

## A. Coverage

The design covers the required topic areas: ordering rationale, per-step validation, rollback action, containerization boundary, F01 cross-reference impact, and an end-state contract. The F01 amendment is now part of the sequence rather than a side note.

Coverage is held below implementer-ready because the rollback model still does not meet the stated per-batch contract, and the document leaves one literal autonomous-document wording violation.

## B. Consistency With Binding Analysis

The dependency targets now match the binding analysis: `happy-dom@^20.9.0`, `node-html-parser@^7.1.0`, `@anthropic-ai/sdk@^0.95.2`, wanted-column safe bumps, `zod` deferral, and residual `vitepress`-chain advisories only.

One consistency gap remains against the topic file rather than the analysis: the design's rollback rule narrows the topic's statement that rollback for any batch is `git revert <hash>` followed by `npm install`.

## C. Sequencing And Revertability

The sequence itself is coherent: engine pin and relock first, safe direct bumps, transitive CVE remediation, `happy-dom`, `node-html-parser`, evidence, then F01 docs.

Blocking issue: the revertability section still says a single-step rollback is only standalone when no later step is present. That is the same operational exception the binding critique rejected. Either step (a) needs a true single-command rollback path that leaves the repository coherent from the full stack, or the dependent runtime steps need to be grouped under one explicit rollback gate.

## D. Gating Thresholds

Most gates are objective and implementable. The runtime steps consistently require typecheck, lint, and tests; targeted tests are named for `happy-dom` and `node-html-parser`; doc-only gates constrain path sets.

The step (c) pass criterion is still too permissive at [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L140): it allows `ws`, `qs`, or `protobufjs` to remain under a different advisory if the count has not grown. That weakens the final audit contract. Step (c) should require those three advisory roots to be closed before progression, unless the operator explicitly changes the topic contract.

## E. Risk Table Completeness

The matrix now covers the F01 amendment and the `protobufjs` failure path. The `protobufjs` row is aligned with the final audit contract.

The rollback rows remain incomplete for step (a) because they depend on the LIFO policy rather than giving the per-batch rollback promised by the topic. That is a design-level issue, not just wording.

## F. Style

The document is factual, concise, and mostly autonomous. One literal banned token remains in the F01 cross-reference label at [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L323). Replace the label with wording such as `F01 plan r2` or `F01 plan`.

## Required Changes

1. Fix step (a) rollback so it satisfies the topic's per-batch contract. Either provide a standalone `git revert <hash> && npm install` path that leaves the full sequence coherent after reverting step (a), or group the dependent runtime work under one explicitly named rollback gate. Remove the conditional statement that standalone rollback requires no later step to be present.
2. Tighten the step (c) pass criterion so `ws`, `qs`, and `protobufjs` must be remediated before F02 can proceed, with no "different advisory but same count" escape hatch unless the operator changes the topic contract.
3. Remove the banned autonomous-document token at [02-design-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r2.md#L323).

VERDICT: CHANGES_REQUESTED