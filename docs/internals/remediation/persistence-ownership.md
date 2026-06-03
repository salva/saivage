# Persistence Ownership

## Problem

Saivage v2 persists most durable state on disk, but ownership is mixed:

- `PlanService` caches and mutates `plan.json`.
- Server routes also read `plan.json`, task lists, summaries, reports, chats,
  inspections, and raw debug state directly.
- Runtime state is written by `RuntimeTracker` as JSON heartbeat state.
- Knowledge state lives in a SQLite sidecar with RAG reingest side effects.
- Some debug endpoints parse raw JSON leniently outside the domain services.

The result is that a reader must inspect many modules to know who owns a file,
which schema is authoritative, and whether a read is safe/redacted.

## Goal

Project-local file I/O has one owner. Other modules access `.saivage/` state
through that owner or through explicit read/query functions.

## Aggregates And Owners

| Aggregate | Owner | Notes |
| --- | --- | --- |
| Project files | `ProjectStore` | Owns typed reads/writes under `.saivage/` for plan, stages, runtime state, chats, and inspections. |
| Plan mutations | `PlanService` | Owns plan commands and serialization; may use `ProjectStore` for load/save/cache. |
| Notes | `NoteManager` | Existing owner can use `ProjectStore` only if it simplifies file access. |
| Knowledge | `KnowledgeStore` | SQLite sidecar remains the owner. |
| RAG | `RagManager` | Owns vector/index state. |

## Read Models

Server endpoints should use `ProjectStore` query/read methods rather than raw
file parsing:

- `ProjectStore.activePlanView()`
- `ProjectStore.planHistoryView()`
- `ProjectStore.stageDetails(stageId)`
- `ProjectStore.debugErrors()`
- `ProjectStore.debugTimeline()`
- `ConfigReadModel.safeConfig()`
- `FileBrowserService.list()` and `FileBrowserService.read()`

Read methods may combine stored files, but they should be explicit about
redaction and lenient parsing. Add separate repository classes only when there is
a concrete need for a distinct cache policy, storage backend, or lifecycle.

## Repository Rules

- `ProjectStore` owns paths.
- `ProjectStore` validates on write.
- `ProjectStore` exposes typed reads.
- Lenient reads must be named `readLenient` or exist only in debug read models.
- Server routes must not join `.saivage` paths directly except through the file
  browser service.
- Runtime services must not duplicate path constants already owned by
  `ProjectContext` or repositories.

## Cache Policy

Only owners may cache.

Example:

- `ProjectStore` or a tiny plan-specific store may cache `PlanDocument` because `PlanService` serializes
  writes through it.
- Server routes must not maintain their own plan cache.
- If an operator can edit files externally, add an explicit `reload()` or use
  mtime checks inside the owner.

## Migration Strategy

1. Introduce `ProjectStore` with the same paths and schemas currently used.
2. Move `PlanService` file load/save/cache behind `ProjectStore` or a very small
   plan-specific store if cache ownership requires it.
3. Add typed stage/task/report/summary methods and migrate server stage endpoints.
4. Add runtime-state methods and migrate `RuntimeTracker` if that simplifies
   ownership.
5. Add explicit debug errors/timeline reads.
6. Delete direct server reads of plan/stage/runtime paths after route migration.

## Validation

- `ProjectStore` unit tests for missing, malformed, and valid files.
- Server route tests use fake read models instead of temp file trees where
  possible.
- Grep gate: `src/server/server.ts` should no longer contain broad `join(...,
  "tasks.json")`, `summary.json`, or `reports` traversal logic.

## Expected Result

Disk remains the source of truth, but access is no longer scattered. Runtime,
server, and agents talk through domain owners, making future storage changes much
less invasive.
