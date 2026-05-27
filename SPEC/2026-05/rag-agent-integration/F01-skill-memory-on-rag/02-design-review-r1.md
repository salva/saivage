# F01 Skill/Memory on RAG Design Review - R1

Reviewed design: [02-design-r1.md](02-design-r1.md)
Against approved analysis: [01-analysis-r7.md](01-analysis-r7.md)
Source checked under: [src/](../../../../src)

## Findings

### 1. `getInternal` is not yet specified in a way that preserves the public RAG export surface

The chosen direction is correct to require a single private RAG-internals seam for boot divergence inspection, and the design explicitly says the seam must stay out of [src/rag/index.ts](../../../../src/rag/index.ts). However, the design's call site uses `opts.ragManager.getInternal(datasetId)` ([02-design-r1.md](02-design-r1.md#L216)), then describes `getInternal` as a friend method on `RagManager` ([02-design-r1.md](02-design-r1.md#L225-L229)). In the actual source, `RagManager` is an exported interface ([src/rag/manager.ts](../../../../src/rag/manager.ts#L42-L49)) and that interface is publicly re-exported from [src/rag/index.ts](../../../../src/rag/index.ts#L16). Adding `getInternal` to that interface would change the public exported type, which the request forbids.

Required change: specify the private seam concretely. For example, keep the exported `RagManager` interface and [src/rag/index.ts](../../../../src/rag/index.ts) unchanged, then expose a non-index internal helper or internal symbol from a RAG-internal module used only by `src/knowledge/recovery.ts`. The recovery code should not require `type RagManager` to gain a `getInternal` member.

### 2. The sidecar schema inheritance conflicts with the current collision rules unless the design narrows it

The design says sidecar migrations establish the approved analysis §3.1 schema ([02-design-r1.md](02-design-r1.md#L49-L54)) and separately says lifecycle collision rules are ported verbatim from current source ([02-design-r1.md](02-design-r1.md#L104-L111)). Those two constraints currently conflict: the analysis schema has a global `CREATE UNIQUE INDEX record_skill_name ON record_skill(name)` ([01-analysis-r7.md](01-analysis-r7.md#L341)), while current `createSkill` only rejects an active same-name skill inside the same scope directory ([src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L277-L279)). Current memory topic collision is also scope-local ([src/knowledge/lifecycle.ts](../../../../src/knowledge/lifecycle.ts#L525-L527)). A global skill-name unique index would reject valid cross-scope names and likely same-name supersession/history cases before the lifecycle helper can apply the approved rule.

Required change: make the sidecar schema and lifecycle rule one story. Either remove the global unique skill-name index and enforce collisions in `enforceCollisionRules`, or denormalize enough scope/status into the indexed table to express the current active-per-scope rule. As written, the design inherits a stricter persistence invariant than the source behavior it says it preserves.

### 3. The eager-loader rewrite snippet breaks the preserved `loadAllCandidates` contract

The analysis says eager-loading APIs are preserved and only the data source is repointed. The source currently returns `RawCandidate[]` with `{ record, body, origin? }` ([src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L31-L33)), and `buildEagerBlock` passes those objects directly to `resolveEagerRecords` ([src/knowledge/eagerLoader.ts](../../../../src/knowledge/eagerLoader.ts#L310-L313)), whose input shape expects a `record` property ([src/knowledge/loader.ts](../../../../src/knowledge/loader.ts#L233-L237)).

The design's rewrite snippet instead maps rows to `{ ...JSON.parse(row.record_json), body: row.body }` ([02-design-r1.md](02-design-r1.md#L161-L170)). If implemented literally, `resolveEagerRecords` will see `cand.record === undefined` and the eager block/survivor reinjection path will fail.

Required change: update the design snippet to return the existing candidate shape, for example `{ record: assembleRecord(row), body: row.body, origin }`, preserving built-in/project origin and keeping `resolveEagerRecords` unchanged.

### 4. Scoped search needs an empty-id guard before constructing `QueryFilter.in`

The design builds a scoped search filter as `{ in: { path: ids.map(...) } }` ([02-design-r1.md](02-design-r1.md#L132-L133)). That matches the public `QueryFilter` shape in [src/rag/types.ts](../../../../src/rag/types.ts#L114-L121), but the actual SQL compiler rejects empty `IN` lists ([src/rag/store/sql.ts](../../../../src/rag/store/sql.ts#L58-L64)). A valid search for a scope with no active records would become an `InvalidQueryFilterError`, which the proposed search handler would incorrectly map to `KNOWLEDGE_RAG_UNAVAILABLE` instead of returning `{ hits: [] }`.

Required change: specify that `searchSkills` / `searchMemories` return an empty hit list before calling RAG when the scoped active-id set is empty.

## Checks That Pass

- The focused proposal, level-up alternative, and chosen direction are present. The rejected alternative correctly avoids adding a public `VectorStoreRef` kind and keeps the chosen design on protected `sqlite-vec` datasets.
- The `KnowledgeStore` facade has the right dependency shape: sidecar handle, `RagManager`, shared protected dataset configs, and a per-kind reingest helper.
- The reingest helper uses the existing public `ragManager.ingest(datasetId, { kind: "records", items })` path and aligns with the analysis requirement that record ingest, not fake `DatasetConfig.sources`, feeds knowledge records.
- The lifecycle rewrite plan preserves the existing write guards, output envelopes, status-only archival direction, and post-commit snapshot reingest model, subject to the collision-rule/schema correction above.
- The search helper uses `QueryFilter.in` on `path`, which is the right public RAG filter for scoped searches once the empty-set case is handled.
- The init flow and legacy-tree refusal match the approved analysis: RAG is hard-required, protected datasets are seeded with `store: { kind: "sqlite-vec" }`, existing legacy `.saivage/skills` or `.saivage/memory` trees cause a migration-required refusal when the sidecar is empty, and [src/store/project.ts](../../../../src/store/project.ts) must remove current legacy-tree seeding before this boot path lands.
- The boot divergence sweep correctly uses the vector store file-state enumerator, not a capped KNN query. The remaining blocker is only how the `Dataset` handle is obtained without public RAG export drift.

## Minor Clarifications

- After successful snapshot reingest, consider specifying whether `rag_sync` rows for inactive/deleted records are removed. The sweep treats `rag_sync` as a hint, so this is not a blocker, but stale rows would make diagnostics noisier.
- If search performs post-query visibility filtering, the design should either overfetch or document that fewer than `limit` hits may be returned even when additional eligible hits exist beyond the initial RAG `topK`.

VERDICT: CHANGES_REQUESTED