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

## Phase 2: Runtime Core — Agent Lifecycle & Concurrency

**Goal:** The runtime can spawn, suspend, resume, and terminate agents. Hierarchical blocking works. Git lock is managed.

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
  - `AgentResult`: success/failure/escalation with payload.

### 2.2 Runtime scheduler
- `src/v2/runtime/scheduler.ts` — Manages agent lifecycle:
  - Tracks active agents (mirrors `RuntimeState`).
  - Enforces concurrency limits (1 per type, except chat).
  - Implements hierarchical blocking:
    - Planner starts → suspend Manager/Coder/Researcher.
    - Manager starts (planning phase) → suspend Coder/Researcher.
    - Manager dispatches → resume Coder/Researcher.
  - Inspector FIFO queue management.
  - Writes `runtime.json` on every state change (crash recovery).

### 2.3 Git lock
- `src/v2/runtime/gitlock.ts` — Serialized git operations:
  - `acquireGitLock(agentId) → Promise<void>` (waits if held).
  - `releaseGitLock(agentId)`.
  - `commitFiles(agentId, files, message)` — add + commit specific files only.
  - On conflict detection → return error (not throw), escalate to Manager.

### 2.4 Crash recovery
- `src/v2/runtime/recovery.ts`:
  - On startup: read `runtime.json`, detect stale PID, reset in-progress tasks to pending, respawn Manager for current stage.

### 2.5 Tests
- Unit tests for scheduler (concurrency enforcement, suspend/resume).
- Unit tests for git lock (serialization, conflict detection).
- Unit tests for recovery (stale state, task reset).

**Deliverable:** Agents can be spawned/suspended/terminated. Crash recovery works.

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
  - Matches triggers against task metadata.
  - Ranks and selects top N skills.
  - Returns skill content for injection into agent context.
  - Reuse/adapt `src/skills/` from v1.

### 3.3 Tool permissions
- `src/v2/agents/permissions.ts`:
  - Defines per-agent-type file access rules:
    - Coder: read all, write project code, commit own files.
    - Researcher: read all, write only `research/`, commit own files.
    - Inspector: read all, write only `inspector-workspace/` (+ granted paths), commit own tools.
  - Wraps filesystem/git tools with permission checks.

### 3.4 Tests
- Integration test: agent base can call LLM, execute tools, produce result.
- Unit test: skill matching logic.
- Unit test: permission enforcement.

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
  - Receives stage description from plan.
  - Reads referenced documents.
  - Generates `TaskList` JSON (task decomposition via LLM).
  - Dispatch loop:
    1. Find next dispatchable tasks (pending, dependencies met).
    2. Dispatch up to 1 Coder + 1 Researcher in parallel.
    3. Wait for reports.
    4. Update task statuses.
    5. On failure: decide retry (increment attempt) vs remediation task vs escalation.
    6. Repeat until all tasks done or escalation.
  - On completion: write `StageSummary`.
  - On escalation: write `StageSummary` with `result: "escalated"`, terminate.

### 5.2 Task dispatch integration
- Wire Manager ↔ Scheduler: Manager requests agent spawn, Scheduler enforces concurrency.
- Manager is suspended while Coder/Researcher run, wakes on report.

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
  - **Initial plan generation**: reads project objectives + current project state → produces `Plan` JSON.
  - **Stage completion handler**: receives `StageSummary`, moves stage to `PlanHistory`, updates plan, picks next stage.
  - **Escalation handler**: receives escalated `StageSummary`, decides action (revise stage, split, remove, schedule retrospective).
  - **Note processing**: reads pending notes, marks permanent if needed, incorporates into plan reasoning, deletes volatile notes after replan.
  - **Retrospective scheduling**: on escalation or repeated failures, inserts a retrospective stage (Inspector analysis) before next work stage.

### 6.2 Inspector agent
- `src/v2/agents/inspector.ts`:
  - Receives `InspectionRequest`.
  - Works in `tmp/inspector-workspace/`.
  - Can create scripts, run analysis, read project code/data.
  - Writes `InspectionReport` JSON.
  - One-shot: terminates after writing report.

### 6.3 Planner ↔ runtime integration
- Planner activation triggers hierarchical suspension (Manager + workers pause).
- After Planner finishes, runtime spawns Manager for next stage.

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
