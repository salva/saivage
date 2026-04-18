# Saivage — Implementation Plan

Staged implementation ordered by dependency. Each stage produces runnable,
testable code. Later stages build on earlier ones without rewriting.

---

## Stage 0 — Project Scaffold

**Goal:** Buildable, testable TypeScript project with tooling configured.

**Deliverables:**
- `package.json` (pnpm, TypeScript 5.x, Node 22+)
- `tsconfig.json` (strict, ESM, path aliases)
- `vitest.config.ts`
- `src/index.ts` (CLI entry point stub)
- `.gitignore`
- ESLint config (flat config, TypeScript rules)

**Test:** `pnpm build && pnpm test` passes with zero tests.

---

## Stage 1 — Configuration & Model Providers

**Goal:** Load config, connect to at least one LLM, make a chat call.

**Deliverables:**
- `src/config.ts` — Load `~/.saivage/saivage.json`, merge env vars, validate
  with zod. Provide defaults for all values.
- `src/providers/types.ts` — `ModelProvider`, `ChatRequest`, `ChatResponse`,
  `ToolCall` interfaces.
- `src/providers/base.ts` — Abstract base with shared retry/timeout logic.
- `src/providers/anthropic.ts` — Anthropic adapter (primary provider).
- `src/providers/openai.ts` — OpenAI adapter.
- `src/providers/router.ts` — Model router with failover chains, rate-limit
  tracking, sticky failover.
- `src/providers/index.ts` — Barrel export.

**Test:**
- Unit: config loading with defaults, env var override, validation errors.
- Unit: router failover logic (mocked providers).
- Integration (manual): `pnpm tsx src/index.ts models test` talks to real API.

**CLI commands enabled:** `saivage models list`, `saivage models test`.

---

## Stage 2 — Event Bus & MCP Runtime

**Goal:** Internal pub/sub and the ability to start/stop/call MCP services.

**Deliverables:**
- `src/orchestrator/eventBus.ts` — Typed async event emitter. Pub/sub with
  typed event map, wildcard subscriptions, error isolation.
- `src/mcp/registry.ts` — Read/write `~/.saivage/registry.json`. CRUD for
  service entries.
- `src/mcp/transport.ts` — stdio and SSE transport setup.
- `src/mcp/client.ts` — MCP client wrapper (connect, listTools, callTool).
- `src/mcp/runtime.ts` — Process manager: start, stop, health-check, lazy
  loading, idle shutdown, crash recovery with backoff.
- Built-in MCP services (each a self-contained MCP server):
  - `src/services/filesystem/` — `read_file`, `write_file`, `list_dir`,
    `search_files`.
  - `src/services/shell/` — `run_command`.

**Test:**
- Unit: event bus (emit, subscribe, unsubscribe, error isolation).
- Unit: registry CRUD.
- Unit: runtime lifecycle (mocked processes).
- Integration: start filesystem service, call `read_file`, get result.

**CLI commands enabled:** `saivage services list`.

---

## Stage 3 — Sub-Agent Base & ReAct Loop

**Goal:** A working agent that can reason, call tools, and iterate.

**Deliverables:**
- `src/agents/base.ts` — `SubAgent` class: ReAct loop, conversation
  management, tool dispatch via MCP Runtime, progress events, cancellation,
  max-iterations guard.
- `src/agents/protocol.ts` — Event types: `AgentProgressEvent`,
  `AgentCompletedEvent`, `AgentFailedEvent`, `AgentBlockedEvent`.
  `TaskAssignment` interface.
- `src/agents/registry.ts` — Agent type registry, config loading from
  `~/.saivage/agents/*.json`.

**Test:**
- Unit: ReAct loop with mocked LLM (canned tool-call sequences).
- Unit: cancellation stops the loop.
- Unit: max-iterations emits failed event.
- Integration: real LLM + filesystem service → agent reads a file and
  summarises it.

---

## Stage 4 — Infrastructure Services

**Goal:** Git, lock, index, and memory services operational.

**Deliverables:**
- `src/services/git/` — `create_branch`, `checkout`, `commit`, `merge`,
  `diff`, `status`, `delete_branch`. Wraps `simple-git`.
- `src/services/lock/` — Advisory locking with SQLite. Shared/exclusive,
  TTL, namespace support (`target:*` / `self:*`).
- `src/services/index/` — SQLite FTS5 index. `search`, `search_conversations`,
  `search_work`, `ingest`.
- `src/services/memory/` — SQLite-backed. `store`, `recall`, `list`, `delete`.
- `src/services/web/` — `fetch_url`, `fetch_page_content` (using `node:fetch`
  + `cheerio` for HTML parsing).

**Test:**
- Unit per service: lock acquire/release/TTL/namespace, index ingest/search,
  memory store/recall, git branch/commit/merge.
- Integration: two agents acquire conflicting locks → one waits.

---

## Stage 5 — Orchestrator Core

**Goal:** The orchestrator maintains TODO state, dispatches agents, and
reacts to events. This is the brain.

**Deliverables:**
- `src/orchestrator/state.ts` — `OrchestratorState`, `TodoItem` types.
  Persistence to `~/.saivage/state/`. Load/save.
- `src/orchestrator/scheduler.ts` — Priority queue (P0–P3), user-activity
  tracking, idle detection.
- `src/orchestrator/branchManager.ts` — Create/merge branches per work item.
  Dual-project routing (`target` vs `self`).
- `src/orchestrator/mcpService.ts` — Orchestrator MCP service (`orch.*`
  tools): `get_state`, `get_todos`, `get_agents`, `submit_work`,
  `update_work`, `cancel_work`, `subscribe`.
- `src/orchestrator/orchestrator.ts` — The main event loop. Receives events,
  calls LLM with state + internal tools, executes decisions (todo_add,
  dispatch_agent, merge_branch, broadcast, etc.).

**Test:**
- Unit: state persistence round-trip.
- Unit: scheduler ordering (P0 > P1 > P2 > P3).
- Unit: event loop processes a `submit_work` → creates TODO → dispatches agent.
- Integration: submit a work request → orchestrator dispatches a Coder →
  Coder writes a file → orchestrator merges branch → file is on main.

---

## Stage 6 — Built-in Agent Types

**Goal:** Coder, Researcher, Executor, Planner agents with system prompts
and skill loading.

**Deliverables:**
- `src/agents/coder.ts` — System prompt, default skills (`coding`,
  `mcp-authoring`), tool patterns.
- `src/agents/researcher.ts` — System prompt, web + memory tools.
- `src/agents/executor.ts` — System prompt, shell + filesystem tools.
- `src/agents/planner.ts` — System prompt, outputs structured JSON plans.
- `src/skills/loader.ts` — Discover skills from `skills/`, `~/.saivage/skills/`,
  `./skills/`. Parse frontmatter, resolve triggers.
- `src/skills/resolver.ts` — Match skills to task by explicit list, agent
  defaults, trigger regex. Context budget enforcement.
- `skills/coding/SKILL.md` — Built-in coding skill.
- `skills/mcp-authoring/SKILL.md` — Built-in MCP authoring skill.
- `skills/research/SKILL.md` — Built-in research skill.
- `skills/planning/SKILL.md` — Built-in planning skill.

**Test:**
- Unit: skill loader finds skills from all three dirs.
- Unit: trigger matching.
- Integration: Coder agent with coding skill writes a function and tests it.
- Integration: Planner agent produces a valid plan JSON from a goal.

---

## Stage 7 — Chat Agent & Server

**Goal:** Users can connect and talk to Saivage. The full loop works.

**Deliverables:**
- `src/agents/chat.ts` — Chat sub-agent: read-only tools + orch.submit_work,
  event subscription, proactive updates.
- `src/channels/types.ts` — `ChatChannel` interface.
- `src/channels/cli.ts` — `CLIChannel` (stdin/stdout).
- `src/channels/websocket.ts` — `WebSocketChannel`.
- `src/server/server.ts` — Fastify HTTP + WebSocket server.
- `src/server/session.ts` — Session manager: creates Chat agent per connection.
- `src/server/routes.ts` — Health endpoint, admin/status REST routes.
- `src/index.ts` — Full CLI: `saivage` (start server), `saivage cli`
  (CLI chat), `saivage "<msg>"` (one-shot), all admin sub-commands.

**Test:**
- Integration: CLI chat → ask a question → get read-only answer.
- Integration: CLI chat → submit work → orchestrator dispatches agent →
  agent completes → chat shows result.
- Integration: WebSocket client connects, sends message, receives response.

**Milestone: Saivage is usable end-to-end via CLI.**

---

## Stage 8 — MCP Generator

**Goal:** The system can generate new MCP services when a tool is missing.

**Deliverables:**
- `src/generator/pipeline.ts` — Orchestrates: analyse → design → scaffold →
  implement → test → register.
- `src/generator/scaffold.ts` — Project skeleton from templates.
- `src/generator/codegen.ts` — Drives the Coder agent for implementation.
- `src/generator/tester.ts` — `pnpm install`, `tsc --noEmit`, `vitest run`
  with retry.
- `src/generator/templates/` — Handlebars templates for `index.ts`,
  `package.json`, `tsconfig.json`, tool stub, test stub.

**Test:**
- Integration: "I need a tool that reverses strings" → generator produces a
  working MCP service → service is registered → tool call works.
- Integration: agent reports `tool_missing` → orchestrator triggers generator
  → agent retries with new tool.

---

## Stage 9 — Security (Prompt Injection Defence)

**Goal:** External data is scanned before entering LLM context.

**Deliverables:**
- `src/security/scanner.ts` — `InjectionScanner`: pattern match + heuristics.
- `src/security/patterns.ts` — Pattern database.
- `src/security/delimiters.ts` — Wrap external content in `<external_data>`.
- `src/security/provenance.ts` — Content hash registry for self-generated
  exemption.
- `src/security/redactor.ts` — Secret redaction for logs.
- Integration into MCP Runtime (scan tool results), web service (scan fetched
  pages), file service (scan reads of non-self files).
- Audit log: `~/.saivage/audit.jsonl`.

**Test:**
- Unit: scanner detects known injection patterns.
- Unit: self-generated content bypasses scanner.
- Unit: delimiters wrap content correctly.
- Integration: fetched web page with injection attempt → content redacted.

---

## Stage 10 — Self-Modification Infrastructure

**Goal:** Saivage can safely modify its own components.

**Deliverables:**
- `src/sandbox/sandbox.ts` — Sandbox service: `start`, `run_tests`,
  `smoke_test`, `check_compat`, `promote`, `destroy`.
- `src/sandbox/contractTests.ts` — Schema comparison, I/O validation.
- `src/sandbox/secondaryInstance.ts` — Spawn + test a secondary Saivage.
- `src/versions/store.ts` — Version store: `list`, `get`, `rollback`, `prune`.
  Snapshot storage at `~/.saivage/versions/`.
- Hot-replacement in `src/mcp/runtime.ts` — drain → swap → verify → rollback.
- `src/watchdog/watchdog.ts` — Detached health-check process with auto-rollback.
- Dual-project routing in orchestrator branch manager.
- Self-modification sandbox gate in orchestrator event loop (§15 of 05-ORCHESTRATOR).

**Test:**
- Unit: version store snapshot/restore/prune.
- Unit: sandbox lifecycle (mocked service).
- Integration: generate a service → modify it → sandbox validates → hot-replace
  → old version in store → rollback works.
- Integration: watchdog detects simulated orchestrator failure → rolls back.

**CLI commands enabled:** `saivage versions`, `saivage sandbox`, `saivage watchdog`.

---

## Stage 11 — Vue Web Frontend

**Goal:** Browser-based chat UI with live status panel.

**Deliverables:**
- `web/` — Vue 3 + Vite + Tailwind + Pinia.
- `web/src/components/ChatWindow.vue` — Message list + input.
- `web/src/components/StatusPanel.vue` — Live TODO list, agent activity.
- `web/src/components/ProgressIndicator.vue` — Per-agent progress.
- `web/src/composables/useWebSocket.ts` — Connection management, auto-reconnect.
- Backend serves built `web/dist/` on the configured port.
- `saivage` command opens browser automatically.

**Test:**
- E2E: open browser → send message → receive response → see TODO updates.

---

## Stage 12 — Polish & Hardening

**Goal:** Production-ready for single-user operation.

**Deliverables:**
- Sub-orchestrators for complex multi-phase projects.
- Context window management (compaction at 80%).
- Agent pool (warm connections, reuse, eviction).
- Cost tracking per agent/work-item (`saivage usage`).
- First-run setup wizard.
- `saivage --resume <id>`.
- Generated skill creation (F6.6).
- Background self-improvement (UC-M9 pattern detection).

---

## Dependency Graph

```
Stage 0 ──► Stage 1 ──► Stage 2 ──► Stage 3 ──► Stage 4
                                         │           │
                                         ▼           ▼
                                     Stage 5 ◄───────┘
                                         │
                                    ┌────┼────┐
                                    ▼    ▼    ▼
                                 St 6  St 8  St 9
                                    │    │    │
                                    ▼    │    │
                                 Stage 7 │    │
                                    │    │    │
                                    ▼    ▼    ▼
                                   Stage 10
                                      │
                                      ▼
                                   Stage 11
                                      │
                                      ▼
                                   Stage 12
```

## Conventions

- **All code is ESM** (`"type": "module"` in package.json).
- **Strict TypeScript** (`strict: true`, no `any` unless unavoidable).
- **Zod** for all runtime validation (config, MCP schemas, event payloads).
- **Tests colocated** where practical (`*.test.ts` next to source), integration
  tests in `tests/`.
- **No classes unless state is needed** — prefer functions + closures.
- **Errors are typed** — custom error classes extending `Error` with `code`.
- **Logging** via a thin wrapper around `console` with level + context.
  Structured JSON to `~/.saivage/logs/`.
