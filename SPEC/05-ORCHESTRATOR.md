# Saivage — Orchestrator (Central Agent)

## 1. Purpose

The Orchestrator is the **autonomous core** of Saivage. It runs as a **daemon**, headless and independent of any user session. It maintains a live TODO state, dispatches sub-agents to do work, and reacts to events — all asynchronously.

The Orchestrator does **not** talk to users directly. Instead, it exposes its capabilities through an **Orchestrator MCP service** — an internal MCP server with tools for querying state, manipulating TODOs, dispatching agents, and subscribing to events. Chat agents (and anything else) interact with it by calling these tools.

The Saivage process exposes an **HTTP + WebSocket API** through which external clients (Vue web app, Telegram bots, CLI, custom integrations) connect. Each client connection spawns a **chat session** — an autonomous Chat sub-agent that talks to the user and uses the Orchestrator MCP to coordinate work.

## 2. Core Responsibilities

| Responsibility | Description |
|---|---|
| **Run as daemon** | Start, run headless, expose HTTP/WS API for client connections |
| **Maintain state** | Keep a TODO list of goals/tasks, their status, assigned workers, and dependencies |
| **Expose Orchestrator MCP** | Provide tools for state queries, TODO manipulation, agent dispatch |
| **Dispatch work** | Start sub-agents asynchronously and react to their completion/failure events |
| **Direct sub-agents** | Send follow-up instructions, redirect, or cancel agents mid-task |
| **Spawn sub-orchestrators** | For complex goals, create child orchestrators that manage their own TODO/agent tree |
| **React to events** | All logic is event-driven — no polling, no blocking waits |

## 3. Orchestrator MCP Service

The Orchestrator exposes an **internal MCP service** registered as `orchestrator`. Chat agents (and potentially other agents) use it like any other MCP tool. This is the single interface for interacting with the Orchestrator's brain.

### 3.1 Tools

```typescript
const orchestratorMcpTools = [
  // ── State queries ──
  {
    name: "orch.get_todos",
    description: "Get full TODO list with status, assignments, and dependencies",
    params: { filter?: TodoStatus[] }           // Optional status filter
  },
  {
    name: "orch.get_agents",
    description: "Get all active agents with their current status and progress",
    params: {}
  },
  {
    name: "orch.get_state",
    description: "Get full orchestrator state: TODOs + agents + child orchestrators",
    params: {}
  },

  // ── Work submission (primary interface for chat agents) ──
  {
    name: "orch.submit_work",
    description: "Submit a work request. The orchestrator plans, schedules, and dispatches.",
    params: { goal, priority?, context?, project?: "target" | "self" }
  },
  {
    name: "orch.update_work",
    description: "Modify a pending or in-flight work item",
    params: { workId, updates }
  },
  {
    name: "orch.cancel_work",
    description: "Cancel a work item and release its resources",
    params: { workId, reason }
  },

  // ── Event subscription ──
  {
    name: "orch.subscribe",
    description: "Subscribe to orchestrator events. Returns a stream of events via MCP notifications.",
    params: { eventTypes?: string[] }           // Filter by type, or all
  },
];
```

### 3.2 Why an MCP Service?

- **Reuse:** Chat agents already know how to call MCP tools (ReAct loop). No special integration needed.
- **Decoupling:** The Orchestrator doesn't know or care about chat sessions. It just processes MCP calls.
- **Composability:** Any agent (not just Chat) can query or manipulate orchestrator state.
- **Extensibility:** Future clients or integrations can call the same MCP tools.
- **Consistency:** One interface, one protocol, same for all consumers.

### 3.3 Internal vs. External

The Orchestrator MCP runs **in-process** (no child process spawn) — it's a direct function call through the MCP protocol adapter. Externally, the HTTP/WS API proxies these tools for non-agent clients.

## 4. Orchestrator State

The Orchestrator maintains a **persistent, structured state** that tracks all work in progress. This state is the orchestrator's "working memory" — it is injected into every LLM evaluation call so the model knows exactly what is going on.

### 4.1 State Structure

```typescript
interface OrchestratorState {
  id: string;                              // Orchestrator instance ID
  parentId?: string;                       // If this is a sub-orchestrator
  goal?: string;                           // High-level goal (if executing a plan)
  conversationId: string;
  todos: TodoItem[];
  activeAgents: AgentHandle[];
  childOrchestrators: ChildOrchestratorHandle[];
  createdAt: Date;
  lastEventAt: Date;
}

interface TodoItem {
  id: string;
  title: string;                           // Short description
  description: string;                     // Detailed task description
  status: TodoStatus;
  priority: "critical" | "high" | "normal" | "low";
  project: "target" | "self";             // Which codebase this work targets
  assignee?: AgentAssignment;              // Who is working on this
  dependsOn: string[];                     // IDs of todos that must complete first
  result?: string;                         // Summary of outcome
  artifacts?: Artifact[];                  // Files / data produced
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

type TodoStatus =
  | "pending"          // Not yet started, waiting for dependencies or assignment
  | "blocked"          // Dependencies not met, or resource unavailable
  | "assigned"         // Agent has been dispatched (async, waiting for event)
  | "in-progress"      // Agent is actively working (progress events received)
  | "needs-input"      // Agent or orchestrator needs user clarification
  | "completed"        // Done successfully
  | "failed"           // Failed after retries
  | "cancelled";       // Abandoned

interface AgentAssignment {
  agentId: string;
  agentType: string;                       // "coder", "researcher", "sub-orchestrator", ...
  model: string;
  assignedAt: Date;
  lastProgressAt?: Date;
  lastProgressMessage?: string;
}
```

### 4.2 State Persistence

The state is persisted to `~/.saivage/state/{orchestrator_id}.json` after every mutation. On crash recovery, the Orchestrator can resume from persisted state.

### 4.3 State in LLM Context

Every time the Orchestrator calls the LLM to make a decision, the current state is injected as a structured block:

```
## Current State

### TODO List
| # | Title | Status | Assignee | Notes |
|---|-------|--------|----------|-------|
| 1 | Research finance APIs | ✅ completed | researcher-a7f | Found Plaid, Teller, MX |
| 2 | Design data model | 🔄 in-progress | coder-b3e | Writing schema... |
| 3 | Build Plaid connector | ⏳ pending | — | Blocked on #1 → now ready |
| 4 | Implement core logic | ⏳ pending | — | Blocked on #2, #3 |
| 5 | Run tests | ⏳ pending | — | Blocked on #4 |

### Active Agents
- coder-b3e: working on TODO #2, last progress 12s ago: "Creating TypeScript interfaces"

### Child Orchestrators
(none)
```

This gives the LLM full visibility into what is happening so it can make informed decisions about what to do next.

## 5. Event Loop

```typescript
class Orchestrator {
  private eventBus: EventBus;
  private state: OrchestratorState;
  private model: ModelClient;
  private mcpService: OrchestratorMcpService;

  async run(): Promise<void> {
    // Restore state if resuming
    this.state = await this.loadOrCreateState();

    // Register the Orchestrator MCP service (in-process)
    this.mcpService = new OrchestratorMcpService(this.state, this.eventBus);
    await this.mcpService.register();

    // Process events
    while (this.running) {
      const event = await this.eventBus.next();
      this.state.lastEventAt = new Date();

      // Update state based on event
      this.applyEvent(event);

      // Ask LLM what to do next
      const decisions = await this.evaluate(event);

      // Execute decisions
      for (const decision of decisions) {
        await this.executeDecision(decision);
      }

      // Persist state
      await this.persistState();
    }
  }
}
```

### 5.1 Event Handling — `applyEvent`

Before calling the LLM, the Orchestrator mechanically updates its state based on the event type:

| Event | State Mutation |
|---|---|
| `user:message` | Append to conversation |
| `agent:completed` | Mark TODO as `completed`, record result, release agent |
| `agent:failed` | Mark TODO as `failed`, record error, release agent |
| `agent:progress` | Update `lastProgressAt` and `lastProgressMessage` on TODO |
| `agent:blocked` | Mark TODO as `needs-input` or `blocked`, record reason |
| `orchestrator:completed` | Mark child orchestrator's TODO as `completed` |
| `orchestrator:failed` | Mark child orchestrator's TODO as `failed` |
| `service:registered` | Add to tool index |
| `timer:fire` | Inject timer context |

### 5.2 Decision Making — `evaluate`

After state update, the LLM is called with the full context:

```typescript
async evaluate(event: Event): Promise<Decision[]> {
  const response = await this.model.chat({
    system: this.buildSystemPrompt(),
    messages: [
      ...this.conversation,
      { role: "user", content: this.formatEvent(event) },
    ],
    tools: this.metaTools,  // Orchestrator's own tools (see §7)
  });

  return this.parseDecisions(response);
}
```

The LLM can return **multiple decisions** per event (e.g., respond to user + start next task + dispatch another agent).

## 6. Event Types

| Event | Source | Payload |
|---|---|---|
| `user:message` | Chat session (via Orchestrator MCP) | `{ sessionId, text, attachments? }` |
| `agent:completed` | Sub-agent | `{ agentId, todoId, output, artifacts }` |
| `agent:failed` | Sub-agent | `{ agentId, todoId, error }` |
| `agent:progress` | Sub-agent | `{ agentId, todoId, step, description }` |
| `agent:blocked` | Sub-agent | `{ agentId, todoId, reason }` |
| `orchestrator:completed` | Child orchestrator | `{ orchestratorId, todoId, result }` |
| `orchestrator:failed` | Child orchestrator | `{ orchestratorId, todoId, error }` |
| `service:registered` | MCP Generator | `{ serviceName, tools[] }` |
| `service:unhealthy` | MCP Runtime | `{ serviceName, error }` |
| `timer:fire` | Scheduler | `{ timerId, context }` |

## 7. Orchestrator Internal Decision Tools

When the Orchestrator's LLM evaluates an event, it has access to **internal decision tools** (not the MCP tools — those are for external callers). These are the tools the LLM uses in its event loop:

```typescript
const internalTools = [
  // TODO management
  {
    name: "todo_add",
    description: "Add a new TODO item to the work list",
    params: { title, description, priority, dependsOn? }
  },
  {
    name: "todo_update",
    description: "Update a TODO item (status, description, priority)",
    params: { todoId, updates }
  },
  {
    name: "todo_cancel",
    description: "Cancel a TODO item and release its agent",
    params: { todoId, reason }
  },

  // Agent dispatch (all async — returns immediately, results come as events)
  {
    name: "dispatch_agent",
    description: "Start a sub-agent on a TODO item. Returns immediately. Agent result arrives as an event.",
    params: { todoId, agentType, prompt, skills?, model?, context? }
  },
  {
    name: "message_agent",
    description: "Send a follow-up message to an active agent, redirecting or refining its work",
    params: { agentId, message }
  },
  {
    name: "cancel_agent",
    description: "Cancel an active agent's work",
    params: { agentId, reason }
  },

  // Sub-orchestrator dispatch
  {
    name: "dispatch_orchestrator",
    description: "Spawn a sub-orchestrator for a complex multi-step goal. Returns immediately.",
    params: { todoId, goal, context?, model? }
  },

  // Branch management
  {
    name: "create_branch",
    description: "Create a feature branch for a work item (saivage/<todo-id>-<slug>)",
    params: { todoId, slug, baseRef? }
  },
  {
    name: "merge_branch",
    description: "Merge a completed work item's branch back to main",
    params: { todoId, strategy? }
  },

  // Notification (broadcasts to all subscribed chat sessions via event bus)
  {
    name: "broadcast",
    description: "Broadcast a notification to all connected chat sessions",
    params: { text }
  },
];
```

Note: The Orchestrator no longer has `respond_to_user` or `ask_user` tools. Chat sessions interact with the user autonomously. The Orchestrator communicates with the world via its MCP service and event bus.

## 8. Async Dispatch Flow

```
Orchestrator                    Sub-Agent
    │                               │
    │  dispatch_agent(todoId,       │
    │    agentType, prompt)         │
    │──────────────────────────────▶│
    │                               │  (runs agent loop independently)
    │  ◀──── agent:progress ────────│  (optional progress updates)
    │  ◀──── agent:progress ────────│
    │                               │
    │  (orchestrator processes      │
    │   other events meanwhile)     │
    │                               │
    │  ◀──── agent:completed ───────│  (or agent:failed / agent:blocked)
    │                               │
    │  evaluate(event) → decide     │
    │  what to do next              │
    ▼                               ▼
```

Multiple agents run concurrently. The Orchestrator processes their events as they arrive, interleaved with user messages and other events.

## 9. Sub-Orchestrators

For complex, multi-step goals, the Orchestrator can spawn a **child orchestrator** instead of a simple sub-agent. A sub-orchestrator is a full Orchestrator instance with its own:

- TODO list
- Agent pool
- Event loop
- LLM context

### 9.1 When to Use Sub-Orchestrators

| Use Sub-Agent | Use Sub-Orchestrator |
|---|---|
| Single focused task | Multi-step project with dependencies |
| 1–30 tool calls | Dozens of tasks across multiple agents |
| "Write this function" | "Build a complete REST API" |
| "Research this topic" | "Plan and execute a migration" |

### 9.2 Sub-Orchestrator Lifecycle

```
Parent Orchestrator
    │
    │  dispatch_orchestrator(todoId, goal, context)
    │──────────────────────────────▶  Child Orchestrator
    │                                      │
    │                                      ├── creates its own TODOs
    │                                      ├── dispatches its own agents
    │                                      ├── manages its own state
    │                                      │
    │  ◀──── orchestrator:progress ────────│  (summary updates)
    │                                      │
    │  (parent processes other             │
    │   events meanwhile)                  │
    │                                      │
    │  ◀──── orchestrator:completed ───────│  (final result + artifacts)
    │
    │  evaluate(event) → next step
    ▼
```

### 9.3 Sub-Orchestrator Communication

The child orchestrator **does not talk to the user directly**. It reports to the parent:

```typescript
interface ChildOrchestratorHandle {
  orchestratorId: string;
  todoId: string;                          // Which parent TODO this serves
  goal: string;
  status: "running" | "completed" | "failed";
  todoCount: number;                       // How many sub-tasks it has
  completedCount: number;                  // How many are done
  lastProgressSummary?: string;
}
```

The parent orchestrator can:
- **Monitor:** See progress summaries.
- **Redirect:** Send `message_orchestrator` to change the goal or add constraints.
- **Cancel:** Kill the child and all its agents.
- **Escalate:** If the child reports `needs-input`, the parent either answers from its own context or escalates to the user.

### 9.4 Nesting Depth

Sub-orchestrators can spawn their own sub-orchestrators (recursive). A configurable depth limit (default: 3) prevents infinite nesting.

## 10. Directing Active Agents

The Orchestrator can **interact with running agents**, not just dispatch and forget:

### 10.1 Follow-Up Messages

```typescript
// Orchestrator decides to redirect an agent based on new user input
{
  name: "message_agent",
  params: {
    agentId: "coder-b3e",
    message: "The user changed their mind — use PostgreSQL instead of SQLite for the data model"
  }
}
```

The message is injected into the agent's conversation as a new user message, causing it to re-evaluate and adjust its approach.

### 10.2 Agent Status Queries

The Orchestrator can inspect agents without LLM involvement via state:
- Which tool call is the agent currently executing?
- How many iterations has it spent?
- What was its last progress message?
- How much has it cost so far?

### 10.3 Cancellation

```typescript
// Agent is taking too long or going in the wrong direction
{
  name: "cancel_agent",
  params: {
    agentId: "researcher-c9a",
    reason: "User provided the information directly, research no longer needed"
  }
}
```

The agent receives a cancellation signal, stops its loop, and emits `agent:failed` with `reason: "cancelled"`.

## 11. Conversation Management

### 11.1 The Orchestrator's Context

The Orchestrator does **not** maintain a conversation with users -- chat agents handle that. The Orchestrator's LLM context contains:

1. **System prompt** -- role, internal decision tools, rules.
2. **Current state** -- TODO list, active agents, child orchestrators (injected fresh each turn).
3. **Event history** -- recent events (work requests, agent completions/failures) as the conversation.

### 11.2 Context Window Management

- Sub-agent full transcripts are **never** injected into the Orchestrator's context — only their final result summaries.
- The TODO list + active agents block is re-rendered each turn (not accumulated).
- When conversation exceeds 80% of context window, older messages are **compacted** (summarised).

### 11.3 Persistence

- Conversations: `~/.saivage/conversations/{id}.jsonl`
- State snapshots: `~/.saivage/state/{orchestrator_id}.json`
- Sub-agent transcripts: `~/.saivage/agents/{agent_id}.jsonl`
- Resume: `saivage --resume <conversation_id>`

## 12. System Prompt Structure

```
You are Saivage, an autonomous AI orchestrator.

You manage work by maintaining a TODO list and dispatching sub-agents.
You NEVER execute tools directly — you delegate to specialised agents.
All dispatch is asynchronous — agents run independently and report back via events.
You do NOT talk to users. Chat sessions handle user interaction and call your MCP tools.

## Your Tools
{internal_tools}

## Current State
{rendered_todo_list}
{active_agents}
{child_orchestrators}

## Available Sub-Agent Types
{sub_agent_registry}

## Available MCP Tools (for reference when writing agent prompts)
{tool_summary}

## Available Skills
{skill_index}

## Rules
- React to events by updating TODOs and dispatching/directing agents.
- When you receive an agent:completed event, update the TODO and check if dependent tasks can start.
- For complex goals (>3 steps with dependencies), spawn a sub-orchestrator.
- For simple tasks, dispatch a sub-agent directly.
- Always keep chat sessions informed via broadcast when significant state changes occur.
- Show TODO status when asked via the orchestrator MCP.
- If an agent fails, decide: retry, try different approach, or broadcast a question.
- If you need user input, broadcast a question to chat sessions — never guess.

## Self-Modification Rules
- When a worker reports tool_missing, create a self-project work item to generate the tool.
- All self-modifications (project: "self") MUST go through sandbox validation before merge.
- For core module changes (orchestrator, event bus, runtime), spawn a secondary instance for testing.
- After sandbox validation passes, perform hot-replacement, then merge the self-branch.
- The watchdog monitors your health after core self-modifications — signal it before restarting.
```

## 13. Autonomous Behaviour

Saivage runs in a confined environment where all actions are allowed. The Orchestrator is **fully autonomous** — it never pauses for approval or permission.

The Orchestrator acts autonomously when:

1. **Processing event cascade:** Agent completes → unblocks next TODO → dispatch next agent — no user involvement needed.
2. **Error recovery:** Agent fails → retry or re-assign with different approach.
3. **Plan progression:** Working through a multi-step plan.

The Orchestrator **broadcasts notifications** (via `broadcast`) only when:
- An agent reports `needs-input` and the Orchestrator cannot resolve it from context.
- The plan has genuinely ambiguous requirements that need clarification.

Chat sessions receive these broadcasts and decide how to present them to their connected user.

## 14. Error Handling

| Error | Orchestrator Behaviour |
|---|---|
| Agent completed | Update TODO, check if dependent tasks unblock, dispatch next |
| Agent failed | Mark TODO failed, evaluate: retry (different model?), re-plan, or ask user |
| Agent blocked (missing tool) | Dispatch Coder to generate MCP service (project: "self"), then retry |
| Agent blocked (needs input) | Broadcast question to connected chat sessions |
| Agent timeout | Cancel agent, try with different approach or escalate |
| Child orchestrator fails | Mark parent TODO failed, summarise child's state, decide next |
| LLM API error | Failover to next provider |
| All providers down | Broadcast error to chat sessions, pause event processing |

## 15. Self-Modification Handling

When the Orchestrator creates work items with `project: "self"`, special
handling applies. The Orchestrator calls `sandbox.*` and `versions.*` tools
**directly** (not via a delegated agent) — these are infrastructure services
on par with `orch.*` and `index.*`, part of the orchestrator's coordination
role rather than work execution.

### 15.1 Dual-Project Routing

```typescript
// Orchestrator determines working directory and branch namespace based on project field
const workingDir = todo.project === "self"
  ? saivageRepoRoot        // Saivage's own source tree
  : targetProjectRoot;      // The user's project

const branchPrefix = todo.project === "self"
  ? "saivage/self-"
  : "saivage/";

const lockNamespace = todo.project === "self"
  ? "self:"
  : "target:";
```

### 15.2 Post-Completion: Sandbox Gate

When a self-modification work item completes (agent emits `agent:completed`),
the Orchestrator does **not** merge immediately. Instead:

1. Call `sandbox.start` — spawn the candidate in an isolated process.
2. Call `sandbox.run_tests` — execute tests and contract checks.
3. Call `sandbox.check_compat` — verify tool schemas haven't broken.
4. **If all pass:** `sandbox.promote` → MCP Runtime hot-replaces the live
   component → merge the self-branch.
5. **If any fail:** `sandbox.destroy` → mark the TODO as `failed` → retry or
   ask the user.

### 15.3 Core Module Changes (Graceful Restart)

For changes to core modules (orchestrator internals, event bus, runtime),
the sandbox gate includes a secondary Saivage instance. A self-modification
is classified as "core" if it modifies files under `src/orchestrator/`,
`src/mcp/runtime.ts`, `src/agents/base.ts`, or `src/server/` — the
orchestrator determines this by inspecting the branch diff before sandbox.

1. `sandbox.spawn_instance` — boot a full Saivage from the modified branch.
2. `sandbox.test_instance` — run the smoke-test suite against it.
3. **If pass:** persist state, quiesce agents, signal the watchdog, restart.
4. **If fail:** destroy secondary instance, mark TODO failed.

### 15.4 Parallel Self + Target Work

The `project` field and separate lock namespaces (`target:*` vs `self:*`)
allow the Orchestrator to run self-modification work items in parallel with
target-project work. Neither blocks the other unless they share a dependency.
