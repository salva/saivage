# Saivage v2 — Subsystem Map (Review 2026-05 Round 2)

**Scope**: `src/` (excluding `src/skills/`, `src/knowledge/` skills internals owned by the concurrent skills/memory agent) and `web/src/`.
**Snapshot date**: 2026-05-24, after batches 1–7 of [../review-2026-05/99-METAPLAN.md](../review-2026-05/99-METAPLAN.md) landed.

Round-1 reference: [../review-2026-05/00-SUBSYSTEM-MAP.md](../review-2026-05/00-SUBSYSTEM-MAP.md). This map is structural only — no findings, no fixes.

---

## 1. Top-level architecture

```
                       +--------------------------------------------+
                       |                CLI / server                |
                       |  src/server/{cli,bootstrap,server,         |
                       |              telegram-bot}                 |
                       +----+--------------------+------------------+
                            |                    |
                  bootstrap |                    | HTTP / WS / Telegram
                            v                    v
        +-------------------+-------+   +--------+-------------------+
        |    Runtime orchestration  |   |        Channels            |
        |   src/runtime/*           |<->|   src/channels/{websocket, |
        |   (recovery, dispatcher,  |   |             telegram}      |
        |    supervisor, notes,     |   +--------+-------------------+
        |    compaction, abort,     |            |
        |    stash, shutdown,       |   +--------v-------------------+
        |    token-counting,        |   |          Chat              |
        |    self-check)            |   |  src/chat/{localCommands,  |
        +----+---------+------------+   |            slashCommands,  |
             |         |                |          validate-stage-id}|
             |         |                +--------+-------------------+
             v         v                         |
    +--------+--+   +--+--------------+          |
    |  Agents   |   |   MCP runtime   |<---------+
    | src/agents/   | src/mcp/*       |
    | (roster,  |   | (runtime,       |
    |  base,    |   |  builtins,      |
    |  worker,  |   |  plan-server,   |
    |  planner, |   |  notes-server,  |
    |  manager, |   |  knowledgeMemory|
    |  coder,   |   |  knowledgeSkills|
    |  reviewer,|   |  toolContext,   |
    |  designer,|   |  client)        |
    |  data,    |   +--+--------------+
    |  researcher| |    |
    |  inspector,| |    | tool-context
    |  chat,    |   |    v
    |  handoff, |   |   +-+-----------+
    |  conventns,   |   |  Store      |
    |  prompts, |   |   |  src/store/ |
    |  task-rpt)|   |   +-+-----------+
    +-+---------+   |     |
      |             |     v
      v             |   +-+-----------+
    +-+----------+  |   |  Knowledge  |
    |  Providers |  |   |  src/knowledge/
    |  src/providers/  +-+-----------+
    |  (router,  |  |
    |   anthropic,  |
    |   openai,  |
    |   openai-codex|
    |   copilot, |  |
    |   ollama,  |  |
    |   llamacpp,|  |
    |   openrouter, |
    |   pi-ai,   |  |
    |   base,    |  |
    |   error,   |  |
    |   types,   |  |
    |   model-caps) |
    +-+----------+  |
      |             |
      v             v
    +-+----------+ +-+-----------+ +-------------+
    |  Routing   | |  Security   | |   Events    |
    |  src/      | |  src/       | |  src/events/|
    |  routing/  | |  security/  | |  (EventBus) |
    |  resolver  | |  (cop,      | +-------------+
    +------------+ |   secrets)  |
                   +-------------+
    +-------------+ +-------------+ +-------------+
    |   Auth      | |  Config &   | | repo-layout |
    | src/auth/   | |   Types     | | src/repo-   |
    | (anthropic, | | src/{       | |  layout/    |
    |  openai-    | |  config,    | | (project-   |
    |  codex,     | |  config-    | |  agnostic   |
    |  github-    | |  validation,| |  contract)  |
    |  copilot,   | |  types,     | +-------------+
    |  store,     | |  index,     |
    |  defaults,  | |  ids, log}  |
    |  pkce)      | +-------------+
    +-------------+
```

Web UI (`web/src/`) consumes the HTTP/WS surface exposed by `src/server/server.ts`. It is a standalone Vue 3 SPA bundled by Vite and served from the Fastify static handler.

---

## 2. Subsystem table

| Subsystem | Purpose | Key files | Public surface | Depends on |
|---|---|---|---|---|
| Types & config | Zod schemas for every on-disk document; runtime config loader; validation that every routed role has a model. | [src/types.ts](../../../src/types.ts), [src/config.ts](../../../src/config.ts), [src/config-validation.ts](../../../src/config-validation.ts), [src/index.ts](../../../src/index.ts), [src/ids.ts](../../../src/ids.ts), [src/log.ts](../../../src/log.ts) | `SaivageConfig`, `loadConfig`, `configPath`, `validateModelCoverage`, `MissingModelForRoleError`, all document schemas re-exported via [src/index.ts](../../../src/index.ts). | Zod; consumed by every other subsystem. |
| Shared LLM-JSON parser | Tolerant JSON extraction shared by workers, supervisor, inspector, security cop. | [src/parse-llm-json.ts](../../../src/parse-llm-json.ts) | `extractJsonCandidates`, `parseLlmJson`, `parseLlmJsonAs`. | (none) |
| Agents | All LLM-driven actors. `BaseAgent` runs the conversation loop, calls the provider, executes tool calls via the dispatcher, and manages compaction. `WorkerAgent` is the shared base for the four task-report producers. `roster.ts` is the single source of truth for role enums, dispatch tools, conventions, abort priorities, self-check frequencies, and default model keys. Prompts are externalized to `prompts/`. | [src/agents/roster.ts](../../../src/agents/roster.ts), [src/agents/base.ts](../../../src/agents/base.ts), [src/agents/worker.ts](../../../src/agents/worker.ts), [src/agents/task-report.ts](../../../src/agents/task-report.ts), [src/agents/prompts.ts](../../../src/agents/prompts.ts), [src/agents/types.ts](../../../src/agents/types.ts), [src/agents/handoff.ts](../../../src/agents/handoff.ts), [src/agents/conventions.ts](../../../src/agents/conventions.ts), [src/agents/planner.ts](../../../src/agents/planner.ts), [src/agents/manager.ts](../../../src/agents/manager.ts), [src/agents/coder.ts](../../../src/agents/coder.ts), [src/agents/reviewer.ts](../../../src/agents/reviewer.ts), [src/agents/designer.ts](../../../src/agents/designer.ts), [src/agents/researcher.ts](../../../src/agents/researcher.ts), [src/agents/data-agent.ts](../../../src/agents/data-agent.ts), [src/agents/inspector.ts](../../../src/agents/inspector.ts), [src/agents/chat.ts](../../../src/agents/chat.ts) | `BaseAgent`, `WorkerAgent`, `*Agent` classes, `ROSTER`, `AgentRole`, `WorkerRole`, `DispatchableRole`, `WORKER_ROLES`, `ALL_ROLES`, `assertExhaustive`, `loadRolePrompt`, `parseTaskReport`, `normalizeTask`, `buildFailureReport`, `buildHandoffContext`. | providers, runtime, mcp, knowledge, parse-llm-json, repo-layout (via conventions). |
| Runtime orchestration | Tool-call dispatch, crash recovery + lock, abort signalling, compaction, supervisor loop, runtime-state writer, ephemeral note manager, stash for oversize tool results, shutdown handoff, tiktoken-backed token counting. | [src/runtime/dispatcher.ts](../../../src/runtime/dispatcher.ts), [src/runtime/recovery.ts](../../../src/runtime/recovery.ts), [src/runtime/abort.ts](../../../src/runtime/abort.ts), [src/runtime/compaction.ts](../../../src/runtime/compaction.ts), [src/runtime/supervisor.ts](../../../src/runtime/supervisor.ts), [src/runtime/notes.ts](../../../src/runtime/notes.ts), [src/runtime/stash.ts](../../../src/runtime/stash.ts), [src/runtime/self-check.ts](../../../src/runtime/self-check.ts), [src/runtime/shutdown-handoff.ts](../../../src/runtime/shutdown-handoff.ts), [src/runtime/token-counting.ts](../../../src/runtime/token-counting.ts) | `Dispatcher`, `DISPATCH_TOOLS`, `ChildSpawner`, `recoverFromCrash`, `acquireRuntimeLock`, `writeRuntimeState`, `RuntimeTracker`, `RuntimeSupervisor`, `NoteManager`, `stashResult`, `readStash`, `cleanStash`, `consumeShutdownHandoff`, `writeShutdownSummary`, `countWithTiktoken`, `countTextWithTiktoken`. | agents/roster (`DispatchableRole`), providers/types, mcp/runtime, store/documents, store/project, config. |
| Providers | HTTP adapters for each provider; typed `ProviderError`; per-model `ModelCapabilities { contextWindow, tokenEncoding }`; model-router with health backoff and lazy `resolveApiKey`. | [src/providers/router.ts](../../../src/providers/router.ts), [src/providers/base.ts](../../../src/providers/base.ts), [src/providers/types.ts](../../../src/providers/types.ts), [src/providers/error.ts](../../../src/providers/error.ts), [src/providers/openai.ts](../../../src/providers/openai.ts), [src/providers/copilot.ts](../../../src/providers/copilot.ts), [src/providers/copilot-client-headers.ts](../../../src/providers/copilot-client-headers.ts), [src/providers/ollama.ts](../../../src/providers/ollama.ts), [src/providers/llamacpp.ts](../../../src/providers/llamacpp.ts), [src/providers/pi-ai.ts](../../../src/providers/pi-ai.ts), [src/providers/pi-ai-types.ts](../../../src/providers/pi-ai-types.ts), [src/providers/responses-ids.ts](../../../src/providers/responses-ids.ts) | `ModelRouter`, `ModelProvider`, `ProviderError`, `classifyProviderError`, `BaseProvider`, `parseModelId`, `OpenAIProvider` (inheritance base for `OllamaProvider`/`LlamaCppProvider`), `CopilotProvider`, `OllamaProvider`, `LlamaCppProvider`, `PiAiProvider`, `piGetModel`, `piGetModels`, `UnknownModelError`. | auth (lazy OAuth token resolution), routing/resolver, config-validation. |
| Routing | Four-source merge (runtime-routing → role override → runtime default → roster default) producing a `ModelSpec` per role. | [src/routing/resolver.ts](../../../src/routing/resolver.ts) | `ModelRoutingResolver`, `parseAccountRef`, `RuntimeProviderConfigLike`, `RuntimeProviderAccountLike`. | agents/roster, config-validation, config. |
| MCP services | In-process MCP runtime + tool registry; built-in services (shell, fs, git, web, repo-layout enforcement, write-guard); plan/PlanHistory/Stage CRUD with in-memory cache; ephemeral notes server; skills/memory knowledge servers; tool-context helper; SDK stdio client. | [src/mcp/runtime.ts](../../../src/mcp/runtime.ts), [src/mcp/types.ts](../../../src/mcp/types.ts), [src/mcp/builtins.ts](../../../src/mcp/builtins.ts), [src/mcp/plan-server.ts](../../../src/mcp/plan-server.ts), [src/mcp/notes-server.ts](../../../src/mcp/notes-server.ts), [src/mcp/knowledgeSkills.ts](../../../src/mcp/knowledgeSkills.ts), [src/mcp/knowledgeMemory.ts](../../../src/mcp/knowledgeMemory.ts), [src/mcp/toolContext.ts](../../../src/mcp/toolContext.ts), [src/mcp/client.ts](../../../src/mcp/client.ts), [src/mcp/index.ts](../../../src/mcp/index.ts) | `McpRuntime`, `RuntimeToolEntry`, `ServiceEntry`, `ToolEntry`, `registerBuiltinServices`, `PlanService`, `NoteService`, `McpClient`. | store/documents, store/project, knowledge/lifecycle, security/prompt-injection-cop, security/secrets, repo-layout/contract, config. |
| Knowledge | Persistent skills/memory store, lifecycle (archive on stage close), eager-loading helpers, concurrency/permissions guards. Skills internals (`src/skills/`) are out of scope; this row covers the integration surface used by MCP and agents. | [src/knowledge/store.ts](../../../src/knowledge/store.ts), [src/knowledge/lifecycle.ts](../../../src/knowledge/lifecycle.ts), [src/knowledge/eagerLoader.ts](../../../src/knowledge/eagerLoader.ts), [src/knowledge/loader.ts](../../../src/knowledge/loader.ts), [src/knowledge/permissions.ts](../../../src/knowledge/permissions.ts), [src/knowledge/types.ts](../../../src/knowledge/types.ts) | `buildSurvivorBlock`, `archiveStage`, `KnowledgeAgentRole`, `SkillMatchContext`, store readers/writers. | store/documents, types. |
| Store | Atomic Zod-validated JSON doc I/O (now async via `node:fs/promises`); project root discovery; `seedProject` for new project trees. | [src/store/documents.ts](../../../src/store/documents.ts), [src/store/project.ts](../../../src/store/project.ts) | `readDoc`, `readDocOrNull`, `readDocLenient`, `readJsonOrNull`, `writeDoc`, `renameDoc`, `listDocs`, `ensureDir`, `pathExists`, `sweepStaleTempFiles`, `loadProject`, `seedProject`, `initProjectTree`, `ProjectContext`. | types (Zod schemas). |
| Security | LLM-only prompt-injection cop (fail-open) and secrets redactor for tool output / chat surfaces. | [src/security/prompt-injection-cop.ts](../../../src/security/prompt-injection-cop.ts), [src/security/secrets.ts](../../../src/security/secrets.ts) | `PromptInjectionCop`, `createPromptInjectionCop`, `disabledCop`, `PromptInjectionScanResult`, secrets redaction helpers. | providers/router, providers/types, config-validation, parse-llm-json. |
| Events | In-process pub/sub bus consumed by the chat agent and HTTP endpoints. | [src/events/bus.ts](../../../src/events/bus.ts) | `EventBus`. | types (`SystemEvent`). |
| Authentication | OAuth flows (Anthropic + OpenAI-Codex PKCE, GitHub-Copilot device code) with on-disk profile store and centralized defaults (client ids configurable via `SaivageConfig.oauth.*`). | [src/auth/anthropic.ts](../../../src/auth/anthropic.ts), [src/auth/openai-codex.ts](../../../src/auth/openai-codex.ts), [src/auth/github-copilot.ts](../../../src/auth/github-copilot.ts), [src/auth/store.ts](../../../src/auth/store.ts), [src/auth/defaults.ts](../../../src/auth/defaults.ts), [src/auth/types.ts](../../../src/auth/types.ts), [src/auth/pkce.ts](../../../src/auth/pkce.ts), [src/auth/index.ts](../../../src/auth/index.ts) | `getOAuthApiKey`, `getProfileByKey`, `hasOAuthCredentials`, `loadAuthProfiles`, `saveAuthProfile`, `AuthProfile`, `OAuthCredentials`, OAuth driver functions. | config, types. |
| Channels | Server-side I/O adapters for chat sessions. Only WebSocket (SPA) and Telegram remain; CLI / one-shot / barrel were deleted (F35). | [src/channels/websocket.ts](../../../src/channels/websocket.ts), [src/channels/telegram.ts](../../../src/channels/telegram.ts), [src/channels/types.ts](../../../src/channels/types.ts) | `WebSocketChannel`, `TelegramChannel`, channel interface types. | agents/chat, events/bus, server/server, server/telegram-bot. |
| Chat | Local (non-LLM) slash-command surface used by `ChatAgent`: registry of `LOCAL_COMMAND_HANDLERS`, parser, stage-id validator. Skills/memory slash family lives in `src/chat/slashCommands.ts` (boundary owned by the concurrent agent). | [src/chat/localCommands.ts](../../../src/chat/localCommands.ts), [src/chat/slashCommands.ts](../../../src/chat/slashCommands.ts), [src/chat/validate-stage-id.ts](../../../src/chat/validate-stage-id.ts) | `LOCAL_COMMAND_HANDLERS`, `LocalChatCommandName`, `parseSlashCommand`, `runSlashCommand`, `validateStageId`. | agents/types, runtime/notes (via handlers), config (for prompt-table rendering). |
| Server & bootstrap | CLI entry, project initialisation, runtime bootstrap (provider/router/MCP/agents/recovery wiring), Fastify HTTP + WS + SPA + docs, Telegram bot listener. | [src/server/cli.ts](../../../src/server/cli.ts), [src/server/bootstrap.ts](../../../src/server/bootstrap.ts), [src/server/server.ts](../../../src/server/server.ts), [src/server/telegram-bot.ts](../../../src/server/telegram-bot.ts) | `bootstrap`, `createServer`, `startTelegramBot`, CLI subcommands (`serve`, `init`, `login`, …). | all of the above. |
| repo-layout contract | Project-agnostic loader for the optional `.saivage/repo-layout.json` (topics → artifact_dir / stage_id regex / new_stages_allowed); enforced by MCP write tools and consulted by conventions. | [src/repo-layout/contract.ts](../../../src/repo-layout/contract.ts), [src/repo-layout/validate-stage-id.ts](../../../src/repo-layout/validate-stage-id.ts) | `loadRepoLayout`, `validateStageId`, contract types. | store/documents (only). |
| Web UI | Vue 3 SPA — five tabs (Dashboard, Plan, Agents, Files, Debug), polling + WS data hooks, shared auth-state composable, API token plumbing, time/markdown formatters. | [web/src/main.ts](../../../web/src/main.ts), [web/src/App.vue](../../../web/src/App.vue), [web/src/components/AgentsView.vue](../../../web/src/components/AgentsView.vue), [web/src/components/ChatWindow.vue](../../../web/src/components/ChatWindow.vue), [web/src/components/PlanView.vue](../../../web/src/components/PlanView.vue), [web/src/components/FilesView.vue](../../../web/src/components/FilesView.vue), [web/src/components/DebugView.vue](../../../web/src/components/DebugView.vue), [web/src/components/StatusPanel.vue](../../../web/src/components/StatusPanel.vue), [web/src/components/FormattedContent.vue](../../../web/src/components/FormattedContent.vue), [web/src/components/JsonHighlight.vue](../../../web/src/components/JsonHighlight.vue), [web/src/composables/useAuthState.ts](../../../web/src/composables/useAuthState.ts), [web/src/composables/useWebSocket.ts](../../../web/src/composables/useWebSocket.ts), [web/src/utils/api.ts](../../../web/src/utils/api.ts), [web/src/utils/toolFormatters.ts](../../../web/src/utils/toolFormatters.ts), [web/src/utils/markdown.ts](../../../web/src/utils/markdown.ts), [web/src/utils/time.ts](../../../web/src/utils/time.ts), [web/src/styles/index.css](../../../web/src/styles/index.css), [web/src/styles/tokens.css](../../../web/src/styles/tokens.css), [web/src/styles/semantic.css](../../../web/src/styles/semantic.css), [web/src/styles/base.css](../../../web/src/styles/base.css), [web/src/styles/patterns.css](../../../web/src/styles/patterns.css) | SPA bundle (`dist/web/`) consumed by Fastify static handler. | Fastify HTTP + WS surface. |
| Externalized prompts | Per-role system prompts shipped from `prompts/` by `tsup` (loaded via `loadRolePrompt`). | [prompts/planner.md](../../../prompts/planner.md), [prompts/manager.md](../../../prompts/manager.md), [prompts/coder.md](../../../prompts/coder.md), [prompts/reviewer.md](../../../prompts/reviewer.md), [prompts/designer.md](../../../prompts/designer.md), [prompts/researcher.md](../../../prompts/researcher.md), [prompts/data-agent.md](../../../prompts/data-agent.md), [prompts/inspector.md](../../../prompts/inspector.md), [prompts/chat.md](../../../prompts/chat.md), [prompts/shared/execution-style.md](../../../prompts/shared/execution-style.md) | Loaded at runtime by `src/agents/prompts.ts`; `{{slash_commands_table}}` substituted from `LOCAL_CHAT_COMMANDS`. | agents/prompts, chat/localCommands. |

---

## 3. What changed since round-1 (2026-05)

### New files

- [src/parse-llm-json.ts](../../../src/parse-llm-json.ts) — shared LLM-JSON parser (F03). Consumed by every worker, supervisor, inspector, prompt-injection cop.
- [src/config-validation.ts](../../../src/config-validation.ts) — boot-time model-coverage check (F04). Exports `MissingModelForRoleError`, `validateModelCoverage`.
- [src/runtime/token-counting.ts](../../../src/runtime/token-counting.ts) — tiktoken backend (F07).
- [src/agents/worker.ts](../../../src/agents/worker.ts), [src/agents/task-report.ts](../../../src/agents/task-report.ts) — shared `WorkerAgent` base + report helpers (F09). Coder/Researcher/Data-Agent/Reviewer all extend `WorkerAgent`.
- [src/agents/prompts.ts](../../../src/agents/prompts.ts) and [prompts/](../../../prompts/) tree — externalized role prompts with shared partials (F18, closes F31).
- [src/agents/designer.ts](../../../src/agents/designer.ts) — reinstated as a `WorkerAgent` subclass (F01); also added to `ROSTER`, `bootstrap.ts`, dispatcher, self-check.
- [src/providers/error.ts](../../../src/providers/error.ts) — typed `ProviderError` classified at the provider boundary (F13).
- [src/providers/pi-ai-types.ts](../../../src/providers/pi-ai-types.ts) — concentrated pi-ai casts (`piGetModel`, `piGetModels`, `UnknownModelError`) (F29).
- [src/providers/copilot-client-headers.ts](../../../src/providers/copilot-client-headers.ts) — operator-configurable Copilot headers (F21).
- [src/auth/defaults.ts](../../../src/auth/defaults.ts) — central OAuth client-id defaults (F27).
- [src/chat/localCommands.ts](../../../src/chat/localCommands.ts) — exhaustive `LOCAL_COMMAND_HANDLERS` registry (F30). `cmdNote` / `cmdRestartPlanner` moved out of `ChatAgent`.
- [src/chat/validate-stage-id.ts](../../../src/chat/validate-stage-id.ts) — stage-id validation shared by chat commands and MCP plan tools.
- [src/security/secrets.ts](../../../src/security/secrets.ts) — secrets redactor.
- [src/repo-layout/contract.ts](../../../src/repo-layout/contract.ts), [src/repo-layout/validate-stage-id.ts](../../../src/repo-layout/validate-stage-id.ts) — generic, project-agnostic repo-layout contract loader (consumed by MCP write guard).
- [web/src/composables/useAuthState.ts](../../../web/src/composables/useAuthState.ts) — single source of truth for SPA auth state (F26). `App.vue` and `useWebSocket.ts` consume it instead of duplicating `"unauthorized"` paths.
- [web/src/utils/markdown.ts](../../../web/src/utils/markdown.ts), [web/src/utils/time.ts](../../../web/src/utils/time.ts) — shared formatters.

### Deleted files

- `src/providers/index.ts` — incomplete barrel removed (F19). All consumers use deep imports.
- `src/mcp/registry.ts` — moved `ServiceEntry` / `ToolEntry` to [src/mcp/types.ts](../../../src/mcp/types.ts); dropped `status` field and `"generated"` origin variant (F28).
- `src/mcp/fsGuard.ts` — write-guard logic folded into [src/mcp/builtins.ts](../../../src/mcp/builtins.ts); only the regression test [src/mcp/fsGuard.test.ts](../../../src/mcp/fsGuard.test.ts) remains, exercising `registerBuiltinServices`.
- `src/channels/cli.ts`, `src/channels/oneshot.ts`, `src/channels/index.ts` — unused (F35). Only `websocket.ts` and `telegram.ts` ship now.
- `web/src/styles.css` — orphan removed (F10).

### Renamed / restructured

- `initProject` → `seedProject` in [src/store/project.ts](../../../src/store/project.ts) (F33). `ProjectConfig` trimmed to project-scoped fields; `project-default` source removed from `ModelRoutingResolver`.
- `legacyRuntimeStatePath` and its mirror write deleted from [src/runtime/recovery.ts](../../../src/runtime/recovery.ts) (F08).
- `__saivage_pending_user_notes` tool-result contamination replaced with `InputChannel { drain, onContextReset }` on `BaseAgent`; `NoteChannel` is the only producer (F06).
- `injectOAuthTokens`, `OAUTH_TO_PI`, `oauthToProviderName` removed from bootstrap; `ModelRouter.resolveApiKey` is now the only OAuth path (F15).
- `BLOCK_PATTERNS` / `SUSPICIOUS_PATTERNS` / `scanHeuristically` deleted from [src/security/prompt-injection-cop.ts](../../../src/security/prompt-injection-cop.ts) (F25). Cop is LLM-only with fail-open.
- `normalizeNonStuckOperationalVerdict` and `looksLike*` predicates deleted from [src/runtime/supervisor.ts](../../../src/runtime/supervisor.ts) (F05).
- `cmdHelp` deleted; help table rendered from `LOCAL_CHAT_COMMANDS` and shared `MEMORY_SKILL_HELP_ROWS` (F30, cross-boundary with skills agent).
- Telegram bespoke Markdown→HTML replaced by `telegramify-markdown` (F17).
- `PlanService` gained in-memory plan + history cache; `init()` loads from disk, mutations write through (F34).
- Consumed shutdown-handoff files are renamed to `${path}.consumed` instead of deleted (F24); `renameDoc` primitive added to [src/store/documents.ts](../../../src/store/documents.ts).
- All of [src/store/documents.ts](../../../src/store/documents.ts) is now async (`node:fs/promises`); `await` cascaded through bootstrap, plan/notes services, agent factories, shutdown handoff, fatal handler (F22).
- Per-model `ModelCapabilities { contextWindow, tokenEncoding }` replaces `maxContextTokens(model)`; `BaseProvider.countTokens` reads encoding from it (F20, supersedes the per-provider overrides briefly added by F07).
- `ROLE_ABORT_PRIORITY` is now a typed `Record<AgentRole, number>` derived from `ROSTER`; `ChatAgent` registered at both WebSocket and Telegram construction sites (F23).
- `prompts/` shipped via `tsup`; `BaseAgentConfig.systemPrompt` JSDoc updated to reference `loadRolePrompt` (F31).

### Surprises vs round-1

- A new top-level subsystem `src/repo-layout/` exists that round-1 did not list. It is project-agnostic and consumed by the MCP write-guard rather than by agents directly.
- `src/security/secrets.ts` is new and not tracked by any of the round-1 findings.
- `src/chat/validate-stage-id.ts` is a small new shared module bridging chat command parsing and MCP plan tools.

---

## 4. Pointers

- [SPEC/v2/00-AGENT-SYSTEM.md](../00-AGENT-SYSTEM.md) — agent roles and lifecycle.
- [SPEC/v2/01-DATA-MODEL.md](../01-DATA-MODEL.md) — on-disk document model.
- [SPEC/v2/04-RUNTIME-DETAILS.md](../04-RUNTIME-DETAILS.md) — runtime orchestration internals.
- [SPEC/v2/05-MCP-SERVICES.md](../05-MCP-SERVICES.md) — MCP tool catalogue.
- [SPEC/v2/06-SYSTEM-DESIGN.md](../06-SYSTEM-DESIGN.md) — top-level system design.
- [docs/guide/config-runtime.md](../../../docs/guide/config-runtime.md) — canonical operator prose for `SaivageConfig`.
