# Knowledge Store Sidecar

The knowledge store persists skills and memories in a project-local
SQLite sidecar at `.saivage/knowledge/store.sqlite`. It is the canonical
state for knowledge records; the retired `.saivage/skills` and
`.saivage/memory` JSON trees are legacy inputs that boot either removes
or rejects before the runtime starts.

Primary source files:

- [`src/knowledge/sidecar.ts`](https://github.com/salva/saivage/blob/main/src/knowledge/sidecar.ts) — database path, migrations, and `SidecarHandle`.
- [`src/knowledge/sidecar-queries.ts`](https://github.com/salva/saivage/blob/main/src/knowledge/sidecar-queries.ts) — typed query and mutation primitives.
- [`src/knowledge/store.ts`](https://github.com/salva/saivage/blob/main/src/knowledge/store.ts) — error taxonomy and write-time guards.
- [`src/knowledge/lifecycle.ts`](https://github.com/salva/saivage/blob/main/src/knowledge/lifecycle.ts) — runtime-lock, validation, transactions, audit, and RAG reingest orchestration.

## Open and migrate

`openSidecar(projectRoot)` computes the path with
`sidecarPath(projectRoot)`:

```ts
`${projectRoot}/.saivage/knowledge/store.sqlite`
```

Opening the store creates the parent directory, opens `better-sqlite3`,
sets `journal_mode = WAL`, enables `foreign_keys`, and migrates by
`PRAGMA user_version`. The current migration is version 1. The helper
returns a `SidecarHandle`:

```ts
interface SidecarHandle {
  readonly db: Database;
  readonly path: string;
  close(): void;
  inTransaction<T>(fn: () => T): T;
}
```

Callers use `inTransaction` for multi-row mutations. The sidecar layer
does not use temp JSON files; SQLite journaling provides atomicity.

## Schema

Version 1 creates five tables:

| Table | Purpose |
|-------|---------|
| `record` | Primary row for every skill and memory. Stores `id`, `kind`, `scope`, `scope_ref`, `status`, `origin`, serialized `record_json`, `body`, timestamps, supersession pointers, and `pending_reingest`. |
| `record_skill` | Skill lookup side table keyed by `id`, with immutable `name`. |
| `record_memory` | Memory lookup side table keyed by `id`, with canonical topic key. |
| `audit` | Append-only lifecycle audit rows with `record_id`, `ts`, `op`, actor role/id, `before_json`, and `after_json`. |
| `rag_sync` | Per-record RAG sync metadata (`record_id`, `kind`, `content_hash`, `last_synced_at`). |

Indexes cover kind/scope lookup, kind/status lookup, pending reingest,
skill name, memory topic, audit record id, and audit timestamp.

Name and topic uniqueness are not global database constraints. The
lifecycle layer enforces collisions per scope with
`findActiveSkillIdByName` and `findActiveMemoryIdByTopic` before insert.

## Query helpers

`sidecar-queries.ts` exposes small typed helpers rather than a large
store object:

| Helper | Used for |
|--------|----------|
| `getRecord` | Fetch one row by id. |
| `listRecordsByStatus` | Status-filtered inspection and tests. |
| `activeRecordsByScope` / `activeIdsForScope` | Scope visibility for lifecycle and search. |
| `loadAllActiveRowsForEager` | Eager injection candidate loading. |
| `listActiveItems` | RAG reingest input for active skills or memories. |
| `pendingReingestKinds` / `clearPendingReingest` | Reingest recovery bookkeeping. |
| `recordCount` | Legacy-tree boot decision. |

`listActiveItems` publishes record bodies to protected RAG datasets with
metadata paths shaped as `skill:<id>.md` or `memory:<id>.md`. Search maps
RAG hits back to sidecar rows through those paths.

## Mutation primitives

Mutation helpers assume the caller has already performed authorization,
runtime-lock checks, input validation, and transaction setup:

| Helper | Effect |
|--------|--------|
| `putRecord` | Insert the `record` row, kind side-table row, and audit row. |
| `updateRecord` | Update mutable record columns and append audit. |
| `markSuperseded` | Mark the predecessor superseded and append audit. |
| `deleteRecord` | Hard-delete a record row and append audit. Kind side-table rows cascade. |
| `archiveScope` | Archive every active skill or memory in a stage/session scope. |
| `insertAudit` | Append one audit row. |

Lifecycle operations in `lifecycle.ts` wrap these primitives in
`store.sidecar.inTransaction(...)`. Successful writes set
`pending_reingest = 1`; `reingestKind` republishes active rows to
`knowledge.skills` or `knowledge.memory` and clears that flag on
success.

## Error taxonomy and guards

`src/knowledge/store.ts` no longer writes records. It defines the shared
`KnowledgeStoreError` class, the `KnowledgeErrorCode` union, and pure
guards used before sidecar mutation:

- `assertReason(reason)` rejects empty write reasons with
  `EMPTY_REASON`.
- `assertNoSecrets(fields)` scans free-text fields and rejects secret
  matches with `SECRET_DETECTED`.
- `assertNotBlockedPath(path, field)` rejects explicitly blocked paths
  with `BLOCKED_PATH`.
- `detectSecrets(fields)` returns matches and redacted text for callers
  that need details.

The lifecycle layer adds the runtime lock (`NO_RUNTIME_LOCK`), scope
validation (`INVALID_SCOPE_REF` / `UNAUTHORIZED_SCOPE`), collision
checks (`NAME_COLLISION` / `TOPIC_COLLISION`), supersession checks, and
best-effort RAG reingest error handling (`KNOWLEDGE_RAG_UNAVAILABLE` for
search failures).

## Boot integration

`initKnowledgeStore` wires the sidecar into the runtime:

1. Require `rag.enabled = true`.
2. Refuse or clean the retired JSON knowledge tree.
3. Open and migrate the sidecar.
4. Build the `KnowledgeStore` facade with the sidecar, `RagManager`,
   shared dataset config array, project root, and `reingestKind`.
5. Upsert bundled skills from `skills/builtin/<topic>/SKILL.md` into
   sidecar rows with `origin = "builtin"`.
6. Reingest built-in skills through the protected RAG dataset.

The resulting `KnowledgeStore` is held by the server / MCP service layer
and passed to knowledge tool handlers. Agents do not write the database
directly; they call MCP tools, which enforce permissions before reaching
the lifecycle layer.
