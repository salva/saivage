# Saivage v2 — Agent System Specification (DRAFT)

## 1. Design Philosophy

Replace the v1 interactive orchestrator/coder/researcher loop with a **structured hierarchical protocol** where each agent has a clearly defined role, communicates through **tool calls and JSON documents on disk**, and errors escalate upward through a chain of command.

Inter-agent communication uses two complementary mechanisms: **tool-call invocation** for control flow (parent calls child, suspends, child returns result) and **JSON documents on disk** for persistence and auditability. A parent writes the task spec to disk, invokes the child via tool call, the child reads the spec from disk, does its work, writes results to disk, and returns a summary as the tool-call result. There are no in-memory message queues. This makes the system crash-recoverable, inspectable, and decoupled.

All project documentation and agent state lives **inside the project directory** (e.g. `/project/foo/.saivage/`), not in a global `~/.saivage/`. Global config (`~/.saivage/config.json`) only stores system-wide settings (LLM credentials, Telegram tokens). Everything project-specific is project-local.

Files are separated into two categories:
- **Persistent** (committed to git): plans, history, research, skills, stage summaries, inspection reports.
- **Temporary** (gitignored): runtime state, agent working directories, in-progress task data, chat logs.

---

## 2. Agent Roles

### 2.1 Planner

**Purpose:** Strategic long-term planning and course correction.

**Lifecycle:** The Planner is a **long-lived agent** that persists for the entire project run. It is the top-level agent — all other agents are invoked by the Planner (directly or transitively) as tool calls. The Planner’s LLM conversation is **suspended** while subordinate agents run and **resumed** when their tool calls return.

When the conversation context grows too large (many stages completed), the Planner performs a **context compaction**: it summarizes the conversation so far into a condensed state and continues from there. The plan state managed by the plan MCP service serves as the authoritative state, so compaction is safe.

**Inputs:**
- Project objectives (from config)
- Stage completion reports (returned by Manager tool calls)
- Issue escalations (returned by Manager tool calls with `result: "escalated"`)
- User notes (injected into context when Planner resumes)
- Inspector reports (returned by Inspector tool calls)

**Outputs:**
- **Active Plan** (`plan.json`): Ordered list of stages remaining to be done. Each stage has:
  - `id`: unique stage identifier
  - `objective`: what the stage should accomplish
  - `starting_points`: current state of affairs relevant to this stage
  - `expected_outcomes`: concrete, verifiable deliverables
  - `acceptance_criteria`: how to know the stage is done
  - `references`: list of document paths the Manager should read before planning tasks
- **Plan History** (`plan-history.json`): Completed stages with their summaries, moved out of the active plan on completion.

**Execution model:**
1. **Initial planning**: reads project objectives + current project state → calls `plan_init(stages)` via the plan MCP service.
2. **Stage dispatch**: calls `run_manager(stage)` as a tool. The Planner's conversation suspends.
3. **Stage result**: Manager returns `StageSummary` as the tool result. Planner resumes.
4. **Plan update**: calls `plan_complete_stage()` to archive the stage, updates remaining stages via `plan_set_stages()` if needed, picks next stage.
5. **Loop**: calls `run_manager(next_stage)` → goto 3.
6. At any point, can call `run_inspector(request)` as a tool for deep analysis.

User notes arriving while the Planner is suspended are queued and **injected as additional context** when the Planner next resumes. If a user note requests immediate replanning (via `urgent` flag), the runtime **aborts** the active agent chain and resumes the Planner immediately (see §4.4).

**Behaviors:**
- Creates the initial plan via `plan_init(stages)` from project objectives and current project state.
- Updates the plan via `plan_complete_stage()` and `plan_set_stages()` after each stage completes (informed by Manager's summary returned as tool result).
- Handles escalations (tool result with `result: "escalated"`) by revising stages via `plan_add_stage()`, `plan_remove_stage()`, or `plan_set_stages()`.
- When something is not going as expected (repeated failures, stalled progress, escalations), the Planner **schedules a full retrospective** — calling the Inspector for deep analysis before deciding on corrective action.
- Schedules corrective/refactoring actions only when they unblock or accelerate progress toward objectives.
- Processes **user notes** from Chat. Volatile notes are retained until the next replanning cycle, then discarded. **Permanent notes** represent lasting adjustments to the project's direction — they serve as lightweight objective modifications and are preserved and factored into all future planning decisions.
- Calls the **Inspector** via tool call to analyze project state before making planning decisions.

### 2.2 Manager

**Purpose:** Tactical task decomposition and execution supervision.

**Lifecycle:** The Manager is a **long-lived agent, one per stage**. A fresh Manager instance is spawned when a new stage begins and persists for the entire stage duration. It terminates when the stage completes or is escalated to the Planner. The Manager does not carry state across stages — each new stage gets a fresh instance with context assembled from the stage description and referenced documents.

**Inputs:**
- Current stage description (from Planner's active plan) — must be self-contained with references to any documents the Manager should read before planning tasks.
- Task completion reports (from Coder/Researcher) — returned as tool-call results when subagents complete.
- Task failure reports (from Coder/Researcher) — returned as tool-call results with `status: "failed"`.

**Outputs:**
- **Task List** (`stages/<stage-id>/tasks.json`): Ordered list of tasks for the current stage. Each task has:
  - `id`: unique task identifier
  - `type`: `code` | `research` | `test` | `document`
  - `assigned_to`: `coder` | `researcher`
  - `description`: detailed description of what to do
  - `checklist`: list of verification points the agent must check
  - `dependencies`: tasks that must complete first
  - `status`: `pending` | `in-progress` | `completed` | `failed` | `aborted`
- **Stage Summary** (`stages/<stage-id>/summary.json`): Written when all tasks complete (or on escalation/abort). Aggregates task summaries. Sent to Planner.

**Execution model:**
1. **Planning phase**: reads referenced documents, decomposes the stage into tasks (writes `tasks.json`).
2. **Dispatch phase**: calls subagents (Coder/Researcher) via tool calls. The Manager invokes subagents as tools — each tool call blocks until the subagent completes and returns its `TaskReport`.
3. **Evaluation phase**: processes the report, updates task status, decides next action.
4. **Loop**: returns to dispatch phase for the next ready task(s). Independent tasks (1 Coder + 1 Researcher) can be dispatched in parallel.
5. **Idle waiting**: when subagents are running, the Manager's LLM conversation is **suspended**. On subagent completion, the Manager is **resumed** with the report injected as a tool result.

This means the Manager maintains its full conversation context throughout the stage — it remembers its planning rationale, can adapt task sequencing based on earlier results, and can generate remediation tasks without re-reading everything.

**Behaviors:**
- **Reads referenced documents** listed in the stage description before decomposing tasks.
- Breaks the current stage into tasks, including mandatory best-practice tasks:
  - Testing for code changes
  - Documentation for new features/APIs
  - These can be standalone tasks or checklist items within coding tasks
- Dispatches tasks to Coder or Researcher via tool calls.
- Can dispatch **independent tasks in parallel** (1 Coder + 1 Researcher) when they have no dependencies.
- Processes task reports returned as tool results.
- On task failure: decides whether to retry, create a remediation task, adjust remaining tasks, or escalate to Planner. **Escalation terminates the Manager.**
- On stage completion: writes the stage summary (aggregating Coder/Researcher reports) and notifies the Planner. **Then terminates.**
- Schedules **skill generation** after a tool or pattern is established that will be reused.

**Trigger events:**
- New stage assigned by Planner → Manager spawned
- Subagent tool call returns → Manager LLM conversation resumed

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
- **Commits** its changes via the MCP git tool. By convention, commits only files it modified for the current task.

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
- Can read project code for context. By convention, writes under `research/` to avoid collisions with Coder.
- **Can write utility scripts** under `research/` for data processing, comparison, or analysis.
- Documents findings in structured research files.
- Self-assesses and flags failures.
- **Commits** its changes via the MCP git tool. By convention, commits files under `research/` and its task report.

### 2.5 Inspector

**Purpose:** Deep analysis of project state on demand.

**Lifecycle:** The Inspector is **one-shot**, invoked as a tool call by the Planner or Chat. It performs its analysis, returns its report as the tool result, and terminates. Multiple Inspector requests are processed sequentially (FIFO — only one tool call at a time).

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
- **Three storage tiers:**
  - **Ephemeral workspace** (`tmp/inspector-workspace/`): scratch space for intermediate processing. Gitignored — does not survive clean checkout.
  - **Persistent reports** (`inspections/<report-id>.json`): final analysis results. Committed to git.
  - **Persistent tooling** (`tools/inspector/`): reusable scripts/tools that survive across investigations. Committed to git.
- Can create tools/scripts in ephemeral workspace during analysis, then promote useful ones to `tools/inspector/`.
- Can read, execute, and modify any project file — same access as other agents. By convention, does not modify main project code unless the investigation requires it.
- Reports include metadata (timestamp, TTL) so the Planner can assess relevance.
- **Commits** reports and persistent tools via the MCP git tool.

**Trigger events:**
- Planner calls `run_inspector(request)` tool → Inspector spawned
- Chat calls `run_inspector(request)` tool → Inspector spawned

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

### 3.1 Tool-Call Hierarchy

All inter-agent invocation uses the **tool-call pattern** — a parent agent calls a child agent as an LLM tool, suspends while the child runs, and resumes when the child returns its result.

```
Planner (long-lived)
  ├── run_manager(stage)          → returns StageSummary
  │     ├── run_coder(task)        → returns TaskReport
  │     └── run_researcher(task)   → returns TaskReport
  └── run_inspector(request)      → returns InspectionReport

Chat (independent, per channel)
  ├── run_inspector(request)      → returns InspectionReport
  └── create_note(content, urgent?)  → writes note for Planner
```

User notes arriving while the Planner is suspended are queued and injected as additional context when the Planner next resumes (this is a runtime mechanism, not a tool call).

The Planner’s conversation never terminates — it loops: plan → call Manager → process result → update plan → repeat.

The Manager’s conversation lives for one stage: plan tasks → call Coder/Researcher → process results → dispatch more → write summary → return.

### 3.2 Document Flow

In addition to tool-call return values, agents write JSON documents to disk for persistence and auditability:

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

### 3.3 Error Escalation Chain

```
Coder/Researcher (task failure)
       → Manager (retry / remediate / replan tasks)
              → Planner (replan stage / adjust plan)
                     → User (notification via Chat)
```

Every agent can signal that it cannot fulfill a requirement. The signal propagates upward until an agent handles it or the user is notified.

### 3.4 File System Layout

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
├── tools/
│   └── inspector/                 # Inspector's persistent analysis tools
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

The execution model is a **nested tool-call chain**:

1. Runtime starts the **Planner** (long-lived LLM conversation).
2. Planner reads objectives + project state, calls `plan_init(stages)` via the plan MCP service.
3. Planner calls `plan_set_current(stage_id)`, then `run_manager(stage)` → Planner suspends.
4. **Manager** spawns, reads stage references, decomposes into tasks, writes `tasks.json`.
5. Manager calls `run_coder(task)` and/or `run_researcher(task)` → Manager suspends.
6. **Coder/Researcher** execute tasks, write reports, commit files → return `TaskReport`.
7. Manager resumes, processes reports, updates task statuses.
8. Manager loops (dispatch next tasks) or finishes:
   - **Completion**: writes `StageSummary`, returns it to Planner.
   - **Escalation**: writes `StageSummary` with `result: "escalated"`, returns it to Planner.
9. Planner resumes, calls `plan_complete_stage()` to archive the stage, updates remaining stages via `plan_set_stages()` if needed.
10. Planner calls `run_manager(next_stage)` → goto 3.

At any point, the Planner can call `run_inspector(request)` for deep analysis.
User notes are injected into the Planner’s context when it next resumes.

### 4.2 Concurrency

The tool-call model naturally serializes the hierarchy — a parent is suspended while its child runs:

| Agent      | Max instances | Lifetime | Invoked by |
|------------|---------------|----------|------------|
| Planner    | 1             | Project lifetime | Runtime (top-level) |
| Manager    | 1             | One stage | Planner via `run_manager()` |
| Coder      | 1             | One task | Manager via `run_coder()` |
| Researcher | 1             | One task | Manager via `run_researcher()` |
| Inspector  | 1             | One investigation | Planner or Chat via `run_inspector()` |
| Chat       | 1 per channel | Session | Runtime (independent) |

**Parallelism:** The Manager can issue `run_coder()` and `run_researcher()` as **parallel tool calls** when the tasks have no dependencies. Both run concurrently; the Manager **resumes as each child returns** — it receives each result independently and can process it, issue new dispatches, or continue waiting. See [04-RUNTIME-DETAILS.md](04-RUNTIME-DETAILS.md) §1.3 for exact mechanics.

**Chat independence:** Chat agents run independently of the Planner hierarchy. They can read all documents and call `run_inspector()` without blocking or being blocked by the main execution chain.

**Inspector contention:** If both Planner and Chat request the Inspector simultaneously, one waits. Inspector requests are serialized (FIFO).

### 4.4 Abort / Immediate Replanning

When the user demands an immediate course change, the system supports **aborting the active agent chain** to return control to the Planner without waiting for the current stage to complete.

**Mechanism:**
1. User sends an urgent message via Chat. Chat creates a note with `urgent: true` via `create_note(content, urgent=true)`.
2. The runtime detects the urgent note and signals an **abort** to the currently running agent chain.
3. Abort propagates **bottom-up**: the lowest-level active agent (Coder/Researcher) is terminated first. Its parent (Manager) receives an abort signal instead of a normal tool result. The Manager writes a partial `StageSummary` with `result: "aborted"` and returns it to the Planner.
4. The Planner resumes with the abort result and the urgent note injected into context. It processes the user's request and replans accordingly.

**Abort semantics:**
- Aborted agents do not commit partial work — uncommitted changes are discarded. The runtime performs a `git checkout -- .` on the project worktree after terminating the aborted agent to ensure no partial modifications remain.
- The Manager's `tasks.json` reflects the state at abort time (completed tasks stay completed, in-progress tasks are marked `aborted`).
- On abort, the Planner **creates a rollback stage** as the first stage in the revised plan. The rollback stage inspects the project state, reverts any inconsistencies left by the interrupted work, and ensures the project is in a clean state before new work begins. After the rollback stage completes, the Planner proceeds with the new direction.
- Abort is a **runtime mechanism**, not an LLM tool call. Agents do not need to "cooperate" with the abort — the runtime terminates their LLM conversation and synthesizes the abort result.

### 4.3 Version Control

All git operations go through an **MCP git server** that serializes access. No direct `git` CLI calls by agents.

The MCP git server exposes tools:
- `git_commit(files, message, task_id)` — stages only the specified files, commits with `[task-<id>] <message>`. Returns commit SHA or conflict error.
- `git_status()` — returns current working tree status.
- `git_diff(files?)` — returns diff of specified files (or all).
- `git_log(n?)` — returns recent commit history.

Serialization is inherent — the MCP server processes one tool call at a time, so no locking is needed.

**Conflict resolution**: If `git_commit` detects a conflict (rare — two agents modifying the same file), it returns an error. The calling agent reports this in its `TaskReport` as a failure, which the Manager handles by creating a resolution task.

**Conventions** (all agents except Chat have full access — conventions prevent collisions):
- **Coder**: commits project code it modified + its task report.
- **Researcher**: commits files under `research/` + its task report.
- **Inspector**: commits reports under `inspections/` and persistent tools under `tools/inspector/`.
- **Planner/Manager**: commit `.saivage/` state files (plan files committed via `plan_commit()`, tasks/summaries via git MCP).
- **Chat**: read-only access to project state. Writes only notes and chat logs.

### 4.5 Plan MCP Service

All read and write operations on `plan.json` and `plan-history.json` go through the **plan MCP service**. No agent reads or writes these files directly.

The plan MCP service exposes tools:
- `plan_get()` — read the current plan.
- `plan_get_stage(stage_id)` — look up a stage in active plan or history.
- `plan_get_current_stage()` — get the currently executing stage.
- `plan_set_stages(stages, current_stage_id)` — replace the plan's stage list.
- `plan_add_stage(stage)` — append a new stage.
- `plan_remove_stage(stage_id)` — remove a stage from the active plan.
- `plan_set_current(stage_id)` — set which stage is currently executing.
- `plan_complete_stage(stage_id, result, summary, actual_outcomes)` — atomically move a stage from active plan to history.
- `plan_get_history(last_n?)` — read plan history.
- `plan_init(stages?)` — initialize an empty plan.
- `plan_commit(message)` — commit `plan.json` and `plan-history.json` to git via the MCP git server. Returns commit SHA.

All writes are atomic (write to `.tmp`, rename). Schema validation is enforced on every write.

See [03-PLAN-MCP-SERVICE.md](03-PLAN-MCP-SERVICE.md) for the full specification.

See [04-RUNTIME-DETAILS.md](04-RUNTIME-DETAILS.md) for detailed runtime mechanics: suspend/resume, LLM error handling, compaction timing, self-check injection, task report flow, crash recovery details, and notification delivery.

### 4.6 Crash Recovery

On restart, the system must reconstruct where it was:
1. Call `plan_get()` — find `current_stage_id`.
2. If `stages/<current_stage_id>/summary.json` exists → stage was completed, Planner needs to process it.
3. If `stages/<current_stage_id>/tasks.json` exists → Manager was running. Reset `in-progress` tasks to `pending`.
4. **Planner is restarted** as a fresh LLM conversation. It calls `plan_get()` + `plan_get_history()` to reconstruct its strategic context (the plan files are the authoritative state).
5. If a stage was in-progress, Planner calls `run_manager()` for that stage. The Manager re-reads `tasks.json` and resumes from remaining pending tasks.
6. Chat agents restart independently (stateless, re-derive from files).

### 4.7 Context Compaction

**All agents** perform **automatic context compaction** when their conversation approaches the model's context window limit.

**Mechanism:**
1. The runtime tracks token usage for each active conversation.
2. When usage exceeds a configurable threshold (e.g., 80% of context window), the runtime triggers compaction before the next LLM call.
3. Compaction produces a **summary message** that replaces the conversation history. The summary includes: agent role, current objective, key decisions made, outstanding work, and relevant state references.
4. The agent continues from the summary as if resuming a fresh conversation.

**What makes compaction safe:**
- All agent state is written to disk (plans, tasks, reports) — the conversation is a working memory, not the source of truth.
- Planner reconstructs strategic context via `plan_get()` + `plan_get_history()`.
- Manager reconstructs tactical context from `tasks.json` + completed task reports.
- Workers (Coder, Researcher, Inspector) reconstruct context from the task description, checklist, and any files they have already read or modified. If compaction occurs mid-task, the summary captures what has been done so far and what remains.

### 4.8 Periodic Self-Check

To prevent agents from looping indefinitely, the runtime injects a **self-check prompt** into the conversation after every N tool calls (configurable, default: 20 for Manager, 15 for workers).

The self-check asks the agent: *"You have made N tool calls. Briefly assess: are you making progress toward the task objective, or are you stuck in a loop? If stuck, report failure."*

The agent's response is evaluated:
- If the agent reports progress, execution continues.
- If the agent reports being stuck, the runtime treats it as a task failure — the worker returns a failed `TaskReport`, and the Manager decides whether to retry, remediate, or escalate.

For **model throttling and transient errors** (rate limits, network timeouts, temporary API failures), the runtime retries automatically at the transport level — these do not count as tool calls and do not trigger self-checks. Transient retries continue indefinitely unless the user explicitly requests termination via an abort.

---

## 5. Skill System

### 5.1 Generation

The Manager schedules skill generation when:
- A new tool or pattern is established that will be reused across future tasks.
- A coder completes a task involving a workflow that should be documented for reuse.

### 5.2 Index & Auto-Loading

**All agents** can have skills loaded — not just workers. Skills provide any agent with project-specific knowledge relevant to its current task.

- `skills/index.json` maps skill names to:
  - `triggers`: list of matching rules (see below)
  - `target_agents`: list of agent types this skill applies to (e.g., `["coder", "manager"]`). If omitted, the skill applies to all agents.
  - `file`: path to the skill file
  - `description`: human-readable summary
  - `created_at` / `updated_at`: timestamps

- **Trigger types** (each skill declares one or more):
  - `keyword:<word>` — case-insensitive substring match in the task/stage description
  - `tool:<name>` — exact match (case-sensitive) against tool names in the task description or agent tool list
  - `path:<glob>` — glob match (minimatch-style) against files in the task scope or project
  - `tag:<label>` — exact match against `task.tags` or `stage.tags`
  - `agent:<type>` — exact match against the current agent type (e.g., `agent:planner`)

- When an agent is invoked, the runtime evaluates all triggers against the agent's metadata (task description, tool list, file paths, tags, agent type). Skills whose triggers match **and** whose `target_agents` includes the current agent type (or is omitted) are loaded into the agent's context.

- **Loading format**: Each loaded skill is prepended to the agent's context as a system message section:
  ```
  ---
  SKILL: <skill-name>
  <full markdown content>
  ---
  ```

- **Loading budget**: Maximum N skills per agent invocation (configurable, default 5). If more match, rank by: number of triggers matched (descending), then `updated_at` (most recent first). Truncate.

---

## 6. External Systems (Carried from v1)

- **LLM Providers**: Router with model config, failover, timeout settings — same as v1. **Model precedence**: `ProjectConfig.model_overrides[role]` > `GlobalConfig.providers[name].models[role]` > most capable model available.
- **MCP Providers**: Tool generation and runtime — same as v1.
- **Web Interface**: Maintained from v1.
- **Telegram Bot**: Maintained from v1 + push notification support with user-configurable filters.

---

## 7. Open Questions

*(None — all resolved. See individual specs for details.)*
