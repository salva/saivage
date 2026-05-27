# F01 RAG subsystem — design dance APPROVED

End-to-end approval marker. The Saivage v2 RAG subsystem design dance is complete.

## Approved deliverables (standalone documents)

| Stage | File | Verdict |
|---|---|---|
| Functional analysis | [01-analysis-r4.md](01-analysis-r4.md) | APPROVED ([review](01-analysis-review-r4.md)) |
| Design | [02-design-r2.md](02-design-r2.md) | APPROVED ([review](02-design-review-r2.md)) |
| Implementation plan | [03-plan-r2.md](03-plan-r2.md) | APPROVED ([review](03-plan-review-r2.md)) |
| Design + plan addendum | [04-addendum-r2.md](04-addendum-r2.md) | APPROVED ([review](04-addendum-review-r2.md)) |

Per-stage markers: [ANALYSIS-APPROVED.md](ANALYSIS-APPROVED.md), [DESIGN-APPROVED.md](DESIGN-APPROVED.md), [PLAN-APPROVED.md](PLAN-APPROVED.md), [ADDENDUM-APPROVED.md](ADDENDUM-APPROVED.md).

The addendum is binding — implementers must read it together with the base design and plan. Highlights:
- Facade and primitive seams are both first-class entry points; the librarian agent is one future consumer, not a gateway. Skills loader, memory manager, and other in-process callers may call the library directly.
- Dataset config gains `sources` (canonical roots) and `watch` (opt-in chokidar watcher) fields. New operations: `dataset.watch()`, `dataset.unwatch()`, `dataset.reconcile()`.
- Watcher waits indefinitely on `proper-lockfile` contention, coalescing into a single pending in-memory batch; mid-wait crashes recover via the next-startup `reconcile()`.
- Plan gains B12 (Directory watcher) between B10 and B11.

## Recommended proposal

**Proposal A — Focused in-process library** under [saivage/src/rag/](saivage/src/rag/):

- One vector store at v1: sqlite-vec via better-sqlite3 loadable extension.
- One hosted embedder at v1: OpenAI `text-embedding-3-small` (1536-d).
- Three chunkers: markdown header-recursive, code with regex+blank-line splitter (tree-sitter deferred), memory atomic.
- Cross-process ingest lock via `proper-lockfile`.
- Mandatory secret-exclusion glob set + per-chunk regex secret scan.
- Embedding-config drift refusal on `{provider, model, dim, releaseFingerprint}` mismatch; recovery is `dataset.rebuild()` with atomic staging directory swap.
- Per-project on-disk layout under `<projectRoot>/.saivage/rag/<datasetId>/`.
- Opt-in via `rag.enabled` config; absent or false = subsystem inert.

## Explicit non-goals (deferred to future specs)

- Integration with skills/memories/docs/code consumers (the entire reason this dance was design-only).
- Local embedding integration (designed-in seam exists; not implemented at v1).
- MCP surface, telemetry, encryption-at-rest, rerankers, hybrid BM25+vector, cross-dataset query, background ingest worker.

## Implementation sequence

Eleven foundational-first batches (B01–B11):

1. **B01** — Raise Node engines to >=24 in [saivage/package.json](saivage/package.json); add deps (better-sqlite3, sqlite-vec, proper-lockfile).
2. **B02** — Public types, error classes, `rag` config schema slice in [saivage/src/config.ts](saivage/src/config.ts).
3. **B03** — Vector store seam + sqlite-vec adapter under [saivage/src/rag/store/](saivage/src/rag/store/).
4. **B04** — Embedder seam + OpenAI adapter under [saivage/src/rag/embedder/](saivage/src/rag/embedder/) with deterministic releaseFingerprint.
5. **B05** — Chunker seam + three chunkers under [saivage/src/rag/chunker/](saivage/src/rag/chunker/); 7500-token default cap.
6. **B06** — Secret-exclusion guard under [saivage/src/rag/security/](saivage/src/rag/security/).
7. **B07** — Ingest pipeline with proper-lockfile + symmetric-difference delete under [saivage/src/rag/ingest/](saivage/src/rag/ingest/).
8. **B08** — Query pipeline + drift refusal under [saivage/src/rag/query/](saivage/src/rag/query/).
9. **B09** — Dataset manager + lifecycle (register/drop/stats/rebuild with staging-dir + atomic rename) at [saivage/src/rag/dataset.ts](saivage/src/rag/dataset.ts).
10. **B10** — End-to-end ingest+query smoke test under [saivage/tests/rag/](saivage/tests/rag/).
11. **B11** — Documentation under [saivage/SPEC/v2/rag/](saivage/SPEC/v2/rag/).

Modifications outside [saivage/src/rag/](saivage/src/rag/) are limited to [saivage/package.json](saivage/package.json) and [saivage/src/config.ts](saivage/src/config.ts).

Each batch is a single revertable commit; the subsystem is opt-in, so `git revert` plus `rag.enabled: false` is a complete rollback at every step.

## Pause point

This dance produced documents only. No code changed. The implementer / operator must explicitly authorize execution of the plan (Phase G of the iterative-dual-llm-review workflow) and confirm there is no overlapping active work in [saivage/src/agents/](saivage/src/agents/) (concurrent uncommitted work was observed at dance start) before starting B01.
