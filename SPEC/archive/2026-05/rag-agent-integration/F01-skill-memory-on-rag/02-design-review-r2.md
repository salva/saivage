# F01 Skill/Memory on RAG Design Review - R2

Reviewed design: [02-design-r2.md](02-design-r2.md)
Against approved analysis: [01-analysis-r7.md](01-analysis-r7.md)
Prior review: [02-design-review-r1.md](02-design-review-r1.md)
Source checked under: [src/](../../../../src)

## Findings

No blocking findings. R2 fixes all four blockers identified in R1.

## Verification

1. The private RAG access seam is now specified without changing the public RAG API. R2 places `getInternalDataset(manager, id)` in the proposed new private non-index module `src/rag/internal/datasetAccess.ts`, and states that [src/rag/manager.ts](../../../../src/rag/manager.ts#L42-L49) and [src/rag/index.ts](../../../../src/rag/index.ts#L16) remain untouched. The proposed module-level `WeakMap<RagManager, (id: string) => Dataset>` satisfies the R1 requirement because recovery can obtain a `Dataset` without adding a `getInternal` member to the exported `RagManager` interface.

2. The sidecar schema collision rule is now scope-local. R2 explicitly drops the inherited global unique skill-name index from the approved analysis schema and replaces it with non-unique `record_skill_name_idx ON record_skill(name)`. It also says memory-topic collision rejection remains at the lifecycle layer with non-unique lookup indexes. That aligns with current scope-local skill and memory collision behavior in [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L277-L279) and [src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L525-L527), while treating the approved analysis's global `CREATE UNIQUE INDEX record_skill_name` as an intentional design adjustment.

3. The eager-loader rewrite now preserves the existing `RawCandidate` contract. R2 quotes the source shape `{ record, body, origin? }` from [src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L31-L33) and returns `{ record: assembleRecord(JSON.parse(row.record_json)), body: row.body, origin: row.origin }`. This keeps [src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L233-L237) compatible because `resolveEagerRecords` continues to read `cand.record`.

4. Scoped search now guards empty scope result sets before constructing `QueryFilter.in`. R2 returns `{ hits: [] }` when `activeIdsForScope(...)` is empty, before creating `{ in: { path: ... } }`. This matches the actual SQL compiler constraint in [src/rag/store/sql.ts](../../../../src/rag/store/sql.ts#L58-L64), where empty `IN` arrays throw `InvalidQueryFilterError`, and prevents a valid empty scoped search from being reported as `KNOWLEDGE_RAG_UNAVAILABLE`.

## Notes

The two R1 minor clarifications were also handled: R2 documents that post-query visibility filtering may return fewer than `limit` hits, and it adds a cleanup note for stale `rag_sync` rows tied to inactive or deleted records. These are not blockers.

VERDICT: APPROVE