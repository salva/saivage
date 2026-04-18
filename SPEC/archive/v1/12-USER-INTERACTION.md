# Saivage — User Interaction

## 1. Interface: Vue Web Chat

The primary user interface is a **Vue 3 web application** served by the Saivage backend. The user communicates with the system through a chat window — all interaction (requests, status updates, clarifications, task modifications) flows through this interface.

The chat is handled by the **Chat sub-agent**, a read-only conversational agent that queries system state and submits work requests. See [06-SUB-AGENTS.md §5.5](06-SUB-AGENTS.md) for the Chat agent specification.

### 1.1 Architecture

```
┌──────────────────────────────────────────────────┐
│  Browser                                          │
│  ┌──────────────────────────────────────────────┐ │
│  │  Vue 3 App (Vite)                            │ │
│  │  ┌──────────────┐ ┌───────────────────────┐  │ │
│  │  │ ChatWindow   │ │ StatusPanel           │  │ │
│  │  │  ┌──────────┐│ │  ┌─────────────────┐  │  │ │
│  │  │  │MessageList││ │  │ TODO list       │  │  │ │
│  │  │  └──────────┘│ │  │ Agent activity  │  │  │ │
│  │  │  ┌──────────┐│ │  │ Progress bars   │  │  │ │
│  │  │  │MsgInput  ││ │  └─────────────────┘  │  │ │
│  │  │  └──────────┘│ │                       │  │ │
│  │  └──────────────┘ └───────────────────────┘  │ │
│  └──────────────────────────────────────────────┘ │
└──────────────────┬───────────────────────────────┘
                   │ WebSocket
                   ▼
┌──────────────────────────────────────────────────┐
│  Saivage Backend (Node.js)                        │
│  ┌──────────────────────┐                         │
│  │  WebSocket Server    │                         │
│  │  (Chat Sub-Agent)    │                         │
│  └──────────────────────┘                         │
└──────────────────────────────────────────────────┘
```

### 1.2 Chat Session

```
You: What's the weather in Berlin?

Saivage: I'll submit a work request for that. Let me check if I have a weather tool...

[orch.submit_work] Goal: "Get weather for Berlin"
[orchestrator] No weather tool found. Creating one first...
[agent: coder] Generating weather-lookup MCP service...
[agent: coder] ✓ Service created and registered (3 tools)
[agent: executor] weather-lookup.get_weather(city="Berlin")

Saivage: It's currently 14°C in Berlin with partly cloudy skies.

You: Schedule a reminder for tomorrow at 9am to check it again.

Saivage: On it — I'll build a scheduler service for that.
[agent: coder] Generating scheduler service...
...
```

### 1.3 Status Panel

The right-side panel shows live system state:

- **TODO list** — all current tasks with status badges (pending, in-progress, completed, failed).
- **Active agents** — which agents are running, what they're doing, how many iterations.
- **Progress indicators** — per-agent progress bars with last activity descriptions.
- **Child orchestrators** — nested task trees for complex goals.

The panel updates in real-time via WebSocket push events from the Chat agent.

### 1.4 Task Modification

The user can modify tasks mid-flight through the chat:

```
You: Actually, use PostgreSQL instead of SQLite for the data model.

Saivage: Got it — I'll update the work item.
[orch.update_work] Updated goal: "Use PostgreSQL instead of SQLite"
[orchestrator] Redirected coder-b3e: "Switch from SQLite to PostgreSQL"

You: Cancel the deployment task, I want to review the code first.

Saivage: Done — cancelled TODO #5 (Deploy to staging).
[orch.cancel_work] Cancelled work item #5
```

The Chat agent relays modification requests to the Orchestrator via `orch.update_work` and `orch.cancel_work`. The orchestrator handles the internal coordination (redirecting or cancelling agents).

## 2. Vue Web App

### 2.1 Tech Stack

| Layer | Choice |
|---|---|
| Framework | Vue 3 (Composition API) |
| Build | Vite |
| Styling | Tailwind CSS |
| WebSocket | Native WebSocket / `ws` |
| Markdown | `markdown-it` (for rendering agent responses) |
| State | Pinia (reactive store for messages + status) |

### 2.2 Components

| Component | Purpose |
|---|---|
| `App.vue` | Root layout — chat panel + status panel |
| `ChatWindow.vue` | Chat container — message list + input |
| `MessageList.vue` | Scrolling message display with user/agent bubbles |
| `MessageInput.vue` | Text input with send button, supports multiline |
| `StatusPanel.vue` | Live TODO list and agent status |
| `ProgressIndicator.vue` | Per-agent progress bar with labels |
| `TodoItem.vue` | Single TODO row with status badge |

### 2.3 WebSocket Protocol

Messages between the Vue app and the Chat agent use JSON over WebSocket:

```typescript
// Client → Server
interface ClientMessage {
  type: "user:message";
  text: string;
  attachments?: string[];          // File paths or URLs
}

// Server → Client
type ServerMessage =
  | { type: "chat:text"; text: string }                       // Chat response
  | { type: "chat:progress"; agentId: string; description: string }  // Agent activity
  | { type: "status:update"; state: OrchestratorState }       // Full state refresh
  | { type: "status:todo"; todo: TodoItem }                   // Single TODO update
  | { type: "status:agent"; agent: AgentHandle }              // Single agent update
  | { type: "chat:typing" }                                   // Typing indicator
  | { type: "error"; message: string };                       // Error
```

### 2.4 Connection Management

```typescript
// web/src/composables/useWebSocket.ts
export function useWebSocket(url: string) {
  const connected = ref(false);
  const messages = ref<ServerMessage[]>([]);
  let ws: WebSocket | null = null;

  function connect() {
    ws = new WebSocket(url);
    ws.onopen = () => { connected.value = true; };
    ws.onclose = () => {
      connected.value = false;
      setTimeout(connect, 2000);   // Auto-reconnect
    };
    ws.onmessage = (event) => {
      messages.value.push(JSON.parse(event.data));
    };
  }

  function send(msg: ClientMessage) {
    ws?.send(JSON.stringify(msg));
  }

  connect();
  return { connected, messages, send };
}
```

### 2.5 Serving

The Vue app is built as a static bundle (`vite build`) and served by the Saivage backend on a configurable port:

```bash
saivage                              # Starts backend + serves web UI at http://localhost:7777
saivage --port 9000                  # Custom port
saivage --no-web                     # Backend only, no web UI (for API / CLI use)
```

On startup, Saivage opens the web UI in the default browser automatically (configurable).

## 3. CLI (Secondary Interface)

A CLI is available as a fallback / admin interface:

```bash
saivage cli                          # Start CLI chat session (uses CLIChannel)
saivage "deploy my app"              # One-shot: send a message, get result, exit
saivage --resume <id>                # Resume a previous conversation
```

### 3.1 CLI Commands

| Command | Description |
|---|---|
| `saivage` | Start web UI (default) |
| `saivage cli` | Start CLI chat session |
| `saivage "<message>"` | One-shot message |
| `saivage --resume <id>` | Resume conversation |
| **Services** | |
| `saivage services list` | List all registered services |
| `saivage services info <name>` | Show service details |
| `saivage services disable <name>` | Disable a service |
| `saivage services enable <name>` | Enable a service |
| `saivage services delete <name>` | Remove a service |
| `saivage services logs <name>` | View service logs |
| **Versions** | |
| `saivage versions list <component>` | List version history for a component |
| `saivage versions info <component> <version>` | Show version details |
| `saivage versions rollback <component> [version]` | Rollback to previous (or specified) version |
| `saivage versions prune <component>` | Remove old versions beyond retention limit |
| **Sandbox** | |
| `saivage sandbox status` | Show active sandbox processes |
| `saivage sandbox test <component>` | Manually trigger sandbox validation |
| `saivage sandbox destroy` | Tear down all active sandboxes |
| **Watchdog** | |
| `saivage watchdog status` | Show watchdog status and last-rollback info |
| `saivage watchdog log` | View watchdog event log |
| **Skills** | |
| `saivage skills list` | List all available skills |
| `saivage skills show <name>` | Show skill content |
| `saivage skills create <name>` | Scaffold a new skill |
| **Models** | |
| `saivage models list` | List configured models |
| `saivage models test [model]` | Test connectivity |
| **Usage** | |
| `saivage usage [--last Nd]` | Show usage/costs |
| **Secrets** | |
| `saivage secrets set <key> <value>` | Store a secret |
| `saivage secrets list` | List secret keys |
| `saivage secrets delete <key>` | Delete a secret |
| **Audit** | |
| `saivage audit list [--last N]` | View audit log |
| **Config** | |
| `saivage config show` | Show current configuration |
| `saivage config edit` | Open config in $EDITOR |

## 4. Progress Display

Both the web UI and CLI show agent progress in real-time:

**Web UI (StatusPanel):**
- TODO items with live status badges.
- Agent activity cards showing current tool call and iteration count.
- Expandable details for each agent.

**CLI:**
```
⠋ [orchestrator] Planning: "Build me a finance tracker"
✓ [orchestrator] Plan created (5 steps)

⠋ [researcher] Step 1/5: Research finance APIs...
✓ [researcher] Found 3 candidate APIs (Plaid, Teller, MX)

⠋ [coder] Step 2/5: Designing data model...
✓ [coder] Created src/models/transaction.ts

⠋ [coder] Step 3/5: Generating plaid-connector service...
  └─ scaffold → implement → test (2/3 passed, retrying)...
```

## 5. First Run Setup

```
$ saivage
Starting Saivage...

No configuration found. Running first-time setup.

1. Primary LLM provider: [anthropic]  openai  google  ollama  other
2. API Key: ****************************
3. Model: [claude-sonnet-4-20250514]  claude-haiku-3

Configuration saved to ~/.saivage/saivage.json
Opening web UI at http://localhost:7777...
```

## 6. Environment Variables

All config values can be overridden:

```bash
SAIVAGE_MODELS_DEFAULT=anthropic/claude-sonnet-4-20250514
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
SAIVAGE_PORT=9000
SAIVAGE_NO_WEB=true
```
