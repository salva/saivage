# RAG configuration

The RAG slice lives at `config.rag` and is parsed by Zod in
`src/config.ts`. The slice is opt-in: with `enabled: false` the rest of the
slice is still validated but no datasets are instantiated.

## Top-level shape

```jsonc
{
  "rag": {
    "enabled": false,            // gate the entire subsystem
    "datasets": []               // ordered list of DatasetConfig entries
  }
}
```

`SaivageConfigSchema` uses `.strict()` at the top level, so unknown top-level
keys fail validation. Nested objects that are not explicitly strict use Zod's
default object behavior. Field defaults are filled by Zod at parse time;
operators may omit any field marked "default below".

## Per-dataset shape

```jsonc
{
  "id": "project-docs",          // unique within a project; matches dir name
  "source": "doc",               // "skill" | "memory" | "doc" | "code"
  "provider": {
    "kind": "openai",
    "model": "text-embedding-3-small", // literal allow-list
    "dim": 1536                  // 256 | 512 | 1024 | 1536; default 1536
  },
  "store": {
    "kind": "sqlite-vec"         // only option today
  },
  "chunker": {
    "kind": "markdown",          // "markdown" | "code" | "memory"
    "chunkSize": 1500,           // optional
    "overlap": 0.15              // optional, 0..0.5
  },
  "exclusions": [],              // parsed/stored, not applied by ingest today
  "sources": [],                 // F01 B12 — list of SourceRoot; default []
  "watch": false                 // F01 B12 — see "Watcher" below; default false
}
```

The `projectId` field on `DatasetConfig` is filled in by the manager at
`register` time using `RagManagerOptions.projectId`; operators do not write
it directly.

## Provider details

- Only `openai` is implemented. The `model` is a literal allow-list to
  prevent accidental drift onto an unreviewed embedding model.
- `releaseFingerprint = sha256("openai:" + model + ":" + dim).slice(0, 16)`.
  Any change in `model` or `dim` flips the fingerprint, and any subsequent
  `open` on the dataset throws `EmbeddingDriftError`. There is no
  in-place migration; operators must `drop` and re-`register`.
- `dim` defaults to 1536. When it is not 1536, the OpenAI SDK is called
  with the explicit `dimensions` argument; otherwise it is omitted so the
  request matches the model's native dim.

## Chunker details

- `markdown` uses a heading-aware splitter with the configured
  `overlap` ratio (default 0.15).
- `code` parses through tree-sitter (Python and TypeScript bundles are
  vendored) with a 7500-token cap on bundle prelude emit.
- `memory` operates over Saivage record sources and forwards the
  `metadataOverlay.scopeRef` to every emitted chunk so retrieval can
  attribute back to the originating record.

## Sources (F01 B12)

`sources: SourceRoot[]` declares the on-disk roots the watcher and the
zero-argument `dataset.reconcile()` should sweep. Each entry:

```jsonc
{
  "root": "/abs/or/repo-relative/path",
  "include": ["**/*.md"],   // optional; default ["**/*"]
  "exclude": ["legacy/**"]  // optional; default []
}
```

`sources` is independent of the `source` field. `source` labels the dataset
and emitted chunk metadata (`skill`, `memory`, `doc`, or `code`), while
`IngestInput.kind` selects filesystem walk vs. record stream for a specific
ingest call. `sources` is what the watcher and zero-argument
`dataset.reconcile()` use.

## Watcher (F01 B12)

`watch` accepts three forms:

```jsonc
"watch": false                                   // default; no chokidar load
"watch": true                                    // native inotify/fsevents
"watch": { "usePolling": true, "interval": 1500 } // for LXC bind-mounts, NFS
```

The watcher is armed by `dataset.watch()` and stopped by
`dataset.unwatch()`. The runtime does not arm it implicitly. See the
`operational-runbook.md` for environment-specific guidance.

## Exclusions interaction

Three exclusion sets are applied by the current ingest/watch paths:

1. The dataset-wide secret guard (`shouldSkipPath` + `scanChunk`).
2. The per-ingest or per-source `exclude` array (`ingest({ kind: "fs" })` or
  `SourceRoot.exclude`).
3. The watcher/reconcile `BUILD_CACHE_EXCLUSIONS`
   (`node_modules`, `dist`, `build`, `.git`, `.saivage`, `coverage`,
   `__pycache__`, `.venv`, …).

The dataset-level `exclusions` field is parsed into `DatasetConfig` but is not
read by the current `Dataset.ingest()`, watcher, or reconcile implementation.
The build/cache list is intentionally not applied to non-watcher ingests:
operators who manually call `dataset.ingest({ kind: "fs", root, exclude })`
remain in control of those globs.
