# Saivage v2 — Subsystem Map (Review 2026-05)

**Scope**: `src/` (excluding `src/skills/`) and `web/src/`.
**Out of scope**: `src/skills/`, `SPEC/v2/skills-memory/`, `SPEC/v2/skills/` (covered by a separate agent).

This map orients the inventory phase. Each subsystem lists its responsibilities, the files that implement it, and notable boundary issues that motivated individual findings in `F##-*.md`.

---

## 1. Types & Configuration

**Responsibility**: Canonical Zod schemas for every on-disk document and the runtime config loader.

**Files**:
- [src/types.ts](src/types.ts) — schemas for `ProjectConfig`, `Plan`, `PlanHistory`, `Task`, `TaskList`, `TaskReport`, `StageSummary`, `UserNote`, `InspectionRequest/Report`, `SkillEntry/Index`, `RuntimeState`, `AgentState`, `ShutdownRequest`, `ShutdownSummary`, `ChatLog`, `SystemEvent`.
- [src/config.ts](src/config.ts) — `SaivageConfig` schema, `loadConfig`, `writeDefaultConfig`, `resolveProjectRoot`.

**Boundary observations**:
- Agent enums in `TaskSchema.assigned_to`, `TaskReportSchema.agent`, `AgentStateSchema.agent_type` and the dispatcher/supervisor maps are now all derived from [src/agents/roster.ts](src/agents/roster.ts) (F02 landed). F01 still owes reinstating Designer.
- `SaivageConfig` adds `security`, `supervisor`, `mcpServers`, `runtime.continuousImprovement` blocks not described in SPEC.
- Hardcoded model identifiers (`"anthropic/claude-sonnet-4-20250514"`, `"github-copilot/gpt-5.4"`) live inside the schema defaults.

---

## 2. Agents (`src/agents/`)

**Responsibility**: All LLM-driven actors. `BaseAgent` runs the conversation loop, calls the provider, executes tool calls through the dispatcher, and manages compaction. Each role adds its own system prompt and finalisation logic.

**Files**:
- [src/agents/base.ts](src/agents/base.ts) — 1012 lines. Loop, retries, compaction wiring, tool-result conversion, diagnostics buffer.
- [src/agents/types.ts](src/agents/types.ts) — `AgentRole`, context/result types.
- [src/agents/roster.ts](src/agents/roster.ts) — single declarative source of truth for every role (worker?, dispatch tool, dispatchableBy, tool filter, abort priority, self-check frequency, convention, default model key, prompt summary).
- [src/agents/worker.ts](src/agents/worker.ts) — `WorkerAgent` base class extended by Coder / Researcher / Data Agent / Reviewer.
- [src/agents/task-report.ts](src/agents/task-report.ts) — shared `normalizeTask`, `parseTaskReport`, `buildFailureReport` for the four worker roles (JSON regex at line 69).
- [src/agents/planner.ts](src/agents/planner.ts) — long-lived strategist, `MAX_NUDGES=15`, note injection.
- [src/agents/manager.ts](src/agents/manager.ts) — stage executor, stage decomposition, reviewer loop.
- [src/agents/coder.ts](src/agents/coder.ts), [researcher.ts](src/agents/researcher.ts), [data-agent.ts](src/agents/data-agent.ts), [reviewer.ts](src/agents/reviewer.ts) — worker agents (extend `WorkerAgent`).
- [src/agents/inspector.ts](src/agents/inspector.ts) — one-shot deep analysis; still extends `BaseAgent` (returns `InspectionReport`, not `TaskReport`).
- [src/agents/chat.ts](src/agents/chat.ts) — user-facing channel agent with slash commands.
- [src/agents/handoff.ts](src/agents/handoff.ts) — handoff-context formatter shared by initial messages.
- [src/agents/conventions.ts](src/agents/conventions.ts) — soft territory rules (warn-only).

**Boundary observations**:
- Inspector still duplicates its own `normalize…/parseInspectionReport/buildFailureReport`; the four `TaskReport`-producing workers now share `task-report.ts` (post-F09).
- Each role embeds a multi-hundred-line system prompt as a string literal inside the TypeScript module.

---

## 3. Runtime orchestration (`src/runtime/`)

**Responsibility**: Tool-call dispatch, recovery from crash, abort signalling, conversation compaction, supervisor loop, runtime state writer, ephemeral notes, stash for oversized tool results, shutdown handoff.

**Files**:
- [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts) — `DISPATCH_TOOLS`, `DISPATCH_ROLE_MAP`, parallel dispatch, `attachPendingNotesNotice`.
- [src/runtime/recovery.ts](src/runtime/recovery.ts) — runtime lock (O_EXCL), stale PID detection, double-write to legacy path.
- [src/runtime/abort.ts](src/runtime/abort.ts) — urgent-note scanner, working-tree reset helper.
- [src/runtime/compaction.ts](src/runtime/compaction.ts) — `chars/4` token estimator, summarisation fallback.
- [src/runtime/supervisor.ts](src/runtime/supervisor.ts) — LLM-based stuck detector, role-priority abort.
- [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts) — writes summary then deletes it after consumption.
- [src/runtime/notes.ts](src/runtime/notes.ts) — `NoteManager`, 2h volatile TTL.
- [src/runtime/stash.ts](src/runtime/stash.ts) — sidecar files for oversized tool results.
- [src/runtime/self-check.ts](src/runtime/self-check.ts) — per-role self-check schedule.

**Boundary observations**:
- Several constants (`MAX_NUDGES`, `MAX_CONSECUTIVE_INVALID`, `FORCE_CANCEL_DELAY_MS`, `RECOVERY_DELAY_MS`, `DEFAULT_VOLATILE_TTL_MS`, `MAX_OUTPUT`, `SHELL_TIMEOUT_MS`, `transientCap`) live inline rather than in `SaivageConfig`.
- Recovery writes runtime state twice: to `paths.runtimeState` and to a legacy `.saivage/runtime/runtime-state.json` mirror.
- Supervisor uses an LLM verdict, then runs a regex post-processor over the logs that can flip "stuck" back to "not stuck" — undermining its own verdict.

---

## 4. Providers & routing (`src/providers/`, `src/routing/`)

**Responsibility**: HTTP adapters for each provider, model-routing resolver, health/failover tracking.

**Files**:
- [src/providers/types.ts](src/providers/types.ts), [base.ts](src/providers/base.ts), [router.ts](src/providers/router.ts) — `ModelRouter`, health backoff, sticky failover, lazy `resolveApiKey`.
- [src/providers/anthropic.ts](src/providers/anthropic.ts), [openai.ts](src/providers/openai.ts), [openai-codex.ts](src/providers/openai-codex.ts), [copilot.ts](src/providers/copilot.ts), [openrouter.ts](src/providers/openrouter.ts), [ollama.ts](src/providers/ollama.ts), [llamacpp.ts](src/providers/llamacpp.ts), [pi-ai.ts](src/providers/pi-ai.ts).
- [src/providers/responses-ids.ts](src/providers/responses-ids.ts) — small id helpers.
- [src/providers/index.ts](src/providers/index.ts) — barrel.
- [src/routing/resolver.ts](src/routing/resolver.ts) — 4-source merge: routing → role override → runtime default → hardcoded default.

**Boundary observations**:
- `providers/index.ts` exports only 4 of the 8 providers; consumers must import the rest by deep path.
- `anthropic.maxContextTokens` and `openai.maxContextTokens` return a single hardcoded number regardless of model.
- `copilot.ts` hardcodes `GitHubCopilotChat/0.35.0` and `vscode/1.107.0` user-agent strings.
- `pi-ai.ts` uses `as any`/`as unknown as` extensively and synthesises missing model entries by cloning a sibling.

---

## 5. MCP services (`src/mcp/`)

**Responsibility**: In-process MCP runtime + tool registry, plus the built-in service implementations (filesystem, shell, git, web, plan, notes, skills, memory, index).

**Files**:
- [src/mcp/runtime.ts](src/mcp/runtime.ts) — `McpRuntime`, in-process tool registry, crash-failure threshold.
- [src/mcp/types.ts](src/mcp/types.ts) — service & tool entry shapes (no persistence).
- [src/mcp/builtins.ts](src/mcp/builtins.ts) — shell, fs, git, web tool implementations.
- [src/mcp/plan-server.ts](src/mcp/plan-server.ts) — plan/PlanHistory/Stage CRUD (re-reads from disk on every operation; no caching).
- [src/mcp/notes-server.ts](src/mcp/notes-server.ts) — `create_note` thin wrapper.
- [src/mcp/client.ts](src/mcp/client.ts) — `McpClient` wraps the SDK's stdio transport.
- [src/mcp/index.ts](src/mcp/index.ts) — barrel.

**Boundary observations**:
- Timeouts and limits (`IN_PROCESS_TIMEOUT_MS=5min`, `SHELL_TIMEOUT_MS=4h`, `MAX_OUTPUT=100KB`, `MAX_FETCH_CHARS=200KB`, `MAX_DOWNLOAD_BYTES=250MB`, `MAX_WALL_CLOCK_MS=3h59m30s`) are spread across files and coupled by subtraction (`SHELL_TIMEOUT_MS - 30s`).
- `MAX_WALL_CLOCK_MS` is computed as `SHELL_TIMEOUT_MS - 30s` — cross-file magic-number coupling.

---

## 6. Server & bootstrap (`src/server/`)

**Responsibility**: CLI entry, project initialisation, runtime bootstrap, Fastify app (REST + WebSocket + SPA static files + docs), Telegram bot.

**Files**:
- [src/server/bootstrap.ts](src/server/bootstrap.ts) — wiring, `createChildSpawner`, planner recovery loop, OAuth-token injection.
- [src/server/server.ts](src/server/server.ts) — Fastify HTTP server, REST endpoints, WebSocket chat session.
- [src/server/cli.ts](src/server/cli.ts) — commander CLI, `initProject` defaults.
- [src/server/telegram-bot.ts](src/server/telegram-bot.ts) — bot listener, allow-list bootstrap.

**Boundary observations**:
- `cli.ts` `initProject` writes a default project config that conflicts with `config.ts` defaults (different provider, different notifications channels).
- `bootstrap.injectOAuthTokens` overlaps with `router.resolveApiKey`'s lazy path; both can resolve OAuth tokens for the same provider call.
- `telegram-bot.ts` calls `getOrCreateSession(userId)` to pre-subscribe an allow-listed user — but uses `userId` as a chat id, which is wrong for group chats.

---

## 7. Channels (`src/channels/`)

**Responsibility**: I/O adapters for chat sessions: CLI, WebSocket, Telegram, one-shot.

**Files**:
- [src/channels/cli.ts](src/channels/cli.ts) — CLI channel implementation (unused: not registered by any server).
- [src/channels/websocket.ts](src/channels/websocket.ts) — server-side WS adapter for the SPA.
- [src/channels/telegram.ts](src/channels/telegram.ts) — Telegram channel + custom markdown→HTML converter.
- [src/channels/oneshot.ts](src/channels/oneshot.ts) — non-interactive one-shot.
- [src/channels/types.ts](src/channels/types.ts), [index.ts](src/channels/index.ts).

**Boundary observations**:
- `cli.ts` is never invoked from any bootstrap path; only the planner runs in long-running mode.
- `telegram.ts` reimplements Markdown→HTML conversion inline rather than using a vetted library; the conversion is lossy.

---

## 8. Authentication (`src/auth/`)

**Responsibility**: OAuth flows (PKCE for Anthropic + OpenAI Codex, device code for GitHub Copilot), profile store on disk.

**Files**:
- [src/auth/types.ts](src/auth/types.ts) — `AuthProfile`, `OAuthCredentials`.
- [src/auth/store.ts](src/auth/store.ts) — load/save profiles at `.saivage/auth-profiles.json` with `0o600`.
- [src/auth/anthropic.ts](src/auth/anthropic.ts), [openai-codex.ts](src/auth/openai-codex.ts), [github-copilot.ts](src/auth/github-copilot.ts) — provider-specific flows.
- [src/auth/pkce.ts](src/auth/pkce.ts) — PKCE helper.
- [src/auth/index.ts](src/auth/index.ts) — barrel.

**Boundary observations**:
- OAuth `CLIENT_ID` strings are embedded as source-level constants in three files; rotating them requires a rebuild.
- `oauthToProviderName` mapping in [src/auth/store.ts](src/auth/store.ts) collapses Anthropic OAuth → `anthropic` and OpenAI Codex OAuth → `openai`, but the router uses `openai-codex` as a distinct provider name.

---

## 9. Security (`src/security/`)

**Responsibility**: Pre-flight prompt-injection scan for retrieved web content.

**Files**:
- [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts) — calls a model for adjudication, hardcoded `BLOCK_PATTERNS` regex set, hardcoded `DEFAULT_SCAN_MODEL = "github-copilot/gpt-5.4"`.

**Boundary observations**:
- The regex blocklist will reliably flag legitimate documentation that discusses prompt-injection itself.
- Hardcoded scan model is duplicated with `supervisor.ts` and `config.ts` (`security.injectionModel`).

---

## 10. Events (`src/events/`)

**Responsibility**: In-process pub/sub bus consumed by the chat agent and HTTP endpoints.

**Files**:
- [src/events/bus.ts](src/events/bus.ts) — `EventBus` with default 5s handler timeout and 100-entry per-subscription buffer.

---

## 11. Document store (`src/store/`)

**Responsibility**: Atomic on-disk reads/writes of Zod-validated JSON documents, project root discovery.

**Files**:
- [src/store/documents.ts](src/store/documents.ts) — `readDoc`, `writeDoc`, `listDocs`, `sweepStaleTempFiles`. Synchronous `fs` everywhere.
- [src/store/project.ts](src/store/project.ts) — `ProjectContext`, `loadProject`, `initProject`.

**Boundary observations**:
- All disk I/O is synchronous, including `fsync` of file and parent directory; called inside Fastify request handlers and tight agent loops.

---

## 12. Web UI (`web/src/`)

**Responsibility**: Vue 3 SPA — five tabs (Dashboard, Plan, Agents, Files, Debug), polling/WS data hooks, API token plumbing.

**Files**:
- [web/src/main.ts](web/src/main.ts) — imports `./styles/index.css` only.
- [web/src/App.vue](web/src/App.vue) — tab shell, hotkeys, title sync (8s polling).
- [web/src/styles/index.css](web/src/styles/index.css), [tokens.css](web/src/styles/tokens.css), [semantic.css](web/src/styles/semantic.css), [base.css](web/src/styles/base.css), [patterns.css](web/src/styles/patterns.css) — current stylesheet pipeline.
- [web/src/styles.css](web/src/styles.css) — **orphan**: not imported by anything (`main.ts` imports `./styles/index.css`).
- [web/src/composables/useWebSocket.ts](web/src/composables/useWebSocket.ts) — WS client with auth-aware reconnect.
- [web/src/utils/api.ts](web/src/utils/api.ts) — token resolution + fetch wrapper.
- [web/src/utils/toolFormatters.ts](web/src/utils/toolFormatters.ts) — per-tool result renderers for the Agents view.
- [web/src/components/](web/src/components/) — `AgentsView.vue`, `ChatWindow.vue`, `PlanView.vue`, `FilesView.vue`, `DebugView.vue`, `StatusPanel.vue`, `FormattedContent.vue`, `JsonHighlight.vue`.

**Boundary observations**:
- The orphan `styles.css` predates the `styles/` split and is now dead code at the bundler level.
- Both `App.vue` and `useWebSocket.ts` independently treat HTTP 401 / WS 1008 as auth-failure terminal states — the same logic exists in two places.
