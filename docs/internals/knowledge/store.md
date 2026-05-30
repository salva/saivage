# Document Store

[`src/store/documents.ts`](https://github.com/salva/saivage/blob/main/src/store/documents.ts)

A thin layer that gives the runtime **atomic, schema-validated JSON
read/write** with a uniform error surface.

## Public API

```ts
function readDoc<T>(path: string, schema: ZodSchema<T>): T;
function readDocOrNull<T>(path: string, schema: ZodSchema<T>): T | null;
function writeDoc<T>(path: string, value: T, schema: ZodSchema<T>): void;
function deleteDoc(path: string): void;
function listDir(path: string): string[];
function listDocs<T>(dir: string, schema: ZodSchema<T>): T[];
function ensureDir(path: string): void;
function sweepStaleTempFiles(root: string, ttlMs: number): void;
```

## Atomic writes

`writeDoc` writes to `<path>.tmp.<rand>`, then `rename()` to the final
path. Rename is atomic on POSIX filesystems within the same directory.
Crash-safety: a partial `.tmp.*` file may exist after a crash, but the
real file is never half-written. `sweepStaleTempFiles` cleans the leftover
tmp files at startup.

## Validation

Every read parses with the supplied Zod schema and throws a typed error
on mismatch. Writes also parse so persisted values cannot drift from the
schema. This is the mechanism that keeps `plan.json`, `tasks.json`,
`summary.json`, etc. consistent with the TypeScript types in
`src/types.ts`.

## Use site map

| Caller | Reads | Writes |
|--------|-------|--------|
| Plan MCP | `plan.json` | `plan.json` |
| Manager | references[] | `tasks.json`, `summary.json` |
| Workers | `tasks.json` | `reports/<task-id>.json` |
| Notes runtime | `notes/*.json` | `notes/*.json` |
| Recovery | `runtime.json` | `runtime.json`, `runtime.crashed.*.json` |
| Inspector | `inspections/<id>.json` | `inspections/<id>.json` |

The web UI's `/api/files/content` endpoint also goes through this layer
for reads (raw text path, not schema-validated).

## ProjectContext.paths

Higher-level callers don't construct paths by hand. `loadProject(root)`
returns a `ProjectContext` with a `paths` field exposing every well-known
location:

```ts
interface ProjectPaths {
  plan: string;
  stages: string;
  notes: string;
  inspections: string;
  skills: string;
  tools: string;
  research: string;
  tmp: string;
  runtimeState: string;
  shutdownRequest: string;
  shutdownSummary: string;
  chats: string;
  inspectorWorkspace: string;
  work: string;
}
```

Use these instead of hand-rolling joins to keep the on-disk layout
discoverable.
