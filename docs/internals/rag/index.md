# RAG subsystem — operator overview

> **Status (F01 B11):** authoritative source for the RAG slice of Saivage v2.
> Implementation lives in `src/rag/` and the on-disk layout described below
> matches the code in `dataset.ts`, `store/sqlite-vec.ts`, and
> `watcher/controller.ts`. Refer to the original analysis / design / plan
> tree under `SPEC/2026-05/rag-subsystem-design/F01-rag-subsystem/` for the
> reasoning behind each contract; the docs in this folder are the working
> operator surface.

## What it does

The RAG subsystem is an opt-in retrieval store the Saivage runtime can query
to back chat completions with material drawn from one or more "datasets". A
dataset is an isolated triple of:

- a vector store (sqlite-vec on local disk),
- an embedding provider (currently `openai`),
- a chunker (`markdown`, `code`, or `memory`).

Each dataset persists under
`<projectRoot>/.saivage/rag/<datasetId>/`. Datasets never share files; this
keeps drift recovery (model swap, dim change, corruption) blast-radius
limited to a single id and a single directory.

## Why it is opt-in

`config.rag.enabled` defaults to `false`. With RAG disabled the runtime
incurs no embedding cost, no network calls, and no disk usage beyond the
empty config slice. Until the operator opts in, the RAG surface is a pure
no-op (`manager.list() === []`; every other call throws
`DatasetNotFoundError`).

## Files in this folder

- `configuration.md` — the user-facing config schema and validation rules.
- `on-disk-layout.md` — exactly which files live under
  `.saivage/rag/<id>/` and the contracts the runtime maintains over them.
- `operational-runbook.md` — operator playbook: ingest, query, rebuild,
  drift recovery, watcher caveats on LXC bind mounts and NFS.

## Key invariants (enforce or fail loud)

1. **Provider stamp pinning.** A dataset records the exact
   `provider:model:dim:releaseFingerprint` on first ingest and refuses any
   subsequent open whose stamp drifts. Recovery is `dataset.drop()` followed
   by a fresh `register` — there is no in-place migration.
2. **Secret exclusion is non-negotiable.** Every candidate file passes
   `shouldSkipPath` (which extends the project-wide blocklist with
   credential file globs), and every chunk's text passes `scanChunk`. Hits
   are dropped silently and counted in `secretsDropped`. There is no opt-in
   to disable this guard.
3. **One ingest at a time per dataset.** `proper-lockfile` arbitrates;
   concurrent calls receive `IngestLockedError`. The watcher also takes the
   same lock so reconcile sweeps and chokidar-triggered ingests cannot
   collide.
4. **Reconcile sweeps are authoritative.** Watcher events are best-effort
   coalescing; `dataset.reconcile()` is the canonical convergence
   mechanism. Operators running on LXC bind-mounts or NFS MUST schedule a
   periodic reconcile.

## Quick links into the implementation

- `src/rag/index.ts` — public surface.
- `src/rag/dataset.ts` — per-id facade (`open`, `ingest`, `query`,
  `reconcile`, `watch`, `unwatch`, `stats`, `drop`).
- `src/rag/manager.ts` — registry-aware factory.
- `src/rag/watcher/` — chokidar + debouncer + flood detector + reconcile.
- `src/rag/store/sqlite-vec.ts` — sqlite-vec persistence (cosine via L2
  distance: `score = 1 − distance² / 2`).
