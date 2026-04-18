# Saivage v2 — Plan MCP Service

## Overview

MCP service that provides structured access to `plan.json` and `plan-history.json`.
Replaces raw file reads/writes with validated, atomic operations that enforce schema constraints.

**Transport:** stdio (in-process via McpRuntime)
**Path:** `src/v2/mcp/plan-server.ts`

---

## Tools

### `plan_get`

Read the current plan.

**Input:** none
**Output:**
```json
{
  "updated_at": "...",
  "current_stage_id": "stg-a1b2c3",
  "stages": [...]
}
```
**Annotations:** readOnly, idempotent

---

### `plan_get_stage`

Get a single stage by ID (from active plan or history).

**Input:**
- `stage_id` (string, required) — the stage ID to look up

**Output:** the Stage object, plus `source: "active" | "history"` and (if from history) the `CompletedStage` fields.
Returns an error if not found.

**Annotations:** readOnly, idempotent

---

### `plan_get_current_stage`

Get the stage currently being executed.

**Input:** none
**Output:** the Stage object, or `null` if no stage is current.

**Annotations:** readOnly, idempotent

---

### `plan_set_stages`

Replace the plan's stage list. Validates all stages, sets `updated_at`. Used by the Planner to update the plan after processing a stage result.

**Input:**
- `stages` (Stage[], required) — the new stage list
- `current_stage_id` (string | null, required) — which stage to mark as current

**Output:** the updated Plan object.

**Annotations:** destructive (replaces stages)

---

### `plan_add_stage`

Append a new stage to the plan.

**Input:**
- `stage` (Stage, required) — the stage to add. `id` must not already exist.

**Output:** the updated Plan object.

---

### `plan_remove_stage`

Remove a stage from the active plan by ID.

**Input:**
- `stage_id` (string, required)

**Output:** the updated Plan object, or error if stage not found.

---

### `plan_set_current`

Set which stage is currently being executed.

**Input:**
- `stage_id` (string | null, required) — the stage ID, or null to clear

**Output:** the updated Plan object.

---

### `plan_complete_stage`

Move a stage from the active plan to history. This is the primary operation the Planner performs after a Manager returns.

**Input:**
- `stage_id` (string, required) — stage to complete
- `result` ("completed" | "failed" | "escalated" | "aborted", required)
- `summary` (string, required) — from the Manager's StageSummary
- `actual_outcomes` (string[], required) — what actually happened

**Output:**
```json
{
  "completed_stage": { ... },   // the CompletedStage entry added to history
  "plan": { ... }               // the updated active plan (stage removed)
}
```

Atomically:
1. Removes the stage from `plan.json`.
2. Appends a `CompletedStage` entry to `plan-history.json`.
3. Clears `current_stage_id` if it matched the completed stage.

---

### `plan_get_history`

Read the plan history.

**Input:**
- `last_n` (number, optional) — return only the N most recent entries. Default: all.

**Output:**
```json
{
  "stages": [...]   // CompletedStage[]
}
```

**Annotations:** readOnly, idempotent

---

### `plan_init`

Initialize an empty plan. Used during project setup or reset.

**Input:**
- `stages` (Stage[], optional) — initial stages. Default: empty.

**Output:** the new Plan object.

Fails if `plan.json` already exists (use `plan_set_stages` to overwrite).

---

### `plan_commit`

Commit `plan.json` and `plan-history.json` to git via the MCP git server. Called by the Planner after plan modifications to persist the plan to version control.

**Input:**
- `message` (string, required) — commit message (will be prefixed with `[planner]`)

**Output:**
```json
{
  "sha": "abc123..."
}
```

Commits only `plan.json` and `plan-history.json`. Returns the commit SHA.

---

## Error Handling

All tools return errors as `{ "error": "<message>" }` with `isError: true`. Errors include:
- `PLAN_NOT_FOUND` — plan.json does not exist (call `plan_init` first)
- `STAGE_NOT_FOUND` — referenced stage ID not in active plan or history
- `STAGE_EXISTS` — stage ID already exists (for `plan_add_stage`)
- `VALIDATION_ERROR` — input fails schema validation
- `IO_ERROR` — file read/write failure

---

## Atomicity

All write operations are atomic: write to `.tmp` file, then rename. This prevents partial writes on crash.
