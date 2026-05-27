# RAG operational runbook

This document is the operator playbook for the RAG subsystem. Code
pointers are absolute paths inside `saivage/`.

## 1. Enabling RAG for a project

1. Write `config.rag.enabled = true` and add at least one `datasets[]`
   entry (see `configuration.md`).
2. Restart the runtime (or call `createRagManager(...)` from a test
   harness).
3. Call `manager.register(datasetConfig)` once. This:
   - opens the store under `.saivage/rag/<id>/`,
   - validates / pins the provider stamp,
   - writes / refreshes the registry entry.

`register` is idempotent for matching stamps and throws
`ConfigDriftError` for stamp mismatches.

## 2. First ingest

```ts
const ds = await manager.register(cfg);
await ds.ingest({ kind: "fs", root: "/path/to/source", include: ["**/*.md"] });
```

Reports back an `IngestReport` with `chunksUpserted`,
`chunksDroppedSecrets`, `embeddingsRequested`, `embeddingsCacheHits`,
etc. Operators should check `chunksDroppedSecrets` and investigate any
non-zero count via `dataset_meta.secretsDropped`.

## 3. Query

```ts
const hits = await ds.query("how does X work?", { topK: 8, filter });
```

`hits` are sorted by descending score (see `on-disk-layout.md` for the
distance-to-score conversion). If the stored provider stamp drifts from
the manager's instantiated provider the call throws
`EmbeddingDriftError`.

## 4. Watcher

### 4.1 When to enable

Enable `watch` only when:
- the source content changes faster than your reconcile schedule, AND
- the source roots are on a filesystem that delivers inotify/fsevents
  events reliably (local ext4/xfs/btrfs/apfs).

For LXC bind mounts, NFS, FUSE, SSHFS, or any virtualised filesystem
the inotify-style events are unreliable. Use the polling form:

```jsonc
"watch": { "usePolling": true, "interval": 2000 }
```

…and combine it with a periodic external reconcile sweep (see §4.3).

### 4.2 Lifecycle

```ts
await ds.watch();    // arms chokidar, runs an initial reconcile
await ds.unwatch();  // disarms; idempotent
```

The controller acquires the same per-dataset lock as `ingest()`; events
that arrive while a long ingest is running are coalesced into the next
flush and proceed after the lock releases.

### 4.3 Reconciliation

`ds.reconcile()` runs even with `watch === false`. It walks
`config.sources[*]`, hashes each candidate file, compares against
`file_state`, and routes deltas through `runIngest`. Schedule it from a
cron or a long-running supervisor whenever the watcher is disabled or
running in polling mode.

### 4.4 Flood handling

The debouncer flushes after 1500 ms of quiescence. If the resulting batch
contains more than 5000 distinct paths, the controller logs the top-three
directories by event count and DROPS the batch. The next non-flood batch
proceeds normally; the rest can be repaired by an external
`ds.reconcile()`.

### 4.5 inotify limits

A `WatcherUnavailableError` (or an `ENOSPC` from chokidar) usually means
the host has exhausted its inotify watch limit. Either:

- raise the kernel limit
  (`/proc/sys/fs/inotify/max_user_watches`), or
- switch to polling (`watch: { "usePolling": true }`), or
- shrink the watched surface via per-source `exclude` patterns.

## 5. Drift recovery

Symptoms:

- `EmbeddingDriftError` on `open()` or `query()`.
- `ConfigDriftError` on `register()`.

Recovery:

1. Call `ds.drop()` — removes the directory and unlinks the registry
   entry.
2. Re-`register` with the new config.
3. Run the initial ingest again.

There is no in-place migration. By design.

## 6. Corruption recovery

If the runtime throws `CorruptedStoreError`, a `.corrupted` sentinel file
is present in the dataset directory. Recovery is the same as drift
recovery: drop, re-register, re-ingest.

## 7. Secret incidents

`scanChunk` is intentionally conservative and may produce false
positives. The flow is:

1. Inspect `dataset_meta.secretsDropped` and `IngestReport.chunksDroppedSecrets`.
2. Cross-reference with the path list under `file_state` for the most
   recent ingest.
3. If a false positive is suspected, examine the originating files
   directly. The RAG runtime never logs the offending content.

## 8. Bind-mount / NFS notes (F01 B12)

The classic-LXC containers in this workspace expose target projects via
bind mounts:

- `saivage-v3` ← `/home/salva/g/ml/saivage-v3` → `/work/saivage-v3`
- `diedrico`   ← `/home/salva/g/ml/diedrico`   → `/work/diedrico`

inotify events do not propagate across the bind. Datasets that watch
sources under `/work/...` MUST use the polling form:

```jsonc
"watch": { "usePolling": true, "interval": 2000 }
```

A 2-second interval is a good baseline; operators can tighten or loosen
it based on observed CPU pressure.

For NFS shares, the same rule applies. SSHFS and FUSE are inherently
unreliable for incremental indexing — prefer scheduled reconciles over
the watcher in those environments.

## 9. Test surface

| Concern                      | Test files                                        |
| ---------------------------- | ------------------------------------------------- |
| Type contracts               | `src/rag/types.test.ts`                           |
| Error classes                | `src/rag/errors.test.ts`                          |
| Chunkers                     | `src/rag/chunker/*.test.ts`                       |
| Secret guard                 | `src/rag/security/secrets.test.ts`                |
| Ingest pipeline              | `src/rag/pipeline.test.ts`                        |
| Query pipeline               | `src/rag/query/pipeline.test.ts`                  |
| Walker / lock / cache        | `src/rag/walker.test.ts` etc.                     |
| Registry + manager + dataset | `src/rag/registry.test.ts`, `src/rag/manager.test.ts` |
| Watcher (B12)                | `src/rag/watcher/*.test.ts`                       |
| Online ingest+query smoke    | `tests/rag/e2e-ingest-query.test.ts` (`OPENAI_API_KEY`) |
| Offline drift                | `tests/rag/e2e-drift.test.ts`                     |

The online suite is gated on `OPENAI_API_KEY` and is the only RAG test
that performs a real network call.
