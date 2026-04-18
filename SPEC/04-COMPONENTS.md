# Saivage — Components & Implementation

## 1. System Context

```
                    Clients
    +------------------+------------------+------------------+
    |                  |                  |                  |
    | Vue Web App      | Telegram Bot     | CLI              |
    | (browser)        | (future)         | (terminal)       |
    +--------+---------+--------+---------+--------+---------+
             |                  |                  |
             +------------------+------------------+
                                |
                        HTTP + WebSocket API
                                |
+-------------------------------v---------------------------------+
|                      Saivage Server (Node.js)                   |
|                                                                 |
|  +-------------------+     +-------------------------------+    |
|  |  API Layer        |     |  Session Manager              |    |
|  |  (HTTP + WS)      |---->|  Creates Chat agent per       |    |
|  +-------------------+     |  client connection             |    |
|                            +------+------------------------+    |
|                                   |                             |
|              +--------------------+--------------------+        |
|              |                    |                    |        |
|              v                    v                    v        |
|        +-----------+       +-----------+       +-----------+   |
|        |Chat Agent |       |Chat Agent |       |Chat Agent |   |
|        |Session 1  |       |Session 2  |       |Session N  |   |
|        +-----------+       +-----------+       +-----------+   |
|              |  calls orch.* tools    |              |         |
|              +--------------------+--------------------+        |
|                                   |                             |
|                                   v                             |
|           +-----------------------------------------------+     |
|           |           Orchestrator (Autonomous Core)      |     |
|           |  +-------------------+  +------------------+  |     |
|           |  | Orchestrator MCP  |  | TODO State       |  |     |
|           |  | (orch.* tools)    |  | Event Loop       |  |     |
|           |  +-------------------+  +------------------+  |     |
|           +---------------------+-------------------------+     |
|                                 | dispatch (async)              |
|                 +---------------+---------------+               |
|                 v               v               v               |
|           +---------+     +---------+     +-----------+         |
|           | Coder   |     |Researcher|    |Sub-Orch   |         |
|           | Agent   |     | Agent   |     |estrator   |         |
|           +---------+     +---------+     +-----------+         |
|                 |               |               |               |
|                 +-------+-------+               |               |
|                         v                                       |
|           +-------------------------------+                     |
|           |        MCP Runtime            |                     |
|           |  +--------+ +--------+        |                     |
|           |  |Service | |Service | ...    |                     |
|           |  |  A     | |  B     |        |                     |
|           |  +--------+ +--------+        |                     |
|           +-------------------------------+                     |
|                                                                 |
|  +-----------------------------------------------------------+  |
|  |                  Model Provider Layer                      |  |
|  |  Anthropic | OpenAI | Google | Ollama | OpenRouter | ...   |  |
|  +-----------------------------------------------------------+  |
+-----------------------------------------------------------------+
```

## 2. Component Breakdown

### 2.1 API Server
- **Role:** HTTP + WebSocket server. The single entry point for all clients.
- **Serves:** Vue web app (static files), WebSocket connections for chat sessions, REST endpoints for admin/status.
- **Framework:** Fastify or Express with `ws` for WebSocket.
- See [12-USER-INTERACTION.md](12-USER-INTERACTION.md).

### 2.2 Session Manager
- **Role:** Creates and manages Chat sub-agent instances.
- **On client connect:** Spawns a new Chat agent with a `ChatChannel` for the transport.
- **On client disconnect:** Destroys the Chat agent and cleans up.
- **Parallel sessions:** Multiple chat sessions run concurrently, each independent.

### 2.3 Orchestrator (Autonomous Core)
- **Role:** Maintain TODO state, dispatch agents, direct in-flight work.
- **Headless:** Does not know about users or chat sessions. Exposes everything via the **Orchestrator MCP service**.
- **State:** Keeps a persistent TODO list of tasks, their status, assigned agents, and dependencies.
- **Async dispatch:** Dispatches sub-agents and sub-orchestrators asynchronously.
- **LLM usage:** Uses an LLM to evaluate events and decide what to do.
- See [05-ORCHESTRATOR.md](05-ORCHESTRATOR.md).

### 2.4 Sub-Agent Pool
- **Role:** Execute specific tasks delegated by an orchestrator.
- **Pattern:** Each runs a ReAct loop like modern coding agents.
- **Types:** **Chat** (one per session, user-facing, read-only), Coder, Researcher, Planner, Executor, plus custom types.
- Chat agents are **read-only**: they query orchestrator state at and submit work via `orch.submit_work`. All mutations flow through the orchestrator.
- Worker agents (Coder, Researcher, Executor) operate on git branches with advisory locks.
- See [06-SUB-AGENTS.md](06-SUB-AGENTS.md).

### 2.5 Skill Store
- **Role:** Manage skill files that teach agents specialised behaviour.
- **Storage:** `~/.saivage/skills/` and `./skills/` (workspace-local).
- See [07-SKILLS.md](07-SKILLS.md).

### 2.6 Model Provider Layer
- **Role:** Unified interface to multiple LLM providers.
- **Pattern:** `provider/model-id` (e.g. `anthropic/claude-sonnet-4-20250514`, `openai/gpt-5`, `ollama/llama3`).
- **Features:** Auth rotation, failover chains, rate-limit backoff, cost tracking.
- See [08-MODEL-PROVIDERS.md](08-MODEL-PROVIDERS.md).

### 2.7 MCP Runtime
- **Role:** Start, stop, monitor MCP service processes.
- **Transport:** stdio (default) or SSE.
- See [10-MCP-RUNTIME.md](10-MCP-RUNTIME.md).

### 2.8 Service Registry
- **Storage:** `~/.saivage/registry.json`.
- **Schema per entry:**
  ```jsonc
  {
    "name": "weather-lookup",
    "version": "0.1.0",
    "origin": "generated",           // "builtin" | "generated" | "external"
    "path": "~/.saivage/services/weather-lookup",
    "transport": "stdio",
    "tools": [
      {
        "name": "get_weather",
        "description": "Get current weather for a city",
        "inputSchema": { /* JSON Schema */ }
      }
    ],
    "capabilities": ["network"],
    "status": "active",
    "createdAt": "2026-04-11T12:00:00Z"
  }
  ```

### 2.9 Event Bus
- Internal async pub/sub for routing events between components.
- All orchestrator ↔ sub-agent communication flows through events (never synchronous calls).
- Event types: `user:message`, `user:approval`, `agent:completed`, `agent:failed`, `agent:progress`, `agent:blocked`, `orchestrator:completed`, `orchestrator:failed`, `timer:fire`, `webhook:receive`, `service:registered`, `service:unhealthy`, `service:replaced`, `sandbox:passed`, `sandbox:failed`, `watchdog:rollback`.

## 3. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Language | TypeScript 5.x | Strong typing, modern async, broad ecosystem |
| Runtime | Node.js 22+ | LTS, native fetch, stable async hooks |
| Build | `tsup` or `tsx` | Fast bundling / direct TS execution |
| Package manager | `pnpm` | Fast, strict, workspace-friendly |
| MCP SDK | `@modelcontextprotocol/sdk` | Official TS SDK for MCP |
| LLM abstraction | Custom provider layer (see §2.4) | Full control over routing, failover, cost tracking |
| Schema validation | `zod` | Runtime + static type inference |
| Configuration | JSON (`~/.saivage/saivage.json`) | Programmatic, supports comments via jsonc |
| Data storage | SQLite (`better-sqlite3`) | Zero-config, single-file, synchronous reads |
| CLI framework | `commander` or `citty` | Lightweight, TS-native |
| Process management | Node `child_process` + `execa` | Reliable subprocess control |
| Testing | `vitest` | Fast, TS-native, watch mode |

## 4. Directory Layout

```
saivage/
├── SPEC/                            # Specification documents
├── src/
│   ├── index.ts                     # CLI entry point
│   ├── server/
│   │   ├── server.ts                # HTTP + WebSocket API server
│   │   ├── routes.ts                # REST API routes (admin, status)
│   │   └── session.ts               # Session manager (spawns Chat agents)
│   ├── channels/
│   │   ├── types.ts                 # ChatChannel interface
│   │   ├── websocket.ts             # WebSocketChannel (primary — Vue web chat)
│   │   └── cli.ts                   # CLIChannel (fallback)
│   ├── orchestrator/
│   │   ├── orchestrator.ts          # Central agent / event loop + TODO state
│   │   ├── state.ts                 # OrchestratorState types & persistence
│   │   ├── scheduler.ts             # Priority scheduler (P0-P3, idle detection)
│   │   ├── branchManager.ts         # Git branch lifecycle for work items
│   │   ├── eventBus.ts              # Internal async event pub/sub
│   │   └── mcpService.ts            # Orchestrator MCP service (orch.* tools)
│   ├── agents/
│   │   ├── base.ts                  # Base sub-agent class
│   │   ├── chat.ts                  # Chat sub-agent (per-session, user-facing)
│   │   ├── coder.ts                 # Code-writing sub-agent
│   │   ├── researcher.ts           # Research / web sub-agent
│   │   ├── executor.ts             # Shell / command sub-agent
│   │   ├── registry.ts             # Sub-agent type registry
│   │   └── protocol.ts             # Orchestrator ↔ sub-agent messages
│   ├── skills/
│   │   ├── loader.ts               # Skill discovery & loading
│   │   ├── resolver.ts             # Match skills to task context
│   │   └── types.ts                # Skill metadata types
│   ├── providers/
│   │   ├── base.ts                  # Provider interface
│   │   ├── anthropic.ts            # Anthropic adapter
│   │   ├── openai.ts               # OpenAI adapter
│   │   ├── google.ts               # Google Gemini adapter
│   │   ├── ollama.ts               # Ollama (local) adapter
│   │   ├── openrouter.ts           # OpenRouter adapter
│   │   ├── router.ts               # Model routing & failover
│   │   └── types.ts                # Shared provider types
│   ├── mcp/
│   │   ├── runtime.ts              # MCP process manager
│   │   ├── registry.ts             # Service registry
│   │   ├── client.ts               # MCP client wrapper
│   │   └── transport.ts            # stdio / SSE transport
│   ├── generator/
│   │   ├── pipeline.ts             # Generation pipeline orchestration
│   │   ├── scaffold.ts             # Project scaffolding
│   │   ├── codegen.ts             # LLM-driven code generation
│   │   ├── tester.ts              # Automated test runner
│   │   └── templates/              # Handlebars/EJS templates for MCP service skeleton
│   ├── security/
│   │   ├── scanner.ts              # Prompt injection scanner
│   │   ├── patterns.ts             # Injection pattern database
│   │   ├── delimiters.ts           # External content wrapping
│   │   ├── provenance.ts           # Content hash tracking
│   │   └── redactor.ts             # Secret redaction for logs
│   ├── services/
│   │   ├── index/                   # Index service (index.* — FTS5 search)
│   │   │   ├── service.ts
│   │   │   └── types.ts
│   │   ├── lock/                    # Lock service (lock.* — advisory locking)
│   │   │   ├── service.ts
│   │   │   └── types.ts
│   │   ├── git/                     # Git service (git.* — branch management)
│   │   │   ├── service.ts
│   │   │   └── types.ts
│   │   └── memory/                  # Memory service (memory.* -- long-term store)
│   │       ├── service.ts
│   │       └── types.ts
│   ├── sandbox/
│   │   ├── sandbox.ts               # Sandbox service (sandbox.* -- isolated testing)
│   │   ├── contractTests.ts         # Schema + I/O contract validation
│   │   ├── secondaryInstance.ts     # Spawn + test secondary Saivage instance
│   │   └── types.ts
│   ├── versions/
│   │   ├── store.ts                 # Version store service (versions.*)
│   │   └── types.ts
│   ├── watchdog/
│   │   ├── watchdog.ts              # Minimal process monitor (separate from orchestrator)
│   │   └── types.ts
│   └── config.ts                    # Configuration loading & schema
├── web/                             # Vue web chat frontend
│   ├── src/
│   │   ├── App.vue                  # Root component
│   │   ├── main.ts                  # Vue entry point
│   │   ├── components/
│   │   │   ├── ChatWindow.vue       # Main chat container
│   │   │   ├── MessageList.vue      # Message display
│   │   │   ├── MessageInput.vue     # User input
│   │   │   ├── StatusPanel.vue      # TODO list / agent status
│   │   │   └── ProgressIndicator.vue # Agent progress display
│   │   ├── composables/
│   │   │   └── useWebSocket.ts      # WebSocket connection management
│   │   └── types.ts                 # Shared message types
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── package.json
├── skills/                          # Built-in skill files
│   ├── coding/SKILL.md
│   ├── mcp-authoring/SKILL.md
│   ├── research/SKILL.md
│   └── planning/SKILL.md
├── tests/
├── package.json
├── tsconfig.json
└── README.md
```

## 5. Data Flow -- Typical Request

```
1. User opens Vue web app in browser, connects via WebSocket to the API server
2. Session Manager spawns a new Chat sub-agent with a WebSocketChannel
3. Chat agent subscribes to orchestrator events via orch.subscribe
4. User sends message -> Chat agent receives it, runs ReAct loop:
     a) Read-only request (status, file read, search)? -> Chat agent handles directly
     b) Work request? -> Chat agent calls orch.submit_work
5. Orchestrator receives the work request, plans, creates branch, dispatches worker agent
6. Worker agent runs its own ReAct loop:
     a) LLM call with task prompt + skills + MCP tool schemas
     b) Tool calls dispatched via MCP Runtime
     c) If tool missing -> emits agent:blocked, Orchestrator dispatches Coder to generate it
     d) Results fed back to worker agent LLM
     e) Loop until complete
7. Worker agent emits agent:completed event
8. Orchestrator processes event, updates TODO state
9. Chat agent (subscribed to events) receives the update, informs user proactively
10. Multiple chat sessions can observe and interact with the same orchestrator state concurrently
```

## 6. Configuration (`~/.saivage/saivage.json`)

```jsonc
{
  // Model assignments per role
  "models": {
    "orchestrator": "anthropic/claude-sonnet-4-20250514",
    "coder": "anthropic/claude-sonnet-4-20250514",
    "researcher": "openai/gpt-5",
    "executor": "anthropic/claude-haiku-3",
    "default": "anthropic/claude-sonnet-4-20250514"
  },

  // Provider authentication
  "providers": {
    "anthropic": {
      "apiKey": "${ANTHROPIC_API_KEY}"
    },
    "openai": {
      "apiKey": "${OPENAI_API_KEY}"
    },
    "ollama": {
      "baseUrl": "http://localhost:11434"
    },
    "openrouter": {
      "apiKey": "${OPENROUTER_API_KEY}"
    }
  },

  // Failover chains
  "failover": {
    "anthropic/claude-sonnet-4-20250514": [
      "openai/gpt-5",
      "openrouter/anthropic/claude-sonnet-4-20250514"
    ]
  },

  // Server
  "server": {
    "port": 7777,
    "host": "0.0.0.0"
  },

  // Agent behaviour
  "agent": {
    "maxIterations": 20,
    "maxConcurrentAgents": 5
  },

  // MCP service generation
  "generator": {
    "language": "typescript",
    "testBeforeRegister": true,
    "sandbox": true
  },

  // Runtime
  "runtime": {
    "maxServices": 50,
    "restartOnCrash": true,
    "healthCheckIntervalMs": 30000,
    "idleShutdownMs": 300000
  },

  // VERSION STORE
  "versions": {
    "storagePath": "~/.saivage/versions",
    "retainCount": 5                     // keep last N versions per component
  },

  // SANDBOX
  "sandbox": {
    "timeoutMs": 120000,                 // max time for sandbox validation
    "secondaryInstancePort": 7778        // port for secondary Saivage instance
  },

  // WATCHDOG
  "watchdog": {
    "enabled": true,
    "healthCheckIntervalMs": 5000,
    "restartTimeoutMs": 60000            // rollback if new instance doesn't start in time
  },

  // Security (prompt injection defence only -- all local actions are allowed)
  "security": {
    "injectionScanner": true,
    "auditLog": true
  }
}
```
