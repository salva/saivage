# Saivage v2 — Data Model

All JSON schemas use TypeScript-style type notation. Optional fields are marked with `?`.
Timestamps are ISO 8601 strings. IDs are opaque strings (nanoid or UUID).

---

## 1. Global Config

**Path:** `~/.saivage/config.json`

System-wide settings, not project-specific.

```typescript
interface GlobalConfig {
  providers: {
    [name: string]: {                // e.g. "github-copilot", "anthropic"
      type: string;                  // provider type
      models: {
        [role: string]: string;      // e.g. "planner": "claude-opus-4.6"
      };
      timeout_ms: number;
      failover?: string;             // name of fallback provider
    };
  };
  telegram: {
    bot_token: string;
    user_id: number;
  };
  auth_dir: string;                  // path to auth tokens (default: "~/.saivage/auth/")
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
    channels: string[];              // e.g. ["telegram", "web"]
    filters: {
      min_severity: "info" | "warning" | "error";
      categories: string[];          // opt-in categories, empty = all
    };
  };
  skills: {
    max_per_task: number;            // loading budget (default: 5)
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

Archive of completed stages. Append-only.

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
  max_attempts: number;              // max retries before escalation
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

Created by Chat, consumed by Planner. Volatile notes are deleted on the next replan unless marked permanent.

```typescript
interface UserNote {
  id: string;
  channel: string;                   // which chat channel created it
  session_id: string;                // chat session for cross-reference
  content: string;                   // the user's input/direction
  created_at: string;
  permanent: boolean;                // false = delete on next replan
  urgent: boolean;                   // true = abort active agents and replan immediately
  acknowledged_at?: string;          // when Planner processed it
  planner_response?: string;         // how the Planner acted on it
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

## 10. Skill Index

**Path:** `<project>/.saivage/skills/index.json`

```typescript
interface SkillIndex {
  skills: SkillEntry[];
}

interface SkillEntry {
  name: string;
  file: string;                      // relative path to .md file
  description: string;
  triggers: string[];                // e.g. "keyword:pandas", "tool:web_search", "path:*.py", "tag:data", "agent:coder"
  target_agents?: string[];          // agent types this skill applies to (omit = all agents)
  created_at: string;
  updated_at: string;
}
```

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

   UserNote ──► Planner (consumed on replan, deleted if not permanent)

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
| `notes/<id>.json`          | Chat        | Planner     | On replan (unless permanent)|
| `inspections/<id>.json`    | Inspector   | —           | After `expires_at` (if set)|
| `skills/index.json`        | Coder       | Coder       | Never (overwritten)       |
| `skills/<name>.md`         | Coder       | Coder       | Never                     |
| `tools/inspector/*`        | Inspector   | Inspector   | Never                     |
| `tmp/state/runtime.json`   | Runtime     | Runtime     | On clean shutdown          |
| `tmp/chats/<ch>/<id>.json` | Chat        | Chat        | Rotation policy (TBD)      |
