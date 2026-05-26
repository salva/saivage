# Types & Schemas

[`src/types.ts`](https://github.com/salva/saivage/blob/main/src/types.ts) ·
spec [`SPEC/v2/01-DATA-MODEL.md`](https://github.com/salva/saivage/blob/main/SPEC/v2/01-DATA-MODEL.md)

`src/types.ts` is the single source of truth for every JSON document
Saivage persists. Each shape is declared as a Zod schema and the
TypeScript type is derived from it via `z.infer`. The schemas are used
both at write time (validation before atomic write) and at read time
(parsing).

## Top-level documents

| Schema | Persisted as |
|--------|-------------|
| `ProjectConfigSchema` | `<project>/.saivage/config.json` |
| `PlanDocumentSchema` | `<project>/.saivage/plan.json` |
| `TaskListSchema` | `<project>/.saivage/stages/<id>/tasks.json` |
| `TaskReportSchema` | `<project>/.saivage/stages/<id>/reports/<task-id>.json` |
| `StageSummarySchema` | `<project>/.saivage/stages/<id>/summary.json` |
| `InspectionReportSchema` | `<project>/.saivage/inspections/<id>.json` |
| `UserNoteSchema` | `<project>/.saivage/notes/<id>.json` |
| `RuntimeStateSchema` | `<project>/.saivage/tmp/state/runtime.json` |
| `ShutdownRequestSchema` | `<project>/.saivage/tmp/state/shutdown-request.json` |
| `ShutdownSummarySchema` | `<project>/.saivage/tmp/state/shutdown-summary.json` |
| `SkillEntrySchema` / `SkillIndexSchema` | `<skills-dir>/index.json` |
| `ChatLogSchema` | `<project>/.saivage/tmp/chats/<channel>/<sessionId>.json` |

## Cross-references

- `SystemEvent` (in-memory; not persisted) — `src/types.ts`.
- `Escalation` — embedded in `CompletedStage` when `result === "escalated"`.
- `AgentState` — embedded in `RuntimeState` to track active agents.

## ID schemes

`src/ids.ts` provides collision-resistant id generators per category:

- `stageId()`, `taskId()`, `noteId()`, `inspectionId()`, `chatSessionId()`,
  `agentId()`.
- All produce `<prefix>-<base32-rand>` strings (e.g. `stg-abc123`).

## Validation philosophy

- **Write-time validation** is the strict gate. A schema mismatch raises
  before the atomic rename, so corrupt files are never written.
- **Read-time validation** raises on mismatch unless `readDocOrNull` is
  used. The runtime usually wraps reads in `readDocOrNull` for tmp files
  (which may not exist) and `readDoc` for canonical artifacts.

## Evolving the schema

When a schema changes:

1. Update the Zod definition in `src/types.ts`.
2. Add a migration if the change is breaking — consume the old shape
   under `readDocOrNull`, write the upgraded shape with `writeDoc`.
3. Update [`SPEC/v2/01-DATA-MODEL.md`](https://github.com/salva/saivage/blob/main/SPEC/v2/01-DATA-MODEL.md).
4. Bump the `package.json` version and note the migration in the changelog.

The schemas use `default()` extensively so new optional fields are
backward-compatible without explicit migration.
