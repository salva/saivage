# Saivage -- Multi-Agent Architecture

Derived from [01-FUNCTIONAL-ANALYSIS.md](01-FUNCTIONAL-ANALYSIS.md). This
document describes the agent roles, their relationships, the services they
share, and the runtime topology.

---

## 1. Design Principles

These follow from the functional analysis:

| Principle | Implication |
|---|---|
| **Single authority** | The Orchestrator is the sole coordinator. No peer-to-peer agent communication. |
| **All mutations are tracked** | Every state change (file write, command, git op) goes through a work item. |
| **Read is free, write is coordinated** | Chat agents answer read-only questions directly. All writes go through the orchestrator and the locking protocol. |
| **Branch isolation** | Code changes happen on git feature branches. Merges are orchestrator-managed. |
| **Priority-driven scheduling** | Interactive requests preempt background work. A scheduler manages the queue. |
| **Everything is searchable** | Conversations, agent transcripts, and work history are indexed and queryable. |
| **Dual-project operation** | Saivage works on two codebases at once: the target project and itself. Self-modifications go through sandboxing and versioned hot-replacement. |
| **Everything is versioned** | Every replaceable component (MCP services, agent configs, skills, core modules) is versioned. Any change can be rolled back. |

---

## 2. Agent Roles

```
                        +--------------------+
                        |   Chat Agent (x N) |   one per client session
                        |   conversational   |   read-only queries + work submission
                        +---------+----------+
                                  |
                    submits work / queries state
                                  |
                                  v
                        +--------------------+
                        |   Orchestrator     |   single instance, headless daemon
                        |   (central brain)  |   plans, prioritises, dispatches, merges
                        +---------+----------+
                                  |
                    dispatches work items (async)
                                  |
              +-------------------+-------------------+
              |                   |                   |
              v                   v                   v
     +---------------+  +---------------+  +------------------+
     |  Coder Agent  |  | Researcher    |  | Executor Agent   |
     |               |  | Agent         |  |                  |
     +---------------+  +---------------+  +------------------+
              |                   |                   |
              +-------------------+-------------------+
                                  |
                          uses MCP tools
                                  |
              +-------------------+-------------------+
              |         |         |         |         |
              v         v         v         v         v
          filesystem   shell     git      lock     index    ... (MCP services)
```

### 2.1 Chat Agent

**What it is:** A conversational LLM agent. One instance per connected client.

**What it does:**
- Parses user intent.
- Answers questions about system state by querying `orch.*` and `index.*` tools (read-only).
- Submits work requests to the orchestrator via `orch.submit_work`.
- Receives event notifications and relays them to the user.
- Searches conversation history across sessions via `index.search`.

**What it does NOT do:**
- Write files, run commands, or make git commits.
- Dispatch other agents.
- Directly interact with worker agents.

**Why this scope?** If chat agents could mutate state, they would bypass the
orchestrator's locking, scheduling, and branch isolation guarantees. The
orchestrator must be the single point of coordination (FA F4.3).

**Tools available:**
- `orch.get_state`, `orch.get_todos`, `orch.get_agents` (read-only queries).
- `orch.submit_work` (submit a work request for the orchestrator to plan/execute).
- `orch.cancel_work`, `orch.update_work` (modify pending/in-flight work items).
- `orch.subscribe` (receive live event stream).
- `index.search` (search conversations and work history).
- `memory.recall` (query long-term memory).
- `filesystem.read_file`, `filesystem.list_dir`, `filesystem.search` (read-only FS
  queries -- these don't need locking).

### 2.2 Orchestrator

**What it is:** A single, headless LLM agent that runs as a daemon.

**What it does:**
- Receives work requests from chat agents (via `orch.submit_work` MCP calls).
- Plans: breaks complex goals into work items with dependencies (using Planner sub-calls or its own LLM).
- Prioritises: orders work queue by priority level and user activity.
- Schedules: decides when to start each work item based on concurrency limits, dependencies, and priority.
- Creates git branches for code-modification tasks.
- Dispatches worker agents to execute work items.
- Monitors agents: redirects, cancels, retries on failure.
- Merges branches on task completion. Dispatches conflict resolution if needed.
- Broadcasts significant events to all subscribed chat sessions.

**What it does NOT do:**
- Execute tools directly (it delegates to worker agents).
- Talk to users directly (chat agents handle presentation).

**Internal decision tools** (used by the orchestrator's LLM in its event loop):
- `todo_add`, `todo_update`, `todo_cancel` -- manage work items.
- `dispatch_agent` -- assign a worker agent to a work item.
- `message_agent`, `cancel_agent` -- interact with running agents.
- `dispatch_orchestrator` -- spawn a sub-orchestrator for complex goals.
- `create_branch`, `merge_branch` -- git branch lifecycle.
- `broadcast` -- push notification to all chat sessions.

**Infrastructure service tools** (called directly by the orchestrator, not delegated):
- `sandbox.*` -- validate self-modifications before promotion.
- `versions.*` -- query and rollback component versions.

### 2.3 Worker Agents (Coder, Researcher, Executor, Custom)

**What they are:** Specialised LLM agents that execute individual work items.

**What they do:**
- Receive a task assignment (prompt, context, skill set, artifacts, branch name).
- Checkout the assigned git branch (for code tasks).
- Run a ReAct loop: reason, call tools, observe, iterate.
- Acquire resource locks before writes via `lock.acquire`.
- Commit work to the assigned branch.
- Report back: progress, completion (with artifacts), failure, or blocked.

**What they do NOT do:**
- Talk to users.
- Dispatch other agents.
- Merge branches.
- Work on any branch other than the one assigned to them.

**Tools available:** `filesystem.*`, `shell.*`, `git.*` (limited to assigned
branch), `lock.*`, `web.*`, `memory.*`, `generator.*`, `index.search`.

### 2.4 Planner (Sub-Role of Orchestrator)

The orchestrator can invoke planning as a sub-task: tear off the goal
decomposition to a Planner agent that returns a structured plan (work items
with dependencies). The orchestrator then imports the plan into its TODO list.

Alternatively, for simpler goals the orchestrator plans inline using its own
LLM context.

### 2.5 Sub-Orchestrators

For complex multi-phase projects, the orchestrator spawns a **child
orchestrator** -- a full orchestrator instance with its own TODO list and agent
pool. The child reports to the parent via events.

This creates a tree of coordinators. Example: "Build me a SaaS" might spawn
sub-orchestrators for "Backend API", "Frontend", "Infrastructure", each
managing their own work items and agents independently.

---

## 3. Infrastructure Services (MCP)

These are always-on MCP services that provide shared capabilities to all agents.

### 3.1 Orchestrator MCP (`orch.*`)

Exposes orchestrator state and commands. Used by chat agents and potentially
by admin tools.

| Tool | Access | Description |
|---|---|---|
| `orch.get_state` | read | Full state: TODOs + agents + sub-orchestrators |
| `orch.get_todos` | read | TODO list with optional status filter |
| `orch.get_agents` | read | Active agents and their progress |
| `orch.submit_work` | write | Submit a work request (goal + priority + context + optional project) |
| `orch.update_work` | write | Modify a pending work item |
| `orch.cancel_work` | write | Cancel a work item |
| `orch.subscribe` | stream | Live event stream |

Note: `submit_work` is the primary interface for chat agents. Unlike the
previous design where chat agents could directly call `dispatch_agent`, now
the chat agent just says "I need this done" and the orchestrator decides how.

### 3.2 Index Service (`index.*`)

Full-text and semantic search over all conversations and work history.

| Tool | Description |
|---|---|
| `index.search` | Search conversations, agent transcripts, and artifacts by query |
| `index.search_conversations` | Search only chat conversations (with session filtering) |
| `index.search_work` | Search only agent work transcripts and outputs |
| `index.ingest` | Index a new document (called automatically by the system) |

**Implementation:** SQLite FTS5 for full-text, with optional embedding-based
semantic search (local model or API). Index is stored in
`~/.saivage/index.db`.

**What gets indexed:**
- Every chat message (user and agent), tagged with session ID.
- Every agent work transcript, tagged with work item ID.
- Work item descriptions, plans, and completion summaries.
- Artifacts (text files, markdown docs) produced by agents.

### 3.3 Lock Service (`lock.*`)

Advisory resource locking to prevent agent collisions.

| Tool | Description |
|---|---|
| `lock.acquire` | Acquire a lock (shared or exclusive) on a resource path |
| `lock.release` | Release a held lock |
| `lock.list` | List all currently held locks |
| `lock.check` | Check if a resource is locked (and by whom) |

**Semantics:**
- Locks are advisory (the filesystem isn't actually locked -- agents cooperate).
- Resources are identified by path (files, dirs) or abstract name.
- Shared (read) locks: multiple holders allowed.
- Exclusive (write) locks: one holder at a time. Blocks other exclusive requests.
- TTL: locks auto-expire after `lock.defaultTtlMs` (default 300s) to prevent deadlocks.
- Locks record: holder agent ID, work item ID, acquired time, TTL.
- **Namespaces:** `target:*` for target-project resources, `self:*` for
  self-project resources. Locks in different namespaces never conflict,
  allowing parallel self-modification and target work.

**Implementation:** In-process (SQLite or in-memory map). No need for Redis
or distributed locking -- single machine.

### 3.4 Git Service (`git.*`)

Branch management for parallel agent work.

| Tool | Description |
|---|---|
| `git.create_branch` | Create a feature branch from a base ref |
| `git.checkout` | Switch to a branch (within an agent's work dir) |
| `git.commit` | Stage and commit changes with a message |
| `git.merge` | Merge a branch into the target (usually main) |
| `git.diff` | Show diff between branches |
| `git.status` | Show working tree status |
| `git.delete_branch` | Clean up after merge |
| `git.resolve_conflicts` | Assist with merge conflict resolution |

**Branch naming:**
- Target project: `saivage/<todo-id>-<slug>` (e.g. `saivage/todo-3-api-routes`).
- Self-project: `saivage/self-<todo-id>-<slug>` (e.g. `saivage/self-todo-50-docker`).

The Git Service operates on two working directories depending on the work
item's `project` field: the target project root or the Saivage source root.

**Merge strategy:** Orchestrator merges completed branches sequentially into
the main branch. If a conflict arises, it dispatches a Coder agent with the
conflict markers and relevant context to resolve it. Self-project merges only
happen after sandbox validation passes.

### 3.5 Memory Service (`memory.*`)

Long-term persistent storage for facts, preferences, patterns.

| Tool | Description |
|---|---|
| `memory.store` | Store a fact with tags |
| `memory.recall` | Query stored facts by semantic similarity or tags |
| `memory.list` | List recent entries |
| `memory.delete` | Remove an entry |

### 3.6 Standard Services

These are the tool-providing MCP services for actual work:

- `filesystem.*` -- Read/write/search files.
- `shell.*` -- Run commands, manage processes.
- `web.*` -- Fetch and parse web pages.
- `generator.*` -- MCP service generation pipeline.

### 3.7 Sandbox Service (`sandbox.*`)

Isolated environment for testing self-modifications before promotion.

| Tool | Description |
|---|---|
| `sandbox.start` | Spawn a candidate component in an isolated process |
| `sandbox.run_tests` | Execute test suite + contract tests against the sandbox |
| `sandbox.smoke_test` | Send representative tool calls and verify responses |
| `sandbox.check_compat` | Compare sandbox tool schemas against live registry |
| `sandbox.promote` | Approve the candidate; triggers hot-replacement via runtime |
| `sandbox.destroy` | Tear down the sandbox process |
| `sandbox.spawn_instance` | Spawn a secondary Saivage instance for core module testing |
| `sandbox.test_instance` | Run smoke-test suite against the secondary instance |

**Lifecycle:**

```
  candidate code (branch)
          │
    sandbox.start
          │
          ▼
  ┌──────────────────┐
  │  sandbox process  │  isolated, not connected to live system
  │  (MCP service)    │
  └────────┬─────────┘
           │
  sandbox.run_tests + sandbox.smoke_test + sandbox.check_compat
           │
      pass │        fail
      ┌────┴────┐
      ▼         ▼
  sandbox.    sandbox.destroy
  promote     (report failure)
      │
      ▼
  runtime hot-replaces live service
```

### 3.8 Version Store Service (`versions.*`)

Manages the version history of all replaceable components.

| Tool | Description |
|---|---|
| `versions.list` | List versions of a component |
| `versions.get` | Retrieve a specific version's metadata and path |
| `versions.rollback` | Restore a previous version (triggers hot-replacement) |
| `versions.prune` | Remove old versions beyond the retention limit |

**Storage:** `~/.saivage/versions/{component-type}/{name}/v{semver}/`

Components are stored as complete snapshots (not diffs) so any version can
be started independently without reconstruction.

---

## 4. Runtime Topology

```
+-----------------------------------------------------------------------+
|  Saivage Process (Node.js)                                            |
|                                                                       |
|  +------------------+                                                 |
|  | HTTP + WS Server |  <-- clients connect here                      |
|  +--------+---------+                                                 |
|           |                                                           |
|           v                                                           |
|  +------------------+         +-----------------------------------+   |
|  | Session Manager  |-------->| Chat Agent 1 (WebSocket session)  |   |
|  |                  |-------->| Chat Agent 2 (CLI session)        |   |
|  |                  |-------->| Chat Agent N ...                  |   |
|  +------------------+         +----------------+------------------+   |
|                                                |                      |
|                                   orch.submit_work / orch.get_state   |
|                                                |                      |
|                                                v                      |
|  +------------------------------------------------------------+      |
|  |  Orchestrator                                               |      |
|  |  +----------+  +-----------+  +-----------+  +-----------+ |      |
|  |  | TODO     |  | Scheduler |  | Branch    |  | Event     | |      |
|  |  | State    |  |           |  | Manager   |  | Bus       | |      |
|  |  +----------+  +-----------+  +-----------+  +-----------+ |      |
|  +--------------------------+----------------------------------+      |
|                             |                                         |
|                dispatch     |  (async, fire-and-forget)               |
|                             |                                         |
|         +-------------------+-------------------+                     |
|         v                   v                   v                     |
|  +------------+     +------------+     +-------------+                |
|  | Coder      |     | Researcher |     | Executor    |                |
|  | (branch X) |     |            |     |             |                |
|  +------+-----+     +------+-----+     +------+------+               |
|         |                  |                   |                       |
|         +------------------+-------------------+                      |
|                            |                                          |
|                     MCP Tool Calls                                    |
|                            |                                          |
|  +----+-----+----+-----+--+--+-----+-----+----+-----+               |
|  |filesystem| shell | git   | lock  | index | memory |  web | gen    |
|  +----------+-------+-------+-------+-------+--------+------+-----+  |
|                                                                       |
|  +-------------------------------------------------------------------+|
|  |  Sandbox Service        | Version Store                           ||
|  |  (isolated processes)   | (~/.saivage/versions/)                  ||
|  +-------------------------------------------------------------------+|
|                                                                       |
|  +-------------------------------------------------------------------+|
|  |  Model Provider Layer                                              ||
|  |  Anthropic | OpenAI | Google | Ollama | OpenRouter                 ||
|  +-------------------------------------------------------------------+|
+-----------------------------------------------------------------------+

+-----------------------------------------------------------------------+
|  Watchdog Process (separate, minimal)                                 |
|  Monitors orchestrator health. Auto-rollback on self-modification     |
|  failure. No LLM, no MCP — just health checks and shell commands.     |
+-----------------------------------------------------------------------+
```

---

## 5. Interaction Flows

### 5.1 User Asks a Question (Read-Only)

```
User (browser) --WS--> Chat Agent
Chat Agent: reads file / queries orch.get_state / calls index.search
Chat Agent: formats answer
Chat Agent --WS--> User
```

No work item. No orchestrator involvement. Fast.

### 5.2 User Requests Simple Work

```
User: "Create a .gitignore with Node.js defaults"
Chat Agent: calls orch.submit_work({ goal: "Create .gitignore ...", priority: "P0" })
Orchestrator: creates work item, fast-tracks it
Orchestrator: creates branch saivage/todo-7-gitignore
Orchestrator: dispatches Coder agent to that branch
Coder: acquires lock on .gitignore, writes file, commits, releases lock
Coder: emits agent:completed
Orchestrator: merges branch to main, marks work item completed
Chat Agent: receives event, tells user "Done -- .gitignore created"
```

### 5.3 User Requests Complex Project

```
User: "Build me a REST API for a finance tracker"
Chat Agent: calls orch.submit_work({ goal: "Build REST API ...", priority: "P1" })
Orchestrator: invokes Planner -> produces 5 work items with dependencies:
  1. Research finance APIs       (no deps)
  2. Design data model           (depends on 1)
  3. Build API routes            (depends on 2)
  4. Write tests                 (depends on 3)
  5. Generate OpenAPI docs       (depends on 3)

Orchestrator: creates branches for items 1-5
Orchestrator: dispatches Researcher for item 1
  ... item 1 completes ...
Orchestrator: merges branch, dispatches Coder for item 2
  ... item 2 completes ...
Orchestrator: merges, dispatches Coder for items 3 (items 4, 5 wait)
  ... item 3 completes ...
Orchestrator: merges, dispatches Coder for items 4 and 5 in parallel
  (on separate branches, no lock conflicts since different files)
  ... items 4, 5 complete ...
Orchestrator: merges both branches (sequentially), marks all done

Chat Agent: pushes live status updates at each step
```

### 5.4 Cross-Session Query

```
User (Tab B): "What was decided about the database in the other tab?"
Chat Agent B: calls index.search_conversations({ query: "database decision" })
Index: returns matching messages from Tab A's conversation
Chat Agent B: summarises and responds
```

### 5.5 Agent Conflict + Locking

```
Orchestrator dispatches Coder-A on branch todo-3 and Coder-B on branch todo-4.
Both need to modify package.json:

Coder-A: lock.acquire("package.json", "exclusive") -> OK
Coder-A: modifies package.json, commits to todo-3, lock.release

Coder-B: lock.acquire("package.json", "exclusive") -> OK (lock freed)
Coder-B: modifies package.json, commits to todo-4, lock.release

Orchestrator: merges todo-3 -> main (clean)
Orchestrator: merges todo-4 -> main (CONFLICT in package.json)
Orchestrator: dispatches Coder-C to resolve conflict on a merge branch
Coder-C: resolves, commits
Orchestrator: completes merge
```

### 5.6 Idle Scheduling

```
Orchestrator has P1 and P3 work queued.
User is active (last message 10s ago) -> P1 work runs, P3 paused.
User goes idle (no message for 5 minutes) -> Scheduler promotes P3 work.
User returns (new message) -> P3 work continues but new P0 response is prioritised.
```

### 5.7 Self-Modification (MCP Service Hot-Replacement)

```
Worker agent: "I need docker.* tools but they don't exist"
Worker agent: emits agent:blocked { reason: "missing_tool", detail: "docker.*" }

Orchestrator: creates work item { project: "self", goal: "Generate docker MCP service" }
Orchestrator: creates branch saivage/self-todo-50-docker in Saivage repo
Orchestrator: dispatches Coder to implement the service

Coder: writes code, tests on the self-branch
Coder: emits agent:completed

Orchestrator: calls sandbox.start (spins up new service in isolated process)
Orchestrator: calls sandbox.run_tests (contract tests + service tests)
Orchestrator: calls sandbox.check_compat (no conflicts -- new service)
Orchestrator: calls sandbox.promote

Runtime: registers docker service, starts live process
Runtime: health check passes

Orchestrator: merges self-branch to Saivage main
Orchestrator: unblocks the original target-project work item
Worker agent: retries, now has docker.* tools
```

### 5.8 Core Module Self-Modification (Graceful Restart)

```
Orchestrator: creates work item { project: "self", goal: "Modify merge strategy" }
Orchestrator: creates branch saivage/self-todo-55-merge in Saivage repo
Orchestrator: dispatches Coder

Coder: modifies src/orchestrator/branchManager.ts, writes tests
Coder: emits agent:completed

Orchestrator: calls sandbox.spawn_instance (secondary Saivage from modified branch)
Orchestrator: calls sandbox.test_instance (smoke-test suite against secondary)
Tests pass.

Orchestrator: persists all state (TODOs, agent progress, conversations)
Orchestrator: quiesces running agents (wait for in-flight work or checkpoint)
Orchestrator: signals the watchdog to expect a restart
Orchestrator: exits and restarts from the modified code
(Watchdog monitors: if new instance doesn't report healthy within 60s, rollback)

New Orchestrator: loads persisted state, resumes work
New Orchestrator: broadcasts to chat sessions: "Self-update applied. Resuming."
```

---

## 6. Data Flow Summary

| From | To | Channel | Payload |
|---|---|---|---|
| Client | Chat Agent | WebSocket / CLI / Telegram | User messages |
| Chat Agent | Orchestrator | `orch.*` MCP calls | Work requests, state queries |
| Orchestrator | Worker Agent | Task assignment (internal) | Prompt, branch, project, skills, artifacts |
| Worker Agent | MCP Services | MCP tool calls | File ops, shell, git, locks |
| Worker Agent | Orchestrator | Event bus | Progress, completion, failure |
| Orchestrator | Chat Agents | Event bus (broadcast) | State changes, notifications |
| Chat Agent | Client | WebSocket / CLI / Telegram | Responses, status updates |
| Any Agent | Index Service | `index.*` MCP calls | Search queries |
| System | Index Service | Auto-ingest | Conversations, transcripts |
| Orchestrator | Sandbox Service | `sandbox.*` MCP calls | Self-modification validation |
| Sandbox Service | MCP Runtime | Process spawn/compare | Isolated candidate processes |
| Orchestrator | Version Store | `versions.*` MCP calls | Version queries, rollback |
| MCP Runtime | Version Store | Read | Retrieve version snapshots for rollback |

---

## 7. Key Decisions & Rationale

### D1. Chat agents are read-only (no direct mutations)

**Decided:** Chat agents can query state and search, but cannot write files,
run commands, or dispatch agents. All work goes through `orch.submit_work`.

**Rationale:** This is the keystone that enables locking (F4.1), git branch
isolation (F4.2), prioritisation (F1.3), and scheduling (F1.3). If chat agents
could bypass the orchestrator, every one of these guarantees would require a
separate enforcement mechanism. Routing everything through one coordinator is
simpler and more robust.

**Trade-off:** A trivial "create a file" request now takes more hops. Mitigated
by the orchestrator's fast-track path.

### D2. Git branches for code isolation

**Decided:** Every code-modifying work item gets a feature branch. Merges are
orchestrator-managed.

**Rationale:** This is the standard way to isolate parallel code changes. It's
well-understood, debuggable (you can inspect branches), and reversible (delete
a branch to discard bad work). Combined with locks for non-git resources, it
covers all parallel conflict scenarios.

### D3. Single orchestrator (no peer agents)

**Decided:** One orchestrator coordinates all work. Agents never communicate
with each other.

**Rationale:** Peer-to-peer multi-agent systems are notoriously hard to debug
and reason about. A single coordinator is easier to implement, audit, explain,
and fix. Sub-orchestrators provide hierarchy without peer complexity.

### D4. Advisory locking (not filesystem locks)

**Decided:** Locks are cooperative -- agents must check them, but the OS
doesn't enforce them.

**Rationale:** Filesystem locks (flock, lockf) don't span git branches, don't
support abstract resources, and are hard to debug. Advisory locks stored in
SQLite are inspectable, have TTLs, and work across all resource types.

### D5. Conversation indexing as a shared service

**Decided:** All conversations are auto-indexed. Agents query a shared index
rather than having access to each other's conversation objects.

**Rationale:** Direct conversation sharing creates tight coupling and privacy
concerns (even for a single user -- session separation has value). An index
provides controlled, searchable access without exposing raw conversations.

### D6. Scheduler driven by user activity

**Decided:** The scheduler monitors last-message timestamps per session. When
all sessions are idle beyond a threshold, background work is promoted.

**Rationale:** Simple heuristic that doesn't require explicit "I'm going AFK"
signals. A more sophisticated scheduler (time-of-day rules, resource
forecasting) can be added later without architectural changes.

### D7. Dual-project operation (target + self)

**Decided:** The system explicitly manages two project contexts. Every work
item carries a `project` field (`"target"` or `"self"`). Self-modifications
use a separate branch namespace (`saivage/self-*`) and a separate lock
namespace (`self:*`).

**Rationale:** Saivage must be able to extend and repair itself while keeping
the target project's work isolated. Using the same orchestrator, branch
isolation, and locking for both contexts avoids a separate "admin mode" and
reuses all existing coordination machinery. The `project` field routes work
to the correct git repo and lock space without architectural duplication.

**Trade-off:** The orchestrator must be aware of two working directories and
two git repos. Work items that cross contexts (e.g., "I need a new tool to
continue my target work") create inter-project dependencies that the scheduler
must handle.

### D8. Sandbox-then-promote for all self-modifications

**Decided:** Every self-modification (MCP service, agent config, skill, core
module) must pass through a sandbox before going live. The sandbox runs the
candidate in an isolated process, executes tests and contract checks, and only
promotes on success. The runtime supports hot-replacement with automatic
rollback.

**Rationale:** Self-modification of a running system is inherently dangerous.
Without validation, a broken MCP service could make entire tool categories
unavailable, or a broken orchestrator module could halt all work. The sandbox
provides a safety net at acceptable cost (a few seconds per promotion). The
hot-replacement + rollback mechanism limits downtime: if a promoted component
fails in production, the runtime reverts to the previous version within
seconds.

**Components involved:**
- Sandbox Service (§3.7): orchestrates the validation pipeline.
- Version Store (§3.8): keeps rollback targets.
- MCP Runtime (10-MCP-RUNTIME.md): performs the actual process swap.
- Watchdog (a minimal health-check loop): last-resort rollback if the
  orchestrator itself becomes unresponsive after a core self-modification.

---

## 8. Relationship to Existing Specs

This document supersedes the architectural decisions in the previous spec
files. The existing specs should be updated to align:

| Spec | Status |
|---|---|
| [01-FUNCTIONAL-ANALYSIS.md](01-FUNCTIONAL-ANALYSIS.md) | Aligned: F6 expanded with dual-project, versioning, sandbox, hot-replacement. |
| [02-USE-CASES.md](02-USE-CASES.md) | Aligned: Category M (UC-M1 to UC-M12) covers self-modification scenarios. |
| [03-ARCHITECTURE.md](03-ARCHITECTURE.md) | This document. |
| [00-OVERVIEW.md](00-OVERVIEW.md) | Aligned: chat agents read-only, `submit_work`. |
| [04-COMPONENTS.md](04-COMPONENTS.md) | Aligned: sandbox, versions, watchdog modules + config keys. |
| [05-ORCHESTRATOR.md](05-ORCHESTRATOR.md) | Aligned: `project` field on TodoItem, §15 self-modification handling. |
| [06-SUB-AGENTS.md](06-SUB-AGENTS.md) | Aligned: Chat agent narrowed to read-only + work submission. Worker agents have branch/lock tools. |
| [07-SKILLS.md](07-SKILLS.md) | Unchanged. |
| [08-MODEL-PROVIDERS.md](08-MODEL-PROVIDERS.md) | Unchanged. |
| [09-MCP-GENERATOR.md](09-MCP-GENERATOR.md) | Aligned: sandbox validation step (§3.6), version store on register (§3.7), regeneration with versioning (§5). |
| [10-MCP-RUNTIME.md](10-MCP-RUNTIME.md) | Aligned: hot-replacement (§11), watchdog (§12). |
| [11-SECURITY.md](11-SECURITY.md) | Aligned: self-modification safety invariants (§7). |
| [12-USER-INTERACTION.md](12-USER-INTERACTION.md) | Aligned: versions, sandbox, watchdog CLI commands. |
