# F01 - Implementation Plan Review R1

Reviewed plan: [03-plan-r1.md](03-plan-r1.md)
Approved design: [02-design-r2.md](02-design-r2.md)
Source reviewed under: [src](../../../../src)

## Sequence And Validation Check

The requested batch spine is present and in the required order:

| Batch | Required coverage | Present? | Concrete validation? | Notes |
|---|---:|---:|---:|---|
| B01 | sidecar | Yes | Yes | Covers schema, handle, typed queries, migrations, rollback, CRUD. |
| B02 | private RAG seam | Yes | Yes | Keeps `getInternalDataset` private and out of the public barrel. |
| B03 | KnowledgeStore facade + recovery | Partial | Yes | Creates facade/reingest/recovery modules, but does not fully spell out the design boot contract or pending-reingest catch-up. |
| B04 | lifecycle rewrite | Partial | Yes | Covers sidecar write template and type changes, but is sequenced before handler injection even though the design API takes a `KnowledgeStore`. |
| B05 | eager loader + builtin upsert | Partial | Yes | Covers loader shape and builtin upsert implementation, but not the boot-time integration point before recovery sweep. |
| B06 | search | Partial | Yes | Covers RAG-backed search behavior, but is sequenced before facade injection and does not cover the current RAG record-source metadata seam. |
| B07 | boot + legacy-tree refusal + handler injection | Partial | Yes | Covers the right topics, but lands too late for B04/B06 and depends on source surfaces not currently named in `src`. |
| B08 | e2e | Partial | Yes | Covers end-to-end lifecycle/search/recovery, but should explicitly include provider-stub boot and pending-reingest recovery cases. |

Every batch has a concrete validation command. The problem is not missing validation blocks; it is that several blocks validate too little for the design constraints or would only pass if the implementation keeps compatibility paths the design rejects.

## Findings

### 1. BLOCKER - Handler injection is sequenced too late for B04/B06

The approved design makes `KnowledgeStore` injection part of the core facade boundary: `registerBuiltinServices` receives `knowledge?: KnowledgeStore`, and the skills/memory handlers use the injected facade instead of module-level singletons ([02-design-r2.md](02-design-r2.md#L30-L45)). The lifecycle template also changes write helpers to take `store` directly ([02-design-r2.md](02-design-r2.md#L108-L129)), and search helpers take `store` plus caller context ([02-design-r2.md](02-design-r2.md#L136-L164)).

The plan rewrites lifecycle in B04 ([03-plan-r1.md](03-plan-r1.md#L55-L68)) and wires RAG-backed search in B06 ([03-plan-r1.md](03-plan-r1.md#L85-L96)), but does not pass `knowledge: store` through `registerBuiltinServices` until B07 ([03-plan-r1.md](03-plan-r1.md#L99-L109)). Current source confirms the handlers are still root/string based: `knowledgeSkillsHandler` derives `root` and calls `createSkill(root, ...)` / `searchSkills(root, ...)` ([src/mcp/knowledgeSkills.ts](../../../../src/mcp/knowledgeSkills.ts#L179-L267)), while `knowledgeMemoryHandler` does the same for memory ([src/mcp/knowledgeMemory.ts](../../../../src/mcp/knowledgeMemory.ts#L184-L288)). `registerBuiltinServices` currently registers those handlers without an injected knowledge option ([src/mcp/builtins.ts](../../../../src/mcp/builtins.ts#L1912-L1966)).

This creates an unsafe implementation fork. If B04 changes lifecycle signatures to match the design, `npm run typecheck` fails because MCP handlers still call the old API. If B04 preserves the old API until B07, it either keeps the legacy root/tree surface or introduces a module-level singleton, both of which violate the approved design. Move the `registerBuiltinServices` option, handler factories/injection, and call-site updates into B03 or B04 before the lifecycle rewrite, then let B06 add search on the already-injected store.

### 2. BLOCKER - `initKnowledgeStore` boot contract is under-specified and split across batches

The design's `initKnowledgeStore` is not just a facade type export. It must assert RAG is enabled, open the sidecar, refuse or clean the legacy tree, ensure and register protected datasets, upsert built-in skills, and run the boot divergence sweep in that order ([02-design-r2.md](02-design-r2.md#L207-L224)). Built-in upsert is explicitly a boot action ([02-design-r2.md](02-design-r2.md#L203-L205)). Legacy-tree refusal and seed removal are also part of the boot/new-project cutover ([02-design-r2.md](02-design-r2.md#L227-L242)).

B03 creates `src/knowledge/init.ts` but only names `initKnowledgeStore(opts)` and the type; its tests cover reingest construction and mismatch sweep, not the full boot contract ([03-plan-r1.md](03-plan-r1.md#L40-L53)). B05 implements `upsertBuiltinSkills` without saying where it is wired into `initKnowledgeStore` ([03-plan-r1.md](03-plan-r1.md#L71-L82)). B07 says bootstrap calls `initKnowledgeStore` after `RagService` construction ([03-plan-r1.md](03-plan-r1.md#L99-L109)), but current source has `createRagManager` as the RAG construction surface ([src/rag/manager.ts](../../../../src/rag/manager.ts#L87-L158)) and bootstrap currently registers built-ins without any RAG manager or knowledge store step ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L145-L151)).

The plan needs to name the exact F02-provided APIs it depends on, or add a source-aligned bootstrap step using the current `createRagManager` surface. It also needs an explicit batch task and validation for `assertRagEnabled`, protected dataset config persistence/registration, builtin upsert before recovery sweep, and legacy-tree refusal. Otherwise B07 is a large hidden integration batch rather than a concrete implementation step.

### 3. BLOCKER - Recovery coverage omits the `pending_reingest` contract

The approved module list calls `recovery.ts` a boot divergence sweep plus `pending_reingest` catch-up ([02-design-r2.md](02-design-r2.md#L16-L24)). The reingest design says failed lifecycle reingest leaves `pending_reingest = 1` so boot retries ([02-design-r2.md](02-design-r2.md#L94-L105)), and the risk table repeats that boot sweep retries uncleared pending state ([02-design-r2.md](02-design-r2.md#L305-L309)).

The plan only says B03 tests that the sweep detects and corrects a mismatch ([03-plan-r1.md](03-plan-r1.md#L40-L53)), and B08 simulates a post-commit/pre-reingest crash ([03-plan-r1.md](03-plan-r1.md#L115-L123)). That covers one divergence shape, but not the explicit pending flag contract. Add tests that failed lifecycle reingest leaves `pending_reingest = 1`, boot retries and clears pending rows, and pending rows are handled even when the vector store file-state comparison is not sufficient by itself. This is design behavior, not optional hardening.

### 4. MAJOR - Legacy refusal error/type updates are not called out

The design throws `KnowledgeStoreError("KNOWLEDGE_MIGRATION_REQUIRED", ...)` for a legacy tree with an empty sidecar ([02-design-r2.md](02-design-r2.md#L227-L237)). Current `KnowledgeErrorCode` does not include that code, and several current schemas still require UUID-only ids (`body_path` and `record_id: z.string().uuid()` remain in [src/knowledge/types.ts](../../../../src/knowledge/types.ts#L114-L163)). B04 covers `body_path` and id widening ([03-plan-r1.md](03-plan-r1.md#L55-L68)), but B07's legacy refusal task does not mention extending the error taxonomy or deciding whether the boot failure is surfaced as a typed `KnowledgeStoreError` or a fatal startup error.

Add an explicit B07 task and validation for the `KNOWLEDGE_MIGRATION_REQUIRED` code path, including type coverage and a bootstrap/legacy-tree test. This is especially important because B07's validation already includes `npm run typecheck`; the plan should make the required type changes visible rather than accidental.

### 5. MAJOR - RAG record ingestion source metadata is a source-alignment dependency

The design's sidecar reingest path sends active records to `ragManager.ingest(datasetId, { kind: "records", items })` ([02-design-r2.md](02-design-r2.md#L94-L101)), and search decodes record ids from `skill:${id}.md` / `memory:${id}.md` paths ([02-design-r2.md](02-design-r2.md#L136-L172)). Current `runIngest` ignores caller-supplied record `metadata.source` and infers `source` from the path extension unless `metadataOverlay.scope === "memory"` ([src/rag/pipeline.ts](../../../../src/rag/pipeline.ts#L108-L203)). With `skill:${id}.md` or `memory:${id}.md` paths, that can silently persist `source: "doc"` unless the pipeline is adjusted or `listActiveItems` works around it.

The plan should either add a small RAG pipeline adjustment to honor record-input `metadata.source`, or add explicit tests proving sidecar reingest produces correct `skill`/`memory` metadata and searchable path filters on the current pipeline. Without that, B03/B06 can pass facade-level tests while storing misleading chunk metadata.

## Required Plan Changes

- Move KnowledgeStore handler injection earlier, before or inside B04, and make B04's validation include the affected MCP handler files.
- Expand B03/B07 so `initKnowledgeStore` owns the full design boot order: RAG enabled assertion, sidecar open, legacy refusal/cleanup, protected dataset ensure/register, builtin upsert, and recovery sweep.
- Name the F02 dependencies precisely (`RuntimeRagDatasetConfig`, config-save helper, protected dataset registration surface), or adapt the plan to the current `createRagManager` source.
- Add pending-reingest tests to B03/B08, not only divergence mismatch tests.
- Add the legacy migration error code/type work and bootstrap test to B07.
- Add RAG record-input metadata validation or pipeline work so skill/memory records do not enter the vector store as generic docs.

VERDICT: CHANGES_REQUESTED