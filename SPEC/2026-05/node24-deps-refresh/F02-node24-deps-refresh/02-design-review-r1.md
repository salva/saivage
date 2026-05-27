# F02 — design review

Under review: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md).

Binding analysis: [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md).

## A. Coverage

The design covers the required topic areas at a high level: sequencing, validation gates, containerization, F01 cross-reference impact, and a per-step risk matrix are all present. The container boundary is explicit and consistent with the approved analysis: F02 does not provision containers, and `saivage-v3-getrich-v2` remains blocked for redeploy until Node 24 is installed.

Coverage is not yet implementer-ready because one cross-reference commit is outside the sequenced step list and outside the risk table. See required change 3.

## B. Consistency With Approved Analysis

Blocking inconsistency: the design changes the `@anthropic-ai/sdk` target from the approved analysis target of `^0.95.2` to `^0.99.0`. See required change 1.

Blocking inconsistency: the step (c) risk row permits accepting a residual `protobufjs` advisory, while both the approved analysis and the design's own end-state allow residual moderates only in the `esbuild → vite → vitepress → vitepress-plugin-mermaid` chain. See required change 4.

## C. Sequencing And Revertability

The general order is realistic: engine pin and Node-24 relock first, safe direct bumps next, transitive audit remediation before critical `happy-dom`, then the parser major, and final evidence last.

The sequence does not meet the independent-revertability bar because step (a) is explicitly not safe to revert while keeping later steps. See required change 2.

## D. Gating Thresholds

Most gates are objective and measurable: command exit codes, audit severity/count, targeted test files, and unchanged web lockfiles. The `@anthropic-ai/sdk` step currently uses a soft threshold of "roughly ten lines" as part of a fallback path. Aligning that step to the approved `^0.95.2` target should remove the need for that fuzzy gate; if any fallback remains, express it as an exact file/touch-count rule.

## E. Risk Table Completeness

The matrix names a detection mechanism and rollback action for steps (a) through (g). It is incomplete for the separate F01 amendment commit described in the cross-reference section, and the step (c) rollback action conflicts with the final audit contract.

## F. Style

The document is factual and avoids marketing language. Markdown links are mostly workspace-relative and command blocks are framed as runnable from [saivage/](saivage/). Non-blocking cleanup: replace "current revision" in the F01 plan bullet and "previously-deduped" in the risk table to keep the autonomous-document wording literal and free of dance-adjacent terms.

## Required Changes

1. Align `@anthropic-ai/sdk` with the binding analysis. The approved analysis sets the target to `^0.95.2` at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L88), recommends taking only the wanted `0.95.2` bump inside F02 at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L595), and records the machine-readable decision at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L607). The design instead makes `^0.99.0` a normal step at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L25), removes the wanted bump from step (b) at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L88), installs `@anthropic-ai/sdk@^0.99.0` at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L215), and makes `^0.99.0` part of the end-state at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L382). Change F02 to take `^0.95.2`; record `^0.99.0` as a follow-up if desired.

2. Remove the rollback exception for step (a) or restructure the sequence so the exception no longer exists. The design claims each step is independently revertable at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L40), then states that reverting step (a) while keeping later steps is undefined and requires LIFO rollback at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L44). That violates the topic's per-batch revertability requirement and the review axis that every step must be independently revertable. The design must give step (a) a standalone rollback that leaves a coherent repository state after `git revert <hash> && npm install`, or make the dependent work a single explicitly grouped batch with one rollback gate.

3. Put the F01 amendment into the sequence as an explicit step with validation, rollback, and risk coverage. The design correctly identifies that [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem.md) and [saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md](saivage/SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/03-plan-r2.md) must stop claiming the engine pin at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L327-L334). But it then describes that amendment as a separate F02 commit outside steps (a) through (g) at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L334). Make it a named step, or merge it into step (g) and update the step table, commands, pass criteria, rollback, and risk matrix accordingly.

4. Make the step (c) risk row consistent with the final audit contract. The approved analysis expects any end-state residual advisories to be only the four dev-only vitepress-chain moderates at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/01-analysis-r2.md#L358-L360), and the design repeats that final gate at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L270) and [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L381). The risk row for step (c), however, says that if the `protobufjs` override breaks, the implementer can revert and accept the residual `protobufjs` advisory with written justification at [saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh/02-design-r1.md#L355). Replace that rollback action with a path that preserves the final gate, such as reverting step (c), opening a follow-up topic, and blocking F02 completion until `protobufjs` is remediated or the final audit contract is explicitly changed.

VERDICT: CHANGES_REQUESTED