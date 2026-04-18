# Saivage v2 — Agent System Specification (DRAFT)

## 1. Design Philosophy

Replace the v1 interactive orchestrator/coder/researcher loop with a **structured hierarchical protocol** where each agent has a clearly defined role, communicates through **JSON documents**, and errors escalate upward through a chain of command.

All inter-agent communication happens through files on disk (JSON documents in a well-known directory structure). There are no in-memory message queues. This makes the system crash-recoverable and inspectable.

All project documentation and agent state lives **inside the project directory** (e.g. `/project/foo/.saivage/`), not in a global `~/.saivage/`. Global config (`~/.saivage/config.json`) only stores system-wide settings (LLM credentials, Telegram tokens). Everything project-specific is project-local.

Files are separated into two categories:
- **Persistent** (committed to git): plans, history, research, skills, stage summaries, inspection reports.
- **Temporary** (gitignored): runtime state, agent working directories, in-progress task data, chat logs.

---

## 2. Agent Roles

### 2.1 Planner

**Purpose:** Strategic long-term planning and course correction.

**Inputs:**
- Project objectives (from config)
- Stage completion reports (from Manager)
- Issue escalations (from Manager)
- User notes (from Chat)
- Inspector reports (on demand)

**Outputs:**
- **Active Plan** (`plan.json`): Ordered list of stages remaining to be done. Each stage has:
  - `id`: unique stage identifier
  - `objective`: what the stage should accomplish
  - `starting_points`: current state of affairs relevant to this stage
  - `expected_outcomes`: concrete, verifiable deliverables
  - `dependencies`: stages that must complete first
  - `acceptance_criteria`: how to know the stage is done
  - `references`: list of document paths the Manager should read before planning tasks
- **Plan History** (`plan-history.json`): Completed stages with their summaries, moved out of the active plan on completion.

**Behaviors:**
- Generates the initial plan from project objectives and current project state.
- Updates the plan after each stage completes (informed by Manager's summary).
- Updates the plan when the Manager escalates an issue it cannot resolve.
- When something is not going as expected (repeated failures, stalled progress, escalations), the Planner **schedules a full retrospective** as an explicit plan stage — dispatching the Inspector for deep analysis before deciding on corrective action.
- Schedules corrective/refactoring actions only when they unblock or accelerate progress toward objectives.
- Processes **user notes** from Chat. Notes are retained until the next replanning cycle, then discarded — unless the Planner explicitly marks a note as **permanent**, in which case it is preserved and factored into all future planning.
- Can dispatch the **Inspector** to analyze project state before making planning decisions.

**Trigger events:**
- Stage completed (Manager sends summary)
- Stage issue escalated (Manager cannot resolve)
- User note received (Chat forwards a note)

### 2.2 Manager

**Purpose:** Tactical task decomposition and execution supervision.

**Lifecycle:** The Manager is **stateless and one-shot per stage**. A new Manager instance is spawned for each stage. When it escalates to the Planner, it terminates — the Planner will spawn a fresh Manager for the revised stage. The Manager never needs to consult its own history; all context it needs must be in the stage description and referenced documents.

**Inputs:**
- Current stage description (from Planner's active plan) — must be self-contained with references to any documents the Manager should read before planning tasks.
- Task completion reports (from Coder/Researcher)
- Task failure reports (from Coder/Researcher)

**Outputs:**
- **Task List** (`stages/<stage-id>/tasks.json`): Ordered list of tasks for the current stage. Each task has:
  - `id`: unique task identifier
  - `type`: `code` | `research` | `test` | `document`
  - `assigned_to`: `coder` | `researcher`
  - `description`: detailed description of what to do
  - `checklist`: list of verification points the agent must check
  - `dependencies`: tasks that must complete first
  - `status`: `pending` | `in-progress` | `completed` | `failed`
- **Stage Summary** (`stages/<stage-id>/summary.json`): Written when all tasks complete. Aggregates task summaries. Sent to Planner.

**Behaviors:**
- **Reads referenced documents** listed in the stage description before decomposing tasks.
- Breaks the current stage into tasks, including mandatory best-practice tasks:
  - Testing for code changes
  - Documentation for new features/APIs
  - These can be standalone tasks or checklist items within coding tasks
- Dispatches tasks to Coder or Researcher based on `assigned_to`.
- Can dispatch **independent tasks in parallel** when they have no dependencies.
- Monitors task completion reports.
- On task failure: decides whether to retry, create a remediation task, adjust remaining tasks, or escalate to Planner. **Escalation terminates the Manager.**
- On stage completion: writes the stage summary (aggregating Coder/Researcher reports) and notifies the Planner. **Then terminates.**
- Schedules **skill generation** after a tool or pattern is established that will be reused.

**Trigger events:**
- New stage assigned by Planner → Manager spawned
- Task completed (Coder/Researcher sends report)
- Task failed (Coder/Researcher sends failure report)

### 2.3 Coder

**Purpose:** Write code, run commands, execute tasks, document the work.

**Inputs:**
- Task description with checklist (from Manager)
- Relevant skills (auto-loaded based on task context)

**Outputs:**
- **Task Report** (`stages/<stage-id>/reports/<task-id>.json`):
  - `task_id`: which task this is for
  - `status`: `completed` | `failed`
  - `summary`: what was done
  - `files_modified`: list of files changed
  - `tests_added`: list of tests written
  - `issues_found`: any problems discovered
  - `failure_reason`: if failed, why

**Behaviors:**
- Executes coding tasks: writes code, runs tests, executes commands.
- Can read project files, documentation, and external resources (web, docs) as needed for context.
- Documents all work in the task report.
- Self-assesses success against the task checklist.
- Flags failure honestly when a task cannot be completed.
- **Can commit** its own changes to version control (must commit only files it modified, avoiding conflicts with concurrent agents).

### 2.4 Researcher

**Purpose:** Investigate external resources, retrieve documentation, build the project knowledge base.

**Inputs:**
- Task description with checklist (from Manager)
- Relevant skills (auto-loaded)

**Outputs:**
- **Research artifacts** stored in `research/` directory (organized by topic)
- **Task Report** (`stages/<stage-id>/reports/<task-id>.json`): same schema as Coder.

**Behaviors:**
- Retrieves and files documentation from the internet.
- Can read project code for context but **cannot modify project code**.
- Can create and edit files under `research/` freely.
- **Can write utility scripts** under `research/` for data processing, comparison, or analysis — same ownership model as Inspector.
- Documents findings in structured research files.
- Self-assesses and flags failures.
- **Can commit** its own files (`research/`) to version control.

### 2.5 Inspector

**Purpose:** Deep analysis of project state on demand.

**Lifecycle:** The Inspector is **one-shot**. It is spawned with a request, performs its analysis, writes its report, and terminates. Multiple Inspector requests are processed sequentially (FIFO queue managed by the runtime).

**Inputs:**
- Investigation request (from Planner or Chat)
- Scope/questions to answer

**Outputs:**
- **Inspection Reports** (`inspections/<report-id>.json`):
  - `id`: unique report identifier
  - `requested_by`: `planner` | `chat`
  - `scope`: what was investigated
  - `findings`: detailed analysis
  - `recommendations`: suggested actions
  - `created_at`: timestamp
  - `expires_at`: optional TTL for relevance (null = permanent)

**Behaviors:**
- Analyzes project state: code quality, data status, test coverage, model performance, etc.
- Has its own working directory (`inspector-workspace/`) for intermediate processing.
- **Can create its own tools/scripts** in its workspace for analysis purposes.
- **Cannot modify main project code** — strict ownership boundary.
  - Exception: Planner can explicitly grant write access to specific files in rare cases.
- Can execute project code (run tests, check outputs) but not change it.
- Reports include metadata (timestamp, TTL) so the Planner can assess relevance.
- Tools/scripts created in `inspector-workspace/` persist across investigations (reusable by future Inspector instances).

**Trigger events:**
- Planner requests investigation → Inspector spawned
- Chat forwards user's analysis request → Inspector spawned

### 2.6 Chat

**Purpose:** User-facing interface for queries, status updates, and steering.

**Lifecycle:** One Chat instance per channel (web UI, Telegram, etc.). Multiple channels can be active simultaneously.

**Inputs:**
- User messages (via web UI or Telegram)
- System events (stage completions, failures, inspector results)

**Outputs:**
- Responses to user queries
- **User Notes** (`notes/<note-id>.json`): forwarded to Planner for consideration
- Push notifications (Telegram) for significant events
- **Chat Logs** (`tmp/chats/<channel>/<session-id>.json`): complete dialogue history saved to disk

**Behaviors:**
- Can inspect: active plan, current stage, task list, task reports, inspector reports.
- **Does not stop execution** unless user explicitly requests replan/pause/stop.
- Creates notes for the Planner when user provides direction or feedback.
- Can dispatch the Inspector on behalf of the user and return results.
- Pushes notifications to user for:
  - Stage completion
  - Unexpected errors (Manager/Planner handling failures)
  - Inspector reports requested by the user
- Notifications are **fire-and-forget** — no response is required. They remain in the chat history so the user can ask follow-up questions about them later.
- User can configure notification filters (opt-out of categories, severity thresholds).
- All dialogues are **persisted to disk** so that agents or users can reference conversations across channels.

---

## 3. Communication Protocol

### 3.1 Document Flow

```
User ←→ Chat ──notes──→ Planner
                           │
                     plan/stages
                           │
                           ▼
                        Manager
                        │     │
                   tasks/      \tasks
                   reports      reports
                      │            │
                      ▼            ▼
                    Coder      Researcher
```

```
Planner ──request──→ Inspector ──report──→ Planner
Chat    ──request──→ Inspector ──report──→ Chat
```

### 3.2 Error Escalation Chain

```
Coder/Researcher (task failure)
       → Manager (retry / remediate / replan tasks)
              → Planner (replan stage / adjust plan)
                     → User (notification via Chat)
```

Every agent can signal that it cannot fulfill a requirement. The signal propagates upward until an agent handles it or the user is notified.

### 3.3 File System Layout

Global config (system-wide, not project-specific):
```
~/.saivage/
├── config.json                    # LLM credentials, Telegram tokens, system settings
└── auth/                          # Provider auth tokens
```

Project-local (inside the project directory, e.g. `/project/foo/.saivage/`):
```
<project>/.saivage/
├── config.json                    # Project objectives, model preferences
│
│── [PERSISTENT — committed to git]
├── plan.json                      # Active plan (stages remaining)
├── plan-history.json              # Completed stages archive
├── notes/                         # User notes from Chat → Planner
│   └── <note-id>.json             #   (volatile: cleared on replan unless marked permanent)
├── stages/
│   └── <stage-id>/
│       ├── tasks.json             # Task breakdown for this stage
│       ├── summary.json           # Stage completion summary
│       └── reports/
│           └── <task-id>.json     # Individual task reports
├── inspections/
│   └── <report-id>.json           # Inspector reports
├── research/                      # Researcher's knowledge base
│   └── <topic>/
├── skills/
│   ├── index.json                 # Skill index for auto-loading
│   └── <skill-name>.md            # Skill files
│
│── [TEMPORARY — gitignored]
├── tmp/
│   ├── state/
│   │   └── runtime.json           # Runtime state for crash recovery
│   ├── inspector-workspace/       # Inspector's private working dir
│   ├── chats/
│   │   └── <channel>/
│   │       └── <session-id>.json  # Chat dialogue logs
│   └── work/
│       ├── coder/                 # Coder's scratch space
│       └── researcher/            # Researcher's scratch space
└── .gitignore                     # Ignores tmp/
```

---

## 4. Execution Model

### 4.1 Main Loop

1. **Planner** generates or updates the plan.
2. Runtime spawns a **Manager** for the next stage.
3. Manager reads stage description + referenced documents, decomposes into tasks.
4. Manager dispatches tasks (parallel when independent, coding and research tasks can run concurrently).
5. **Coder/Researcher** execute tasks, write reports, commit their own files.
6. On task completion/failure → Manager evaluates.
7. On unresolvable failure → Manager escalates to Planner and **terminates**. Planner revises plan → goto 2.
8. When all stage tasks complete → Manager writes stage summary, notifies Planner, and **terminates**.
9. Planner updates plan → goto 2.

### 4.2 Concurrency

At most **one instance of each agent type** runs at a time (except Chat — one per channel):

| Agent      | Max instances | Notes |
|------------|---------------|-------|
| Planner    | 1             | When running, Manager and all subordinates are **suspended** until Planner finishes. |
| Manager    | 1             | When running (planning tasks), Coder/Researcher are **suspended** until dispatch. |
| Coder      | 1             | Runs one task at a time. |
| Researcher | 1             | Runs one task at a time, **in parallel with Coder**. |
| Inspector  | 1             | FIFO queue, one-shot. |
| Chat       | 1 per channel | Never blocked. |

**Hierarchical blocking:** When a higher-level agent activates, subordinate agents are suspended:
- Planner running → Manager, Coder, Researcher suspended.
- Manager running (task planning/evaluation) → Coder, Researcher suspended until tasks are dispatched.
- Once tasks are dispatched, Coder and Researcher run in parallel (one of each).

### 4.3 Version Control

All code-producing agents (Coder, Researcher, Inspector) can commit to git:
- Each agent commits **only the files it created or modified**.
- Agents must not stage or commit files belonging to other concurrent agents.
- Commit messages must reference the task ID: `[task-<id>] <description>`.
- The runtime must ensure git operations are serialized (lock around `git add`/`commit`) to prevent race conditions.
- **Conflict resolution**: If a commit fails due to a conflict (rare — would require two agents editing the same file), the failure is escalated to the Manager, which creates a new task to resolve the conflict.

### 4.4 Crash Recovery

On restart:
1. Load `plan.json` — resume current stage.
2. Load `stages/<stage-id>/tasks.json` — find in-progress tasks.
3. Tasks marked `in-progress` at crash time → reset to `pending` for retry.
4. Manager is respawned for the current stage with remaining tasks.
5. Inspector/Chat state is stateless (re-derive from files).

---

## 5. Skill System

### 5.1 Generation

The Manager schedules skill generation when:
- A new tool or pattern is established that will be reused across future tasks.
- A coder completes a task involving a workflow that should be documented for reuse.

### 5.2 Index & Auto-Loading

- `skills/index.json` maps skill names to:
  - `triggers`: list of matching rules (see below)
  - `file`: path to the skill file
  - `description`: human-readable summary
  - `created_at` / `updated_at`: timestamps

- **Trigger types** (each skill declares one or more):
  - `keyword:<word>` — matches if the task description contains the word (case-insensitive)
  - `tool:<name>` — matches if the task uses or mentions the named tool/MCP
  - `path:<glob>` — matches if any file in the task scope matches the glob pattern
  - `tag:<label>` — matches if the task or stage has the given tag

- When a task is dispatched, the runtime evaluates all triggers against the task metadata (description, tool list, file paths, tags). Skills with **any matching trigger** are loaded into the agent's context.

- **Loading budget**: Maximum N skills per agent invocation (configurable, default 5). If more match, rank by: number of triggers matched (descending), then `updated_at` (most recent first). Truncate.

---

## 6. External Systems (Carried from v1)

- **LLM Providers**: Router with model config, failover, timeout settings — same as v1.
- **MCP Providers**: Tool generation and runtime — same as v1.
- **Web Interface**: Maintained from v1.
- **Telegram Bot**: Maintained from v1 + push notification support with user-configurable filters.

---

## 7. Open Questions

1. **Planner retrospective depth**: How deep should the Inspector's analysis go when the Planner schedules a full retrospective? Should there be a budget (time/tokens)?
2. **Chat log retention**: How long are chat dialogue logs kept? Rotate by size, age, or keep forever?
3. **Permanent note format**: What metadata should permanent notes carry so the Planner can filter/prioritize them across many planning cycles?
