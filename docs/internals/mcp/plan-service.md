# Plan MCP service

[`src/mcp/plan-server.ts`](https://github.com/salva/saivage/blob/main/src/mcp/plan-server.ts)

The plan service is the **authoritative state store** for the active plan
and plan history. It is the only path through which the Planner mutates
plan state, which keeps the on-disk view always consistent with the
Planner's mental model.

**Transport:** in-process handler registered on `McpRuntime`.

## Why MCP and not direct file I/O?

Putting plan mutations behind a tool surface lets us:

- Validate every mutation with Zod.
- Produce a deterministic mutation log (every plan change is observable
  through the agent's conversation).
- Keep the Planner's behavior auditable from the dashboard.

## Concurrency model

Agent-facing Plan tools are advertised to the Planner only. The Plan
service itself does not perform role checks; it implements **serialized
writes** for every tool in `PLAN_WRITER_TOOLS`. Each mutation updates the
in-memory `PlanDocument`, validates it against `PlanDocumentSchema`, and
writes atomically (temp + rename). Read tools bypass the writer queue and
return a cloned snapshot.

If multiple write requests arrive in flight (it can happen during parallel
dispatch), they are queued in arrival order.

## Storage

`plan.json` — `{ updated_at, current_stage_id, stages[], history[] }`.

Committed to git by the Planner via `plan_commit`; Manager output is
persisted separately via stage summaries.

## Tool reference

### `plan_get`

Read the current plan.

- **Input:** none
- **Output:** `{ updated_at, current_stage_id, stages[] }`
- **Annotations:** readOnly, idempotent

### `plan_get_stage`

Get a single stage by ID (from active plan or history).

- **Input:** `stage_id` (string, required)
- **Output:** the `Stage` object, plus `source: "active" | "history"` and
  (if from history) the `CompletedStage` fields. Error if not found.
- **Annotations:** readOnly, idempotent

### `plan_get_current_stage`

Get the stage currently being executed.

- **Input:** none
- **Output:** the `Stage` object, or `null` if no stage is current.
- **Annotations:** readOnly, idempotent

### `plan_set_stages`

Replace the plan's stage list. Validates all stages, sets `updated_at`.
Used by the Planner to update the plan after processing a stage result.

- **Input:** `stages` (`Stage[]`), `current_stage_id` (`string | null`)
- **Output:** the updated active plan view
- **Annotations:** destructive (replaces stages)

### `plan_add_stage`

Append a new stage to the plan.

- **Input:** `stage` (`Stage`). `id` must not already exist.
- **Output:** the updated active plan view

### `plan_remove_stage`

Remove a stage from the active plan by ID.

- **Input:** `stage_id` (string)
- **Output:** the updated active plan view, or error if not found

### `plan_set_current`

Set which stage is currently being executed.

- **Input:** `stage_id` (`string | null`)
- **Output:** the updated active plan view

Stamps `started_at` once on the active `Stage` the first time it becomes
current.

### `plan_complete_stage`

Move a stage from the active plan to history. This is the primary
operation the Planner performs after a Manager returns.

- **Input:**
  - `stage_id` (string)
  - `result` (`"completed" | "failed" | "escalated" | "aborted"`)
  - `summary` (string) — from the Manager's `StageSummary`
  - `actual_outcomes` (string[]) — what actually happened
  - `escalation` (`Escalation`, optional) — if `result == "escalated"`
  - `abort_reason` (string, optional) — if `result == "aborted"`
- **Output:**
  ```json
  {
    "completed_stage": { ... },
    "plan": { ... }
  }
  ```

Atomically, in one `plan.json` write:

1. Removes the stage from the active `stages` array.
2. Appends a `CompletedStage` entry to the embedded `history` array.
3. Clears `current_stage_id` if it matched the completed stage.

### `plan_get_history`

Read the plan history.

- **Input:** `last_n` (number, optional) — return only the N most recent
  entries. Default: all.
- **Output:** `{ stages: CompletedStage[] }`
- **Annotations:** readOnly, idempotent

### `plan_init`

Initialize an empty plan. Used during project setup or reset.

- **Input:** `stages` (`Stage[]`, optional) — initial stages. Default: empty.
- **Output:** the new active plan view

Fails if `plan.json` already exists (use `plan_set_stages` to overwrite).

### `plan_commit`

Commit `plan.json` to git via the MCP git server. Called by the Planner
after plan modifications to persist the plan to version control.

- **Input:** `message` (string) — commit message (prefixed with `[planner]`)
- **Output:**
  ```json
  { "sha": "abc123..." }
  ```

If nothing has changed since the last commit: returns
`{ "sha": "<previous_sha>", "noop": true }`. Not an error.

Commits only `plan.json`. Returns the commit SHA.

### `plan_done`

Signal verified project completion. Read-only marker the Planner emits
when objectives are met.

- **Input:** `reason` (string, required) — why the configured objectives
  are complete, with evidence.
- **Output:** `{ ok: true }`

## Error handling

All tools return errors as `{ "code": "<ERROR_CODE>", "error": "<message>" }`
with `isError: true`. Error codes:

- `PLAN_NOT_FOUND` — `plan.json` does not exist (call `plan_init` first)
- `STAGE_NOT_FOUND` — referenced stage ID not in active plan or history
- `STAGE_EXISTS` — stage ID already exists (for `plan_add_stage`)
- `VALIDATION_ERROR` — input fails schema validation
- `IO_ERROR` — file read/write failure

`STAGE_MISMATCH` is part of the exported `PlanErrorCode` union for
dispatcher gates around `run_manager`; normal Plan service tool methods do
not emit it directly.

## Stage validation

On every write, stages are validated:

- `id` — required, non-empty string (prefix `stg-` by convention)
- `objective` — required, 1–1000 chars
- `starting_points` — required, string array
- `expected_outcomes` — required, non-empty string array
- `acceptance_criteria` — required, non-empty string array
- `references` — required, string array (paths relative to project root)
- `tags` — required, string array (may be empty)
- `started_at` — optional ISO timestamp, set once when a stage becomes current

## Stage schema

```ts
interface Stage {
  id: string;
  objective: string;
  starting_points: string[];
  expected_outcomes: string[];
  acceptance_criteria: string[];
  references: string[];
  tags: string[];
  started_at?: string;
}
```

`references` are document paths the Manager will read before decomposing
the stage; `tags` drive skill auto-attachment.

```ts
type StageResult = "completed" | "failed" | "escalated" | "aborted";
```

`plan_complete_stage(stage_id, result, summary, actual_outcomes, ...)`
constructs a `CompletedStage` record from the stored start time plus the
completion timestamp and any escalation or abort context, then appends to
embedded history.

## Atomicity

All write operations are atomic: write to `.tmp` file, then rename. This
prevents partial writes on crash.
