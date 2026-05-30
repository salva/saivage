# Data types & schemas

[`src/types.ts`](https://github.com/salva/saivage/blob/main/src/types.ts) is
the single source of truth for every JSON document Saivage persists. Each
shape is declared as a Zod schema and the TypeScript type is derived from it
via `z.infer`. Schemas are used both at write time (validation before atomic
write) and at read time (parsing).

All schemas below use TypeScript notation. Optional fields are marked with
`?`. Timestamps are ISO 8601 strings. IDs follow the
[ID conventions](#id-conventions) below.

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

## 1. Runtime config (`SaivageConfig`)

**Path:** `<saivageDir>/saivage.json` (see
[`docs/guide/config-runtime`](../../guide/config-runtime) for the precise
resolution rules).

The runtime config schema is defined in
[`src/config.ts`](https://github.com/salva/saivage/blob/main/src/config.ts)
as the Zod `configSchema` and exported as the TypeScript type
`SaivageConfig`. Every top-level block (`models`, `providers`, `failover`,
`modelEquivalents`, `server`, `agent`, `runtime`, `security`, `supervisor`,
`telegram`, `mcp`, `notifications`, `oauth`, `mcpServers`) lives there; this
page does not mirror it. The Zod source plus the operator guide are the
contract.

## 2. Project config

**Path:** `<project>/.saivage/config.json`

```typescript
interface ProjectConfig {
  project_name: string;
  objectives: string[];              // high-level project goals
  provider: string;                  // which global provider to use
  model_overrides?: {                // per-role model overrides (optional)
    [role: string]: string;
  };
  notifications: {
    channels: ("telegram" | "web")[];  // default: ["telegram"]
    filters: {
      min_severity: "info" | "warning" | "error";
      categories: ("stage_completed" | "stage_failed" | "escalation" |
                   "task_failed" | "inspector_complete" | "plan_updated")[];
                                     // empty = all categories
    };
  };
  skills: {
    max_per_agent: number;           // loading budget per agent invocation (default: 5)
  };
  agents?: {                         // per-role runtime config (all optional, defaults apply)
    [role: string]: {                // e.g. "planner", "manager", "coder"
      compaction_threshold_pct?: number;  // default: 80 (% of context window)
      max_compactions?: number;           // max compactions before forced termination (default: 3)
    };
  };
}
```

## 3. Active plan view

**Path:** `<project>/.saivage/plan.json`

The active plan projection. Contains only stages that remain to be done.

```typescript
interface ActivePlanView {
  updated_at: string;
  current_stage_id: string | null;   // stage currently being executed
  stages: Stage[];
}

interface Stage {
  id: string;
  objective: string;                 // what this stage accomplishes
  starting_points: string[];         // current state relevant to this stage
  expected_outcomes: string[];       // concrete, verifiable deliverables
  acceptance_criteria: string[];     // how to know the stage is done
  references: string[];              // document paths relative to project root
  tags: string[];                    // for skill matching
  started_at?: string;               // set when the stage becomes current
}
```

## 4. Plan document (active + history)

**Path:** `<project>/.saivage/plan.json` (full document)

Archive of terminal stages (completed, failed, escalated, aborted) is
embedded in the authoritative plan document so completing a stage is a
single atomic write.

```typescript
interface PlanDocument {
  updated_at: string;
  current_stage_id: string | null;
  stages: Stage[];
  history: CompletedStage[];
}

interface PlanHistoryView {
  stages: CompletedStage[];
}

interface CompletedStage {
  id: string;
  objective: string;
  expected_outcomes: string[];
  actual_outcomes: string[];         // what actually happened
  started_at: string;
  completed_at: string;
  result: "completed" | "failed" | "escalated" | "aborted";
  summary: string;                   // from Manager's stage summary
  escalation?: Escalation;           // if result == "escalated"
  abort_reason?: string;             // if result == "aborted"
}
```

## 5. Tasks

**Path:** `<project>/.saivage/stages/<stage-id>/tasks.json`

Task breakdown for a stage. Written by the Manager.

```typescript
interface TaskList {
  stage_id: string;
  created_at: string;
  updated_at: string;
  tasks: Task[];
}

interface Task {
  id: string;
  type: "code" | "research" | "test" | "document";
  assigned_to: "coder" | "researcher" | "data_agent" | "reviewer";
  description: string;               // detailed work description
  checklist: ChecklistItem[];
  dependencies: string[];            // task IDs that must complete first
  status: "pending" | "in-progress" | "completed" | "failed" | "aborted";
  tags?: string[];                   // for skill matching (inherits stage tags if absent)
  started_at?: string;
  completed_at?: string;
  attempt: number;                   // retry count (starts at 1)
  max_attempts: number;              // max retries before escalation (default: 3)
}

interface ChecklistItem {
  description: string;
  required: boolean;                 // must-pass vs nice-to-have
}
```

## 6. Task report

**Path:** `<project>/.saivage/stages/<stage-id>/reports/<task-id>.json`

Written by Coder, Researcher, Data Agent, or Reviewer after executing a task.

```typescript
interface TaskReport {
  task_id: string;
  stage_id: string;
  agent: "coder" | "researcher" | "data_agent" | "reviewer";
  status: "completed" | "failed";
  summary: string;                   // what was done
  checklist_results: ChecklistResult[];
  files_modified: string[];          // paths relative to project root
  files_created: string[];
  tests_added: string[];
  tests_run: TestResult[];
  commits: string[];                 // git commit SHAs
  issues_found: Issue[];
  output_truncated?: boolean;        // true if test output or report was truncated
  failure_reason?: string;           // if status == "failed"
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

interface ChecklistResult {
  description: string;
  passed: boolean;
  notes?: string;
}

interface TestResult {
  name: string;
  passed: boolean;
  output?: string;                   // truncated stdout/stderr
}

interface Issue {
  severity: "info" | "warning" | "error";
  description: string;
  file?: string;
  suggestion?: string;
}
```

Output-truncation rules and limits are documented in
[runtime/details](../runtime/details) §5.2.

## 7. Stage summary

**Path:** `<project>/.saivage/stages/<stage-id>/summary.json`

Written by the Manager when all tasks complete (or on escalation/abort).
Consumed by the Planner.

```typescript
interface StageSummary {
  stage_id: string;
  result: "completed" | "failed" | "escalated" | "aborted";
  summary: string;                   // aggregated narrative
  tasks_completed: number;
  tasks_failed: number;
  total_tasks: number;
  outcomes_achieved: string[];       // which expected outcomes were met
  outcomes_missed: string[];         // which were not
  issues: Issue[];                   // aggregated from task reports
  escalation?: Escalation;           // if result == "escalated" (see §13)
  abort_reason?: string;             // if result == "aborted" — captured from urgent note
  started_at: string;
  completed_at: string;
  duration_ms: number;
}
```

## 8. User notes

**Path:** `<project>/.saivage/notes/<note-id>.json`

Created by Chat, consumed by Planner. The **runtime** manages note
lifecycle: it injects unacknowledged notes into the Planner's context on
resume, sets `acknowledged_at` after the Planner completes its planning
action, and deletes volatile notes after acknowledgment. Permanent notes
persist on disk indefinitely.

```typescript
interface UserNote {
  id: string;
  channel: string;                   // which chat channel created it
  session_id: string;                // chat session for cross-reference
  content: string;                   // the user's input/direction
  created_at: string;
  permanent: boolean;                // true = persist across replans; false = delete after acknowledgment
  urgent: boolean;                   // true = abort active agents and replan immediately
  acknowledged_at?: string;          // set by runtime when Planner has processed this note
}
```

## 9. Inspection report

**Path:** `<project>/.saivage/inspections/<report-id>.json`

Written by Inspector, consumed by Planner or Chat.

```typescript
interface InspectionReport {
  id: string;
  requested_by: "planner" | "chat";
  request: InspectionRequest;
  findings: string;                  // detailed analysis (markdown)
  recommendations: string[];
  data: Record<string, unknown>;     // structured data (metrics, counts, etc.)
  artifacts: string[];               // paths to files created during analysis
  created_at: string;
  expires_at: string | null;         // TTL — null means permanent
  duration_ms: number;
}

interface InspectionRequest {
  id: string;                        // same as report id
  scope: string;                     // what to investigate
  questions: string[];               // specific questions to answer
  requested_at: string;
  requested_by: "planner" | "chat";
  chat_channel?: string;             // if from chat, which channel to reply to
}
```

## 10. Skills & memory records

Skills and memory records share `RecordBase` (defined in
[`src/knowledge/types.ts`](https://github.com/salva/saivage/blob/main/src/knowledge/types.ts))
plus per-kind extensions. On-disk layout (`skills/{project,stages,sessions}/…`
and `memory/{project,stages,sessions}/…`), the supersession state machine,
and the audit-log format are documented in
[knowledge/skills-and-memory](../knowledge/skills-and-memory).

Summary of shared `RecordBase` fields:

- `id` (UUID) — unique within `(kind, scope, scope_ref)`.
- `kind` — `"skill"` | `"memory"`.
- `scope` — `"project"` | `"stage"` | `"session"`; `scope_ref` is required
  for stage/session.
- `status` — `"active"` | `"superseded"` | `"archived"` | `"expired"`.
- `created_at` / `updated_at` — ISO 8601 datetimes.
- `author_agent` — `{ role, agent_id }` of the creator.
- `source` — optional `{ stage_id?, task_id? }` provenance.
- `expires_at` / `ttl_ms` — optional decay metadata (project scope only).
- `supersedes` / `superseded_by` — UUID pair forming the supersession chain.
- `relates_to` — symmetric free-form references (bounded at 16).
- `survive_compaction` — boolean; `true` ⇒ participates in post-compaction
  reinjection.

`SkillRecord` adds
`{ origin: "builtin"|"project", name, description, triggers[], target_agents[], body_path }`.
`MemoryRecord` adds
`{ topic: {domain, subject, aspect?}, keys[], target_agents[], body, source_ref? }`.

`AuditEntry` is one JSON line per write attempt (including rejections) in
the scope's `audit.jsonl`:
`{ ts, record_id, op, outcome, error_code?, author_agent, reason, prev_status?, next_status?, content_hash_before?, content_hash_after? }`.

## 11. Runtime state

**Path:** `<project>/.saivage/tmp/state/runtime.json`

Temporary. Used for crash recovery.

```typescript
interface RuntimeState {
  status: "idle" | "running" | "suspended" | "error";
  current_stage_id: string | null;
  active_agents: AgentState[];
  started_at: string;
  updated_at: string;
  pid: number;                       // process ID for stale detection
}

interface AgentState {
  agent_type: "planner" | "manager" | "coder" | "researcher" | "data_agent" | "reviewer" | "inspector" | "chat";
  agent_id: string;                  // unique instance ID
  status: "running" | "suspended" | "idle";
  current_task_id?: string;          // for coder/researcher
  channel?: string;                  // for chat
  started_at: string;
}
```

## 12. Chat log

**Path:** `<project>/.saivage/tmp/chats/<channel>/<session-id>.json`

Temporary. Persisted for cross-channel reference but not committed.

```typescript
interface ChatLog {
  session_id: string;
  channel: string;                   // "web", "telegram", etc.
  started_at: string;
  updated_at: string;
  messages: ChatMessage[];
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  event?: SystemEvent;               // if this message was triggered by a system event
  note_id?: string;                  // if this message created a user note
  inspector_request_id?: string;     // if this triggered an inspection
}

interface SystemEvent {
  type: "stage_completed" | "stage_failed" | "escalation" |
        "inspector_complete" | "task_failed" | "plan_updated";
  stage_id?: string;
  task_id?: string;
  report_id?: string;
  summary: string;
}
```

## 13. Escalation

Not a standalone file — escalations are embedded in the stage summary
([§7](#_7-stage-summary)) and trigger Planner re-invocation. Defined here
for clarity.

```typescript
interface Escalation {
  stage_id: string;
  task_id?: string;                  // if escalation originated from a task
  reason: string;
  attempted_remediations: string[];  // what the Manager tried before escalating
  suggested_action?: string;         // Manager's recommendation to Planner
  created_at: string;
}
```

The Manager writes this into the `StageSummary.escalation` field and sets
`result: "escalated"`. The Planner reads it and decides whether to revise
the stage, remove it, split it, or schedule an Inspector.

## 14. Document relationships

The full ER diagram lives in [architecture](../architecture) §5.3. The
linear flow is:

```
ProjectConfig → PlanDocument → Stage → TaskList → Task → TaskReport → StageSummary → (Escalation? → Planner)
UserNote → Runtime → Planner context
InspectionRequest → Inspector → InspectionReport → Planner | Chat
ChatLog cross-references Notes and InspectionRequests
```

## 15. ID conventions

`src/ids.ts` provides collision-resistant id generators per category. All
produce `<prefix>-<base32-rand>` strings (e.g. `stg-abc123`).

| Entity       | Prefix   | Example                | Generator           |
|--------------|----------|------------------------|---------------------|
| Stage        | `stg-`   | `stg-a1b2c3`           | `stageId()`         |
| Task         | `tsk-`   | `tsk-x4y5z6`           | `taskId()`          |
| Note         | `note-`  | `note-m7n8o9`          | `noteId()`          |
| Inspection   | `insp-`  | `insp-p0q1r2`          | `inspectionId()`    |
| Chat session | `chat-`  | `chat-s3t4u5`          | `chatSessionId()`   |
| Agent inst.  | `agt-`   | `agt-v6w7x8`           | `agentId()`         |

## 16. File lifecycle

| Document                   | Created by   | Updated by   | Deleted when              |
|----------------------------|-------------|-------------|---------------------------|
| `plan.json`                | Plan MCP    | Plan MCP    | Never (overwritten)       |
| `stages/<id>/tasks.json`   | Manager     | Manager     | Never (archived)          |
| `stages/<id>/reports/*.json`| Coder/Researcher | —     | Never (archived)          |
| `stages/<id>/summary.json` | Manager     | —           | Never (archived)          |
| `notes/<id>.json`          | Chat        | Runtime     | Volatile: after ack. Permanent: never |
| `inspections/<id>.json`    | Inspector   | —           | After `expires_at` (if set)|
| `skills/**/records/*`      | Manager / Inspector | Manager / Inspector | Archived on scope close |
| `memory/**/records/*`      | Manager / Inspector | Manager / Inspector | Archived on scope close |
| `tools/inspector/*`        | Inspector   | Inspector   | Never                     |
| `tmp/state/runtime.json`   | Runtime     | Runtime     | On clean shutdown          |
| `tmp/chats/<ch>/<id>.json` | Chat        | Chat        | Rotation policy (TBD)      |

## Validation philosophy

- **Write-time validation** is the strict gate. A schema mismatch raises
  before the atomic rename, so corrupt files are never written.
- **Read-time validation** raises on mismatch unless `readDocOrNull` is
  used. The runtime usually wraps reads in `readDocOrNull` for tmp files
  (which may not exist) and `readDoc` for canonical artifacts.

## Evolving the schema

1. Update the Zod definition in
   [`src/types.ts`](https://github.com/salva/saivage/blob/main/src/types.ts).
2. If the change is breaking, migrate in place — consume the old shape
   under `readDocOrNull`, write the upgraded shape with `writeDoc`. Per the
   workspace architecture-first rule, prefer removing the old shape entirely
   rather than carrying compatibility shims.
3. Update this page.
4. Bump the `package.json` version and note the migration in the changelog.

Schemas use `default()` extensively so new optional fields are
backward-compatible without explicit migration.
