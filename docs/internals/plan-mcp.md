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
| `plan_done(reason)` | Signal verified project completion. |
| `plan_commit(message?)` | Commit `.saivage/plan.json` to git. |

## Concurrency model

Only the Planner holds plan-mutation tools. The Manager and Inspector see
read-only variants. The Plan service implements **serialized writes**:
each mutation updates the in-memory `PlanDocument`, validates it against
`PlanDocumentSchema`, and writes atomically (temp + rename). Read tools
bypass the writer queue and return a cloned snapshot.

If multiple write requests arrive in flight (it can happen during parallel
dispatch), they are queued in arrival order.

## Storage

- `plan.json` — `{ updated_at, current_stage_id, stages[], history[] }`.

It is committed to git by the Planner via `plan_commit`; Manager output is
persisted separately via stage summaries.

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

## Completion result

```ts
type StageResult = "completed" | "failed" | "escalated" | "aborted";
```

`plan_set_current(id)` stamps `started_at` once on the active `Stage`.
`plan_complete_stage(id, result, summary)` constructs a `CompletedStage`
record from that stored start time plus the completion timestamp and any
escalation context, then appends to embedded history.

## Why MCP and not direct file I/O?

Putting plan mutations behind a tool surface lets us:

- Validate every mutation with Zod.
- Produce a deterministic mutation log (every plan change is observable
  through the agent's conversation).
- Keep the Planner's behavior auditable from the dashboard.
