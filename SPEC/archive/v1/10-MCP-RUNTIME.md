# Saivage — MCP Runtime

## 1. Purpose

The MCP Runtime manages the lifecycle of MCP service processes: start, stop, restart, health-check, and sandbox. It provides the bridge between sub-agents making tool calls and the actual MCP service processes that execute them.

## 2. Responsibilities

| Responsibility | Description |
|---|---|
| **Process management** | Start, stop, restart MCP service processes |
| **Transport** | Set up stdio or SSE communication channels |
| **Health monitoring** | Periodic liveness checks, crash detection |
| **Resource limits** | Timeout enforcement per tool call |
| **Lazy loading** | Start services on first use, stop after idle |
| **Connection pooling** | Maintain persistent MCP client sessions to active services |

## 3. Transport Modes

### 3.1 stdio (default)

```
Sub-Agent  →  MCP Client  ──stdin──▶  MCP Service Process
                           ◀─stdout──
```

- The runtime spawns the service as a child process.
- Communication via JSON-RPC over stdin/stdout.
- stderr is captured for diagnostics.

### 3.2 SSE (for remote/long-lived services)

```
Sub-Agent  →  MCP Client  ──HTTP POST──▶  MCP Service (HTTP server)
                           ◀──SSE stream──
```

- Used for services that need state or serve multiple clients.
- Port allocation managed by the Runtime.

## 4. Process Lifecycle

```
                   start()
                      │
              ┌───────▼───────┐
              │   starting     │  (spawning process, waiting for init)
              └───────┬───────┘
                      │ ready
              ┌───────▼───────┐
              │    running     │  (healthy, accepting tool calls)
              └───┬───────┬───┘
                  │       │
          crash   │       │  stop()
              ┌───▼───┐ ┌─▼──────┐
              │crashed │ │stopping│
              └───┬───┘ └───┬────┘
                  │         │
          restart?│    ┌────▼────┐
              ┌───▼──▶ │ stopped │
              │        └─────────┘
              └── (back to starting)
```

## 5. Service Startup

```typescript
async function startService(entry: ServiceEntry): Promise<ManagedProcess> {
  const cwd = entry.path;
  const cmd = ["node", "--import", "tsx", "src/index.ts"];

  // Prepare environment
  const env = {
    ...process.env,
    NODE_ENV: "production",
    ...secrets.resolveEnvVars(entry.secrets),
  };

  // Spawn process (no sandboxing — confined environment allows all actions)
  const proc = execa(cmd[0], cmd.slice(1), {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Initialize MCP client session
  const transport = new StdioClientTransport(proc.stdin!, proc.stdout!);
  const client = new Client({ name: "saivage", version: "0.1.0" });
  await client.connect(transport);

  // Verify tools match registry
  const tools = await client.listTools();
  assertToolsMatch(tools, entry.tools);

  return { proc, client, entry, status: "running" };
}
```

## 6. Health Checking

### 6.1 Passive
- Monitor for unexpected process exit (via `execa` event).
- Monitor stderr for error patterns.

### 6.2 Active
- Every `runtime.healthCheckIntervalMs` (default 30s), send a `ping` request.
- No response within 5s → `unhealthy`.
- 3 consecutive failures → restart.

### 6.3 Crash Recovery
- On unexpected exit, check if `runtime.restartOnCrash` is enabled.
- Exponential backoff: 1s, 2s, 4s, 8s, 16s (max).
- After 5 consecutive crash-restarts → `unhealthy`, emit `service:unhealthy` event.

## 7. Tool Call Dispatch

```typescript
async function callTool(
  serviceName: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  let proc = this.processes.get(serviceName);

  // Lazy start
  if (!proc) {
    const entry = registry.get(serviceName);
    proc = await this.startService(entry);
    this.processes.set(serviceName, proc);
  }

  if (proc.status !== "running") {
    throw new ServiceUnavailable(serviceName);
  }

  // Timeout
  const timeoutMs = this.config.runtime.toolCallTimeoutMs ?? 60_000;
  const result = await Promise.race([
    proc.client.callTool({ name: toolName, arguments: args }),
    timeout(timeoutMs),
  ]);

  return result;
}
```

## 8. Resource Limits

| Resource | Default | Config key |
|---|---|---|
| Tool call timeout | 60s | `runtime.toolCallTimeoutMs` |
| Max concurrent services | 50 | `runtime.maxServices` |
| Max concurrent tool calls | 10 | `runtime.maxConcurrentCalls` |
| Idle shutdown | 300s | `runtime.idleShutdownMs` |
| Health check interval | 30s | `runtime.healthCheckIntervalMs` |

## 9. Lazy Loading

Services are **not** started at boot:
- Registry is read on startup; all active services are marked `registered`.
- A service is started on the **first tool call** targeting it.
- After `runtime.idleShutdownMs` without a tool call, the service is stopped.
- Next tool call restarts it.

## 10. Shutdown

On agent exit (`SIGTERM`, `SIGINT`, or CLI exit):
1. Stop accepting new tool calls.
2. Wait for in-flight calls (up to 10s).
3. Send shutdown to all running service processes.
4. Wait up to 5s for graceful exit.
5. Kill remaining processes.

## 11. Hot-Replacement

When a self-modification is promoted (via `sandbox.promote`), the Runtime
performs an in-place replacement of the live service:

```
1. DRAIN     — Stop routing new tool calls to the old process.
               Wait for in-flight calls to complete (up to 10s).
2. SNAPSHOT  — Copy current service directory to the version store
               (~/.saivage/versions/services/{name}/v{old}/).
3. SWAP      — Replace the service directory with the new version.
4. START     — Spawn the new process, initialise MCP client.
5. VERIFY    — Health check + schema assertion (tools match registry).
6. PROMOTE   — Route new tool calls to the new process. Done.
7. ROLLBACK  — If VERIFY fails: kill new process, restore previous
               version from version store, restart old process.
```

The caller (Orchestrator or Sandbox Service) receives a success/failure
result with details.

### 11.1 Zero-Downtime for Consumers

During hot-replacement, tool calls targeting the service are **queued** (not
rejected). The queue is drained once the new process is verified. Callers
experience slightly higher latency but no errors.

If rollback is needed, the queue is drained against the restored old process.

## 12. Watchdog

A minimal, separate process that monitors the Orchestrator's health.

**Startup:** The watchdog is launched by the main `saivage` process on boot
as a detached child process. It survives the parent's exit or restart. If the
watchdog is not running when Saivage starts, it is spawned automatically.
The CLI command `saivage watchdog status` reports its PID and state.

**Behaviour:**
- Runs as a lightweight loop outside the main Saivage process.
- Checks the Orchestrator's health endpoint every `watchdog.healthCheckIntervalMs`.
- If the Orchestrator becomes unresponsive after a self-modification:
  1. Wait `watchdog.restartTimeoutMs` for recovery.
  2. Identify the last self-modification (from the version store log).
  3. Rollback: restore the previous version of the modified component.
  4. Restart the Orchestrator from the rolled-back code.
  5. Emit a `watchdog:rollback` event for diagnostics.
- The watchdog is intentionally minimal — it does **not** use LLMs or MCP.
  It reads a version log file and runs shell commands.

## 13. Logging

Each service's output is logged:
- `~/.saivage/logs/{service_name}.stdout.log`
- `~/.saivage/logs/{service_name}.stderr.log`
- Rotated at 10 MB.
