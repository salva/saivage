# Saivage v2 — Implementation Plan

## Overview

Build v2 incrementally on top of the v1 codebase. Reuse infrastructure that works (providers, MCP, channels, services, auth), replace the orchestrator entirely, and refactor agents into the new role-based system.

**Approach:** Bottom-up. Build the foundation layers first (data access, runtime), then agents one by one (simplest first), then the execution loop, then integration.

---

## Phase 1: Foundation — Data Layer & Project Structure

**Goal:** All JSON documents can be created, read, updated, validated. The project directory structure is initialized and managed correctly.

### 1.1 Type definitions
- Define all TypeScript interfaces from 01-DATA-MODEL.md as a single `src/v2/types.ts`.
- Include Zod schemas for runtime validation of every JSON document.

### 1.2 Document store
- `src/v2/store/documents.ts` — Generic CRUD for JSON documents on disk.
  - `read<T>(path) → T | null`
  - `write<T>(path, data: T)` — atomic write (write to `.tmp`, rename)
  - `append<T>(path, item: T)` — for append-only docs like plan-history
  - `list(dir) → string[]` — list documents in a directory
  - `delete(path)` — remove a document
- All writes go through validation (Zod parse before write).

### 1.3 Project initializer
- `src/v2/store/project.ts` — Initialize/discover `.saivage/` directory for a project.
  - `initProject(projectRoot)` — creates directory structure, `.gitignore` for `tmp/`.
  - `loadProject(projectRoot) → ProjectContext` — loads config, resolves paths.
  - `ProjectContext` bundles paths and config for everything downstream.

### 1.4 ID generator
- `src/v2/ids.ts` — nanoid-based ID generation with entity prefixes (`stg-`, `tsk-`, etc.).

### 1.5 Tests
- Unit tests for document store (CRUD, atomic writes, validation failures).
- Unit tests for project init (directory creation, gitignore content).

**Deliverable:** You can create, read, and validate every document type. Projects initialize cleanly.

---

## Phase 2: Runtime Core — Agent Lifecycle & Tool-Call Dispatch

**Goal:** The runtime can spawn agents, manage LLM conversations with suspend/resume, handle the tool-call dispatch pattern, and serve git operations via MCP.

### 2.1 Agent interface
- `src/v2/agents/types.ts` — Base `Agent` interface:
  ```
  interface Agent {
    type: AgentType;
    id: string;
    run(context: AgentContext): Promise<AgentResult>;
  }
  ```
  - `AgentContext` carries: project paths, LLM client, tool access, task/stage info.
  - `AgentResult`: success/failure/escalation with payload (returned to parent as tool result).

### 2.2 Tool-call dispatch
- `src/v2/runtime/dispatch.ts` — Implements the nested tool-call pattern:
  - When an LLM agent calls `run_manager()`, `run_coder()`, `run_researcher()`, or `run_inspector()`, the runtime:
    1. Suspends the calling agent’s LLM conversation.
    2. Spawns the child agent.
    3. Runs the child to completion.
    4. Returns the child’s result as the tool-call response.
    5. Resumes the parent’s LLM conversation.
  - Supports **parallel tool calls**: Manager can issue `run_coder()` + `run_researcher()` simultaneously. Both run concurrently; parent resumes when both return.

### 2.3 Conversation management
- `src/v2/runtime/conversation.ts` — Manages LLM conversation state:
  - Suspend: save conversation messages, pending tool calls.
  - Resume: restore conversation, inject tool results (+ any queued notes).
  - **Context compaction**: when conversation exceeds a token threshold, summarize and compact. Write disk state (`plan.json`, etc.) as authoritative fallback.

### 2.4 MCP git server
- `src/v2/mcp/git-server.ts` — MCP server that serializes all git operations:
  - `git_commit(files, message, task_id)` — stages specified files, commits with `[task-<id>] <message>`. Returns SHA or conflict error.
  - `git_status()` — returns working tree status.
  - `git_diff(files?)` — returns diff.
  - `git_log(n?)` — returns recent history.
  - Serialization is inherent — MCP processes one request at a time, so no locking needed.
  - On conflict: returns error (not throw). Calling agent reports failure in `TaskReport`.

### 2.5 Plan MCP service
- `src/v2/mcp/plan-server.ts` — MCP server for structured plan operations (see 03-PLAN-MCP-SERVICE.md):
  - All reads/writes to `plan.json` and `plan-history.json` go through this service.
  - Tools: `plan_get`, `plan_get_stage`, `plan_get_current_stage`, `plan_set_stages`, `plan_add_stage`, `plan_remove_stage`, `plan_set_current`, `plan_complete_stage`, `plan_get_history`, `plan_init`.
  - Validates Stage schema on every write.
  - Atomic writes (`.tmp` + rename).
  - `plan_complete_stage` is the key atomic operation: removes stage from active plan, appends to history, clears `current_stage_id` if matching.
  - Built on top of the document store from Phase 1.

### 2.6 Crash recovery
- `src/v2/runtime/recovery.ts`:
  - On startup: read `runtime.json`, detect stale PID.
  - Call `plan_get()` + `plan_get_history()` via the plan MCP service to reconstruct state.
  - Reset in-progress tasks to pending.
  - Restart Planner as fresh conversation (disk files are authoritative).

### 2.7 Abort mechanism
- `src/v2/runtime/abort.ts`:
  - Monitors for urgent notes (notes with `urgent: true`).
  - On urgent note: signals abort to the active agent chain.
  - Abort propagates bottom-up: terminates lowest-level agent, synthesizes abort result for parent, cascades up to Planner.
  - Manager writes partial `StageSummary` with `result: "aborted"` on abort.
  - Uncommitted changes from aborted agents are discarded.

### 2.8 Context compaction
- `src/v2/runtime/compaction.ts`:
  - Tracks token usage per active conversation.
  - When usage exceeds configurable threshold (default: 80% of context window), triggers compaction.
  - Compaction: produces summary message replacing conversation history.
  - Summary includes: agent role, current objective, key decisions, outstanding work, state references.
  - Applies to Planner and Manager (long-lived agents). One-shot agents (Coder, Researcher, Inspector) do not need compaction.

### 2.9 Periodic self-check
- `src/v2/runtime/self-check.ts`:
  - After every N tool calls (configurable: Manager=20, workers=15), injects self-check prompt.
  - Self-check asks the agent to assess whether it is making progress or stuck in a loop.
  - If agent reports stuck, runtime treats it as task failure.
  - Model throttling / transient errors retry automatically at transport level, do not count toward self-check counter.

### 2.10 Tests
- Unit tests for tool-call dispatch (spawn child, suspend parent, return result).
- Unit tests for parallel dispatch (Coder + Researcher concurrent).
- Unit tests for conversation suspend/resume.
- Unit tests for MCP git server (serialization, conflict detection, commit scoping).
- Unit tests for plan MCP service (CRUD, atomic complete_stage, validation).
- Unit tests for crash recovery (stale state, task reset).
- Unit tests for abort mechanism (agent chain termination, partial summary).
- Unit tests for context compaction (trigger threshold, summary generation).
- Unit tests for periodic self-check (injection timing, stuck detection).

**Deliverable:** The nested tool-call pattern works. Parent agents suspend while children run.

---

## Phase 3: LLM Integration — Agent Base Class

**Goal:** A base class that any agent extends. Handles LLM calls, tool execution, context assembly (including skill loading).

### 3.1 Agent base
- `src/v2/agents/base.ts`:
  - Wraps LLM provider calls (reuse `src/providers/` from v1).
  - Assembles context: system prompt + task description + skills + reference documents.
  - Manages tool calls via existing MCP runtime (reuse `src/mcp/` from v1).
  - Handles conversation loop (multi-turn until agent produces a final result).
  - Stash mechanism for large outputs (carry from v1's `src/agents/stash.ts`).

### 3.2 Skill loader
- `src/v2/skills/loader.ts`:
  - Reads `skills/index.json`.
  - Matches triggers against agent metadata (task description, tool list, file paths, tags, agent type).
  - Filters by `target_agents` (if specified in skill entry).
  - Ranks and selects top N skills.
  - Returns skill content for injection into agent context.
  - Applies to **all agent types**, not just workers.
  - Reuse/adapt `src/skills/` from v1.

### 3.3 Conventions & access model
- `src/v2/agents/conventions.ts`:
  - All agents (except Chat) have full read/write/execute access. Chat is read-only for project state.
  - Defines per-agent-type **conventions** (advisory, not enforced):
    - Coder: works on project code, commits own changes + task report.
    - Researcher: writes under `research/`, commits own files + task report.
    - Inspector: scratch in `tmp/inspector-workspace/`, reports in `inspections/`, persistent tools in `tools/inspector/`.
    - Planner/Manager: commit `.saivage/` state files (plan, tasks, summaries).
  - Convention violations are logged as warnings, not blocked. Agents coordinate via conventions to avoid collisions.
  - Git operations go through the MCP git server, which serializes access and prevents conflicts.

### 3.4 Tests
- Integration test: agent base can call LLM, execute tools, produce result.
- Unit test: skill matching logic.
- Unit test: convention violation detection/logging.

**Deliverable:** Any agent can be built by extending base + defining its prompt and permissions.

---

## Phase 4: Worker Agents — Coder & Researcher

**Goal:** Both worker agents execute tasks, write reports, commit code.

### 4.1 Coder agent
- `src/v2/agents/coder.ts`:
  - System prompt: coding role, checklist-aware, self-assessment.
  - Tools: filesystem (read/write project code), shell (run commands/tests), git (commit own files), web (read docs).
  - On completion: writes `TaskReport` JSON, commits modified files.
  - On failure: writes `TaskReport` with `status: "failed"` and `failure_reason`.

### 4.2 Researcher agent
- `src/v2/agents/researcher.ts`:
  - System prompt: research role, cannot modify project code.
  - Tools: filesystem (read all, write `research/` only), web search/fetch, shell (read-only commands), git (commit `research/`).
  - On completion: writes `TaskReport`, commits research files.

### 4.3 Tests
- Integration test: Coder executes a simple coding task, writes report, commits.
- Integration test: Researcher fetches info, writes to `research/`, commits.
- Permission test: Researcher cannot write to project code.

**Deliverable:** Both workers can independently execute tasks and produce reports.

---

## Phase 5: Manager Agent

**Goal:** Manager decomposes stages into tasks, dispatches to workers, handles results, writes summaries.

### 5.1 Manager agent
- `src/v2/agents/manager.ts`:
  - Receives stage description from plan (passed by Planner’s `run_manager()` tool call).
  - Reads referenced documents.
  - Generates `TaskList` JSON (task decomposition via LLM).
  - Dispatch loop (within its LLM conversation):
    1. Find next dispatchable tasks (pending, dependencies met).
    2. Call `run_coder(task)` and/or `run_researcher(task)` as tool calls.
       - Independent tasks: parallel tool calls (both run concurrently).
       - Dependent tasks: sequential tool calls.
    3. Process tool results (`TaskReport`).
    4. Update task statuses in `tasks.json`.
    5. On failure: decide retry (increment attempt, **modify task description** with failure context), create remediation task, or escalate. Model throttling and transient errors are retried automatically at the runtime level and do not count as task failures.
    6. Repeat until all tasks done or escalation.
  - On completion: write `StageSummary`, return it to Planner.
  - On escalation: write `StageSummary` with `result: "escalated"`, return it to Planner.

### 5.2 Manager ↔ worker integration
- Manager calls `run_coder()` / `run_researcher()` as LLM tool calls → runtime dispatches child agents.
- Manager’s LLM conversation suspends while children run, resumes with `TaskReport` as tool result.
- Manager maintains full conversation context for the stage (remembers planning rationale, earlier results).

### 5.3 Skill generation
- When Manager detects a reusable pattern (heuristic: task description mentions "create tool/utility/helper"), schedule a follow-up task for skill creation.

### 5.4 Tests
- Unit test: task decomposition produces valid `TaskList`.
- Integration test: full stage execution (Manager → Coder → report → summary).
- Test: failure handling (retry, escalation).

**Deliverable:** Complete stage execution loop works end-to-end.

---

## Phase 6: Planner Agent

**Goal:** Planner generates and maintains the plan, processes events, dispatches Inspector.

### 6.1 Planner agent
- `src/v2/agents/planner.ts`:
  - **Long-lived LLM conversation** — persists for the entire project run.
  - **Initial plan generation**: reads project objectives + current project state → calls `plan_init(stages)` or `plan_set_stages()` via the plan MCP service.
  - **Stage execution**: calls `run_manager(stage)` as a tool call. Suspends while Manager runs. Resumes with `StageSummary` as tool result.
  - **Stage completion handler**: calls `plan_complete_stage()` to atomically move stage to history. Then updates remaining stages via `plan_set_stages()` if the plan needs revision.
  - **Abort handler**: receives `StageSummary` with `result: "aborted"` when an urgent user note triggers abort. Processes the urgent note and replans.
  - **Escalation handler**: processes escalated summary, decides action (revise stage, split, remove, schedule retrospective via Inspector). Uses `plan_add_stage()`, `plan_remove_stage()`, `plan_set_stages()` as needed.
  - **Inspector dispatch**: calls `run_inspector(request)` as a tool call for deep analysis.
  - **Note processing**: on resume, reads pending notes injected into context. Marks permanent if needed, incorporates into plan reasoning, deletes volatile notes.
  - **Context compaction**: when conversation grows too large, summarizes and compacts. Plan state is reconstructed via `plan_get()` + `plan_get_history()` (authoritative source).

### 6.2 Inspector agent
- `src/v2/agents/inspector.ts`:
  - Invoked as tool call by Planner or Chat.
  - Receives `InspectionRequest` as tool parameters.
  - Three storage tiers: ephemeral scratch (`tmp/inspector-workspace/`), persistent reports (`inspections/`), persistent tools (`tools/inspector/`).
  - Can create scripts, run analysis, read/execute any project file.
  - Writes `InspectionReport` JSON to `inspections/`.
  - Promotes reusable tools from scratch to `tools/inspector/`.
  - Returns report as tool result to caller.
  - One-shot: terminates after returning.

### 6.3 Planner ↔ runtime integration
- Planner is the top-level agent — started by bootstrap, runs for project lifetime.
- All other agents are children invoked via tool calls.
- On crash: Planner restarts as fresh conversation, reconstructs context via `plan_get()` + `plan_get_history()` from the plan MCP service.

### 6.4 Tests
- Unit test: plan generation from objectives.
- Unit test: stage completion → plan update + history append.
- Unit test: escalation → retrospective scheduling.
- Integration test: Planner → Manager → Coder → report → Planner cycle.

**Deliverable:** Full autonomous loop: Plan → Stage → Tasks → Reports → Plan update.

---

## Phase 7: Chat Agent & Notifications

**Goal:** User can query status, create notes, request inspections, receive push notifications.

### 7.1 Chat agent
- `src/v2/agents/chat.ts`:
  - System prompt: knows project state, can read all documents.
  - Tools: read plan/stages/tasks/reports/inspections, create notes, dispatch Inspector.
  - Persists dialogue to `tmp/chats/<channel>/<session-id>.json`.
  - One instance per channel.
  - Does not block execution pipeline.

### 7.2 Notification system
- `src/v2/events/notifier.ts`:
  - Subscribes to runtime events (stage complete, failure, escalation, inspector done).
  - Pushes to active chat channels.
  - Telegram: push messages via bot API.
  - Web: push via WebSocket.
  - Respects user's notification filter config.

### 7.3 Channel integration
- Adapt v1 channels (`src/channels/telegram.ts`, `src/channels/websocket.ts`) to v2 Chat agent.
- Chat log persistence.

### 7.4 Tests
- Integration test: Chat can read plan, create note, dispatch Inspector.
- Test: notification delivery on stage completion.
- Test: notification filtering.

**Deliverable:** Users can interact with the running system and receive updates.

---

## Phase 8: Main Entry Point & CLI

**Goal:** Single entry point to start/stop the system, init projects, manage config.

### 8.1 Server bootstrap
- `src/v2/server/bootstrap.ts`:
  1. Load global config.
  2. Discover/load project.
  3. Run crash recovery.
  4. Start chat channels (web, telegram).
  5. Start execution loop (Planner → Manager → workers).
  6. Handle graceful shutdown (write runtime state, complete current task).

### 8.2 CLI commands
- `init <project-path>` — initialize `.saivage/` in a project.
- `start <project-path>` — start the execution loop.
- `status <project-path>` — show current plan, stage, tasks.
- `note <project-path> <message>` — create a user note directly.
- `inspect <project-path> <scope>` — dispatch Inspector from CLI.
- Carry over: `login`, `config`, `models` from v1.

### 8.3 Tests
- Integration test: full bootstrap → plan → stage → task → report cycle.
- Test: graceful shutdown and restart.

**Deliverable:** Saivage v2 is fully operational from CLI.

---

## Phase 9: Web UI & Polish

**Goal:** Web interface works with v2, system is production-ready.

### 9.1 Web interface adaptation
- Update web UI to display v2 plan/stages/tasks (different from v1 orchestrator state).
- Show plan timeline, task progress, agent status.
- Chat via WebSocket.

### 9.2 Telemetry
- Adapt `src/telemetry/` to track v2 metrics: stages completed, tasks per stage, failure rate, LLM token usage per agent type.

### 9.3 Documentation
- Generated `README.md` with setup instructions.
- Operator guide: how to configure projects, manage providers, customize notification filters.

**Deliverable:** Production-ready v2 with web UI and documentation.

---

## Reuse Map (v1 → v2)

| v1 Module | v2 Status | Notes |
|-----------|-----------|-------|
| `src/providers/` | **Keep as-is** | LLM router, all providers (copilot, anthropic, ollama, llamacpp, openai-codex) |
| `src/auth/` | **Keep as-is** | Auth flows for all providers |
| `src/mcp/` | **Keep as-is** | MCP client, runtime, builtins, registry |
| `src/channels/` | **Adapt** | Telegram, WebSocket, CLI channels — wire to v2 Chat agent |
| `src/services/` | **Keep most** | filesystem, shell, git, web, lock, memory services |
| `src/skills/` | **Adapt** | Loader/resolver → v2 trigger-based matching |
| `src/generator/` | **Keep as-is** | MCP server generator |
| `src/server/` | **Replace** | New bootstrap for v2 execution model |
| `src/orchestrator/` | **Delete** | Entirely replaced by v2 Planner/Manager/Runtime |
| `src/agents/` | **Replace** | New role-based agents, keep stash mechanism |
| `src/watchdog/` | **Replace** | Replaced by v2 crash recovery |
| `src/config.ts` | **Adapt** | Split into global + project config |
| `src/log.ts` | **Keep as-is** | Logging |

---

## Dependency Graph

```
Phase 1 (Data Layer)
    │
    ▼
Phase 2 (Runtime Core) ◄── Phase 3 (LLM / Agent Base)
    │                           │
    ▼                           ▼
Phase 4 (Coder + Researcher)
    │
    ▼
Phase 5 (Manager)
    │
    ▼
Phase 6 (Planner + Inspector)
    │
    ▼
Phase 7 (Chat + Notifications)
    │
    ▼
Phase 8 (Entry Point + CLI)
    │
    ▼
Phase 9 (Web UI + Polish)
```

Phases 2 and 3 can be worked on in parallel. Everything else is sequential.

---

## Migration Strategy

1. All v2 code goes under `src/v2/` initially, alongside v1 code.
2. Shared modules (`providers/`, `mcp/`, `auth/`, `services/`) stay at current paths — both v1 and v2 import them.
3. Once v2 is functional, delete `src/orchestrator/`, old `src/agents/`, `src/watchdog/`.
4. Move v2 code out of `src/v2/` to top level.
5. Update `src/index.ts` to use v2 bootstrap.

This allows v1 to remain runnable during development for reference/comparison.
