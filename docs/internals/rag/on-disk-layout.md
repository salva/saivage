# RAG on-disk layout

Everything a dataset persists lives under
`<projectRoot>/.saivage/rag/<datasetId>/`. Each layer is owned by exactly
one module — operators should not edit any file in this tree by hand.

## Per-dataset directory

```
<projectRoot>/.saivage/rag/<datasetId>/
├── store.db          SQLite database (sqlite-vec extension loaded)
├── store.db-wal      SQLite WAL (transient)
├── store.db-shm      SQLite SHM (transient)
├── .ingest.lock      proper-lockfile sentinel; held while ingest runs
└── store.db.corrupted sentinel written before a CorruptedStoreError throw
```

When `dataset.drop()` is invoked the entire directory is removed.

## Registry

`<projectRoot>/.saivage/rag/registry.json`:

```jsonc
{
  "entries": [
    {
      "id": "project-docs",
      "projectId": "example-project",
      "source": "doc",
      "providerStamp": { "provider": "openai", "model": "...", "dim": 1536, "releaseFingerprint": "..." },
      "createdAt": "2026-05-30T08:00:00.000Z"
    }
  ]
}
```

The registry is written atomically (`registry.json.<pid>.<ts>.tmp` + rename
into place) by `src/rag/registry.ts`. The manager re-derives drift checks
from this file on every `register`.

## Vector store tables (sqlite-vec)

| Table              | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `chunk`            | One row per chunk: id, path, source kind, metadata columns, text     |
| `vec_chunk`        | sqlite-vec virtual table holding the Float32 vectors                 |
| `embedding_cache`  | Stamp-keyed cache: `(stampFingerprint, contentHash) -> embedding`    |
| `file_state`       | `(path) -> { sourceHash, mtimeMs, lastIngestAt }`                    |
| `meta`             | Provider stamp, `createdAt`, `lastIngestAt`, `secretsDroppedTotal`   |

### Chunk id formula

```
chunkId = sha256(contentNormalized || '\0' || path || '\0' || startLine || '\0' || endLine)
```

`contentNormalized` strips `\r\n` and trailing whitespace per line so
identical content from different OS line-endings hashes the same.

### Embedding cache key formula

```
cacheKey = sha256(`${provider}:${model}:${dim}:${releaseFingerprint}` || '\0' || contentHash)
```

The cache is preserved across re-ingests of the same content as long as
the provider stamp is unchanged, which means a `drift`-free re-walk of
the same files is free of network calls.

### Distance → score

sqlite-vec returns L2 distance over normalised unit vectors. The runtime
converts that to a cosine-style score:

```
score = 1 − distance² / 2
```

`store.query()` over-fetches `topK × POST_FILTER_OVERSHOOT` (4) so post-
filter (`QueryFilter`) results still satisfy `topK`.

## file_state contract

`file_state` is the ingest pipeline's source of truth for what is already
stored. The reconcile sweep diff is:

- file present on disk + matching `sourceHash` → no-op
- file present on disk + differing `sourceHash` → re-chunk + re-embed +
  upsert; old chunks for the path are deleted first
- file absent on disk but present in `file_state` → delete all chunks for
  the path; remove the `file_state` row

The watcher relies on this contract entirely; it never carries its own
incremental cache.
