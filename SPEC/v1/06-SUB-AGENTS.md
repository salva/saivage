# Saivage — Sub-Agents

## 1. Purpose

Sub-agents are **autonomous workers** that execute tasks delegated by an Orchestrator. Each sub-agent operates like a modern coding agent (GitHub Copilot, Cursor, Cline): it has a system prompt, a set of skills, access to tools, and runs its own **ReAct loop** — reasoning with an LLM, calling tools, observing results, and iterating until the task is done.

Sub-agents are spawned **asynchronously**. The orchestrator dispatches them and continues processing other events. The sub-agent reports back via events when it finishes, fails, or needs help.

## 2. The Agent Loop (ReAct)

Every sub-agent runs the same core loop, modelled after how modern AI coding agents work:

```typescript
class SubAgent {
  private config: SubAgentConfig;
  private conversation: Message[];
  private model: ModelClient;
  private eventBus: EventBus;
  private cancelled = false;

  async execute(assignment: TaskAssignment): Promise<void> {
    const systemPrompt = this.buildSystemPrompt(assignment);
    const toolSchemas = this.resolveTools(assignment);

    this.conversation = [
      { role: "user", content: assignment.prompt },
    ];

    // Inject context / artifacts from orchestrator
    if (assignment.context) {
      this.conversation[0].content += `\n\n## Context\n${assignment.context}`;
    }

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (this.cancelled) {
        this.emitFailed(assignment, "cancelled");
        return;
      }

      const response = await this.model.chat({
        system: systemPrompt,
        messages: this.conversation,
        tools: toolSchemas,
      });

      // Text response → task complete
      if (response.type === "text") {
        this.emitCompleted(assignment, response.text);
        return;
      }

      // Tool calls → execute and continue
      for (const toolCall of response.toolCalls) {
        this.emitProgress(assignment, i, `Calling ${toolCall.name}...`);

        const result = await this.dispatchTool(toolCall);
        this.conversation.push(
          { role: "assistant", content: [toolCall] },
          { role: "tool", toolCallId: toolCall.id, content: result },
        );
      }
    }

    this.emitFailed(assignment, "Max iterations exceeded");
  }

  // Handle follow-up messages from orchestrator
  async onMessage(message: string): Promise<void> {
    this.conversation.push({ role: "user", content: message });
    // The next LLM call will see this message and adjust
  }

  onCancel(): void {
    this.cancelled = true;
  }
}
```

### 2.1 How This Matches Modern Coding Agents

| Modern Agent Pattern | Saivage Sub-Agent Equivalent |
|---|---|
| System prompt with role/rules | `config.systemPrompt` + loaded skills |
| Tool definitions (functions) | MCP tool schemas from registry |
| ReAct loop (reason → act → observe) | The `for` loop: LLM call → tool calls → results → next LLM call |
| Context injection (codebase, files) | `assignment.context` + `assignment.artifacts` |
| Skill/instruction files | SKILL.md files loaded into system prompt |
| Progress streaming | `agent:progress` events emitted each iteration |
| Max iterations safety | `config.maxIterations` (default varies by type) |

## 3. Sub-Agent Lifecycle

```
┌──────────┐   dispatch_agent    ┌──────────┐   agent:progress
│  idle    │──────────────────▶│  active  │──────────────────▶ (events to orchestrator)
│(pooled)  │                    │(running  │
└──────────┘                    │  loop)   │
      ▲                         └────┬─────┘
      │                              │
      │    agent:completed           │ agent:failed
      │    agent:failed              │ agent:blocked
      └──────────────────────────────┘
                                (events to orchestrator)
```

1. **Dispatch:** Orchestrator calls `dispatch_agent(todoId, agentType, prompt, ...)` — returns immediately.
2. **Start:** A sub-agent instance is created (or reused from pool), configured with skills, model, and tools.
3. **Run:** The agent loop executes asynchronously. Progress events are emitted.
4. **Interact:** Orchestrator may send follow-up messages (`message_agent`) or cancel (`cancel_agent`) at any time.
5. **Complete:** Agent emits `agent:completed` (or `agent:failed` / `agent:blocked`). Orchestrator processes the event.
6. **Release:** Agent returns to pool or is destroyed.

## 4. Configuration

```typescript
interface SubAgentConfig {
  type: string;                   // "coder", "researcher", "executor", ...
  description: string;            // For the orchestrator's sub-agent registry
  model: string;                  // "anthropic/claude-sonnet-4-20250514"
  systemPrompt: string;           // Role-specific instructions
  skills: string[];               // Default skill names to load
  toolPatterns: string[];         // Glob patterns for allowed MCP tools
  maxIterations: number;          // Max LLM ↔ tool loops
  timeoutMs: number;              // Kill after this duration
  emitProgressEvery: number;      // Emit progress event every N iterations (default: 1)
}
```

## 5. Built-in Sub-Agent Types

### 5.1 Coder

**Role:** Write, edit, review code. Generate new MCP services. Works like GitHub Copilot's coding agent.

| Property | Value |
|---|---|
| Default model | `models.coder` from config |
| Default skills | `coding`, `mcp-authoring` |
| Tool access | `filesystem.*`, `shell.run_command`, `generator.*`, `git.*`, `lock.*`, `index.search` |
| Max iterations | 30 |

**System prompt (abbreviated):**
```
You are a senior software engineer.

You have access to tools for reading/writing files, running commands, and searching code.
Work methodically:
1. Understand the task by reading relevant files.
2. Plan your approach.
3. Implement changes, one file at a time.
4. Run tests or type-checks to verify.
5. If tests fail, read the errors and fix them.

Follow best practices: strong types, error handling, tests.
When creating MCP services, follow the patterns in your loaded skills.

When you are done, provide a summary of all changes made.
```

**Capabilities:**
- File read/write/search.
- Run shell commands (build, test, lint).
- Invoke MCP Service Generator pipeline.
- Semantic code search.

### 5.2 Researcher

**Role:** Gather, synthesise, and summarise information.

| Property | Value |
|---|---|
| Default model | `models.researcher` from config |
| Default skills | `research` |
| Tool access | `web-fetch.*`, `filesystem.read_file`, `memory.*` |
| Max iterations | 20 |

**System prompt (abbreviated):**
```
You are a research specialist.

Gather information from the web, documents, and memory.
Always cite your sources. Cross-reference multiple sources.
Store important findings in memory for future reference.
Produce structured summaries with key findings, sources, and confidence levels.
```

### 5.3 Executor

**Role:** Run commands, manage processes, interact with external systems.

| Property | Value |
|---|---|
| Default model | `models.executor` from config |
| Default skills | (none by default) |
| Tool access | `shell.*`, `filesystem.*`, `git.*`, `lock.*` |
| Max iterations | 15 |

**System prompt (abbreviated):**
```
You are a command execution specialist.

Run shell commands to accomplish tasks. Always:
1. Validate commands before running (no destructive commands without thought).
2. Check exit codes and stderr.
3. If a command fails, diagnose the error and try to fix it.
4. Report results clearly: what ran, what happened, what to do next.
```

### 5.4 Planner

**Role:** Decompose complex goals into actionable plans.

| Property | Value |
|---|---|
| Default model | `models.orchestrator` (strong model) |
| Default skills | `planning` |
| Tool access | `memory.recall`, `filesystem.read_file` (for context) |
| Max iterations | 5 |

**System prompt (abbreviated):**
```
You are a planning specialist.

Break complex goals into ordered, actionable steps.
Each step should specify:
- What to do (clear, unambiguous description).
- Which agent type should do it (coder, researcher, executor).
- Dependencies on other steps.

Output a structured plan as JSON.
Think about parallelism — steps without dependencies can run concurrently.
```

### 5.5 Chat

**Role:** Conversational, user-facing agent. One Chat agent is spawned **per client session** (browser tab, Telegram chat, CLI session). Chat agents are **read-only** with respect to the working tree -- they can answer questions, search conversations and files, and submit work requests to the orchestrator, but they do **not** write files, run commands, or dispatch agents directly.

Multiple chat sessions run **in parallel**. Each session has its own conversation, context, and identity.

| Property | Value |
|---|---|
| Default model | `models.chat` or `models.orchestrator` |
| Default skills | `chat`, `status-reporting` |
| Tool access | **Read-only** tools + `orch.submit_work` / `orch.update_work` / `orch.cancel_work` (see below) |
| Max iterations | Unlimited (long-lived, event-driven) |
| Lifetime | Persistent -- lives for the duration of the client connection |

#### 5.5.1 What the Chat Agent Can Do

The Chat agent is a ReAct agent with a **read-only + work-submission** scope:

| Capability | How |
|---|---|
| **Answer questions about TODOs** | Calls `orch.get_todos` / `orch.get_state` |
| **Show agent status** | Calls `orch.get_agents` |
| **Submit work requests** | Calls `orch.submit_work` (orchestrator plans and dispatches) |
| **Modify/cancel work** | Calls `orch.update_work` / `orch.cancel_work` |
| **Read files, search code** | Calls `filesystem.read_file`, `filesystem.list_dir`, `filesystem.search` |
| **Search conversations** | Calls `index.search`, `index.search_conversations` |
| **Query memory** | Calls `memory.recall` |
| **Handle greetings/small talk** | LLM responds directly (no tool calls needed) |
| **Subscribe to events** | Calls `orch.subscribe` to stream live updates to the user |

**What it does NOT do (mutations, routed through orchestrator instead):**
- Write files (`filesystem.write_file`)
- Run shell commands (`shell.*`)
- Dispatch or manage agents (`dispatch_agent`, `message_agent`)
- Make git commits or manage branches (`git.*`)
- Acquire locks (`lock.*`)

> **Rationale:** Routing all mutations through the orchestrator is what enables
> locking, prioritisation, scheduling, git branch isolation, and cross-session
> awareness. See [03-ARCHITECTURE.md §7 D1](03-ARCHITECTURE.md).

**System prompt (abbreviated):**
```
You are the user-facing assistant for Saivage.

You talk to the user through a chat interface. You have read-only access to
the workspace and system state, plus the ability to submit work requests.

Tools available:
- orch.get_state, orch.get_todos, orch.get_agents (read-only queries)
- orch.submit_work (submit a goal for the orchestrator to plan and execute)
- orch.update_work, orch.cancel_work (modify pending/in-flight work)
- orch.subscribe (live event stream)
- index.search, index.search_conversations (search history)
- memory.recall (query long-term memory)
- filesystem.read_file, filesystem.list_dir, filesystem.search (read-only FS)

Decision guide:
- Questions about code or state: read files / query orchestrator directly.
- "Do X" / "Build Y" / any mutation: call orch.submit_work.
- "Cancel task Z": call orch.cancel_work.
- Status queries: call orch.get_state and present the result.

You receive live event notifications. When relevant things happen
(agents complete, TODOs update), inform the user proactively.

Keep responses concise and helpful.
```

#### 5.5.2 Session Lifecycle

```
Client connects (WebSocket / Telegram / CLI)
         |
         v
  +-----------------------------+
  |  Session Manager creates    |
  |  a new Chat sub-agent       |
  |  with a ChatChannel for     |
  |  this transport             |
  +----------+------------------+
             |
             v
  +-----------------------------+
  |  Chat Agent starts          |
  |  - Subscribes to orch events|
  |  - Enters ReAct loop        |
  |  - Listens for user msgs    |
  +----------+------------------+
             |
             | (long-lived loop)
             |
  User msg --> LLM decides --> tool calls --> respond to user
             |
  Event -----> LLM formats --> push to user (proactive update)
             |
  Client disconnects --> agent destroyed
```

Each Chat agent is independent — it does not share conversation state with other sessions.

#### 5.5.3 ChatChannel Interface (Transport Abstraction)

```typescript
interface ChatChannel {
  // Receive from user
  onMessage(handler: (msg: UserMessage) => void): void;
  onDisconnect(handler: () => void): void;

  // Send to user
  sendText(text: string): Promise<void>;
  sendProgress(progress: ProgressUpdate): Promise<void>;
  sendStatus(state: OrchestratorState): Promise<void>;
  sendTyping(): Promise<void>;
}
```

**Built-in implementations:**

| Channel | Transport | Description |
|---|---|---|
| `WebSocketChannel` | WebSocket | Vue web chat (primary) |
| `CLIChannel` | stdin/stdout | Terminal fallback |

**Future implementations (pluggable):**

| Channel | Transport | Description |
|---|---|---|
| `TelegramChannel` | Telegram Bot API | Messaging app integration |
| `SlackChannel` | Slack Events API | Workspace integration |
| `DiscordChannel` | Discord Gateway | Community integration |

Adding a new transport only requires implementing `ChatChannel` — the Chat agent doesn't change.

#### 5.5.4 Event Subscription

On startup, the Chat agent calls `orch.subscribe` to receive a stream of orchestrator events. It uses these to **proactively** inform the user:

```
[event: agent:completed] -> "The data model is ready — coder-b3e finished TODO #2."
[event: agent:failed]    -> "The API tests failed. The coder is retrying with a different approach."
[event: todo:unblocked]  -> "TODO #3 (Build Plaid connector) is now unblocked and starting."
```

The LLM decides which events to surface and how to phrase them — not every event is displayed.

#### 5.5.5 Read-Only Queries

Chat agents handle read-only requests directly without involving the orchestrator:

```
User: What's in the package.json?
-> Chat agent calls filesystem.read_file directly.

User: Show me the TODO list.
-> Chat agent calls orch.get_todos, formats the result.

User: What did we discuss about the database schema yesterday?
-> Chat agent calls index.search_conversations, summarises results.
```

Any request that requires a **mutation** (file write, command, git op) is
submitted to the orchestrator via `orch.submit_work`.

## 6. Custom Sub-Agent Types

Users can define new agent types in `~/.saivage/agents/`:

```jsonc
// ~/.saivage/agents/devops.json
{
  "type": "devops",
  "description": "Infrastructure and deployment specialist",
  "model": "anthropic/claude-sonnet-4-20250514",
  "systemPrompt": "You are a DevOps engineer. You manage infrastructure using Terraform, Docker, and Kubernetes. ...",
  "skills": ["docker", "kubernetes", "ci-cd"],
  "toolPatterns": ["shell.*", "filesystem.*"],
  "maxIterations": 20,
  "timeoutMs": 600000
}
```

The Orchestrator sees these in its sub-agent registry and can dispatch work to them.

## 7. Communication Protocol (All Async)

### 7.1 Orchestrator -> Sub-Agent: Task Assignment

```typescript
interface TaskAssignment {
  taskId: string;                  // Unique task ID
  todoId: string;                  // Which orchestrator TODO this serves
  project: "target" | "self";     // Which codebase this work targets
  prompt: string;                  // What to do
  context?: string;                // Additional context (previous results, user preferences)
  branch?: string;                 // Git branch to work on (for code tasks)
  skills: string[];                // Skills to load into system prompt
  tools: string[];                 // Tool patterns to allow
  artifacts?: Artifact[];          // Files/data from previous tasks
  timeoutMs: number;
}
```

### 7.2 Sub-Agent -> Orchestrator: Events

All communication from sub-agent to orchestrator is via **events on the event bus**:

```typescript
// Emitted every N iterations (configurable)
interface AgentProgressEvent {
  type: "agent:progress";
  agentId: string;
  todoId: string;
  iteration: number;
  description: string;             // Human-readable: "Reading src/index.ts..."
  currentToolCall?: string;        // Tool name currently being called
}

// Emitted on success
interface AgentCompletedEvent {
  type: "agent:completed";
  agentId: string;
  todoId: string;
  output: string;                  // Summary for orchestrator
  artifacts?: Artifact[];          // Files created, data produced
  iterationCount: number;
  tokensUsed: { input: number; output: number };
}

// Emitted on failure
interface AgentFailedEvent {
  type: "agent:failed";
  agentId: string;
  todoId: string;
  error: string;
  reason: "max_iterations" | "timeout" | "cancelled" | "tool_error" | "model_error";
  iterationCount: number;
  tokensUsed: { input: number; output: number };
}

// Emitted when agent cannot proceed without external help
interface AgentBlockedEvent {
  type: "agent:blocked";
  agentId: string;
  todoId: string;
  reason: "missing_tool" | "needs_clarification" | "resource_unavailable";
  detail: string;                  // Explanation
}
```

### 7.3 Orchestrator -> Active Sub-Agent: Mid-Task Messages

```typescript
// Inject a message into a running agent's conversation
interface AgentMessage {
  agentId: string;
  message: string;                 // Treated as a new "user" message in the agent's conversation
}

// Cancel a running agent
interface AgentCancelSignal {
  agentId: string;
  reason: string;
}
```

## 8. Artifact Passing

Tasks produce and consume **artifacts** — files, data, or structured outputs that flow between tasks:

```typescript
interface Artifact {
  name: string;                    // e.g. "api-design.md", "test-results.json"
  type: "file" | "data" | "plan";
  path?: string;                   // Filesystem path for file artifacts
  content?: string;                // Inline content for small artifacts
}
```

When the Orchestrator dispatches a new agent, it can include artifacts from previous tasks:

```typescript
dispatch_agent({
  todoId: "4",
  agentType: "coder",
  prompt: "Implement the REST API based on the design document",
  artifacts: [
    { name: "api-design.md", type: "file", path: "/tmp/saivage/api-design.md" }
  ],
})
```

The agent receives these in `assignment.artifacts` and can reference them in its work.

## 9. Agent Pool

For performance, sub-agents are pooled:
- **Pool size:** Configurable per type (default: 2 per type).
- **Reuse:** After a task completes, the agent's conversation is cleared but the model client connection stays warm.
- **Eviction:** Idle agents are evicted after `agent.pool.idleTimeoutMs` (default 120s).
- **Concurrency limit:** Maximum N agents running simultaneously (from Orchestrator config `agent.maxConcurrentAgents`, default 5).

## 10. Error Escalation

When a sub-agent cannot complete its task:

1. **Self-retry:** Within its own loop, the agent tries different approaches (up to max iterations).
2. **Block:** Emit `agent:blocked` with a reason — the Orchestrator decides what to do.
3. **Fail:** Emit `agent:failed` — the Orchestrator may:
   - Retry the same task with a stronger model.
   - Retry with a different agent type.
   - Re-plan the approach.
   - Broadcast a question to connected chat sessions.

The sub-agent **never talks to the user directly** — except for the **Chat sub-agent**, which is the designated user-facing interface. All other agents route through the Orchestrator.
