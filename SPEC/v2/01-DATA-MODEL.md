# Saivage v2 — Data Model

All JSON schemas use TypeScript-style type notation. Optional fields are marked with `?`.
Timestamps are ISO 8601 strings. IDs are opaque strings (nanoid or UUID).

---

## 1. Runtime Config

**Path:** `<project>/.saivage/saivage.json`

Runtime/provider settings stored inside the project. Loaded by `src/config.ts`.

```typescript
interface RuntimeConfig {
  models: {
    orchestrator: string;            // default: "anthropic/claude-sonnet-4-20250514"
    coder: string;
    researcher: string;
    executor: string;
    chat: string;
    default: string;
  };
  providers: {
    [name: string]: {                // e.g. "anthropic", "openai", "ollama"
      apiKey?: string;               // API key (or use env var / OAuth)
      baseUrl?: string;              // custom endpoint
    };
  };
  failover: {
    [provider: string]: string[];    // fallback chain, e.g. "anthropic": ["openai"]
  };
  modelEquivalents: {
    [modelSpec: string]: string[];   // bidirectional equivalent model specs, e.g. "github-copilot/gpt-5.4": ["openai-codex/gpt-5.4"]
  };
  server: {
    port: number;                    // default: 8080
    host: string;                    // default: "0.0.0.0"
  };
  agent: {
    maxConcurrentAgents: number;     // default: 3 (not yet enforced)
  };
  runtime: {
    maxServices: number;             // default: 50
    restartOnCrash: boolean;         // default: true
    healthCheckIntervalMs: number;   // default: 30000
    idleShutdownMs: number;          // default: 300000
  };
  telegram: {
    botToken: string;
    allowedUserIds: number[];
  };
}
```

---

## 2. Project Config

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

---

## 3. Plan

**Path:** `<project>/.saivage/plan.json`

The active plan. Contains only stages that remain to be done.

```typescript
interface Plan {
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
}
```

---

## 4. Plan History

**Path:** `<project>/.saivage/plan-history.json`

Archive of terminal stages (completed, failed, escalated, aborted). Append-only.

```typescript
interface PlanHistory {
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
  escalation?: Escalation;           // if result == "escalated" (preserved from StageSummary)
  abort_reason?: string;             // if result == "aborted" (preserved from StageSummary)
}
```

---

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
  assigned_to: "coder" | "researcher";
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

---

## 6. Task Report

**Path:** `<project>/.saivage/stages/<stage-id>/reports/<task-id>.json`

Written by Coder or Researcher after executing a task.

```typescript
interface TaskReport {
  task_id: string;
  stage_id: string;
  agent: "coder" | "researcher";
  status: "completed" | "failed";
  summary: string;                   // what was done
  checklist_results: ChecklistResult[];
  files_modified: string[];          // paths relative to project root
  files_created: string[];
  tests_added: string[];
  tests_run: TestResult[];
  commits: string[];                 // git commit SHAs
  issues_found: Issue[];
  output_truncated?: boolean;        // true if test output or report was truncated (see 04-RUNTIME-DETAILS §5.2)
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

---

## 7. Stage Summary

**Path:** `<project>/.saivage/stages/<stage-id>/summary.json`

Written by the Manager when all tasks complete (or on escalation/abort). Consumed by the Planner.

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

---

## 8. User Notes

**Path:** `<project>/.saivage/notes/<note-id>.json`

Created by Chat, consumed by Planner. The **runtime** manages note lifecycle: it injects unacknowledged notes into the Planner's context on resume, sets `acknowledged_at` after the Planner completes its planning action, and deletes volatile notes after acknowledgment. Permanent notes persist on disk indefinitely.

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

---

## 9. Inspection Report

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

---

## 10. Skills & Memory

**On-disk layout under `<project>/.saivage/`** (design §B.4):

```
.saivage/
├── skills/
│   ├── project/{index.json, audit.jsonl, records/<uuid>.json, records/<uuid>.md}
│   ├── stages/<stage_id>/{index.json, audit.jsonl, records/}
│   └── sessions/<channel_id>/{index.json, audit.jsonl, records/}
├── memory/
│   ├── project/{index.json, audit.jsonl, records/<uuid>.json}
│   ├── stages/<stage_id>/{index.json, audit.jsonl, records/}
│   └── sessions/<channel_id>/{index.json, audit.jsonl, records/}
```

Built-in skills ship at `saivage/skills/builtin/<topic>/SKILL.md` (YAML frontmatter, no `index.json`) and live **outside** `<project>/.saivage/`. They are bundled into `dist/skills/builtin/` by `tsup`.

`.saivage/{skills,memory}/sessions/` is gitignored; `project/` and `stages/` subtrees are committed. Each scope subtree is self-contained — its own `index.json` (a derivable summary projection of `records/*.json`), its own append-only `audit.jsonl`, and its own `records/` directory.

**Schemas.** The canonical Zod schemas live in the design document — see [SPEC/v2/skills-memory/01-DESIGN.md](skills-memory/01-DESIGN.md) §B.1 for `SkillRecord`, `MemoryRecord`, and `AuditEntry`. Summary of the shared `RecordBase` fields:

- `id` (UUID) — unique within `(kind, scope, scope_ref)`.
- `kind` — `"skill"` | `"memory"`.
- `scope` — `"project"` | `"stage"` | `"session"`; `scope_ref` is required for stage/session and matches the path under §B.4.
- `status` — `"active"` | `"superseded"` | `"archived"` | `"expired"` (tombstone for `deleted`).
- `created_at` / `updated_at` — ISO 8601 datetimes.
- `author_agent` — `{ role, agent_id }` of the creator.
- `source` — optional `{ stage_id?, task_id? }` provenance.
- `expires_at` / `ttl_ms` — optional decay metadata (project scope only; stage/session use scope hooks instead).
- `supersedes` / `superseded_by` — UUID pair forming the supersession chain.
- `relates_to` — symmetric free-form references (bounded at 16).
- `survive_compaction` — boolean; `true` ⇒ record participates in post-compaction reinjection (design §E.1).

`SkillRecord` adds `{ origin: "builtin"|"project", name, description, triggers[], target_agents[], body_path }`. `MemoryRecord` adds `{ topic: {domain, subject, aspect?}, keys[], target_agents[], body, source_ref? }`. See design §B.1 for the exact refinements.

`AuditEntry` is one JSON line per write attempt (including rejections) in the scope's `audit.jsonl`: `{ ts, record_id, op, outcome, error_code?, author_agent, reason, prev_status?, next_status?, content_hash_before?, content_hash_after? }`. Operations: `create | update | supersede | archive | unarchive | delete | expire`.

**Lifecycle states.** `active` → `superseded` (via `supersede_*`), `archived` (reversible via `unarchive_*`), `expired` (sweeper), `deleted` (tombstone). Stage terminal transitions archive their stage-scoped records via a directory walk; chat-channel close archives session-scoped records the same way. Supersession may widen scope (`stage → project`) but never narrow it; see design §B.2 / §B.5.

---

## 11. Runtime State

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
  agent_type: "planner" | "manager" | "coder" | "researcher" | "inspector" | "chat";
  agent_id: string;                  // unique instance ID
  status: "running" | "suspended" | "idle";
  current_task_id?: string;          // for coder/researcher
  channel?: string;                  // for chat
  started_at: string;
}
```

---

## 12. Chat Log

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

---

## 13. Escalation

Not a standalone file — escalations are embedded in the stage summary (§7) and trigger Planner re-invocation. Defined here for clarity.

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

The Manager writes this into the `StageSummary.escalation` field and sets `result: "escalated"`.
The Planner reads it and decides whether to revise the stage, remove it, split it, or schedule an Inspector.

---

## 14. Document Relationships

```
ProjectConfig
     │
     ▼
   Plan ──────────────────────► PlanHistory
     │                              ▲
     │ stages[]                     │ on completion
     ▼                              │
   Stage ──► Manager ──► TaskList ──┤
                           │        │
                           ▼        │
                         Task[] ────┤
                           │        │
                           ▼        │
                      TaskReport ───┤
                           │        │
                           ▼        │
                     StageSummary ──┘
                           │
                           ▼
                    Escalation? ──► Planner (re-invoke)

   UserNote ──► Runtime (injects into Planner context; manages acknowledgment and cleanup)

   InspectionRequest ──► Inspector ──► InspectionReport ──► Planner | Chat

   ChatLog (cross-references Notes, InspectionRequests)
```

---

## 15. ID Conventions

| Entity       | Prefix   | Example                |
|--------------|----------|------------------------|
| Stage        | `stg-`   | `stg-a1b2c3`           |
| Task         | `tsk-`   | `tsk-x4y5z6`           |
| Note         | `note-`  | `note-m7n8o9`          |
| Inspection   | `insp-`  | `insp-p0q1r2`          |
| Chat session | `chat-`  | `chat-s3t4u5`          |
| Agent inst.  | `agt-`   | `agt-v6w7x8`           |

IDs are generated with nanoid (12 chars, alphanumeric), prefixed by entity type.

---

## 16. File Lifecycle

| Document                   | Created by   | Updated by   | Deleted when              |
|----------------------------|-------------|-------------|---------------------------|
| `plan.json`                | Plan MCP    | Plan MCP    | Never (overwritten)       |
| `plan-history.json`        | Plan MCP    | Plan MCP    | Never (append-only)       |
| `stages/<id>/tasks.json`   | Manager     | Manager     | Never (archived)          |
| `stages/<id>/reports/*.json`| Coder/Researcher | —     | Never (archived)          |
| `stages/<id>/summary.json` | Manager     | —           | Never (archived)          |
| `notes/<id>.json`          | Chat        | Runtime     | Volatile: after ack. Permanent: never |
| `inspections/<id>.json`    | Inspector   | —           | After `expires_at` (if set)|
| `skills/index.json`        | Coder       | Coder       | Never (overwritten)       |
| `skills/<name>.md`         | Coder       | Coder       | Never                     |
| `tools/inspector/*`        | Inspector   | Inspector   | Never                     |
| `tmp/state/runtime.json`   | Runtime     | Runtime     | On clean shutdown          |
| `tmp/chats/<ch>/<id>.json` | Chat        | Chat        | Rotation policy (TBD)      |
