# Saivage -- Functional Analysis

This document defines **what** Saivage must do, independent of implementation.
It synthesises all requirements gathered across design sessions and resolves
open questions into concrete decisions.

---

## F1. Task Management

The system accepts goals from users (natural language), decomposes them into
trackable units of work, and drives them to completion.

### F1.1 Work Items

A **work item** (TODO) represents a unit of work with:

- Title, description, acceptance criteria.
- Status: pending, blocked, assigned, in-progress, completed, failed, cancelled.
- Priority: critical > high > normal > low > background.
- Dependencies on other work items.
- Assigned worker (agent ID, branch, artifacts produced).

Work items form a DAG (directed acyclic graph) of dependencies.

### F1.2 Goal Decomposition

When a user submits a complex goal, the system must:

1. **Plan**: Break the goal into ordered work items with dependencies.
2. **Parallelise**: Identify independent items that can run concurrently.
3. **Track**: Monitor all items and their inter-dependencies.
4. **Re-plan**: Adjust the plan when items fail or requirements change.

### F1.3 Prioritisation

Multiple sources submit work concurrently (several chat sessions, background
recovery, scheduled tasks). The system must arbitrate:

| Priority | Source | Behaviour |
|---|---|---|
| **P0 -- Interactive** | Active chat user awaiting a response | Executes immediately; may preempt background work |
| **P1 -- Foreground** | User-initiated complex task | Queued at head; runs ASAP within concurrency limits |
| **P2 -- System** | Error recovery, health checks | Runs when foreground slots are free |
| **P3 -- Background** | Deferred optimisations, self-improvement | Runs only when no higher-priority work is waiting |

A **scheduler** monitors user activity (last message time per session). When
all users are idle for a configurable period, background work resumes.

### F1.4 Work Queue

All work -- whether triggered by a user chat message, by an agent needing a
sub-task, or by the system itself -- enters a **single work queue** managed by
the orchestrator. There is no side-channel for "quick" tasks; the orchestrator
is always in the loop.

The orchestrator can **fast-track** trivial items (e.g., "create a .gitignore")
by assigning them immediately without full planning. But the item is still
logged, tracked, and goes through the locking protocol.

---

## F2. Work Execution

Agents execute work items. An agent is a ReAct loop (LLM + tools) that runs
autonomously until its item is done or it gets stuck.

### F2.1 Capabilities

The system must be able to:

| Capability | Tool domain |
|---|---|
| Read/write/search files | `filesystem.*` |
| Run shell commands | `shell.*` |
| Fetch and parse web pages | `web.*` |
| Search and store long-term memory | `memory.*` |
| Generate new MCP tool services | `generator.*` |
| Manage git branches, commits, merges | `git.*` |
| Acquire/release resource locks | `lock.*` |
| Search conversation/work history | `index.*` |
| Query/manipulate orchestrator state | `orch.*` |

### F2.2 Agent Specialisation

Different tasks require different expertise. The system provides specialised
agent types with tailored system prompts, skill sets, and tool access:

| Agent | Role |
|---|---|
| **Coder** | Write, edit, review, test code |
| **Researcher** | Web search, document analysis, summarisation |
| **Executor** | Run commands, deploy, operate infrastructure |
| **Planner** | Decompose complex goals into plans |
| **Custom** | User-defined agent types (JSON config) |

### F2.3 Parallel Execution

Multiple agents run concurrently on independent work items. Concurrency is
bounded by a configurable limit (default: 5 agents).

### F2.4 Agent Interaction

The system can interact with running agents:

- **Redirect**: Inject a follow-up message changing the agent's direction.
- **Cancel**: Stop a running agent and release its resources.
- **Query**: Inspect agent progress without interrupting it.

---

## F3. User Communication

### F3.1 Multiple Concurrent Sessions

Multiple users (or tabs, or devices) connect simultaneously. Each connection
creates an independent **chat session** with its own conversation context.

### F3.2 Transport Abstraction

Chat sessions are transport-agnostic. Supported transports:

- **WebSocket** (Vue web app) -- primary.
- **CLI** (stdin/stdout) -- secondary.
- **Telegram, Slack, Discord** -- future, pluggable.

Adding a transport requires only implementing a channel adapter.

### F3.3 Conversational Agent

Each session has a dedicated **chat agent** that:

- Understands user intent (natural language).
- Answers questions about system state (read-only queries).
- Submits work requests to the orchestrator on behalf of the user.
- Receives live status updates and relays them to the user proactively.
- Formats and presents results in a human-friendly way.

The chat agent does **not** execute work directly. It is a smart conversational
front-end. All mutations (file writes, commands, git operations) go through the
orchestrator as tracked work items (see F1.4).

> **Rationale:** Routing all mutations through the orchestrator is what enables
> locking (F4.1), prioritisation (F1.3), scheduling (F1.3), git branch
> isolation (F4.2), and cross-session awareness (F5.1). If chat agents could
> write files directly, these guarantees would break.

### F3.4 Cross-Session Awareness

Chat agents can search **other sessions' conversations** via the conversation
index (F5.1). This lets a user in session B ask "what did we discuss in the
other tab about the API design?" and get an answer.

### F3.5 Real-Time Updates

Chat sessions receive push notifications for:

- Work item status changes (started, completed, failed).
- Agent progress (what tool is being called, iteration count).
- System events (service registered, provider failover).
- Broadcasts from the orchestrator (questions, alerts).

The chat agent's LLM decides which events to surface and how to phrase them.

---

## F4. Coordination & Conflict Resolution

When multiple agents work in parallel, they must not step on each other.

### F4.1 Resource Locking

A **locking service** provides advisory locks on resources:

- Individual files.
- Directories (recursive).
- Named abstract resources (e.g., "database-schema").

Before an agent modifies a file, it must acquire a lock. If the lock is held,
the agent waits or reports a conflict to the orchestrator.

Lock semantics:
- **Shared (read)**: Multiple agents can hold simultaneously.
- **Exclusive (write)**: Only one agent at a time.
- **Timeout**: Locks expire after a configurable duration to prevent deadlocks.
- **Owner tracking**: Locks record the agent ID and work item for debugging.

### F4.2 Git Branch Isolation

For code-modification tasks, agents work on **feature branches** rather than
directly on the main branch:

1. Orchestrator creates a branch for a work item (or group of related items):
   `saivage/<todo-id>-<slug>`.
2. The assigned agent works exclusively on that branch.
3. On completion, the orchestrator merges the branch back:
   - Fast-forward if clean.
   - Three-way merge if diverged.
   - On conflict: dispatch a Coder agent to resolve it.
4. Branch is deleted after successful merge.

Benefits:
- Agents cannot corrupt each other's in-progress code.
- Failed tasks can be discarded by deleting the branch.
- Users can review changes before merge (optional, not for v0.1).

### F4.3 Orchestrator as Single Authority

The orchestrator is the **sole coordinator** for all work. There is no
peer-to-peer communication between worker agents. This eliminates race
conditions and makes the system's behaviour deterministic and auditable.

Communication paths:
- Chat agent -> orchestrator: submit work, query state.
- Orchestrator -> worker agent: assign task, redirect, cancel.
- Worker agent -> orchestrator: progress, completion, failure, blocked.
- Worker agents never communicate with each other directly.

---

## F5. Knowledge & Memory

### F5.1 Conversation Index

All conversations (chat sessions and agent work logs) are **indexed** in a
local full-text search engine. Agents can search this index to:

- Find what was discussed about a topic across sessions.
- Retrieve context from a previous task's work log.
- Discover decisions already made.

The index is updated in real-time as conversations progress.

### F5.2 Long-Term Memory

A persistent key-value store for facts, preferences, and learned patterns.
Agents can store and recall entries. Survives across sessions and restarts.

### F5.3 Skills

Structured markdown files (SKILL.md) that teach agents domain-specific
procedures. Loaded into agent context on demand. Can be:

- Built-in (shipped with Saivage).
- User-defined (workspace-local or personal).
- Generated by the system when it learns something reusable.

### F5.4 Work History

Completed work items, their plans, agent transcripts, and artifacts are
preserved and searchable. This serves as institutional memory -- the system
can reference past approaches to similar problems.

---

## F6. Self-Extension & Self-Modification

Saivage operates on **two projects simultaneously**: the **target project**
under development and **itself**. It must be able to modify its own running
components -- MCP services, agent types, skills, even core modules -- while
remaining operational. This requires component versioning and sandbox testing.

### F6.1 Dual-Project Awareness

The system always maintains two working contexts:

| Context | Root | Branch namespace |
|---|---|---|
| **Target project** | The user's working directory | `saivage/<todo-id>-<slug>` |
| **Saivage itself** | The Saivage installation directory | `saivage/self-<todo-id>-<slug>` |

Agents must know which context they are modifying. Work items carry a `project`
field: `"target"` (default) or `"self"`.

### F6.2 MCP Service Generation

When no existing tool can fulfil a task, the system generates a new one:

1. Detect: Agent reports `tool_missing` or orchestrator identifies a gap.
2. Design: Derive the tool's API from the requirement.
3. Implement: Coder agent writes the MCP service (TypeScript).
4. **Sandbox test**: Run the new service in an isolated sandbox process, verify
   it passes tests and doesn't break existing tool contracts.
5. Register: Add to service registry, available immediately.

### F6.3 MCP Service Hot-Replacement

The system can replace a **running** MCP service with a new version:

1. New version is generated/modified on a branch and sandbox-tested.
2. The runtime **drains** in-flight calls to the current version.
3. The old process is stopped, the new version is started.
4. If the new version fails health checks, the runtime **rolls back** to the
   previous version automatically.
5. Both versions are retained in the version store.

### F6.4 Component Versioning

Every replaceable component is versioned:

| Component | Versioning mechanism |
|---|---|
| MCP services (generated) | Semver in `package.json` + version store (`versions/`) |
| MCP services (built-in) | Same as generated -- built-ins are treated identically |
| Agent type configs | Versioned JSON in `~/.saivage/agents/` with backup copies |
| Skills | Semver in frontmatter + `~/.saivage/skills/{name}/.versions/` |
| Core modules (orchestrator, runtime, etc.) | Git history in the Saivage repo itself |

The version store keeps the last N versions (configurable, default 5) of each
component. Any version can be restored via `saivage rollback <component> <version>`.

### F6.5 Sandbox Environment

Before any self-modification goes live, it must pass through a **sandbox**:

1. **Isolated process**: The candidate component runs in a separate process
   with its own stdio/port, not connected to the live system.
2. **Test suite**: Automated tests run against the sandbox. For MCP services,
   this includes the service's own tests plus **contract tests** that verify
   tool schemas and basic input/output behaviour haven't regressed.
3. **Smoke test**: The sandbox service receives a set of representative tool
   calls and must return valid responses within timeout.
4. **Compatibility check**: The sandbox service's tool schemas are compared
   against the currently registered schemas. Breaking changes (removed tools,
   changed required parameters) are flagged and require explicit approval or
   a migration plan.
5. **Promotion**: On success, the orchestrator approves the swap and the
   runtime performs the hot-replacement (F6.3).

For core module changes (orchestrator, agent base class, runtime):
- Changes are made on a `saivage/self-*` branch.
- A **secondary Saivage instance** is spawned from the modified code.
- A smoke-test suite exercises the secondary instance.
- If it passes, the primary instance schedules a **graceful restart** from
  the new code.

### F6.6 Skill Generation

When the system learns a reusable procedure (e.g., "how to interact with the
GitHub API"), it can create a new skill file for future reference.

### F6.7 Custom Agent Types

Users can define new agent types via JSON config files. The system itself can
also generate new agent types. These are versioned and available to the
orchestrator for dispatch.

---

## F7. Multi-Model Intelligence

### F7.1 Provider Abstraction

The system supports multiple LLM providers: Anthropic, OpenAI, Google, Ollama,
OpenRouter, and any OpenAI-compatible endpoint.

### F7.2 Role-Based Assignment

Each agent role can be assigned a different `provider/model` pair. The
orchestrator might use a strong model; the executor might use a cheap fast one.

### F7.3 Failover

If a provider is unavailable, the system falls back to the next provider in a
configured failover chain. This is transparent to agents.

### F7.4 Cost Tracking

Token usage and estimated cost are tracked per agent, per work item, and
system-wide.

---

## F8. Security

### F8.1 Execution Environment

Saivage runs in a **confined environment** where all local actions are allowed
(root access, full network, full filesystem). There are no permission prompts
or approval gates.

### F8.2 Prompt Injection Defence

The only security layer. External content (web pages, API responses, user-
uploaded files) is scanned for injection attempts before being shown to an LLM.
External content is always wrapped in delimiters and tagged with provenance.

### F8.3 Audit Log

All tool calls, agent dispatches, and state mutations are logged to an
append-only audit trail for debugging and accountability.

---

## F9. System Lifecycle

### F9.1 Daemon Mode

The system runs as a long-lived daemon (headless process) with an HTTP/WS API.
It starts, loads state, and processes work indefinitely.

### F9.2 State Persistence

All state (work items, orchestrator context, agent transcripts, conversation
history) is persisted. On crash or restart, the system resumes from the last
known state.

### F9.3 Configuration

A single JSON config file (`~/.saivage/saivage.json`) controls: model
assignments, provider auth, failover chains, concurrency limits, server port,
and feature flags.

---

## Use Cases

See [02-USE-CASES.md](02-USE-CASES.md) for the full catalogue of use cases
(65+ scenarios covering development workflows, user interaction, debugging,
multi-session collaboration, and edge cases).

---

## Constraints

| Constraint | Detail |
|---|---|
| Single-machine | Runs on one host. No distributed systems. |
| Single-user | One user (multiple sessions, but one identity). v0.1 non-goal: multi-tenant. |
| Local-first | No cloud dependency (except LLM API calls). |
| TypeScript | All system code and generated services in TypeScript on Node.js. |
| Confined | All local actions allowed at the OS level. No permission prompts or approval gates. (Self-modification sandboxing in F6.5 is application-level testing, not OS-level restriction.) |

---

## Open Questions (Deferred to v0.2+)

- Cross-machine agent distribution.
- Multi-user identity and permissions.
- Plugin/marketplace for services and skills.
- Code review gates before merge (optional, configurable).
