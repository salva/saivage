# Review - Skill and Memory on RAG Functional Analysis

## 1. Coverage Of Required Topics

The analysis covers some current-state basics, but it does not satisfy the topic file's required coverage. The topic asks for replacement of the bespoke storage and retrieval paths with RAG-backed facades, removal of legacy lookup/storage code, and no flat-file search fallback ([SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md](SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md#L3-L10), [SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md](SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md#L12-L36)). The analysis instead treats the existing records tree as the permanent source of truth and RAG as derived mirrored state, which is not the same migration.

The current-state section is incomplete. It identifies the major schemas and tools, but it gives the wrong scoped on-disk shape and does not cover which agents call the tools or the argument patterns the topic explicitly requests ([SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md](SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md#L39-L48)). Current records are stored under scope-specific subtrees, not directly under one records directory: [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L110-L119) and [src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L73-L84).

The schema mapping is not a gap analysis. The topic asks which fields map to `ChunkMetadata`, which need a separate sidecar table, and which can be dropped with justification ([SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md](SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md#L49-L51)). The analysis maps many fields into a non-existent free-form `metadata` bag and does not define a sidecar table for fields that are not filterable RAG columns.

The sources-to-index topic is mostly missing. The analysis sets both dataset `sources` to an empty array, says the watcher is unused, and provides no on-disk roots, include/exclude globs, representative file counts, or token estimates, all of which are required ([SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md](SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md#L52-L55)).

Identity and IDs are under-specified. The analysis maps record UUIDs to `scopeRef`, but it does not resolve stable identity for built-in skills, whose eager-loader records currently receive a fresh UUID each load while the human identity is the frontmatter `name` ([src/knowledge/eagerLoader.ts](src/knowledge/eagerLoader.ts#L169-L210)). It also does not account for the ingest pipeline's path-based diffing contract.

Permissions and scope are only partially covered. The topic specifically asks how memory's scope and permission filters collapse onto `QueryFilter` ([SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md](SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md#L59-L62)). The analysis does not confront the fact that `QueryFilter` can only filter fixed chunk columns, not arrays such as `target_agents` or arbitrary sidecar metadata ([src/rag/types.ts](src/rag/types.ts#L114-L120), [src/rag/store/sql.ts](src/rag/store/sql.ts#L15-L27)).

Lifecycle, eager loading, backout/removal, and failure modes are present but not complete. The backout/removal table omits several actual files under [src/knowledge/](src/knowledge/) and [src/mcp/](src/mcp/), including the type/store/permissions/loader/eager-loader tests and both MCP handler tests. The failure-mode table does not specify first-run seeding, exact implemented error-code changes, or how search is protected when a write succeeds but mirroring fails.

## 2. Factual Accuracy Against The Cited Files

Several claims do not match the cited source files.

- The documented on-disk layout is wrong. Skills and memories live under `project`, `stages/<id>`, or `sessions/<id>` subtrees, with skill bodies currently written as `records/<uuid>.md` beside record JSON ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L110-L119), [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L289-L296)).
- The MCP skill read tool is named `read_skill`, not `read_skill_by_id` ([src/mcp/knowledgeSkills.ts](src/mcp/knowledgeSkills.ts#L123-L142)).
- `RagSource` already includes `skill`; the analysis says adding it is the only RAG-side change ([src/rag/types.ts](src/rag/types.ts#L3-L3)).
- The TypeScript RAG config surface currently accepts `DatasetConfig.source` as a `RagSource` string, not `{ kind: "records" }`, and the runtime config schema uses `text-embedding-3-small`, not the `text-embedding-3-large` entries shown in the analysis ([src/rag/types.ts](src/rag/types.ts#L39-L47), [src/config.ts](src/config.ts#L217-L266)). The shipped RAG docs still show `text-embedding-3-large`, so the analysis should call out and resolve that docs/code conflict instead of silently depending on one side ([SPEC/v2/rag/configuration.md](SPEC/v2/rag/configuration.md#L24-L49)).
- `ChunkMetadata` has fixed columns and no free-form `metadata` object for `name`, `description`, `triggers`, `targetAgents`, or `status` ([src/rag/types.ts](src/rag/types.ts#L57-L77)). The closest existing lifecycle field is `lifecycleStatus`, not `metadata.status`.
- The records ingest input is `{ kind: "records", items: [...] }`, not `{ kind: "records", records: [...] }` ([src/rag/types.ts](src/rag/types.ts#L143-L147)).
- The records ingest pipeline diffs by `metadata.path` and deletes prior chunks by `path`, not by `scopeRef` ([src/rag/pipeline.ts](src/rag/pipeline.ts#L108-L125), [src/rag/pipeline.ts](src/rag/pipeline.ts#L256-L285)). The analysis repeatedly assumes replacement by `scopeRef`.
- The pipeline does not currently preserve a caller-supplied record `source` through `metadataOverlay`; for record input it infers source from the path, and the existing condition checking `metadataOverlay.scope === "memory"` cannot be true for actual knowledge scopes (`project`, `stage`, `session`) ([src/rag/pipeline.ts](src/rag/pipeline.ts#L197-L207)).
- `Dataset` exposes `ingest`, `query`, `stats`, `drop`, and `reconcile`, but not `deleteByFilter` ([src/rag/dataset.ts](src/rag/dataset.ts#L101-L170)). `deleteByFilter` exists on the internal vector-store seam ([src/rag/store/index.ts](src/rag/store/index.ts#L13-L19)).
- The analysis calls `store.getFileState()` an existing RAG API for reconciliation. It is an internal store method, not an operator-facing `Dataset` method ([src/rag/store/index.ts](src/rag/store/index.ts#L35-L40)).
- The current audit schema has optional hash fields, but the lifecycle helpers do not compute or populate content hashes; a search of the knowledge source only finds the schema fields ([src/knowledge/types.ts](src/knowledge/types.ts#L161-L172)).
- The analysis overstates read-scope enforcement. The `checkScope` restriction applies to worker memory writes, not reads or searches ([src/knowledge/permissions.ts](src/knowledge/permissions.ts#L239-L288)).

## 3. Architectural Soundness

The analysis preserves many records-layer invariants, but it does so by keeping the old records layer as the actual source of truth and adding a RAG mirror. That conflicts with the topic's requested architecture: RAG datasets plus a small sidecar table should become the storage/search foundation for the MCP facades, while legacy indexing and lookup code are removed ([SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md](SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md#L83-L95)).

The proposed architecture also violates the fixed-RAG constraint. It first says adding `skill` to `RagSource` is the only RAG-side change, then says exposing `Dataset.deleteByFilter` is the only required RAG-side change. The former is already implemented; the latter is explicitly a public-surface change to [src/rag/](src/rag/) even though the topic says to design around gaps and name them as follow-ups ([SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md](SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md#L18-L20)).

The records-layer invariants are not fully protected during mirror drift. The analysis allows `archive` and `delete` to write the authoritative record state while leaving stale chunks visible until reconcile. Because `readSkillById` returns a skill record by ID without filtering out archived status, semantic search must explicitly re-check status after loading, not just rely on chunk metadata that may be stale ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L838-L889)). The analysis does not specify that guard.

The sidecar story is architecturally missing. Without a sidecar table or a valid fixed-column encoding, the proposed `target_agents`, lifecycle, skill name, topic, and origin filters cannot be expressed as `QueryFilter`. The analysis should decide which fields are stored in RAG columns, which are sidecar-only, and which are rechecked after ID resolution.

## 4. Clean Code And Architecture-First Compliance

The analysis preserves too much legacy structure. Keeping [src/knowledge/store.ts](src/knowledge/store.ts), `index.json` rebuilds, old scoped record files, and most lifecycle code while adding `semantic-search.ts`, `rag-mirror.ts`, reconcile helpers, startup hooks, and a new CLI command creates a parallel storage system rather than removing the old one.

This is effectively a backward-compatibility architecture, even if it is not described as one. It keeps the old format and lookup machinery alive and makes RAG a cache. That conflicts with the project-wide rule to remove old data structures and dead code instead of preserving shims.

There is also speculative scope creep: public `Dataset.deleteByFilter`, tombstone ingest discussion, auto-drop/auto-reconcile on drift, a periodic prune job, and a CLI reconcile command are all introduced before the analysis has established the minimal sidecar/query design required by the topic.

## 5. Completeness For An Implementer

An implementer could not safely implement from this analysis yet.

- It does not specify the sidecar schema, where sidecar files/tables live under `.saivage/rag/<datasetId>/`, or how sidecar writes are kept coherent with `Dataset.ingest`.
- It does not specify first-run seeding. With `sources: []` and a records-driven design, `dataset.reconcile()` cannot discover old records by itself; the analysis needs an explicit bootstrap ingest path.
- It does not define lock ordering between the runtime lock, the existing in-process `scopeLifecycleLocks`, and the RAG `.ingest.lock` ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L60-L99), [src/rag/pipeline.ts](src/rag/pipeline.ts#L166-L174)).
- It does not say what to do if a mirror write partially fails after the record write but before index rebuild, or if deletion fails and stale chunks still rank highly.
- It does not classify every file under [src/knowledge/](src/knowledge/) and [src/mcp/](src/mcp/) as keep, rewrite, or delete, even though the topic requires that inventory ([SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md](SPEC/2026-05/rag-agent-integration/F01-skill-memory-on-rag.md#L71-L73)).
- It does not update the actual `KnowledgeErrorCode` union for new error codes such as `RAG_UNAVAILABLE` or `KNOWLEDGE_RAG_UNREGISTERED` ([src/knowledge/store.ts](src/knowledge/store.ts#L37-L53)).
- It does not handle the stage/session archive hooks, which move records into an archive subtree and would need RAG deletion or sidecar lifecycle updates ([src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L923-L1016)).

## 6. Internal Consistency

The analysis contradicts itself in several places.

- It says the keyword scorers and candidate-pool structures are deleted, then says eager loading remains keyword-based over the on-disk pool and keeps trigger scoring unchanged.
- It says there is no keyword fallback when RAG is unavailable, then later says CRUD is unaffected when `config.rag.enabled === false`, despite the topic requiring the subsystem to refuse to start unless RAG is enabled and both collections are registered.
- It lists tombstone-record ingest for archive/delete in the lifecycle table, then rejects tombstone records and chooses `Dataset.deleteByFilter` instead.
- It claims one required RAG change in the source-kind section and a different single required RAG change in the public-surface section.
- It says `reconcileKnowledgeRag` can diff stored `scopeRef` values using `dataset.stats()` plus `store.getFileState()`, but `stats()` does not expose IDs and `file_state` is path-oriented.
- Its final non-goals say the keyword scorer is gone, but the file plan keeps keyword-trigger logic and eager keyword selection. That may be a valid split, but the analysis must make the boundary precise because the topic says skill matching goes through RAG datasets.

## 7. Style Compliance

The analysis is mostly readable and self-contained, and it uses no emojis. However, its markdown links are not repo-root-relative for this repository: many links are prefixed with the workspace folder name instead of starting at paths such as [src/rag/types.ts](src/rag/types.ts) or [SPEC/v2/rag/configuration.md](SPEC/v2/rag/configuration.md). Those links will not resolve correctly from the Saivage repo root.

It also uses some unlinked file references and cites source line ranges that no longer match the current code, especially around `RagSource`, provider configuration, and records ingest. The next analysis should use current repo-root-relative links and avoid references to process rounds or prior revisions.

VERDICT: CHANGES_REQUESTED
1. Rework the architecture to satisfy the topic goal: the MCP facades must be thin RAG-backed facades with the old storage/index/lookup code removed or explicitly reduced to a justified sidecar, not a permanent authoritative flat-file records layer plus RAG mirror.
2. Remove proposed public changes to [src/rag/](src/rag/) from the F01 design. If a required capability is absent, name it as a follow-up and design the F01 migration around the existing `Dataset` and `IngestInput` surface.
3. Correct all factual API/type mismatches: `RagSource`, provider model/config shape, `DatasetConfig.source`, `IngestInput.items`, fixed `ChunkMetadata` columns, `QueryFilter` limitations, path-based record ingest diffing, and the actual MCP tool names.
4. Provide the required schema gap analysis, including a concrete sidecar schema for non-ChunkMetadata fields, field-drop justifications, and query/post-load enforcement rules for lifecycle, target agents, scope, and permissions.
5. Fill the missing required coverage: source roots/globs/sample sizes, stable identity for built-in skills and project records, first-run dataset seeding, exact startup/unregistered/drift errors, partial mirror failure handling, lock ordering, and stage/session archival behavior.
6. Replace the partial file-action table with a complete keep/rewrite/delete inventory for every file under [src/knowledge/](src/knowledge/) and the knowledge MCP files, including tests.
7. Resolve the internal contradictions around keyword deletion versus eager matching, tombstones versus delete-by-filter, RAG-disabled behavior, and the two competing "only RAG change" claims.
8. Fix style issues by using repo-root-relative markdown links, current line anchors, and no process-round or revision-number references in the analysis body.