# Saivage v2 — Agent System Specification (DRAFT)

See [06-SYSTEM-DESIGN.md](06-SYSTEM-DESIGN.md) for architecture overview and component diagrams.

## 1. Design Philosophy

Replace the v1 interactive orchestrator/coder/researcher loop with a **structured hierarchical protocol** where each agent has a clearly defined role, communicates through **tool calls and JSON documents on disk**, and errors escalate upward through a chain of command.

Inter-agent communication uses two complementary mechanisms: **tool-call invocation** for control flow (parent calls child, suspends, child returns result) and **JSON documents on disk** for persistence and auditability. A parent writes the task spec to disk, invokes the child via tool call, the child reads the spec from disk, does its work, writes results to disk, and returns a summary as the tool-call result. There are no in-memory message queues. This makes the system crash-recoverable, inspectable, and decoupled.

All project documentation, agent state, runtime config, and auth state live **inside the project directory** (e.g. `/project/foo/.saivage/`). Nothing is stored in a global `~/.saivage/` directory.

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
  - `tags`: string array for skill matching (may be empty)
- **Plan History** (`plan-history.json`): Terminal stages (completed, failed, escalated, aborted) with their summaries, archived from the active plan via `plan_complete_stage()`.

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
- Processes **user notes** injected into its context by the runtime. **Permanent notes** represent lasting adjustments to the project's direction — they serve as lightweight objective modifications and are preserved and factored into all future planning decisions. Volatile notes are processed once and deleted by the runtime after the Planner completes its next planning action. The Planner does not write to note files — acknowledgment and cleanup are runtime-managed.
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
- On task failure: decides whether to retry, create a remediation task, adjust remaining tasks, or escalate to Planner. **Escalation terminates the Manager.** On escalation, the Manager updates `tasks.json` — completed tasks stay `completed`, the failing task stays `failed`, and remaining undispatched tasks stay `pending`.
- On stage completion: writes the stage summary (aggregating Coder/Researcher reports) and notifies the Planner. **Then terminates.**
- **Authors skills directly** via the `create_skill` / `update_skill` / `supersede_skill` MCP tools when a tool or pattern is established that will be reused. The Manager writes the skill record itself; it does **not** dispatch a Coder to do this. See [SPEC/v2/skills-memory/01-DESIGN.md](skills-memory/01-DESIGN.md) §C.1 and §F (skill authorship is restricted to Manager and Inspector).
- May also call `create_memory` (and the memory lifecycle tools) directly to record durable project-scope facts; see §D / §F of the design for the permissions matrix.

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
- All dialogues are **persisted to disk** so that the Chat agent maintains conversation continuity across user sessions. Chat logs are gitignored and not accessible to other agents — they exist for user-facing context only.

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
  └── create_note(content, permanent?, urgent?)  → writes note for Planner
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

Project-local (inside the project directory, e.g. `/project/foo/`):
```
<project>/
├── research/                      # Researcher's knowledge base (project-level)
│   └── <topic>/
│
└── .saivage/
    ├── config.json                # Project objectives, model preferences
    ├── saivage.json               # Runtime/provider config
    ├── auth/                      # Provider auth tokens
    │
    │── [PERSISTENT — committed to git]
    ├── plan.json                  # Active plan (stages remaining)
    ├── plan-history.json          # Terminal stages archive
    ├── notes/                     # User notes from Chat → Planner
    │   └── <note-id>.json         #   (volatile or permanent)
    ├── stages/
    │   └── <stage-id>/
    │       ├── tasks.json         # Task breakdown for this stage
    │       ├── summary.json       # Stage completion summary
    │       └── reports/
    │           └── <task-id>.json # Individual task reports
    ├── inspections/
    │   └── <report-id>.json       # Inspector reports
    ├── skills/
    │   ├── index.json             # Skill index for auto-loading
    │   └── <skill-name>.md        # Skill files
    ├── tools/
    │   └── inspector/             # Inspector's persistent analysis tools
    │
    │── [TEMPORARY — gitignored]
    ├── tmp/
    │   ├── state/
    │   │   └── runtime.json       # Runtime state for crash recovery
    │   ├── inspector-workspace/   # Inspector's private working dir
    │   ├── chats/
    │   │   └── <channel>/
    │   │       └── <session-id>.json  # Chat dialogue logs
    │   └── work/
    │       ├── coder/             # Coder's scratch space
    │       └── researcher/        # Researcher's scratch space
    └── .gitignore                 # Ignores tmp/
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
   - **Failure** (runtime-generated): if the Manager's own conversation fails unrecoverably (max compactions exceeded, non-retryable LLM error), the runtime synthesizes a `StageSummary` with `result: "failed"` and returns it to the Planner. This is distinct from escalation, which is a deliberate Manager decision.
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
- Aborted agents do not commit partial work — uncommitted changes are discarded. The runtime performs a `git checkout -- .` on the project worktree after terminating the aborted agent, which resets tracked modified files. **Untracked files** (new files created by the aborted agent) are not removed by `git checkout` — the rollback stage handles cleanup of those.
- The Manager's `tasks.json` reflects the state at abort time (completed tasks stay completed, in-progress tasks are marked `aborted`).
- On abort, the Planner **creates a rollback stage** as the first stage in the revised plan. The rollback stage inspects the project state, reverts any inconsistencies left by the interrupted work, and ensures the project is in a clean state before new work begins. After the rollback stage completes, the Planner proceeds with the new direction.
- Abort is a **runtime mechanism**, not an LLM tool call. Agents do not need to "cooperate" with the abort — the runtime terminates their LLM conversation and synthesizes the abort result.

### 4.3 Version Control

All git operations go through an **MCP git server** that serializes access. No direct `git` CLI calls by agents. Tools: `git_commit`, `git_status`, `git_diff`, `git_log`. See [05-MCP-SERVICES.md](05-MCP-SERVICES.md) §3 for full tool schemas.

**Conflict resolution**: If `git_commit` detects a conflict (rare — two agents modifying the same file), it returns an error. The calling agent reports this in its `TaskReport` as a failure, which the Manager handles by creating a resolution task.

**Conventions** (all agents except Chat have full access — conventions prevent collisions):
- **Coder**: commits project code it modified + its task report.
- **Researcher**: commits files under `research/` + its task report.
- **Inspector**: commits reports under `inspections/` and persistent tools under `tools/inspector/`.
- **Planner/Manager**: commit `.saivage/` state files (plan files committed via `plan_commit()`, tasks/summaries via git MCP).
- **Chat**: read-only access to project state. Writes only notes and chat logs.

### 4.5 Plan MCP Service

All read and write operations on `plan.json` and `plan-history.json` go through the **plan MCP service**. No agent reads or writes these files directly. All writes are atomic (write to `.tmp`, rename). Schema validation is enforced on every write.

See [03-PLAN-MCP-SERVICE.md](03-PLAN-MCP-SERVICE.md) for the full specification and [05-MCP-SERVICES.md](05-MCP-SERVICES.md) §5 for the tool summary.

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

For **model throttling and transient errors** (rate limits, network timeouts, temporary API failures), the runtime retries automatically at the transport level — these do not count as tool calls and do not trigger self-checks. Retries are bounded by a configurable maximum duration per request (default: 10 minutes). If the duration is exceeded, the error is surfaced as an agent failure. The user can also abort via an urgent note at any time.

---

## 5. Skill & Memory System

The skill and memory subsystems share one document-store substrate, one Zod base, one audit-trail format, and one permission engine. They diverge on default surfacing mode (skills are eager-injected; memories are on-demand lookup) and on authoring ergonomics (skills use `triggers` + `target_agents`; memories use `topic` + `keys`). See [SPEC/v2/skills-memory/](skills-memory/) for the full functional analysis ([00-FUNCTIONAL-ANALYSIS.md](skills-memory/00-FUNCTIONAL-ANALYSIS.md)), design ([01-DESIGN.md](skills-memory/01-DESIGN.md)), and implementation plan ([02-IMPLEMENTATION-PLAN.md](skills-memory/02-IMPLEMENTATION-PLAN.md)).

### 5.1 Authoring

Skills and memories are authored exclusively through MCP tools (`create_skill`, `create_memory`, etc.). The runtime `fsGuard` rejects direct filesystem writes under `.saivage/{skills,memory}/` from any role, closing the FA §1.6.4 escape hatch.

Built-in skills ship with Saivage at `saivage/skills/builtin/<topic>/SKILL.md` (YAML frontmatter, walked by the loader). Project skills are authored at runtime by the Manager or Inspector via `create_skill`. Memories are authored by Planner, Manager, Coder, Researcher, or Inspector; Coder/Researcher are restricted to `scope == "stage"` writes (design §F).

Full permissions matrix: [SPEC/v2/skills-memory/01-DESIGN.md](skills-memory/01-DESIGN.md) §F.

### 5.2 Eager Injection & On-Demand Lookup

When an agent is constructed, the knowledge loader (`src/knowledge/loader.ts`) walks built-in skills + project / stage / session records, filters by `target_agents` and trigger match, ranks them, and prepends a single `--- SAIVAGE KNOWLEDGE ---` block to the agent's system prompt.

Supported trigger types (skills only): `keyword:<word>`, `tag:<label>`, `agent:<role>`. The `tool:` and `path:` triggers were dropped (no call site populated them; see design §D.4). Triggerless skills are still findable via `search_skills` and `read_skill` by id (FR-8).

A two-tier budget governs the eager block (design §D.2): records with `survive_compaction: true` are **always** injected as one-line summaries (no token cap); other eager records share a default 2048-token budget; overflow records have their ids echoed in the block header so the agent can retrieve them on demand.

Memories are surfaced via `get_memory` / `search_memories` / `list_memories` — eager injection only applies when `target_agents` is non-empty.

### 5.3 Lifecycle

Records transition through `active` → `superseded` | `archived` | `expired` (and `deleted` writes a tombstone). All transitions are audit-logged. Stage-scoped records are archived when the stage terminates; session-scoped records are archived when the chat channel closes. Full state machine: design §B.2.

### 5.4 Compaction Integration

After `compactConversation` returns, `BaseAgent` reinjects every `active`, `scope == "project"`, `survive_compaction == true` record before `replaceMessages` (design §E.1). Compaction itself remains a pure history-to-summary function with no MCP / no store access — the survivor reinjection lives in the agent, not in `compaction.ts`.

Before compaction triggers on a Planner agent, `BaseAgent` injects a one-message nudge asking the Planner to call `create_memory` for any durable facts worth keeping; the call goes through the normal MCP loop (no synthesized tool). Capped at 5 turns. Non-Planner agents skip the nudge (design §E.2).

---

## 6. External Systems (Carried from v1)

- **LLM Providers**: Router with model config, failover, timeout settings — same as v1. **Model precedence**: `ProjectConfig.model_overrides[role]` > `RuntimeConfig.providers[name].models[role]` > most capable model available.
- **MCP Providers**: Tool generation and runtime — same as v1.
- **Web Interface**: Maintained from v1.
- **Telegram Bot**: Maintained from v1 + push notification support with user-configurable filters.

---

## 7. Open Questions

*(None — all resolved. See individual specs for details.)*
