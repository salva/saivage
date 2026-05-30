# F01 - Implementation Plan Review R2

Reviewed plan: [03-plan-r2.md](03-plan-r2.md)
Approved design: [02-design-r2.md](02-design-r2.md)
Prior review: [03-plan-review-r1.md](03-plan-review-r1.md)
Source reviewed under: [src](../../../../src)

## Findings

No blocking or major findings. R2 addresses the five issues raised in R1 without introducing a source-alignment problem that should block the implementation plan.

## R1 Fix Verification

| R1 issue | Status | Review note |
|---|---|---|
| Handler injection sequenced too late | Fixed | B03 now extends `BuiltinServicesOptions` with `knowledge?: KnowledgeStore`, passes the façade into the skills/memory handlers, and adds lifecycle shim adapters so B03 typechecks before the B04 lifecycle rewrite. This lands before B04 and B06 depend on store-shaped lifecycle/search APIs. |
| `initKnowledgeStore` boot contract under-specified | Fixed | B03 now spells out the boot order explicitly: `assertRagEnabled`, `openSidecar`, `refuseOrCleanLegacyTree`, `ensureProtectedDatasets`, `registerProtectedDatasets`, `upsertBuiltinSkills`, and `runBootDivergenceSweep`, with order assertions in tests. This matches design §A.8 and the current source seams around `BuiltinServicesOptions`, config-backed RAG datasets, and bootstrap registration. |
| Recovery omitted `pending_reingest` contract | Fixed | B03 now requires `runBootDivergenceSweep` to enumerate `pending_reingest=1` rows and reingest those kinds even when file-state maps match. B04 tests failed post-commit reingest leaving the flag set, and B08 adds cold-boot e2e coverage for a pending flag. |
| Legacy refusal error taxonomy not called out | Fixed | B07 now adds `KNOWLEDGE_MIGRATION_REQUIRED` to `KnowledgeErrorCode` and handler-facing unions, and validates the legacy-empty and legacy-populated sidecar cases. This directly covers the current source gap where `KnowledgeErrorCode` lacks the migration code. |
| RAG record metadata source mismatch | Fixed | B05 now adds pipeline work so `runIngest` honours `metadata.source` for `IngestInput.records`, plus tests that `skill` and `memory` survive a `reingestKind` round trip. This addresses the current source behavior where `buildRecordItems` drops `metadata.source` and `runIngest` infers document source from `.md` paths. |

## Source Alignment Notes

- Current MCP registration already has a `BuiltinServicesOptions` seam and root-based knowledge handlers, so the B03 injection work is source-aligned.
- Current `IngestInput.records` already carries `ChunkMetadataInput.source`, while `runIngest` does not preserve it for record inputs; B05 targets the right layer.
- Current knowledge schemas still require UUID ids and `SkillRecord.body_path`; B04/B07 explicitly cover the required type and taxonomy changes for sidecar/builtin ids and migration refusal.
- The B03 recovery implementation should follow design §A.9 literally by using the `Dataset` returned from `getInternalDataset` and reading `dataset.store.getFileState()`.

VERDICT: APPROVE