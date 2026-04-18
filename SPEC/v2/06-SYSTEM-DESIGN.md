# Saivage v2 — System Design

High-level architecture, component structure, data flow, and deployment topology. This document provides the bird's-eye view; detailed specifications live in companion documents.

**Document index:**

| Doc | Contents |
|-----|----------|
| [00-AGENT-SYSTEM.md](00-AGENT-SYSTEM.md) | Agent roles, behaviors, communication protocol, execution model |
| [01-DATA-MODEL.md](01-DATA-MODEL.md) | TypeScript interfaces and JSON schemas for all document types |
| [02-IMPLEMENTATION-PLAN.md](02-IMPLEMENTATION-PLAN.md) | Phased build plan (9 phases, bottom-up) |
| [03-PLAN-MCP-SERVICE.md](03-PLAN-MCP-SERVICE.md) | Full specification for the plan MCP service |
| [04-RUNTIME-DETAILS.md](04-RUNTIME-DETAILS.md) | Suspend/resume, LLM error handling, compaction, self-check, crash recovery |
| [05-MCP-SERVICES.md](05-MCP-SERVICES.md) | Complete MCP service catalog with tool schemas |

---

## 1. System Overview

Saivage v2 is an **autonomous software engineering agent** that takes high-level project objectives and executes them through a hierarchy of specialized LLM agents. It manages its own planning, execution, quality assurance, and user communication — running continuously until the project objectives are met.

```
┌─────────────────────────────────────────────────────────┐
│                     User Interface                       │
│         Telegram Bot  ·  Web UI (WebSocket)              │
└────────────┬──────────────────────┬──────────────────────┘
             │                      │
       ┌─────▼──────┐        ┌─────▼──────┐
       │  Chat Agent │        │  Chat Agent │    (1 per channel)
       │  (Telegram) │        │   (Web UI)  │
       └──────┬──────┘        └──────┬──────┘
              │ create_note()        │ create_note()
              │ run_inspector()      │ run_inspector()
              │                      │
   ┌──────────▼──────────────────────▼───────────────┐
   │                   Runtime Core                    │
   │  ┌──────────────────────────────────────────┐    │
   │  │              Planner Agent                │    │
   │  │  (long-lived · project lifetime)          │    │
   │  │                                           │    │
   │  │  run_manager(stage) ──┐                   │    │
   │  │  run_inspector(req) ──┼──┐                │    │
   │  └───────────────────────┼──┼────────────────┘    │
   │                          │  │                      │
   │  ┌───────────────────────▼──┼────────────────┐    │
   │  │           Manager Agent  │                │    │
   │  │  (long-lived · 1 stage)  │                │    │
   │  │                          │                │    │
   │  │  run_coder(task) ────┐   │                │    │
   │  │  run_researcher(task)┼─┐ │                │    │
   │  └──────────────────────┼─┼─┼────────────────┘    │
   │                         │ │ │                      │
   │  ┌──────────────────┐ ┌─▼─▼─▼──────────────┐     │
   │  │   Coder Agent    │ │  Inspector Agent     │     │
   │  │  (one-shot/task) │ │  (one-shot/request)  │     │
   │  └──────────────────┘ └──────────────────────┘     │
   │  ┌──────────────────┐                              │
   │  │ Researcher Agent │                              │
   │  │  (one-shot/task) │                              │
   │  └──────────────────┘                              │
   └────────────────────────────────────────────────────┘
              │         │         │
    ┌─────────▼─┐ ┌─────▼───┐ ┌──▼──────────┐
    │ MCP       │ │ LLM     │ │ Event Bus   │
    │ Services  │ │ Provider│ │ (in-process) │
    └───────────┘ │ Router  │ └─────────────┘
                  └─────────┘
```

---

## 2. Component Architecture

### 2.1 Process Model

Saivage runs as a **single Node.js process**. All components are in-process:

| Component | Type | Description |
|-----------|------|-------------|
| Runtime Core | singleton | Agent lifecycle, suspend/resume, abort, compaction, self-check |
| Planner Agent | LLM conversation | Long-lived, 1 per project |
| Manager Agent | LLM conversation | Long-lived, 1 per stage |
| Worker Agents | LLM conversations | One-shot, 1 at a time per type |
| Chat Agents | LLM conversations | 1 per channel, independent |
| MCP Runtime | singleton | Service process management |
| Event Bus | singleton | In-process pub/sub for notifications |
| LLM Provider Router | singleton | Model selection, failover, retry |
| Channel Transports | per-channel | Telegram polling, WebSocket server |

MCP services (filesystem, shell, git, web, etc.) run as **child processes** spawned by the MCP Runtime, communicating via stdio. They are started lazily and shut down when idle.

### 2.2 Module Structure

```
src/v2/
├── types.ts                    # All TypeScript interfaces + Zod schemas
├── ids.ts                      # nanoid-based ID generator (stg-, tsk-, note-, insp-, chat-)
│
├── store/
│   ├── documents.ts            # Generic JSON document CRUD (atomic writes)
│   └── project.ts              # Project discovery, init, config loading
│
├── runtime/
│   ├── core.ts                 # Main runtime: agent lifecycle, dispatch loop
│   ├── dispatcher.ts           # Tool-call dispatch: suspend, spawn child, resume
│   ├── abort.ts                # Abort mechanism: urgent note → chain termination
│   ├── compaction.ts           # Context compaction: token tracking, summary generation
│   ├── self-check.ts           # Periodic self-check injection
│   └── recovery.ts             # Crash recovery: stale PID, state reconstruction
│
├── agents/
│   ├── types.ts                # Agent interface, AgentContext, AgentResult
│   ├── base.ts                 # Agent base class: LLM loop, tool execution, context assembly
│   ├── conventions.ts          # Per-agent convention definitions + violation logging
│   ├── planner.ts              # Planner agent
│   ├── manager.ts              # Manager agent
│   ├── coder.ts                # Coder agent
│   ├── researcher.ts           # Researcher agent
│   ├── inspector.ts            # Inspector agent
│   └── chat.ts                 # Chat agent
│
├── skills/
│   └── loader.ts               # Skill matching, ranking, loading into context
│
├── mcp/
│   └── plan-server.ts          # Plan MCP service (new in v2)
│
├── events/
│   └── notifier.ts             # Event bus + notification formatting + delivery
│
├── channels/
│   ├── telegram.ts             # Telegram bot (adapted from v1)
│   └── websocket.ts            # WebSocket server (adapted from v1)
│
└── server/
    └── bootstrap.ts            # CLI entry point, startup sequence
```

### 2.3 Reused v1 Components

| v1 Component | v2 Location | Changes |
|-------------|-------------|---------|
| `src/providers/` | Same | No changes — model router, provider abstractions |
| `src/mcp/client.ts` | Same | No changes — MCP SDK client wrapper |
| `src/mcp/runtime.ts` | Same | No changes — service lifecycle management |
| `src/mcp/registry.ts` | Same | No changes — service registry CRUD |
| `src/mcp/builtins.ts` | Adapted | Remove lock service, add plan service |
| `src/services/filesystem/` | Same | No changes |
| `src/services/shell/` | Same | No changes |
| `src/services/git/` | Adapted | Add explicit file staging, task-id prefix |
| `src/services/web/` | Same | No changes |
| `src/services/skills/` | Adapted | Add `target_agents`, `agent:<type>` trigger |
| `src/services/memory/` | Same | No changes |
| `src/services/index/` | Same | No changes |
| `src/generator/` | Same | No changes — MCP service scaffold |
| `src/channels/telegram.ts` | Adapted | Connect to v2 Chat agent |
| `src/channels/websocket.ts` | Adapted | Connect to v2 Chat agent |
| `src/config.ts` | Adapted | Add v2 ProjectConfig fields |
| `src/log.ts` | Same | No changes |

### 2.4 Removed v1 Components

| v1 Component | Reason |
|-------------|--------|
| `src/orchestrator/` | Replaced by Planner + Manager + runtime dispatcher |
| `src/agents/orchestrator.ts` | Replaced by Planner agent |
| `src/agents/coder.ts` | Rewritten as `src/v2/agents/coder.ts` |
| `src/agents/researcher.ts` | Rewritten as `src/v2/agents/researcher.ts` |
| `src/agents/chat.ts` | Rewritten as `src/v2/agents/chat.ts` |
| `src/services/lock/` | Convention-based territory replaces explicit locking |
| `src/orchestrator/mcpService.ts` | `orch_*` tools replaced by plan MCP + agent dispatch |

---

## 3. Data Flow

### 3.1 Main Execution Flow

```
                        ┌──────────────┐
                        │ Project Init │
                        │  config.json │
                        └──────┬───────┘
                               │
                        ┌──────▼───────┐
                        │   Planner    │
                        │ plan_init()  │
                        └──────┬───────┘
                               │ plan.json created
                               │
               ┌───────────────▼───────────────┐
               │        Stage Loop              │
               │                                │
               │  plan_set_current(stage_id)    │
               │  run_manager(stage) ─────────┐ │
               │                              │ │
               │  ┌───────────────────────────▼─┤
               │  │        Manager              │
               │  │  tasks.json written         │
               │  │                             │
               │  │  ┌──── Task Loop ────┐      │
               │  │  │ run_coder(task)   │      │
               │  │  │ run_researcher()  │      │
               │  │  │     │             │      │
               │  │  │  TaskReport ←─────┘      │
               │  │  │  update tasks.json       │
               │  │  └──────────────────┘       │
               │  │                             │
               │  │  summary.json written       │
               │  │  StageSummary returned ─────┤
               │  └─────────────────────────────┤
               │                                │
               │  plan_complete_stage()         │
               │  plan_set_stages() (if revised)│
               │  plan_commit()                 │
               │  (next stage or done)          │
               └────────────────────────────────┘
```

### 3.2 User Interaction Flow

```
User ──message──► Channel Transport ──► Chat Agent
                                           │
                              ┌────────────┼────────────┐
                              │            │            │
                         status query   direction    inspection
                              │            │            │
                         plan_get()   create_note()  run_inspector()
                              │            │            │
                         ◄─response   note.json      InspectionReport
                                      written         returned
                                           │            │
                                      Planner        Chat formats
                                      resumes        and replies
                                      with note
```

### 3.3 Abort Flow

```
User: "stop everything, change direction"
        │
   Chat: create_note(content, urgent=true)
        │
   Runtime detects urgent note
        │
   ┌────▼────────────────────────┐
   │  Terminate active agents     │
   │  (bottom-up: Coder → Manager)│
   │  git checkout -- .           │
   │  Manager writes partial      │
   │  StageSummary (aborted)      │
   └────┬────────────────────────┘
        │
   Planner resumes with:
   - StageSummary (result: "aborted")
   - Urgent note content
        │
   Planner creates rollback stage
   + new stages for revised direction
        │
   Normal execution resumes
```

### 3.4 Notification Flow

```
Runtime event (stage_completed, task_failed, etc.)
        │
   Event Bus (in-process)
        │
   ┌────▼────────────────┐
   │  Each Chat Agent     │
   │  - check filters     │
   │  - format message    │
   │  - push to channel   │
   └─────────────────────┘
        │
   Channel transport
   (Telegram bot API / WebSocket)
        │
   User receives notification
```

---

## 4. Persistence Architecture

### 4.1 Storage Layers

```
┌────────────────────────────────────────────────────────┐
│                Project Directory                        │
│                                                         │
│  .saivage/                                             │
│  ├── [Git-tracked]                                     │
│  │   ├── config.json          ProjectConfig            │
│  │   ├── plan.json            Active plan (via MCP)    │
│  │   ├── plan-history.json    Completed stages         │
│  │   ├── notes/               User → Planner           │
│  │   ├── stages/              Per-stage artifacts       │
│  │   ├── inspections/         Inspector reports         │
│  │   ├── research/            Researcher output         │
│  │   ├── skills/              Project skills            │
│  │   └── tools/inspector/     Persistent analysis tools │
│  │                                                      │
│  └── [Gitignored]                                      │
│      └── tmp/                                          │
│          ├── state/runtime.json  Crash recovery         │
│          ├── inspector-workspace/ Scratch space         │
│          ├── chats/              Dialogue logs          │
│          └── work/               Agent scratch          │
│                                                         │
├── research/                    Researcher output        │
│   └── <topic>/                 (committed to git)       │
│                                                         │
└── (project source code)        Main codebase            │
└────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────┐
│                Global (~/.saivage/)                      │
│                                                         │
│  config.json        LLM creds, Telegram token           │
│  auth/              Provider auth tokens                │
│  registry.json      MCP service registry                │
│  skills/            User global skills                  │
│  data/                                                  │
│  ├── memory.db      Long-term memory (SQLite)           │
│  └── index.db       Full-text search index (SQLite)     │
└────────────────────────────────────────────────────────┘
```

### 4.2 Data Sovereignty

- **Plan state** is managed exclusively by the Plan MCP service. No agent reads/writes `plan.json` or `plan-history.json` directly.
- **Git operations** are serialized through the Git MCP service. No agent calls `git` CLI directly.
- **Agent conversations** are ephemeral in-memory state. All durable state is on disk. On crash, conversations are lost but the system recovers from disk.
- **The disk is the source of truth.** Conversations are working memory only.

---

## 5. LLM Integration

### 5.1 Provider Router

Reused from v1. Routes LLM calls to configured providers with failover.

```
AgentBase.llmCall(messages)
    │
    ▼
Provider Router
    │
    ├── Primary provider (e.g., "github-copilot")
    │     Model selected by role:
    │     ProjectConfig.model_overrides[role]
    │       > GlobalConfig.providers[name].models[role]
    │         > most capable available
    │
    └── Failover provider (if primary fails 5x in 2min)
          Switch logged, try primary again on next agent
```

### 5.2 Context Assembly

When an agent is invoked, the runtime assembles its initial context:

```
┌──────────────────────────────────────────────┐
│ System Prompt                                 │
│ (from SPEC/v2/prompts/<agent-type>.md)        │
├──────────────────────────────────────────────┤
│ Skills (auto-loaded, max N per agent)         │
│ --- SKILL: git-conventions ---                │
│ <content>                                     │
│ --- SKILL: testing-conventions ---            │
│ <content>                                     │
├──────────────────────────────────────────────┤
│ Task/Stage Context                            │
│ (stage description, task object, references)  │
├──────────────────────────────────────────────┤
│ User Notes (if resuming Planner)              │
├──────────────────────────────────────────────┤
│ Tool Definitions                              │
│ (filesystem, shell, git, web, dispatch, etc.) │
└──────────────────────────────────────────────┘
```

### 5.3 Token Budget

The context window is partitioned (by convention, not enforcement):

| Allocation | % of context | Purpose |
|-----------|-------------|---------|
| System prompt + skills | ~15% | Fixed overhead |
| Task context + references | ~25% | Input material |
| Conversation history | ~40% | Working memory |
| Tool results buffer | ~20% | Space for incoming results |

Compaction triggers at 80% total usage (configurable per agent role). See [04-RUNTIME-DETAILS.md](04-RUNTIME-DETAILS.md) §3.

---

## 6. Concurrency Model

### 6.1 Agent Hierarchy

At any point in time, the active agent tree looks like:

```
[Runtime]
 ├── Planner (suspended, waiting for Manager)
 │    └── Manager (running or suspended)
 │         ├── Coder (running)        ← max 1
 │         └── Researcher (running)   ← max 1
 │
 ├── Chat:telegram (running independently)
 └── Chat:web (running independently)
```

Only **leaf agents** are actively making LLM calls. Parent agents are suspended (their conversation state is held in memory).

### 6.2 Thread Model

Despite concurrent agents, Saivage is **single-threaded** (Node.js event loop). Concurrency comes from:
- **LLM calls** are async I/O — while waiting for one agent's LLM response, another agent's response can arrive.
- **MCP tool calls** are async I/O — child processes communicate via stdio pipes.
- **Channel messages** arrive asynchronously via polling (Telegram) or WebSocket events.

There are **no race conditions** on shared state because:
- Git operations are serialized through the Git MCP (sequential tool calls).
- Plan mutations are serialized through the Plan MCP (sequential tool calls).
- File writes use atomic temp-file + rename.
- Each agent writes to its own territory by convention.

### 6.3 Inspector Contention

The Inspector is serialized (FIFO). If Planner and Chat both request the Inspector, one blocks:

```
Planner: run_inspector(req1) ─► [Inspector runs] ─► report1
Chat:    run_inspector(req2) ─► [queued] ─────────► [Inspector runs] ─► report2
```

Neither caller is aware of the queue — they simply wait for their tool call to return.

---

## 7. Deployment

### 7.1 Topology

```
┌──────────────────────────────────────────┐
│           LXC Container: saivage          │
│           IP: 10.0.3.111                  │
│           Port: 7777                      │
│                                           │
│  ┌─────────────────────────────────────┐  │
│  │     Node.js Process (saivage)       │  │
│  │                                     │  │
│  │  Runtime Core                       │  │
│  │  ├── Agent conversations (in-mem)   │  │
│  │  ├── Event bus (in-mem)             │  │
│  │  ├── WebSocket server (:7777)       │  │
│  │  └── MCP child processes            │  │
│  │       ├── filesystem (stdio)        │  │
│  │       ├── shell (stdio)             │  │
│  │       ├── git (stdio)               │  │
│  │       ├── web (stdio)               │  │
│  │       ├── plan (stdio)              │  │
│  │       ├── skills (stdio)            │  │
│  │       ├── memory (stdio)            │  │
│  │       └── index (stdio)             │  │
│  └─────────────────────────────────────┘  │
│                                           │
│  ~/.saivage/    Global config + data      │
│  /home/salva/<project>/.saivage/  Project │
│                                           │
└──────────────────────────────────────────┘
         │                    │
    Telegram API         LLM Provider APIs
    (outbound)           (outbound)
```

### 7.2 Build & Deploy

```bash
# Build
npm run build          # TypeScript → dist/

# Deploy to container
make -C deploy deploy  # rsync + npm ci + npm run build + systemctl restart

# Service management
ssh saivage "sudo systemctl {start|stop|restart|status} saivage"
ssh saivage "sudo journalctl -u saivage -f"
```

### 7.3 Configuration

**Global** (`~/.saivage/config.json`):
```json
{
  "providers": {
    "github-copilot": {
      "type": "github-copilot",
      "models": { "planner": "claude-opus-4.6", "manager": "claude-sonnet-4", ... },
      "timeout_ms": 120000,
      "failover": "anthropic"
    }
  },
  "telegram": { "bot_token": "...", "user_id": 12345 },
  "auth_dir": "~/.saivage/auth/"
}
```

**Per-project** (`<project>/.saivage/config.json`):
```json
{
  "project_name": "my-project",
  "objectives": ["Build a REST API for user management"],
  "provider": "github-copilot",
  "notifications": {
    "channels": ["telegram"],
    "filters": { "min_severity": "info", "categories": [] }
  },
  "skills": { "max_per_agent": 5 },
  "agents": {
    "planner": { "compaction_threshold_pct": 80, "self_check_frequency": 30 },
    "coder": { "self_check_frequency": 15 }
  }
}
```

---

## 8. Safety & Reliability

### 8.1 Fault Tolerance

| Failure | Recovery |
|---------|----------|
| LLM API timeout/5xx | Exponential backoff, unlimited retries |
| LLM API 400 (bad request) | Agent returns failure to parent |
| LLM provider down | Failover to backup provider |
| MCP service crash | Auto-restart on next tool call |
| Agent infinite loop | Self-check → compaction limit → forced termination |
| Process crash | Disk-based recovery on restart |
| Abort by user | `git checkout -- .`, rollback stage, replan |

### 8.2 Safety Nets (ordered by trigger)

1. **Self-check** (per N tool-call rounds): nudges agent to assess progress.
2. **Context compaction** (at 80% context window): summarize and continue.
3. **Max compactions** (3 per conversation): if compacted 3x with no resolution, terminate agent as stuck.
4. **Task max_attempts** (2-3): Manager escalates or gives up.
5. **Escalation**: Manager → Planner → User notification.
6. **Abort**: user can force-stop and redirect at any time.

### 8.3 Auditability

Every agent action produces a persistent artifact:
- **Planner**: plan.json, plan-history.json (via MCP, committed to git)
- **Manager**: tasks.json, summary.json (committed to git)
- **Workers**: task reports, git commits with task-id prefix
- **Inspector**: inspection reports, persistent tools
- **Chat**: dialogue logs (ephemeral but persistent across sessions)

The git log provides a complete timeline of all changes made by all agents.

---

## 9. Differences from v1

| Aspect | v1 | v2 |
|--------|----|----|
| **Architecture** | Flat orchestrator + agents | Hierarchical: Planner → Manager → Workers |
| **Planning** | Single-level TODO list | Multi-stage plan with history, acceptance criteria |
| **Agent lifecycle** | All one-shot | Mixed: Planner (project), Manager (stage), Workers (task) |
| **Concurrency** | Sequential tasks | 1 Coder + 1 Researcher in parallel |
| **State management** | In-memory + orchestrator | Disk-authoritative, crash-recoverable |
| **Git access** | Direct CLI | MCP-serialized, explicit file staging |
| **User interaction** | Chat reads orchestrator state | Chat reads plan/tasks, creates notes, dispatches Inspector |
| **Error handling** | Agent retries, manual intervention | Multi-level: retry → remediate → escalate → replan → notify |
| **Locking** | Explicit advisory locks | Convention-based territory (no locks) |
| **Quality assurance** | None | Inspector agent with 3-tier storage |
| **Skills** | Workers only | All agents |
| **Plan persistence** | Orchestrator-internal | MCP service with atomic operations |
| **Context management** | None | Compaction + self-check + max compactions |
