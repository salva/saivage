# F01 — RAG subsystem implementation plan

## 1. Scope

This plan implements a focused in-process RAG (retrieval-augmented generation) library for Saivage v2 at [saivage/src/rag/](saivage/src/rag/), exposing dataset-centric ingest and query operations backed by a single SQLite-vector vector store (sqlite-vec on better-sqlite3), a single hosted embedding provider (OpenAI `text-embedding-3-small` routed through the existing OpenAI auth path), and three chunkers (markdown, code, memory). The library is opt-in via the project configuration slice `rag.enabled`; with the slice absent or `enabled: false`, no module path runs, no native dependency loads, no on-disk artifact is created under `.saivage/rag/`. The implementation lands new RAG-specific dependencies (`better-sqlite3`, `sqlite-vec`, `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, `picomatch`, `proper-lockfile`) in [saivage/package.json](saivage/package.json). The Node engine pin at `>=24.0.0` is a prerequisite owned by [F02](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md) step (a); F01 does not modify `engines.node`. Modifications outside [saivage/src/rag/](saivage/src/rag/) are limited to [saivage/package.json](saivage/package.json) and [saivage/src/config.ts](saivage/src/config.ts) — no other config files are touched. The existing [saivage/tsconfig.json](saivage/tsconfig.json), [saivage/eslint.config.js](saivage/eslint.config.js), and [saivage/vitest.config.ts](saivage/vitest.config.ts) are assumed sufficient as-is; if the implementer discovers a real need at execution time to alter any of them, that requires a new design decision rather than a midstream config edit. All work is TypeScript / ESM under Node LTS >=24.

## 2. Explicit non-goals

The following items are out of scope for this implementation and are deferred to a separate, later specification (forward pointer: a future `rag-consumers` spec under [saivage/SPEC/2026-05/](saivage/SPEC/2026-05/) will own them):

- Consumer integration with the skills loader, the memory manager at [saivage/src/knowledge/](saivage/src/knowledge/), the planner, or any agent role under [saivage/src/agents/](saivage/src/agents/). No code under [saivage/src/agents/](saivage/src/agents/), [saivage/src/runtime/](saivage/src/runtime/), [saivage/src/server/](saivage/src/server/), [saivage/src/knowledge/](saivage/src/knowledge/), or [saivage/web/](saivage/web/) is touched.
- Local embedding integration. The `EmbeddingProvider` seam is defined and a single OpenAI implementation ships; no local model, no `worker_threads` pool, no `@xenova/transformers` integration.
- MCP server surface around the RAG library. No tool exposure, no transport, no `@modelcontextprotocol/sdk` wiring inside the rag module.
- Telemetry, metrics, or tracing emitted by the RAG layer. Structured logs only via the existing log surface at [saivage/src/log.ts](saivage/src/log.ts).
- Encryption-at-rest for `store.db` files. The library inherits the parent `.saivage/` directory permissions.
- Reranking (cross-encoder or LLM-as-reranker) and hybrid BM25 + vector retrieval. No FTS5 index, no candidate-reranking stage.
- Cross-dataset query in a single call. Callers fan out to multiple `Dataset.query` invocations and merge client-side.
- Background ingest worker, write-ahead queue, or file-watcher daemon. Ingest is synchronous from the caller's perspective.
- Web UI, dashboard, or CLI surface for dataset administration. Visibility is via `Dataset.stats()` and structured logs only.
- Quantization (float16, int8) of stored vectors. Native float32 only.

## 3. Validation commands (referenced by every batch)

| Tag | Command | Run from | Purpose |
|---|---|---|---|
| `T` | `npm run typecheck` | [saivage/](saivage/) | TypeScript compile check across the package |
| `L` | `npm run lint` | [saivage/](saivage/) | ESLint on `src/` |
| `U` | `npx vitest run src/rag` | [saivage/](saivage/) | Unit tests colocated under `src/rag/` |
| `E` | `npx vitest run tests/rag` | [saivage/](saivage/) | End-to-end tests under `tests/rag/` |
| `A` | `npm test` | [saivage/](saivage/) | Full vitest run (regression sweep) |
| `S` | manual smoke ingest — see B10 | [saivage/](saivage/) | Real OpenAI embed against a 50-doc fixture |

Each batch's `Validation` row lists the subset that MUST pass before the batch commit is considered done. Every batch ends with at minimum `T` + `L` + `A`. Functional batches add `U` for the slice they introduce; B10 adds `E` and `S`.

## 4. Rollback model (referenced by every batch)

Each batch lands as a single commit on a feature branch (e.g. `feat/rag-subsystem`). Rollback of any batch is `git revert <hash>` (or `git revert <oldest>..<newest>` for a contiguous range). The RAG subsystem is opt-in via the project configuration slice `rag.enabled`; absent the slice or with `enabled: false`, no rag module is loaded and no on-disk artifact is created. Therefore reverting any batch up to B09 leaves the rest of Saivage v2 unaffected at runtime for any project that has not opted in, and reverting B10/B11 leaves no behavioral footprint at all (tests + docs only). Operator-side rollback for an opted-in project is `rm -rf .saivage/rag/` plus removing the `rag` slice from the project config; the next start runs without the subsystem.

## 5. Batch summary

| Id | Title | Adds files | Modifies files | Validation | Depends on |
|---|---|---|---|---|---|
| B01 | RAG dependency landing | none | [saivage/package.json](saivage/package.json) | `T`, `L`, `A` | — |
| B02 | Public types, errors, config slice | [saivage/src/rag/types.ts](saivage/src/rag/types.ts), [saivage/src/rag/errors.ts](saivage/src/rag/errors.ts), [saivage/src/rag/index.ts](saivage/src/rag/index.ts), [saivage/src/rag/types.test.ts](saivage/src/rag/types.test.ts), [saivage/src/rag/errors.test.ts](saivage/src/rag/errors.test.ts) | [saivage/src/config.ts](saivage/src/config.ts) | `T`, `L`, `U`, `A` | B01 |
| B03 | Vector store seam + sqlite-vec adapter | [saivage/src/rag/store/index.ts](saivage/src/rag/store/index.ts), [saivage/src/rag/store/sqlite-vec.ts](saivage/src/rag/store/sqlite-vec.ts), [saivage/src/rag/store/sql.ts](saivage/src/rag/store/sql.ts), [saivage/src/rag/store/sqlite-vec.test.ts](saivage/src/rag/store/sqlite-vec.test.ts) | none | `T`, `L`, `U`, `A` | B02 |
| B04 | Embedding provider seam + OpenAI adapter | [saivage/src/rag/provider/index.ts](saivage/src/rag/provider/index.ts), [saivage/src/rag/provider/openai.ts](saivage/src/rag/provider/openai.ts), [saivage/src/rag/provider/openai.test.ts](saivage/src/rag/provider/openai.test.ts) | none | `T`, `L`, `U`, `A` | B02 |
| B05 | Chunker seam + markdown / code / memory chunkers | [saivage/src/rag/chunker/index.ts](saivage/src/rag/chunker/index.ts), [saivage/src/rag/chunker/tokens.ts](saivage/src/rag/chunker/tokens.ts), [saivage/src/rag/chunker/markdown.ts](saivage/src/rag/chunker/markdown.ts), [saivage/src/rag/chunker/code.ts](saivage/src/rag/chunker/code.ts), [saivage/src/rag/chunker/memory.ts](saivage/src/rag/chunker/memory.ts), plus `*.test.ts` siblings | none | `T`, `L`, `U`, `A` | B02 |
| B06 | Secret-exclusion guard | [saivage/src/rag/security/secrets.ts](saivage/src/rag/security/secrets.ts), [saivage/src/rag/security/secrets.test.ts](saivage/src/rag/security/secrets.test.ts) | none | `T`, `L`, `U`, `A` | B02 |
| B07 | Ingest pipeline + per-dataset lock + embedding cache | [saivage/src/rag/ingest/walker.ts](saivage/src/rag/ingest/walker.ts), [saivage/src/rag/ingest/pipeline.ts](saivage/src/rag/ingest/pipeline.ts), [saivage/src/rag/ingest/lock.ts](saivage/src/rag/ingest/lock.ts), [saivage/src/rag/cache/embedding-cache.ts](saivage/src/rag/cache/embedding-cache.ts), plus `*.test.ts` siblings | none | `T`, `L`, `U`, `A` | B03, B04, B05, B06 |
| B08 | Query pipeline + drift refusal | [saivage/src/rag/query/pipeline.ts](saivage/src/rag/query/pipeline.ts), [saivage/src/rag/query/pipeline.test.ts](saivage/src/rag/query/pipeline.test.ts) | none | `T`, `L`, `U`, `A` | B03, B04 |
| B09 | Dataset registry + RagManager lifecycle | [saivage/src/rag/manager.ts](saivage/src/rag/manager.ts), [saivage/src/rag/dataset.ts](saivage/src/rag/dataset.ts), [saivage/src/rag/registry.ts](saivage/src/rag/registry.ts), plus `*.test.ts` siblings | none | `T`, `L`, `U`, `A` | B07, B08 |
| B10 | End-to-end ingest+query smoke on fixture corpus | [saivage/tests/rag/e2e-ingest-query.test.ts](saivage/tests/rag/e2e-ingest-query.test.ts), [saivage/tests/rag/fixtures/docs/](saivage/tests/rag/fixtures/docs/) (~50 markdown docs), [saivage/tests/rag/README.md](saivage/tests/rag/README.md) | none | `T`, `L`, `U`, `E`, `S`, `A` | B09 |
| B11 | Factual SPEC notes | [saivage/SPEC/v2/rag/README.md](saivage/SPEC/v2/rag/README.md), [saivage/SPEC/v2/rag/configuration.md](saivage/SPEC/v2/rag/configuration.md), [saivage/SPEC/v2/rag/on-disk-layout.md](saivage/SPEC/v2/rag/on-disk-layout.md), [saivage/SPEC/v2/rag/operational-runbook.md](saivage/SPEC/v2/rag/operational-runbook.md) | none | `T`, `L` | B09 |

Eleven batches total. Branching strategy: a single long-lived branch `feat/rag-subsystem` with one commit per batch; merge to the integration branch only after B10 is green.

## 6. Batch detail

### B01 — RAG dependency landing

Prerequisite: [F02](saivage/SPEC/2026-05/node24-deps-refresh/F02-node24-deps-refresh.md) step (a) merged — `engines.node` is already `>=24.0.0` on master.

Goal: declare the new RAG runtime dependencies in one isolated commit so the rest of the work proceeds against a stable lockfile. The Node engine pin is not modified here; it is owned by F02 step (a).

Files modified:

- [saivage/package.json](saivage/package.json) — add the dependencies listed below. Do NOT touch the `engines` block.

Dependencies added (runtime):

```
better-sqlite3       ^12
sqlite-vec           ^0.1
tree-sitter          ^0.22
tree-sitter-typescript ^0.23
tree-sitter-python   ^0.23
picomatch            ^4
proper-lockfile      ^4
```

Dependencies added (dev):

```
@types/better-sqlite3 ^7
@types/picomatch      ^3
@types/proper-lockfile ^4
```

`js-tiktoken` is already a runtime dependency in [saivage/package.json](saivage/package.json) and is reused by B05 (the tokens module). No removals from the manifest.

After editing the manifest, run:

```
npm install
```

Verify the lockfile updates and that the prebuilt binaries land for the current Linux x64 host:

```
node -e "require('better-sqlite3')" && echo better-sqlite3 OK
node -e "require('sqlite-vec')"     && echo sqlite-vec OK
node -e "require('tree-sitter')"    && echo tree-sitter OK
node -e "require('tree-sitter-typescript')" && echo ts-grammar OK
node -e "require('tree-sitter-python')"     && echo py-grammar OK
node -e "require('proper-lockfile')" && echo lockfile OK
node -e "require('picomatch')"      && echo picomatch OK
```

If any of the native packages lacks a Node 24 / Linux x64 prebuild, the plan halts and a new design decision is requested. Do NOT introduce source-build fallbacks in this commit, and do NOT substitute an alternate vector store: this plan implements `sqlite-vec` only.

Validation: `T`, `L`, `A` (no source changes yet so all current tests must still pass).

Rollback: `git revert <hash>`; `npm install` to restore the prior lockfile.

Test count: 0 new tests in B01 (manifest-only change).

### B02 — Public types, errors, configuration slice

Goal: land the type surface, the typed error hierarchy, and the configuration schema. No runtime behaviour is added; subsequent batches import from here.

Files created:

- [saivage/src/rag/types.ts](saivage/src/rag/types.ts) — `Chunk`, `RawChunk`, `StoredChunk`, `ChunkMetadata`, `ChunkMetadataInput`, `QueryFilter`, `QueryOptions`, `QueryHit`, `DatasetConfig`, `DatasetStats`, `IngestInput`, `IngestReport`, `ProviderStamp`, `EmbeddingProviderRef`, `VectorStoreRef`, `ChunkerRef`, `RegisteredDataset`. Matches the public surface fixed in the design.
- [saivage/src/rag/errors.ts](saivage/src/rag/errors.ts) — exported error classes: `RagError` (base), `ConfigDriftError`, `EmbeddingDriftError`, `CorruptedStoreError`, `ProviderUnavailableError`, `IngestLockedError`, `SecretDroppedError`, `DatasetNotFoundError`, `InvalidQueryFilterError`. Each carries documented fields (e.g. `EmbeddingDriftError` carries `{ expected: ProviderStamp, actual: ProviderStamp }`).
- [saivage/src/rag/index.ts](saivage/src/rag/index.ts) — re-exports the types and the manager factory (the latter is filled in by B09; in B02 it is an empty `export {}` placeholder file).
- [saivage/src/rag/types.test.ts](saivage/src/rag/types.test.ts) — compile-time shape assertions plus a couple of structural sanity tests (e.g. `QueryFilter` union members construct).
- [saivage/src/rag/errors.test.ts](saivage/src/rag/errors.test.ts) — every error subclass round-trips its fields via `new Error()`-style construction and is detectable via `instanceof`.

Files modified:

- [saivage/src/config.ts](saivage/src/config.ts) — add the `rag` top-level slice to the project config Zod schema and export the inferred TypeScript type (e.g. `RagConfig`). Shape (exact literal as designed):

```ts
rag: z.object({
  enabled: z.boolean().default(false),
  datasets: z.array(z.object({
    id: z.string().min(1),
    source: z.enum(["skill", "memory", "doc", "code"]),
    provider: z.object({
      kind: z.literal("openai"),
      model: z.literal("text-embedding-3-small").default("text-embedding-3-small"),
      dim: z.union([z.literal(256), z.literal(512), z.literal(1024), z.literal(1536)]).default(1536),
    }),
    store: z.object({
      kind: z.literal("sqlite-vec").default("sqlite-vec"),
    }).default({ kind: "sqlite-vec" }),
    chunker: z.object({
      kind: z.enum(["markdown", "code", "memory"]),
      chunkSize: z.number().int().positive().optional(),
      overlap: z.number().min(0).max(0.5).optional(),
    }),
    exclusions: z.array(z.string()).default([]),
  })).default([]),
}).default({ enabled: false, datasets: [] }),
```

Constraint: the slice MUST be additive. No existing key in the config schema is renamed, removed, or restructured. The existing tests at [saivage/src/config.test.ts](saivage/src/config.test.ts) and [saivage/src/config-validation.test.ts](saivage/src/config-validation.test.ts) must continue to pass without edits.

Validation: `T`, `L`, `U` (against [saivage/src/rag/types.test.ts](saivage/src/rag/types.test.ts) and [saivage/src/rag/errors.test.ts](saivage/src/rag/errors.test.ts)), `A`.

Rollback: `git revert <hash>`.

Test count: ~2 unit test files, ~10 assertions total.

### B03 — Vector store seam + sqlite-vec adapter

Goal: define the `VectorStore` interface and ship the sqlite-vec adapter. No embedding logic, no chunker awareness — the adapter accepts `Float32Array` vectors and `StoredChunk` rows from the caller.

Files created:

- [saivage/src/rag/store/index.ts](saivage/src/rag/store/index.ts) — `export interface VectorStore` (verbatim from the design surface: `open`, `upsert`, `deleteByFilter`, `deleteByIds`, `query`, `stats`, `close`, `drop`) plus the `StoredChunk` and `StoredHit` types it consumes. Factory `createVectorStore(ref: VectorStoreRef, path: string): VectorStore` dispatches on `ref.kind`.
- [saivage/src/rag/store/sqlite-vec.ts](saivage/src/rag/store/sqlite-vec.ts) — `SqliteVecStore` implementation: opens a `better-sqlite3` `Database`, sets `PRAGMA journal_mode = WAL` and `PRAGMA synchronous = NORMAL`, loads the `sqlite-vec` extension via `db.loadExtension(require('sqlite-vec').getLoadablePath())`, creates the schema (`meta`, `chunk`, `vec_chunk`, `embedding_cache`, `file_state`) and the index set documented in the design, runs `PRAGMA integrity_check` on open and writes a `.corrupted` sentinel on failure. The `dim` literal in the `vec0` declaration is substituted from the `ProviderStamp` passed to `open()`; subsequent opens validate the stamp against the `meta` table and throw `EmbeddingDriftError` on mismatch.
- [saivage/src/rag/store/sql.ts](saivage/src/rag/store/sql.ts) — pure functions that compose SQL fragments for the `QueryFilter` shapes: `eq`, `and`, `or`, `gt`/`lt`, `in`, `pathGlob`. Decides pre-filter vs. post-filter per shape (equality and `in` on indexed columns become candidate-rowid subqueries; range and `pathGlob` run as a `WHERE` after the `MATCH` with an internal `K * overshoot` multiplier). No exported knob for the overshoot.
- [saivage/src/rag/store/sqlite-vec.test.ts](saivage/src/rag/store/sqlite-vec.test.ts) — open creates schema; second open with mismatched stamp throws `EmbeddingDriftError`; integrity-check failure on a deliberately truncated file throws `CorruptedStoreError`; upsert is idempotent on identical `id`; `deleteByFilter` matches every `QueryFilter` shape; `query` returns top-K rows in score order; `drop` removes the file and its WAL siblings.

Files modified: none.

Validation: `T`, `L`, `U`, `A`.

Rollback: `git revert <hash>`; no on-disk state outside test temp dirs.

Test count: ~1 unit test file, ~12 assertions.

### B04 — Embedding provider seam + OpenAI adapter

Goal: define the `EmbeddingProvider` interface and ship a single OpenAI implementation that routes through the existing Saivage auth path for OpenAI. No fallback chain, no second provider.

Files created:

- [saivage/src/rag/provider/index.ts](saivage/src/rag/provider/index.ts) — `export interface EmbeddingProvider`, `ProviderRegistry`, and a `createEmbeddingProvider(ref: EmbeddingProviderRef): Promise<EmbeddingProvider>` factory that dispatches on `ref.kind` (only `"openai"` in v1).
- [saivage/src/rag/provider/openai.ts](saivage/src/rag/provider/openai.ts) — `OpenAIEmbeddingProvider`: constructs an authenticated `openai` SDK client by calling the existing auth resolution path used by the Saivage chat completions surface (whichever path is in use under [saivage/src/auth/](saivage/src/auth/)); never reads `.saivage/auth-profiles.json` directly. Implements `embedDocuments` with a per-request cap of 96 inputs (chunks the input array internally), honours `Retry-After` on 429, retries with capped attempts (e.g. 5) and exponential backoff, throws `ProviderUnavailableError` on persistent failure. Implements `embedQuery` as a single-document `embedDocuments` call. Stamp exposes `{ provider: "openai", model, dim, releaseFingerprint }`.

  `releaseFingerprint` is defined as the deterministic local hash `sha256("openai:" + modelName + ":" + dim).slice(0, 16)`, computed at provider construction time. The value is persisted to dataset `meta` on first ingest; on every subsequent open the runtime stamp is compared against `meta` and any mismatch aborts ingest/query with `EmbeddingDriftError`. Rationale: OpenAI does not currently publish a per-deployment release or version header on the embeddings response, so v1 pins the fingerprint to the contract `(provider, model, dim)` itself. If OpenAI later exposes such a header, the implementer replaces this derivation in a future revision — but v1 uses the deterministic local hash.
- [saivage/src/rag/provider/openai.test.ts](saivage/src/rag/provider/openai.test.ts) — mocks the openai client; asserts batching at the 96 cap, retry on synthetic 429, surfacing of `ProviderUnavailableError`, stamp population (including the deterministic `releaseFingerprint`), dimension truncation honoured when `ref.dim !== 1536`. An integration sibling test gated on `OPENAI_API_KEY` is deferred to B10's `tests/rag/` tree to keep B04 fully offline.

Files modified: none.

Validation: `T`, `L`, `U`, `A`.

Rollback: `git revert <hash>`.

Test count: ~1 unit test file, ~10 assertions.

### B05 — Chunker seam + chunkers + tokens

Goal: ship the `Chunker` interface and the three chunker implementations. Pure functions over text + path + metadata; no I/O, no embedding, no store awareness.

Files created:

- [saivage/src/rag/chunker/index.ts](saivage/src/rag/chunker/index.ts) — `Chunker` interface (verbatim from the design surface) and `createChunker(ref: ChunkerRef): Chunker` factory dispatching on `ref.kind`.
- [saivage/src/rag/chunker/tokens.ts](saivage/src/rag/chunker/tokens.ts) — `countTokens(text: string): number` backed by `js-tiktoken` with `cl100k_base`; falls back to `Math.ceil(text.length / 4)` when the encoder fails to load.
- [saivage/src/rag/chunker/markdown.ts](saivage/src/rag/chunker/markdown.ts) — header-recursive splitter producing chunks with `headingPath` metadata; ~15% overlap default; greedy merge for undersized sections; oversized sections split at paragraph boundaries.
- [saivage/src/rag/chunker/code.ts](saivage/src/rag/chunker/code.ts) — tree-sitter-aware (TypeScript and Python grammars loaded eagerly); produces chunks at function / class boundaries with `symbolName`, `symbolKind`, and `language` metadata. On grammar load failure, falls back to a regex/blank-line splitter that does NOT populate symbol metadata.
- [saivage/src/rag/chunker/memory.ts](saivage/src/rag/chunker/memory.ts) — atomic up to 1000 tokens; above the threshold, delegates to the markdown chunker with `recordId` propagated to every sub-chunk.
- [saivage/src/rag/chunker/markdown.test.ts](saivage/src/rag/chunker/markdown.test.ts), [saivage/src/rag/chunker/code.test.ts](saivage/src/rag/chunker/code.test.ts), [saivage/src/rag/chunker/memory.test.ts](saivage/src/rag/chunker/memory.test.ts), [saivage/src/rag/chunker/tokens.test.ts](saivage/src/rag/chunker/tokens.test.ts) — one file per chunker plus tokens.

Token cap policy: every chunker MUST enforce a configurable hard maximum on emitted chunk size measured in tokens via `countTokens`. The default cap is 7500 tokens, chosen to leave headroom under the documented OpenAI `text-embedding-3-small` per-input maximum of 8191 tokens. Any chunk that would exceed the cap after splitting is re-split at the next-finer boundary (paragraph for markdown/memory, statement for code); if no finer boundary exists, the chunker falls back to hard token-count splitting on whitespace. The cap is exposed through `ChunkerRef.chunkSize` from the config schema but defaults to 7500 when unset.

Files modified: none.

Validation: `T`, `L`, `U`, `A`.

Rollback: `git revert <hash>`.

Test count: ~4 unit test files, ~25 assertions.

### B06 — Secret-exclusion guard

Goal: ship the non-overridable credential glob set and per-chunk regex scan. Operator-overridable globs are NOT here — those live in `DatasetConfig.exclusions` and are applied by the walker in B07.

Files created:

- [saivage/src/rag/security/secrets.ts](saivage/src/rag/security/secrets.ts) — exports `shouldSkipPath(path: string): boolean` and `scanChunk(text: string): { dropped: boolean; reason?: string }`. The mandatory glob list blocks at minimum: `**/.saivage/auth-profiles.json`, `**/.saivage/auth-profiles.*.json`, `**/.env*`, `**/*.pem`, `**/*.key`, `**/id_rsa*`, `**/.ssh/**`, `**/.aws/credentials`, `**/.netrc`, `**/secrets/**`. The mandatory regex set covers at minimum: OpenAI keys (`sk-[A-Za-z0-9]{20,}`), Anthropic keys (`sk-ant-[A-Za-z0-9_-]{20,}`), GitHub tokens (`gh[pousr]_[A-Za-z0-9]{36,}`), Slack tokens (`xox[abpr]-[A-Za-z0-9-]{10,}`), AWS access keys (`AKIA[0-9A-Z]{16}`), AWS secret keys (40-char base64 adjacent to `secret_access_key` line markers), PEM blocks (`-----BEGIN [A-Z ]+PRIVATE KEY-----`). The regex set MUST be cross-checked against the patterns already detected by [saivage/src/knowledge/store.ts](saivage/src/knowledge/store.ts) and aligned without weakening either.
- [saivage/src/rag/security/secrets.test.ts](saivage/src/rag/security/secrets.test.ts) — every glob blocks the matching path; every regex drops the matching chunk; non-matching paths and chunks pass through.

Files modified: none.

Validation: `T`, `L`, `U`, `A`.

Rollback: `git revert <hash>`.

Test count: ~1 unit test file, ~15 assertions.

### B07 — Ingest pipeline + per-dataset lock + embedding cache

Goal: assemble walker, chunker, secrets, embedding cache, and store into the synchronous ingest pipeline. Cross-process safety via `proper-lockfile`.

Files created:

- [saivage/src/rag/ingest/walker.ts](saivage/src/rag/ingest/walker.ts) — filesystem walker that honours include globs, mandatory + operator exclusion globs, resolves symlinks once with a visited-inode set, yields `{ path, sourceHash, mtimeMs }` in stable order. Hard exclusion of `**/.git/**`, `**/node_modules/**`, `**/.saivage/**`, plus everything from `secrets.ts`.
- [saivage/src/rag/ingest/lock.ts](saivage/src/rag/ingest/lock.ts) — thin wrapper around `proper-lockfile.lock(path, { stale: 60_000, update: 10_000, retries: 0 })` returning a release handle; throws `IngestLockedError` immediately on a live lock; retries a stale lock exactly once and then throws.
- [saivage/src/rag/cache/embedding-cache.ts](saivage/src/rag/cache/embedding-cache.ts) — keyed lookup against the `embedding_cache` SQLite table by `sha256(stamp || '\0' || contentHash)`; serializes `Float32Array` to bytes and back. Lives in the same `store.db` as the dataset (the table created in B03).
- [saivage/src/rag/ingest/pipeline.ts](saivage/src/rag/ingest/pipeline.ts) — the top-level `runIngest(dataset, input)` function: acquires the lock, walks, diffs against `file_state`, chunks changed files, runs `secrets.scanChunk` per chunk, queries the embedding cache, batches cache misses to `provider.embedDocuments`, writes per-batch transactions to `store.upsert`, performs symmetric-difference `store.deleteByIds` for stale chunks at the same `path`, updates `file_state`, stamps `meta.lastIngestAt`, returns `IngestReport`. Crash semantics: per-batch transactions guarantee atomicity; the next ingest resumes via `file_state`.
- [saivage/src/rag/ingest/walker.test.ts](saivage/src/rag/ingest/walker.test.ts), [saivage/src/rag/ingest/lock.test.ts](saivage/src/rag/ingest/lock.test.ts), [saivage/src/rag/ingest/pipeline.test.ts](saivage/src/rag/ingest/pipeline.test.ts), [saivage/src/rag/cache/embedding-cache.test.ts](saivage/src/rag/cache/embedding-cache.test.ts) — exclusion short-circuit, symlink cycle, mandatory excludes always win; lock acquire/release, double-acquire throws, stale-lock single retry; pipeline diff correctness (no work on unchanged files, exact set of upserts and deletes on a changed file), secrets dropped count, cache hit ratio after a no-op re-ingest is 1.0; cache key derivation includes stamp.

Files modified: none.

Validation: `T`, `L`, `U`, `A`.

Rollback: `git revert <hash>`.

Test count: ~4 unit test files, ~30 assertions.

### B08 — Query pipeline + drift refusal

Goal: assemble provider, store, and post-filter into the query path. Refuse queries when the runtime provider stamp disagrees with the stamp written into `meta` at ingest time.

Files created:

- [saivage/src/rag/query/pipeline.ts](saivage/src/rag/query/pipeline.ts) — `runQuery(dataset, text, options)`: validates the stamp via `store.open(currentStamp)` (the store throws `EmbeddingDriftError` on mismatch; the query pipeline lets it propagate); calls `provider.embedQuery(text)`; calls `store.query(vec, K * overshoot, options.filter)` where `overshoot` is a small internal constant (2–4); applies post-filter when `sql.ts` reports the filter was not fully expressible as pre-filter; truncates to `topK` (default 10); hydrates `text` and `metadata` from the `chunk` table; returns `QueryHit[]` sorted by score desc.
- [saivage/src/rag/query/pipeline.test.ts](saivage/src/rag/query/pipeline.test.ts) — stamp mismatch surfaces as `EmbeddingDriftError`; provider outage surfaces as `ProviderUnavailableError`; top-K respected; metadata hydrated; post-filter applied for filter shapes the pre-filter path cannot fully express.

Files modified: none.

Validation: `T`, `L`, `U`, `A`.

Rollback: `git revert <hash>`.

Test count: ~1 unit test file, ~8 assertions.

### B09 — Dataset registry + RagManager lifecycle

Goal: ship the operator-visible lifecycle surface: `register`, `list`, `get`, plus the `Dataset` methods (`ingest`, `delete`, `query`, `stats`, `rebuild`, `drop`).

Files created:

- [saivage/src/rag/registry.ts](saivage/src/rag/registry.ts) — reads and writes `<projectRoot>/.saivage/rag/registry.json` atomically (write to `registry.json.tmp` + `rename`). Tolerates a missing file (treats as empty registry).
- [saivage/src/rag/dataset.ts](saivage/src/rag/dataset.ts) — `Dataset` implementation that owns a `VectorStore`, an `EmbeddingProvider`, and a `Chunker`, delegates `ingest`/`query` to B07/B08, implements `rebuild`, implements `drop` (close + `unlink` of `<datasetId>/`), implements `stats` by aggregating `store.stats()` + `meta` rows + the secrets-dropped counter.

  `rebuild` staging layout: writes the new dataset into a sibling directory `<projectRoot>/.saivage/rag/<datasetId>.rebuild/`. On successful completion (every file ingested, every chunk embedded and upserted, integrity check green), `rebuild` closes the old database, atomically renames `<datasetId>.rebuild/` over `<datasetId>/` (using `fs.rename` on the directory), and reopens. On any failure mid-rebuild, the staging directory is removed and the existing `<datasetId>/` is left untouched. On `Dataset.open()` any leftover `<datasetId>.rebuild/` directory from a prior crash is deleted before opening the live dataset.
- [saivage/src/rag/manager.ts](saivage/src/rag/manager.ts) — `createRagManager(projectRoot, config)`: returns `RagManager` (a no-op object when `config.rag.enabled` is false); on `enabled: true`, instantiates a `Dataset` per entry, defers `store.open` until first `ingest` / `query`. Exposes `register(config)`, `list()`, `get(id)`. `register` validates the slot against the project config, creates the dataset directory, opens the store, writes the stamp to `meta`, appends to `registry.json`.
- [saivage/src/rag/dataset.test.ts](saivage/src/rag/dataset.test.ts), [saivage/src/rag/manager.test.ts](saivage/src/rag/manager.test.ts), [saivage/src/rag/registry.test.ts](saivage/src/rag/registry.test.ts) — `rebuild` produces the same chunk count and same top-K results as a fresh ingest on a fixture, leaves no `<datasetId>.rebuild/` directory on success, removes the staging directory on simulated failure; `drop` removes the directory; `register` is idempotent on re-call with identical config and throws `ConfigDriftError` when called with a config that differs in `provider.dim` or `chunker.kind`; registry atomic writes survive simulated mid-write crash.
- [saivage/src/rag/index.ts](saivage/src/rag/index.ts) — fill in the actual re-exports (`createRagManager`, types, errors) replacing the B02 placeholder.

Files modified: none.

Validation: `T`, `L`, `U`, `A`.

Rollback: `git revert <hash>`.

Test count: ~3 unit test files, ~20 assertions.

### B10 — End-to-end ingest+query smoke

Goal: prove the subsystem on a real fixture corpus and a real OpenAI account.

Files created:

- [saivage/tests/rag/fixtures/docs/](saivage/tests/rag/fixtures/docs/) — ~50 small hand-written markdown documents (each ~200–800 tokens) covering a synthetic project's "architecture", "operations", "glossary", and "decisions" sections so the query side has unambiguous targets.
- [saivage/tests/rag/e2e-ingest-query.test.ts](saivage/tests/rag/e2e-ingest-query.test.ts) — gated on `OPENAI_API_KEY` (skip when absent); creates a temp project root under `tmp/rag-e2e/<uuid>/.saivage/`, instantiates `RagManager` with one `markdown` dataset, ingests the fixture tree, asserts `IngestReport.filesScanned ≈ 50` and `chunksUpserted > 0`, runs three canned queries with known target documents, asserts the target document is in the top-3 hits, runs a no-op re-ingest, asserts cache hit ratio is 1.0 (zero `tokensEmbedded`), drops the dataset, asserts the directory is gone.
- [saivage/tests/rag/e2e-drift.test.ts](saivage/tests/rag/e2e-drift.test.ts) — offline (no `OPENAI_API_KEY` required): ingests a tiny records-mode dataset with a fake provider stamped `dim=512`, then reopens with a fake provider stamped `dim=1024`, asserts `query` throws `EmbeddingDriftError`.
- [saivage/tests/rag/README.md](saivage/tests/rag/README.md) — documents the manual smoke ingest procedure (the `S` validation step):

```
# from saivage/
export OPENAI_API_KEY=sk-...
npx vitest run tests/rag/e2e-ingest-query.test.ts
```

Plus a documented manual fallback: a tiny script invocation pattern that constructs a `RagManager`, ingests `tests/rag/fixtures/docs/`, runs one query, prints `IngestReport` + top-3 `QueryHit`s, and exits. The script itself is not committed; the README shows the invocation shape so an operator can reproduce.

Files modified: none.

Validation: `T`, `L`, `U`, `E`, `S` (operator runs `S` manually with a real `OPENAI_API_KEY`), `A`.

Rollback: `git revert <hash>`. The smoke-test fixture corpus is removed by the revert.

Test count: ~2 e2e test files, ~12 assertions (plus the manual smoke).

### B11 — SPEC notes

Goal: land factual operator-facing notes adjacent to the existing SPEC tree. Notes only; no docstrings or comments are injected into source files.

Files created:

- [saivage/SPEC/v2/rag/README.md](saivage/SPEC/v2/rag/README.md) — one-page index pointing at the other notes and at this plan's batch list. States the opt-in story.
- [saivage/SPEC/v2/rag/configuration.md](saivage/SPEC/v2/rag/configuration.md) — the `rag` config slice shape, every field's meaning, the per-source recommended chunker, and the `dim` selection rationale.
- [saivage/SPEC/v2/rag/on-disk-layout.md](saivage/SPEC/v2/rag/on-disk-layout.md) — the `<projectRoot>/.saivage/rag/<datasetId>/` layout, the `meta` table contents, the integrity-check + `.corrupted` sentinel + `.ingest.lock` semantics, the `<datasetId>.rebuild/` staging directory, and the recovery procedure (`rebuild`).
- [saivage/SPEC/v2/rag/operational-runbook.md](saivage/SPEC/v2/rag/operational-runbook.md) — how to read `Dataset.stats()`, how to interpret `IngestReport`, what `EmbeddingDriftError` means and how to recover, what `IngestLockedError` means and how to recover, where the secret-dropped counter lives.

Files modified: none. Source files are NOT annotated; no docstrings, no comments are added to code introduced by B02–B09 retroactively.

Validation: `T` + `L` (typecheck and lint, since adding documentation files can break the build only if they accidentally touch source). No test commands needed; `npm run typecheck && npm run lint` must remain green.

Rollback: `git revert <hash>`.

Test count: 0.

## 7. Test surface summary

| Layer | Location | Test files | Approximate assertions |
|---|---|---|---|
| Types & errors | colocated under `src/rag/` | 2 | 10 |
| Vector store | colocated under `src/rag/store/` | 1 | 12 |
| Embedding provider | colocated under `src/rag/provider/` | 1 | 10 |
| Chunkers + tokens | colocated under `src/rag/chunker/` | 4 | 25 |
| Secrets | colocated under `src/rag/security/` | 1 | 15 |
| Ingest + cache + lock + walker | colocated under `src/rag/ingest/` and `src/rag/cache/` | 4 | 30 |
| Query | colocated under `src/rag/query/` | 1 | 8 |
| Manager / dataset / registry | colocated under `src/rag/` | 3 | 20 |
| End-to-end (incl. drift) | under [saivage/tests/rag/](saivage/tests/rag/) | 2 | 12 |
| Manual smoke (`S`) | documented in [saivage/tests/rag/README.md](saivage/tests/rag/README.md) | 0 | 1 (operator-run) |

Tests colocated next to source follow the existing Saivage v2 convention visible in [saivage/src/config.test.ts](saivage/src/config.test.ts) and [saivage/src/config-validation.test.ts](saivage/src/config-validation.test.ts); end-to-end tests live under [saivage/tests/rag/](saivage/tests/rag/), which is a new top-level test directory introduced in B10. The existing [saivage/vitest.config.ts](saivage/vitest.config.ts) is assumed to already pick up both locations; if the implementer discovers it does not at execution time, that requires a new design decision rather than a midstream config edit.

## 8. Open questions for the implementer

The implementer MUST resolve the following before the corresponding batch lands; if any answer invalidates an assumption in this plan, halt and request a new design decision rather than working around it.

- B01: confirm `sqlite-vec` (latest stable line) ships a Linux x64 prebuilt against Node 24 in the npm package; pinpoint the exact published version and update the table in §6/B01. If no prebuild ships, halt and request a new design decision; do not introduce a source-build fallback and do not substitute an alternate vector store.
- B01: confirm `better-sqlite3` `^12` is the most recent line with a Node 24 / Linux x64 prebuild and a working `db.loadExtension` against the `sqlite-vec` shipped path. If a different major is required, pin the exact major in §6/B01.
- B01: confirm `proper-lockfile` exposes a working ESM entrypoint under `"type": "module"` and that the `stale` + `update` options are honoured against an `.ingest.lock` filename suffix (the package historically appends `.lock` itself — verify the call shape).
- B04: inspect [saivage/node_modules/@mariozechner/pi-ai](saivage/node_modules/@mariozechner/pi-ai) for an embeddings export. If present and stable across OpenAI, route through it for parity with the existing chat-completions surface; if absent, the direct `openai` SDK call documented in §6/B04 stands. Update §6/B04 with the chosen path.
- B07: confirm the OpenAI per-request input-array cap; if the documented cap is not 96, pin the exact value in §6/B04 and §6/B07.

## 9. Acceptance criteria

The work is accepted when ALL of the following hold on the integration branch:

- `npm run typecheck` exits cleanly with the changes from every batch B01–B11 merged.
- `npm run lint` exits cleanly under the same configuration.
- `npm test` (full vitest sweep) is green, including every colocated `src/rag/**/*.test.ts` file and every `tests/rag/**/*.test.ts` file.
- `npx vitest run src/rag` is green in isolation.
- `npx vitest run tests/rag` is green in isolation (with `OPENAI_API_KEY` unset, the openai-gated test skips; the drift test still runs).
- The manual smoke ingest documented in [saivage/tests/rag/README.md](saivage/tests/rag/README.md) succeeds against a real OpenAI account on a fixture of ~50 markdown documents: `IngestReport` reports `chunksUpserted > 0`, the three canned queries return the expected target document in the top-3 hits, a no-op re-ingest reports zero `tokensEmbedded` (cache hit ratio 1.0), and `Dataset.drop()` removes the dataset directory.
- The drift-refusal path triggers on a simulated stamp change: reopening the same dataset with a different `dim` causes `Dataset.query` to throw `EmbeddingDriftError`.
- With `rag.enabled` absent from a project's config, Saivage v2 starts, serves, and shuts down identically to its pre-B01 behaviour: no `.saivage/rag/` directory is created, no native dependency from B01 is loaded into the process (verified by inspecting the loaded-module list in a focused test or in the e2e harness).
- The secret-exclusion guard rejects every fixture path matching the mandatory glob set and every fixture chunk matching the mandatory regex set; this is asserted in B06's unit tests and exercised again by B10's e2e ingest (the fixture corpus includes one deliberately planted credential-shaped string in a non-blocked path).
