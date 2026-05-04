# Plan MCP Service

[`src/mcp/plan-server.ts`](https://github.com/salva/saivage/blob/main/src/mcp/plan-server.ts) ·
spec [`SPEC/v2/03-PLAN-MCP-SERVICE.md`](https://github.com/salva/saivage/blob/main/SPEC/v2/03-PLAN-MCP-SERVICE.md)

The plan service is the **authoritative state store** for the active plan
and plan history. It is the only path through which the Planner mutates
plan state, which makes the on-disk view always consistent with the
Planner's mental model.

## Tools

| Tool | Purpose |
|------|---------|
| `plan_init(stages)` | Create the initial plan from objectives. Fails if a plan already exists. |
| `plan_get()` | Read the active plan. |
| `plan_get_stage(id)` | Read a single stage. |
| `plan_get_current_stage()` | Read the current stage (or null). |
| `plan_set_stages(stages)` | Replace the entire stages array (preserving current id when possible). |
| `plan_add_stage(stage, after?)` | Insert a new stage. |
| `plan_remove_stage(id)` | Remove a pending stage. |
| `plan_set_current(id)` | Move the cursor. |
| `plan_complete_stage(id, result, summary)` | Archive a stage to history. |
| `plan_get_history()` | Read the archive. |
| `plan_commit(message?)` | Commit `.saivage/plan*.json` to git. |

## Concurrency model

Only the Planner holds plan-mutation tools. The Manager and Inspector see
read-only variants. The Plan service implements **serialized writes**:
each mutation reads the file, validates the result against
`PlanSchema`/`PlanHistorySchema`, and writes atomically (temp + rename).

If multiple write requests arrive in flight (it can happen during parallel
dispatch), they are queued in arrival order.

## Storage

- `plan.json` — `{ updated_at, current_stage_id, stages[] }`.
- `plan-history.json` — `{ stages: CompletedStage[] }`.

Both are committed to git by the agents (Planner via `plan_commit`,
Manager indirectly via stage summaries).

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
}
```

`references` are document paths the Manager will read before decomposing
the stage; `tags` drive skill auto-attachment.

## Completion result

```ts
type StageResult = "completed" | "failed" | "escalated" | "aborted";
```

`plan_complete_stage(id, result, summary)` constructs a `CompletedStage`
record by merging the `Stage` with the runtime's started/completed
timestamps and any escalation context, then appends to history.

## Why MCP and not direct file I/O?

Putting plan mutations behind a tool surface lets us:

- Validate every mutation with Zod.
- Produce a deterministic mutation log (every plan change is observable
  through the agent's conversation).
- Keep the Planner's behavior auditable from the dashboard.
