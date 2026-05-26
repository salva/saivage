# Round-2 Metaplan — saivage v2 systematic review (2026-05)

## 1. Executive summary

Round 2 produced 42 APPROVED findings (G01–G13, G20–G38, G40–G50) plus two supersessions (G12→G12b, G35→G35b), three subsumptions (G02/G03/G04 under G01; G39 under G38), and one deferral ([G51-partial-bootstrap-teardown.md](G51-partial-bootstrap-teardown.md)). This metaplan groups them into 14 execution batches whose order is driven by five hard sequencing chains (router, resolver, plan-server, builtins async-fs, web-types-before-decomposition) and three new project-wide principles (slash-only intent, config over hardcoded, no agent-tool-call heuristics). Each batch lists its prerequisites, files touched, validation gate, and daemon-restart impact so the executing agent can land them as atomic commit sets without re-deriving the dependency graph.

## 2. New project-wide principles (2026-05-26)

- **P1 — No regex for parsing user intent.** Only structured slash commands or typed tool calls. Shapes findings: [G09/APPROVED.md](G09/APPROVED.md) (`PLAN_COMPLETE` text → `plan_done` MCP tool), [G11/APPROVED.md](G11/APPROVED.md) (delete fuzzy restart heuristic, keep `/restart-planner`), [G47/APPROVED.md](G47/APPROVED.md) (literal `/subscribe` / `/unsubscribe`), [G49/APPROVED.md](G49/APPROVED.md) (Zod envelope schema at both WS boundaries).
- **P2 — Avoid hardcoded values; what can live in a config file should live in a config file.** Shapes findings: [G35b/APPROVED.md](G35b/APPROVED.md) (credential-lexeme + suffix lists moved out of `src/security/secrets.ts` into the saivage.json schema; supersedes G35), and is the explicit grep gate for every other batch (no new module-level constant tables that an operator would plausibly want to tune).
- **P3 — No fragile agent-tool-call heuristics; treat agents as adults.** Shapes findings: [G12b/APPROVED.md](G12b/APPROVED.md) (delete the prompt-injection cop, the `scanUntrustedText` boundary, the `security: { ... }` config block, the `/api/debug/security` route, the DebugView Security tab; supersedes G12). Also reinforces G09/G11/G47/G49 above — none of those re-introduce a "did the agent call X?" classifier.

These principles are the reason G12 and G35 were re-opened after r2+ approvals: G12's design retained the cop and merely hardened its failure surface (violates P3); G35 encoded the credential corpus as module constants (violates P2). The metaplan ships G12b and G35b in place of the originals; G12 and G35 APPROVED.md files are marked DISAPPROVED-superseded but kept on disk as audit trail.

## 3. Inventory

Severities are copied from each finding's analysis header. "Chosen" is the one-line summary of the approved proposal; full design + plan references live behind the linked `APPROVED.md`. Subsumed findings (G02, G03, G04, G39) and superseded findings (G12, G35) are listed at the bottom for completeness. Deferred: G51 (see §6).

| ID | sev | subsystem | chosen proposal (one line) | depends-on | batch |
|----|-----|-----------|----------------------------|------------|-------|
| [G01](G01/APPROVED.md) | high | agents/roster | Derive role policy from `ROSTER` via four pure accessors in `src/agents/tool-filters.ts`; delete hand-rolled parallel tables (subsumes G02/G03/G04). | — | B5 |
| [G05](G05/APPROVED.md) | medium | agents/worker | Single `WorkerAgent.createWorker<T>` factory; `ROSTER.workerInit` owns initial-message metadata; bodyless pure-worker subclasses; compile-time + runtime cross-checks. | G01 | B5 |
| [G06](G06/APPROVED.md) | medium | runtime/stash | In-place `fs/promises` migration of `src/runtime/stash.ts`; reuse `noSyncFsScanner` from G30; no shared lock primitive. | G30 | B4 |
| [G07](G07/APPROVED.md) | medium | agents/compaction | `parseRounds` walker builds atomic `TextRound`/`ToolRound`; `selectKeptRounds` against projected outbound cost; bounded fallback; runtime exposes `active_agents[*].compaction`. | G01,G05 | B5 |
| [G08](G08/APPROVED.md) | medium | store/project | Export `SaivageConfigSchema`; replace the 28-line handwritten seed literal with `writeDoc(..., SaivageConfigSchema.parse({}), schema)`. | — | B11 |
| [G09](G09/APPROVED.md) | medium | agents/planner | Replace `PLAN_COMPLETE` text marker with `plan_done(reason)` MCP tool; `detectTerminalToolCall` hook on `BaseAgent`; abort precedence re-checked after tool dispatch. (P1) | G01,G05,G07 | B5 |
| [G10](G10/APPROVED.md) | low-medium | store/documents | Delete `appendDoc` and its tests; rewrite the round-trip test to use `writeDoc`; regenerate API docs via TypeDoc. | — | B11 |
| [G11](G11/APPROVED.md) | medium | agents/chat | Delete the multilingual restart heuristic; keep `/restart-planner`; rewrite five `prompts/chat.md` directives. (P1) | — | B9 |
| [G12b](G12b/APPROVED.md) | medium | security | DELETE the prompt-injection cop, `scanUntrustedText`, the `security: { ... }` config block, `/api/debug/security`, `SecurityStatusRing`, DebugView Security tab; Zod `.strict()` rejects stale blocks. (P3, supersedes G12) | — | B9 |
| [G13](G13/APPROVED.md) | low | chat/conventions | Extract `LocalChatCommand` + registry into `src/chat/localCommandRegistry.ts`; territory rules stay in `src/agents/conventions.ts`; `git mv` of test file. | — | B11 |
| [G20](G20/APPROVED.md) | high | providers | Delete `AnthropicProvider`, `OpenAICodexProvider`, `OpenRouterProvider` and their unit tests; surgically prune `model-capabilities.test.ts`. | — | B6 |
| [G21](G21/APPROVED.md) | medium | providers/router | Replace four duplicated provider-name lists with a single `PROVIDER_DESCRIPTORS` table; derive `ProviderName`, `isProviderName`, OAuth-id resolution, registration, ctor branch from one source. | G20 | B6 |
| [G22](G22/APPROVED.md) | low | providers/router | Delete `PROVIDER_TO_OAUTH` and rename downstream `oauthId` back to `providerName`; identity map was a "comment in code". | G20 | B6 |
| [G23](G23/APPROVED.md) | medium | routing/resolver | Eager DFS profile-cycle validation in the resolver constructor; typed `RoutingProfileCycleError`; remove dead `seen` plumbing in `mergeRuleChain`. | — | B7 |
| [G24](G24/APPROVED.md) | low | routing/resolver | Narrow input to `ProjectRoutingInput`; cache `this.routing` once; delete redundant `projectRoutingSchema.parse` calls and `ProjectRoutingConfigLike` shim. | G23 | B7 |
| [G25](G25/APPROVED.md) | medium | routing/resolver | Typed `NoAllowedRouteMatchError` for empty-after-filter; same fix for `allowed_accounts` with `defaultAccount` candidate; `validateModelCoverage` rethrows verbatim. | G23,G24 | B7 |
| [G26](G26/APPROVED.md) | low | routing/resolver | Eliminate `model_overrides` legacy tier via `z.preprocess` fatal Zod issue; collapse resolver legacy arm; drop docs references in six guides. | G23,G24,G25 | B7 |
| [G27](G27/APPROVED.md) | medium | mcp/plan-server | Add `started_at?: string` to active `StageSchema`; stamp on `plan_set_current`; `plan_set_stages` preserves by id; `plan_complete_stage` rejects if missing. | — | B8 |
| [G28](G28/APPROVED.md) | high | mcp/plan-server | Collapse `plan.json` + `plan-history.json` into a single `PlanDocument` with embedded history; `ActivePlanView`/`PlanHistoryView` projections; invariants via `superRefine`. | G27 | B8 |
| [G29](G29/APPROVED.md) | low | mcp/plan-server | Classify tools into `PLAN_WRITER_TOOLS` / `PLAN_READER_TOOLS`; readers bypass the writer FIFO; registry-drift guard. | G27,G28 | B8 |
| [G30](G30/APPROVED.md) | high | mcp/builtins | In-place `fs/promises` migration of `src/mcp/builtins.ts`; ships shared `src/testing/noSyncFsScanner.ts` reused by G06/G36/G37; `settled` flag for `runShellCommand`. | — | B2 |
| [G31](G31/APPROVED.md) | medium | mcp/builtins | Async capped windowed `read_file` with `mcp.maxFileReadBytes`, 4 KiB NUL probe, exported `classifyFsError` + `parseNonNegativeInt`; structured error contract. | G30 | B2 |
| [G32](G32/APPROVED.md) | medium | mcp/builtins | In-process bounded async walker for `search_files`; segment-aware `globToRegExp`; structured success + `skipped[]` envelope; reuses G31 helpers. | G30,G31 | B2 |
| [G33](G33/APPROVED.md) | medium | mcp/builtins | DOM-parsed `web_search` over `node-html-parser`+`he`; uses G34 helpers (`TimedFetch`, `readBoundedTextBody`, `discardBody`, `classifyNetworkError`); `webSearch` config group. | G30,G31,G34 | B2 |
| [G34](G34/APPROVED.md) | medium | mcp/builtins | Shared `src/mcp/httpFetch.ts` (`fetchWithTimeout`, `readBoundedTextBody`, `readBoundedBinaryBody`, `discardBody`, `classifyNetworkError`); rename `maxFetchChars` → `maxFetchBytes` (no shim). | G30,G31 | B2 |
| [G35b](G35b/APPROVED.md) | low | security/secrets | Move `credentialLexemes` + `configPointerSuffixes` from hardcoded module constants to a `security.envScrubber` Zod block (replace semantics); `createSecretEnvNamePredicate` factory rebuilt once at bootstrap. (P2, supersedes G35) | G30,G31,G32,G34 | B2 |
| [G36](G36/APPROVED.md) | high | auth/store | In-place async-fs migration with `mutateProfiles(fn)`; lockfile via `open(..., "wx", 0o600)`; reload-inside-critical-section; no cache. | G30 | B4 |
| [G37](G37/APPROVED.md) | medium | config | Async `fs/promises` in `src/config.ts`; keep `existsSync` only for the `resolveProjectRoot` quick probe (carve-out documented in scanner); G36 must land first to remove the auth-store consumer of `config.ensureDir`. | G30,G36 | B4 |
| [G38](G38/APPROVED.md) | high | knowledge/lifecycle | `assertRuntimeLockHeld` on every public writer; private `withChainLock`/`withScopeLifecycleLock`/`withSupersedeLock` helpers with `prev.catch(()=>{})` (subsumes G39). | — | B10 |
| [G40](G40/APPROVED.md) | high | docs/web-ui | In-place rewrite of `docs/internals/web-ui.md` (or `docs/guide/web-ui.md`) to match reality; remove the dangerous "no authentication" paragraph; ~150 lines, one file. | — | B0 |
| [G41](G41/APPROVED.md) | medium | web/types | Shared `PlanStage` mirror of `StageSchema`; narrow `AgentState.agent_type` to the 9-role `AgentRole` literal union; delete duplicate types in `PlanView`; wire `vue-tsc` into the web build. | — | B12 |
| [G42](G42/APPROVED.md) | high | skills/loader | Strict typed `BuiltinSkillFrontmatterSchema`; fail-loud on unknown fields; canonical `target_agents:` spelling; delete `src/knowledge/builtinWalker.ts`. | G43 | B13 |
| [G43](G43/APPROVED.md) | high | skills/planning | DELETE `skills/builtin/planning/SKILL.md` outright — planner system prompt is canonical. | — | B13 |
| [G44](G44/APPROVED.md) | medium | docs/channels | Rewrite `docs/internals/channels.md` to match live `ChatChannel` interface; rewrite `docs/internals/agent-chat.md` `sendEvent` call sites; fix `ChatLogSchema` cell in `data-model.md`. | — | B0 |
| [G45](G45/APPROVED.md) | medium | docs/server | Surgical rewrite of three sections in `docs/internals/server.md` (`SaivageRuntime` interface, `startServer` signature, 7-step bootstrap shutdown closure); design B build-time TS-snippet directive deferred. | — | B0 |
| [G46](G46/APPROVED.md) | medium | web/agents-view | Decompose `web/src/components/AgentsView.vue` into coordinator + 5 leaves + 3 composables + pure timeline transformer; strict byte-level `parseRoundId` replacing regex/prefix checks; constants module. | G41 | B12 |
| [G47](G47/APPROVED.md) | medium | server/telegram-bot | Targeted in-channel fix: explicit unauthorized `ctx.reply`; readiness-handoff Promise around `bot.start` resolving on `onStart`; persistence schema `entries[]` so boot hydration respects `allowedUserIds`. (P1) | — | B14 |
| [G48](G48/APPROVED.md) | low | server/cli | `withRuntime(projectPath, fn)` helper extracted to side-effect-free `src/server/cli-actions.ts`; encodes bootstrap/teardown invariant; T8 normalized prefix contract. | — | B15 |
| [G49](G49/APPROVED.md) | low | channels/ws | Shared Zod envelope at `src/channels/ws-schema.ts` (alias `@channels/ws-schema`); fail-loud at both boundaries; SPA `send` wraps `WsInboundSchema.parse`; delete duplicate `WsEvent` interfaces and `ChatChannel & { sendEvent?: ... }` escape hatches. (P1) | — | B14 |
| [G50](G50/APPROVED.md) | low | runtime/notes | Single `NoteManager` owned by `SaivageRuntime`; required `AgentContext.noteManager`; `registerNotesRoutes(app, runtime)` helper extracted from `startServer`. | — | B14 |

Subsumed:
- [G02](G02/), [G03](G03/), [G04](G04/) — collapsed under [G01/APPROVED.md](G01/APPROVED.md) (the four pure accessors derive every consumer behaviour from `ROSTER`).
- [G39](G39/APPROVED.md) — collapsed under [G38/APPROVED.md](G38/APPROVED.md) (`prev.catch(()=>{})` is the canonical fix for lock-chain poisoning).

Superseded:
- [G12/APPROVED.md](G12/APPROVED.md) — DISAPPROVED; redo at [G12b/APPROVED.md](G12b/APPROVED.md) per P3.
- [G35/APPROVED.md](G35/APPROVED.md) — DISAPPROVED; redo at [G35b/APPROVED.md](G35b/APPROVED.md) per P2.

Deferred:
- [G51-partial-bootstrap-teardown.md](G51-partial-bootstrap-teardown.md) — filed; not scheduled. Documented as deferred follow-up to G48 (partial `bootstrap()` failure leaks the runtime lockfile FD, MCP children, and supervisor interval before `installFatalHandlers` is wired).

## 4. Sequencing chains (cite once, then drive batch order)

- **C-PlanServer**: G27 → G28 → G29 (started_at field shape → merged `PlanDocument` → reader bypass).
- **C-Skills**: G43 → G42 (delete the fictional skill before strict-typing the loader, else G42's `--- SKILL: planning` assertion blocks the merge).
- **C-Router**: G20 → { G21, G22 } batched (dead provider classes deleted first so G22's identity-mapping is provably dead and G21's descriptor table is the only router source).
- **C-Resolver**: G23 → G24 → G25 → G26 (all touch `src/routing/resolver.ts`; landing them as a single resolver batch avoids merge churn).
- **C-AsyncFs**: G30 → { G06, G36, G37 } and G30 → G31 → G34 → G33 → G32 → G35b (G30 ships the shared `noSyncFsScanner`; the builtins string is the order in which the helpers compose — G31 exports `parseNonNegativeInt`+`classifyFsError`, G34 exports the HTTP helpers used by G33, G35b consumes the env-filter shape).
- **C-WebTypes**: G41 → G46 (G46 reuses `PlanStage`/`AgentRole`/`AgentState` from G41; G46 also wires `vue-tsc` exit-clean as a hard gate, which G41 introduces).

## 5. Batches

Each batch lists members, prerequisites (other batches), files touched (short list — the canonical exhaustive list lives in the per-finding `03-plan-rN.md`), validation gate (single line — pick the strictest from {tsc, vitest, build, docs:build, docs:api, lint, build:web}), and restart impact (which of the four LXC daemons must restart; "none" = docs/web-only or operator-gated optional).

### B0 — Docs baseline

- **Members**: [G40](G40/APPROVED.md), [G44](G44/APPROVED.md), [G45](G45/APPROVED.md).
- **Prereqs**: none. Safe to land first or in parallel with any code batch; tracks the four LXC harnesses' bind-mounted source independently.
- **Files**:
  - [../../../docs/internals/web-ui.md](../../../docs/internals/web-ui.md) (or `docs/guide/web-ui.md`) — full rewrite per G40; remove the dangerous "no authentication" paragraph.
  - [../../../docs/internals/channels.md](../../../docs/internals/channels.md) — match the live `ChatChannel` 4-member interface copied verbatim from `src/channels/types.ts` L5–L17 (G44).
  - [../../../docs/internals/agent-chat.md](../../../docs/internals/agent-chat.md) — enumerate the three real `sendEvent` call sites (ChatAgent thinking, ChatAgent non-Telegram message, WebSocket setup) per G44.
  - [../../../docs/internals/data-model.md](../../../docs/internals/data-model.md) — `ChatLogSchema` cell fix (G44).
  - [../../../docs/internals/server.md](../../../docs/internals/server.md) — three sections (`SaivageRuntime` 13-field interface, `startServer` signature, 7-step bootstrap shutdown) per G45.
- **Validation**: `npm run docs:build` + source-side strict-grep + dist-side HTML grep + dist-side regenerated VitePress page-content JS chunks (`.md.*.js` and `.lean.js`) per G44 r4.
- **Principles touched**: none directly (P1/P2/P3 are about runtime code, not docs).
- **Restart impact**: none (docs-only).

### B1 — Reserved

(Skipped; numbering kept aligned with the §3 batch column.)

### B2 — Async-fs foundation + builtins

- **Members**: [G30](G30/APPROVED.md), [G31](G31/APPROVED.md), [G34](G34/APPROVED.md), [G33](G33/APPROVED.md), [G32](G32/APPROVED.md), [G35b](G35b/APPROVED.md).
- **Prereqs**: none (G30 ships the shared scanner). Internal order is the hard C-AsyncFs chain — do not reorder.
- **Files**:
  - [../../../src/mcp/builtins.ts](../../../src/mcp/builtins.ts) — async fs migration (G30), windowed `read_file` (G31), bounded walker for `search_files` (G32), DOM-parsed `web_search` (G33), `fetch_url`/`fetch_page_text`/`downloadUrl`/`download_file`/`download_with_fallbacks` rewired through G34 helpers, `SECRET_ENV_PATTERNS` deletion + predicate-factory call (G35b).
  - [../../../src/mcp/builtins.test.ts](../../../src/mcp/builtins.test.ts) — new describe blocks per finding plus the timer-cleanup regression (G33 row 17).
  - new [../../../src/mcp/httpFetch.ts](../../../src/mcp/httpFetch.ts) + `httpFetch.test.ts` (G34).
  - [../../../src/config.ts](../../../src/config.ts) — `mcp.maxFileReadBytes` (G31), `mcp.fetchTimeoutMs` + rename `maxFetchChars` → `maxFetchBytes` no-shim (G34), `mcp.maxSearch*` (G32), `webSearch.*` group (G33), `security.envScrubber` Zod block (G35b).
  - new [../../../src/testing/noSyncFsScanner.ts](../../../src/testing/noSyncFsScanner.ts) — dependency-free, accepts `roots`/`allowedNamedImports`/`skipPathContains` (G30).
  - new [../../../src/security/secrets.ts](../../../src/security/secrets.ts) + test — exports `DEFAULT_CREDENTIAL_LEXEMES`, `DEFAULT_CONFIG_POINTER_SUFFIXES`, `createSecretEnvNamePredicate(...)` (G35b).
  - new `src/mcp/web-search.fixture.html` plus drifted and empty variants (G33).
  - [../../../package.json](../../../package.json) — add `node-html-parser`, `he` (G33).
  - [../../../docs/guide/config-runtime.md](../../../docs/guide/config-runtime.md) — one paragraph each for G31/G33/G34 + envScrubber section for G35b.
  - [../../05-MCP-SERVICES.md](../../05-MCP-SERVICES.md) — G31 doc crumb.
- **Validation**: `npx tsc && vitest && npm run build && npm run docs:build && npm run lint` — strictest because G34 renames the public config key `maxFetchChars` → `maxFetchBytes` with no shim.
- **Grep gates**: G32's four scoped greps (obsolete guard removal, INVALID_ARGUMENT in-case + absence-in-complement + absence-in-helper); G33 gates #5/#6/#10–#12 pinning the G34 helper contract; G35b's four sentinel literals (hyphen tolerance, union rejection, empty-suffix replacement, shell-safe pattern literals).
- **Principles touched**: P2 (G35b moves the credential corpus out of module constants into the saivage.json schema).
- **Restart impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — operator-gated. `saivage-v3-getrich-v2` (10.0.3.170) unaffected.

### B4 — Store / runtime async-fs consumers

- **Members**: [G06](G06/APPROVED.md), [G36](G36/APPROVED.md), [G37](G37/APPROVED.md).
- **Prereqs**: B2 (G30 — shared `noSyncFsScanner`). Internal order: G06 independent, G36 before G37 (G37 needs the `config.ensureDir` consumer in `auth/store.ts` gone).
- **Files**:
  - [../../../src/runtime/stash.ts](../../../src/runtime/stash.ts) — `fs/promises` migration (G06); UUID-unique filenames so no lock surface.
  - [../../../src/runtime/stash.test.ts](../../../src/runtime/stash.test.ts) — `beforeEach`/`afterEach` preserve+restore `PROJECT_ROOT` and `SAIVAGE_ROOT`.
  - [../../../src/auth/store.ts](../../../src/auth/store.ts) — `mutateProfiles(fn)` helper acquires lockfile, reloads inside the critical section, atomically writes, no cache (G36).
  - [../../../src/auth/store.test.ts](../../../src/auth/store.test.ts) — cross-process via `child_process.fork(..., { execArgv: ["--import", "tsx"] })` against TS source (no `dist/auth/*` artifact — tsup only emits `dist/cli.js`).
  - [../../../src/config.ts](../../../src/config.ts) — async `fs/promises` plus the carved-out `existsSync` quick probe in `resolveProjectRoot` (G37).
  - [../../../src/config.test.ts](../../../src/config.test.ts) — regression test matches the G30 scanner contract (expects both `disallowed-named-import` and `sync-call` for the carve-out).
- **Validation**: `npx tsc && vitest` (scanner regression test on the carve-out is a hard gate; G36's PID/hostname stale-lock recovery via `process.kill(pid, 0)` probe is unit-tested).
- **Principles touched**: none directly.
- **Restart impact**: `saivage`, `diedrico`, `saivage-v3` — all bind-mount affected source.

### B5 — Roster + worker foundation

- **Members**: [G01](G01/APPROVED.md), [G05](G05/APPROVED.md), [G07](G07/APPROVED.md), [G09](G09/APPROVED.md).
- **Prereqs**: none structurally. Internal order: G01 (ROSTER accessors + tool-filter consolidation) → G05 (worker scaffold + `ROSTER.workerInit`) → G07 (compaction round-parser; depends on stable `BaseAgent` shape) → G09 (planner `plan_done` MCP terminal-tool + `detectTerminalToolCall` hook on `BaseAgent`). G09 notes the merge-conflict risk with G01/G05/G07; landing them as one batch removes it.
- **Files**:
  - [../../../src/agents/roster.ts](../../../src/agents/roster.ts) — `ROSTER.workerInit` becomes single owner of worker initial-message metadata (G05); compile-time anchor `[Extract<..., { worker: true; workerInit: null }>] extends [never]` plus `hasWorkerCtor(role)` runtime cross-check.
  - [../../../src/agents/tool-filters.ts](../../../src/agents/tool-filters.ts) — four pure accessors derive role policy from `ROSTER` (G01); delete hand-rolled parallel tables.
  - [../../../src/agents/base.ts](../../../src/agents/base.ts) — new `detectTerminalToolCall(toolCalls, dispatchResult)` hook (G09); `runLoop` re-checks `this.abortSignal?.aborted || dispatchResult.aborted` after tool-result push and before any terminal-tool return.
  - [../../../src/agents/worker.ts](../../../src/agents/worker.ts) — `WorkerAgent.createWorker<T>(...)` factory + bodyless pure-worker subclasses (G05); reviewer-only override surface.
  - [../../../src/agents/planner.ts](../../../src/agents/planner.ts) — overrides `detectTerminalToolCall` for `plan_done` exclusivity; returns `{ completion: "plan_done", summary }` (G09).
  - [../../../src/agents/task-report.ts](../../../src/agents/task-report.ts) — duplicate `WorkerRole` union deleted and re-imported from `roster.ts` (G05).
  - [../../../src/agents/agents.test.ts](../../../src/agents/agents.test.ts) — migrate four direct-constructor call sites to `await WorkerAgent.createWorker<XxxAgent>(...)` plus `new ...Agent(` grep gate.
  - [../../../src/agents/base.compaction.test.ts](../../../src/agents/base.compaction.test.ts) — `parseRounds` walker + `selectKeptRounds` against projected outbound cost; bounded fallback escape via `maxConsecutiveFallbacks` + `oversizedAtomicFallback` (G07).
  - [../../../src/runtime/runtime-state.ts](../../../src/runtime/runtime-state.ts) (or equivalent) — optional `active_agents[*].compaction` plumbed through `RuntimeTracker.agentCompactionUpdate` and `BaseAgentConfig.onCompactionUpdate` (G07).
  - [../../../prompts/planner.md](../../../prompts/planner.md) — drop `PLAN_COMPLETE` text protocol; describe `plan_done` MCP terminal tool (G09).
  - new `plan_done` MCP wiring in [../../../src/mcp/plan-server.ts](../../../src/mcp/plan-server.ts) — stateless `PlanService.plan_done`, typed `Promise<{ ok: true; recorded: boolean } | PlanError>` (G09; orthogonal to B8's writer/reader split).
- **Validation**: `npx tsc && vitest && grep -rn PLAN_COMPLETE src/ prompts/` (must return zero — negative regression test uses `const LEGACY_TOKEN = "PLAN_" + "COMPLETE"` so the literal never appears in source).
- **Principles touched**: P1 (G09 replaces the `PLAN_COMPLETE` free-text marker with a structured tool call).
- **Restart impact**: `saivage`, `diedrico`, `saivage-v3`.

### B6 — Provider router cleanup

- **Members**: [G20](G20/APPROVED.md), [G21](G21/APPROVED.md), [G22](G22/APPROVED.md).
- **Prereqs**: none. Internal order: G20 first (delete dead concrete provider classes); G21+G22 batched together because both edit only [../../../src/providers/router.ts](../../../src/providers/router.ts).
- **Files**:
  - delete `src/providers/anthropic.ts`, `src/providers/openai-codex.ts`, `src/providers/openrouter.ts` and their unit tests (G20).
  - [../../../src/providers/router.ts](../../../src/providers/router.ts) — single `PROVIDER_DESCRIPTORS as const satisfies readonly ProviderDescriptor[]` with `makePiAiDescriptor<N extends string>(...)` factory; `ProviderName` derived from the table; descriptor-only `isProviderName` type guard (G21). Delete `PROVIDER_TO_OAUTH` constant + JSDoc at L60–L69 and rename downstream `oauthId` back to `providerName` at L174 + L184–L199 (G22).
  - [../../../src/providers/router.test.ts](../../../src/providers/router.test.ts) — zero residual hard-coded provider-name lists; constructor closures byte-identical.
  - [../../../src/providers/model-capabilities.test.ts](../../../src/providers/model-capabilities.test.ts) — surgical prune of the deleted-class references (G20).
- **Validation**: `npx tsc && vitest` plus follow-up tickets F-G20-RENAME (rename `OpenAIProvider` → `OpenAICompatProvider` after G21/G22) and F-G20-OPENAI-PKG (audit whether `openai` package is still needed) — not in scope here.
- **Principles touched**: none directly.
- **Restart impact**: `saivage`, `diedrico`, `saivage-v3` (bind-mounts); `saivage-v3-getrich-v2` unaffected.

### B7 — Resolver batch

- **Members**: [G23](G23/APPROVED.md), [G24](G24/APPROVED.md), [G25](G25/APPROVED.md), [G26](G26/APPROVED.md).
- **Prereqs**: none. Internal order is the hard C-Resolver chain G23 → G24 → G25 → G26.
- **Files**:
  - [../../../src/routing/resolver.ts](../../../src/routing/resolver.ts) — eager DFS profile-cycle validation + typed `RoutingProfileCycleError` (G23); narrow input to `ProjectRoutingInput`, cache `this.routing`, delete redundant parses + `ProjectRoutingConfigLike` shim (G24); typed `NoAllowedRouteMatchError` with symmetric `allowed_accounts` fix (G25); collapse legacy arm + delete `resolveLegacyModels` + narrow source union to `"routing" | "runtime-default"` (G26).
  - [../../../src/routing/resolver.test.ts](../../../src/routing/resolver.test.ts) — cycle tests (direct self-loop, two-node, deep, unused-transitive); production grep gate (zero `projectRoutingSchema.parse` hits outside the helper); typed-error assertions for `NoAllowedRouteMatchError`.
  - [../../../src/config-validation.ts](../../../src/config-validation.ts) — `validateModelCoverage` narrowed to catch only `MissingModelForRoleError` + `RoutingProfileCycleError`, rethrow `NoAllowedRouteMatchError` verbatim.
  - [../../../src/config-validation.test.ts](../../../src/config-validation.test.ts) — `configPath` non-empty assertion.
  - [../../../src/types.ts](../../../src/types.ts) — `ProjectConfigSchema` wrapped in `z.preprocess` that emits a typed Zod custom issue with `fatal: true` at path `["model_overrides"]` (G26).
  - new [../../../src/types.test.ts](../../../src/types.test.ts) — schema-rejection tests assert `ZodError.issues.length === 1` with `toBe(EXACT_MESSAGE)` for populated and empty-stub legacy fixtures (G26).
  - [../../../src/store/project.ts](../../../src/store/project.ts) — drop the legacy seeder stub (G26).
  - six [../../../docs/guide/](../../../docs/guide/) files — every `model_overrides` reference removed (G26).
- **Validation**: `npx tsc && vitest && npm run docs:build`. Configs that previously fell open through `allowed_models` / `allowed_accounts` now fail loudly at validation or first resolve — operator-aware change.
- **Principles touched**: none directly (the `model_overrides` removal is a legacy-tier elimination, not a P2 hardcoded-value move).
- **Restart impact**: `saivage`, `diedrico`, `saivage-v3` — operator-gated. Existing `.saivage/config.json` files inventoried in G26 r7 do not contain `model_overrides`.

### B8 — Plan server

- **Members**: [G27](G27/APPROVED.md), [G28](G28/APPROVED.md), [G29](G29/APPROVED.md).
- **Prereqs**: B5 (G09 adds `plan_done`, a new tool — orthogonal to writer/reader split but in the same file; landing B5 first avoids merge churn in `plan-server.ts`).
- **Files**:
  - [../../../src/mcp/plan-server.ts](../../../src/mcp/plan-server.ts) — add `started_at?: string` to active `StageSchema` and stamp on `plan_set_current` (G27); `plan_set_stages` preserves existing `started_at` by id via `preserveStartedAt` helper; `plan_complete_stage` consumes it and rejects with `VALIDATION_ERROR` if missing (no synthetic value). Export `PLAN_WRITER_TOOLS` and `PLAN_READER_TOOLS` sets; `handleToolCall` branches readers past `serializeOp` (G29).
  - [../../../src/store/plan.ts](../../../src/store/plan.ts) — collapse `plan.json` + `plan-history.json` into a single `PlanDocument` with embedded `history`; define `ActivePlanView` / `PlanHistoryView` projection types; `PlanDocumentSchema` invariants via `superRefine` (G28).
  - [../../../src/runtime/runtime.test.ts](../../../src/runtime/runtime.test.ts) — G29 replaces the F34 test with three deterministic G29 tests via the existing deferred helper (no `setTimeout` races). Drift guard asserts that the disjoint union of writer and reader sets equals the names exposed by `getToolSchemas`.
- **Validation**: `npx tsc && vitest`. Live deploy on B8 lands the merged `PlanDocument`; per-host `jq` merge of `.saivage/plan.json` + `.saivage/plan-history.json` per the G28 daemon-impact note (file contents must not reach the agent).
- **Principles touched**: none directly.
- **Restart impact**: `saivage`, `diedrico`, `saivage-v3` — operator-gated, with the per-host `jq` merge as a documented manual step. Rollback regime split per G27: pre-B8 = single-commit revert; post-B8 = forbid G27-only revert (must roll back G28 first).

### B9 — Principles cleanup (drop fuzzy heuristics)

- **Members**: [G11](G11/APPROVED.md), [G12b](G12b/APPROVED.md).
- **Prereqs**: none. Both are deletions framed by P1/P3 — landing them early prevents new code from re-introducing the same anti-patterns.
- **Files**:
  - [../../../src/agents/chat.ts](../../../src/agents/chat.ts) — delete the fuzzy free-text restart heuristic (G11).
  - [../../../prompts/chat.md](../../../prompts/chat.md) — rewrite five directives at L7, L33, L43, L51, L73 so Chat never claims to restart the Planner; "Restart cautiously" guideline at L73 removed outright (G11).
  - [../../../src/chat/localCommands.ts](../../../src/chat/localCommands.ts) — keep `/restart-planner` local slash command as the only restart entry point (G11).
  - delete `src/security/promptInjectionCop.ts` and all dependents (G12b).
  - [../../../src/mcp/builtins.ts](../../../src/mcp/builtins.ts) — delete `scanUntrustedText` (now a pass-through, then deleted) (G12b).
  - [../../../src/server/server.ts](../../../src/server/server.ts) — delete `/api/debug/security` route (G12b).
  - [../../../web/src/components/DebugView.vue](../../../web/src/components/DebugView.vue) — delete `SecurityStatusRing` and the Security tab (G12b).
  - [../../../src/config.ts](../../../src/config.ts) — drop the `security: { ... }` block; Zod `.strict()` rejects stale blocks via `unrecognized_keys` (G12b).
  - test fixtures across runtime/router/model-capabilities referencing `security: { ... }` (G12b).
  - [../../../docs/guide/config-runtime.md](../../../docs/guide/config-runtime.md), [../../../docs/internals/testing.md](../../../docs/internals/testing.md), [../../../docs/internals/source-tree.md](../../../docs/internals/source-tree.md), [../../../docs/.vitepress/config.ts](../../../docs/.vitepress/config.ts) — docs surfaces cleaned (G12b).
- **Validation**: `npx tsc && vitest && npm run build && npm run build:web && npm run docs:api && npm run docs:build && npm run lint`. Static invariant test grep-gates the 13 needles enumerated in G12b. Regression test exercises the public `loadConfig` path with an on-disk fixture (ZodError with `unrecognized_keys`).
- **Principles touched**: P1 (G11 deletes the multilingual restart regex; structured `/restart-planner` only) and P3 (G12b deletes the cop entirely).
- **Restart impact**: `saivage`, `saivage-v3`, `diedrico` — operator-gated.

### B10 — Knowledge lifecycle

- **Members**: [G38](G38/APPROVED.md) (subsumes G39).
- **Prereqs**: none. Independent of B2/B4 because the knowledge store already uses async fs.
- **Files**:
  - [../../../src/knowledge/lifecycle.ts](../../../src/knowledge/lifecycle.ts) — private `withChainLock`/`withScopeLifecycleLock`/`withSupersedeLock` with `prev.catch(()=>{})` to prevent chain poisoning; `assertRuntimeLockHeld(saivageRoot)` on every public writer; delete misleading public lock primitives.
  - regression test from the G39 inventory — chain poisoning test (one rejection must not poison subsequent locks); runtime-lock invariant test (writers throw if runtime lock is absent).
- **Validation**: `npx tsc && vitest` plus the chain-poisoning regression test from the G39 inventory.
- **Principles touched**: none directly.
- **Restart impact**: `saivage`, `diedrico`, `saivage-v3`.

### B11 — Seed + structural

- **Members**: [G08](G08/APPROVED.md), [G10](G10/APPROVED.md), [G13](G13/APPROVED.md).
- **Prereqs**: none. Three independent small fixes; bundled for review-load amortisation.
- **Files**:
  - [../../../src/store/project.ts](../../../src/store/project.ts) — seed cleanup; depends on B7 already having removed the `model_overrides` legacy stub (G08).
  - [../../../src/store/documents.ts](../../../src/store/documents.ts) — `appendDoc` signature fix (G10).
  - [../../../src/store/documents.test.ts](../../../src/store/documents.test.ts) — new regression coverage.
  - [../../../src/agents/conventions.ts](../../../src/agents/conventions.ts) → new [../../../src/chat/localCommandRegistry.ts](../../../src/chat/localCommandRegistry.ts) — move; drop unused `checkConvention` import at [../../../src/agents/base.ts](../../../src/agents/base.ts) L35 (G13).
  - `git mv` of `src/agents/chat-commands.test.ts` → `src/chat/localCommandRegistry.test.ts` (G13).
- **Validation**: `npx tsc && vitest && npm run docs:api && npm run lint` (G10 regenerates `docs/api/store/documents/functions/appendDoc.md` and sidebar via TypeDoc; G13 wires lint before build).
- **Principles touched**: none directly.
- **Restart impact**: G08 + G13 operator-gated (live harness restart on `saivage-v3` optional); G10 has no daemon impact.

### B12 — Web types + decomposition

- **Members**: [G41](G41/APPROVED.md), [G46](G46/APPROVED.md).
- **Prereqs**: B5 (G09 only — runtime exposes `active_agents[*].compaction` consumed by G46's timeline transformer for compacted buckets, per the G07 r2 runtime-state pluming) and B8 (G28 — `PlanStage` mirrors the post-G27 `StageSchema` shape, so the merged `PlanDocument` must already be in place for the web `PlanStage` to be byte-correct). Internal order: G41 → G46 (C-WebTypes).
- **Files**:
  - [../../../web/src/api/types.ts](../../../web/src/api/types.ts) — `PlanStage`, narrowed `AgentRole` to the live worker roles, deduplicated `AgentState`/`RuntimeState` so `WsEvent` source-of-truth is unique (G41).
  - [../../../web/src/components/PlanView.vue](../../../web/src/components/PlanView.vue) — consume narrowed types (G41).
  - [../../../web/src/components/StatusPanel.vue](../../../web/src/components/StatusPanel.vue) — consume narrowed `AgentState`/`RuntimeState` (G41).
  - delete [../../../web/src/components/AgentsView.vue](../../../web/src/components/AgentsView.vue); new [../../../web/src/components/agents/AgentsView.vue](../../../web/src/components/agents/AgentsView.vue) is the coordinator under 300 LoC (G46).
  - new `web/src/components/agents/` — 5 leaf components + 3 composables + `round-id.ts` + `constants.ts` + `timeline.ts` (unit-tested transformer).
  - [../../../web/package.json](../../../web/package.json) — `vue-tsc` devDep + `typecheck` script chained into Vite build (G46).
- **Validation**: `npm run typecheck` (vue-tsc) + `npm run build:web`. Per-component flat ≤300-line cap; CSS-extraction fallback at >300 (G46 r3 contract).
- **Principles touched**: none directly.
- **Restart impact**: web-only rebuild + restart `saivage`, `saivage-v3`, `diedrico` operator-gated.

### B13 — Skills

- **Members**: [G43](G43/APPROVED.md), [G42](G42/APPROVED.md).
- **Prereqs**: none. Internal order is the hard C-Skills chain: G43 lands first (delete `skills/builtin/planning/SKILL.md`); G42 second (strict `BuiltinSkillFrontmatterSchema`, canonical `target_agents:`, single walker, delete `src/knowledge/builtinWalker.ts`).
- **Files**:
  - `skills/builtin/planning/SKILL.md` — deleted (G43).
  - the surviving three `skills/builtin/**/SKILL.md` files — must explicitly declare `target_agents:` (no `.default([])`).
  - [../../../src/knowledge/builtinSkills.ts](../../../src/knowledge/builtinSkills.ts) (or current walker location) — strict `BuiltinSkillFrontmatterSchema`; single walker; canonical `target_agents:` (G42).
  - delete [../../../src/knowledge/builtinWalker.ts](../../../src/knowledge/builtinWalker.ts) — duplicate walker removed (G42).
  - rewrite (or delete) [../../../docs/internals/skill-loader.md](../../../docs/internals/skill-loader.md) and [../../../docs/guide/skills.md](../../../docs/guide/skills.md).
- **Validation**: `npx tsc && vitest && npm run docs:build` plus the eager-block-scoped grep for `## Planning Guidelines` and `--- SKILL: planning` (must NOT match broad code searches — `summary` is a real `plan_complete_stage` arg).
- **Principles touched**: P2 (G42 makes `target_agents` an explicit per-skill declaration instead of falling back to an empty default).
- **Restart impact**: `saivage`, `diedrico`, `saivage-v3`.

### B14 — Channels + auth + notes

- **Members**: [G47](G47/APPROVED.md), [G49](G49/APPROVED.md), [G50](G50/APPROVED.md).
- **Prereqs**: B12 (G41 narrows `AgentRole` and removes the `web/src/components/...` duplicate `WsEvent` declarations that G49 also wants gone in one atomic PR). G49 and G50 are otherwise independent of G47.
- **Files**:
  - [../../../src/server/telegram-bot.ts](../../../src/server/telegram-bot.ts) — explicit `ctx.reply` denial; readiness-handoff Promise around `bot.start`; persistence schema `entries: Array<{ chatId, userId, subscribedAt }>` with no migration shim (G47).
  - new [../../../src/channels/ws-schema.ts](../../../src/channels/ws-schema.ts) — single source of truth for WS inbound/outbound schemas (G49).
  - [../../../vitest.config.ts](../../../vitest.config.ts), [../../../web/vite.config.ts](../../../web/vite.config.ts), [../../../web/tsconfig.json](../../../web/tsconfig.json) — wire `@channels/ws-schema` alias for both sides (G49).
  - [../../../src/server/server.ts](../../../src/server/server.ts) — strict outbound parse on every emit; extract `registerNotesRoutes(app, runtime)` helper out of `startServer` so notes routes consume `runtime.noteManager` (G49+G50).
  - [../../../web/src/composables/useWebsocket.ts](../../../web/src/composables/useWebsocket.ts) — SPA `send` wraps `WsInboundSchema.parse`; emitter API replaces unbounded `events.value` array (G49).
  - [../../../src/runtime/notes.ts](../../../src/runtime/notes.ts) + [../../../src/runtime/runtime.ts](../../../src/runtime/runtime.ts) — `SaivageRuntime.noteManager` singleton; required `AgentContext.noteManager` (no optional field) (G50).
  - five live `AgentContext` construction sites: `createChildSpawner`, `runPlanner` in [../../../src/bootstrap.ts](../../../src/bootstrap.ts), `/ws` chat in [../../../src/server/server.ts](../../../src/server/server.ts), Telegram chat in [../../../src/server/telegram-bot.ts](../../../src/server/telegram-bot.ts), CLI inspector in [../../../src/cli.ts](../../../src/cli.ts) — pass `runtime.noteManager` (G50).
- **Validation**: `npx tsc && vitest && npm run build && npm run build:web` + the `app.inject()` regression test against `registerNotesRoutes(app, runtime)` with `vi.spyOn(runtime.noteManager, ...)` so any handler that reverts to per-request construction fails. G49 acceptance uses `node --import tsx -e ...` against the workspace-local `tmp/` smoke project (no top-level `import()`).
- **Principles touched**: none directly (G50 is a singleton refactor; G49 is a schema codification; G47 is an authorization fix).
- **Restart impact**: `saivage`, `saivage-v3`, `diedrico` — operator-gated. Telegram `subscribers.json` schema breaks intentionally per G47 (architecture-first, no shim).

### B15 — CLI / runtime

- **Members**: [G48](G48/APPROVED.md).
- **Prereqs**: B5 (touches `bootstrap.ts` and `cli.ts`; landing B5 first prevents AST-invariant churn against `runPlanner`/`createChildSpawner`). G48 is small enough to ship alone.
- **Files**:
  - new [../../../src/server/cli-actions.ts](../../../src/server/cli-actions.ts) — extracted `startAction`, `inspectAction`, `withRuntime` helpers.
  - [../../../src/cli.ts](../../../src/cli.ts) — thin re-export; `serve` deliberately untouched, documented in code.
  - test suite T1–T8 — unit tests for `withRuntime`, `startAction`, `inspectAction`; integration leak test (T7); shutdown-only failure test (T8); AST-based invariant test using the TypeScript compiler API pinning that `bootstrap()` and `.shutdown()` co-occur only inside `withRuntime` or `serve`.
- **Validation**: `npx tsc && vitest` (T1–T6 helper unit tests; T7 e2e leak test using `process.getActiveResourcesInfo()` per-kind histogram + `/proc/self/fd` length delta; T8 shutdown-only failure test).
- **Principles touched**: none directly.
- **Restart impact**: `saivage`, `saivage-v3`, `diedrico` — operator-gated.

## 6. Final phase ordering

The execution order below resolves every chain in §4, ships `tsc`-green at every batch boundary, and minimises operator restart windows on the four LXC daemons (`saivage` 10.0.3.111, `saivage-v3` 10.0.3.112, `diedrico` 10.0.3.113, `saivage-v3-getrich-v2` 10.0.3.170).

1. **B0** — Docs baseline. No daemon impact; lands first so subsequent code PRs do not have to argue about docs-drift gates that B0 sets.
2. **B2** — Async-fs foundation + builtins (G30 → G31 → G34 → G33 → G32 → G35b). Ships the shared `noSyncFsScanner` and `httpFetch.ts` helpers that B4 and the rest of the tree consume.
3. **B4** — Store / runtime async-fs consumers (G06; G36 → G37). First downstream consumer of B2's scanner; G37 hard-depends on G36 finishing the `config.ensureDir` removal in `auth/store.ts`.
4. **B6** — Provider router cleanup (G20; G21+G22). Independent of B2/B4 but lands here because it is small and B5 wants a clean `router.ts` baseline (no dead provider classes) before touching agent wiring.
5. **B7** — Resolver batch (G23 → G24 → G25 → G26). Independent of the router work but kept adjacent to it for review-context locality (routing/ subtree).
6. **B5** — Roster + worker foundation (G01 → G05 → G07 → G09). Largest single batch in the agent-core layer; runs after B6/B7 so the provider/router/resolver surface it queries is stable.
7. **B8** — Plan server (G27 → G28 → G29). Depends on B5 because G09 adds the `plan_done` tool to `plan-server.ts`; landing B5 first avoids merge churn against B8's writer/reader split.
8. **B10** — Knowledge lifecycle (G38; subsumes G39). Orthogonal to B5–B8 but slotted here so it precedes B11's seed work.
9. **B9** — Principles cleanup (G11, G12b). Lands after B5 (planner & chat surface is stable) so the chat-prompt directive rewrite and the cop deletion do not race against B5's `plan_done` wiring.
10. **B11** — Seed + structural (G08, G10, G13). Small consolidation pass; G08 must come after B7 so the `model_overrides` legacy stub is already gone from the seeder.
11. **B13** — Skills (G43 → G42). Lands after B5+B9 so the planner system prompt and chat surface are final before G42's `target_agents:` strict-typing freezes the eager-block contract.
12. **B12** — Web types + decomposition (G41 → G46). Depends on B5 (compaction-state plumbing) and B8 (`PlanStage`/`StageSchema` shape). Lands here so the web build picks up the final agent/plan shape in one atomic web-side change.
13. **B14** — Channels + auth + notes (G47, G49, G50). G49 wants B12 to have already deleted the duplicate `WsEvent` declarations under `web/src/components/`; B14 ships alongside web rebuild + daemon restart.
14. **B15** — CLI / runtime (G48). Lands last so the AST-invariant test pins the final shape of `bootstrap.ts` and `cli.ts` after every upstream batch has finished editing them.

## 7. Deferred items

- **G51 — Partial-bootstrap teardown** — see [G51-partial-bootstrap-teardown.md](G51-partial-bootstrap-teardown.md). G48's `withRuntime` helper cannot shut down a runtime that never returned; making `bootstrap()` transactional is filed but not scheduled. Operator-visible symptom is "Another Saivage instance is already running" until `pkill -f saivage`; severity low because it only surfaces when `bootstrap()` itself rejects mid-acquisition.
- **Docs-lint level-up across G40 / G44 / G45 (G45 design B)** — build-time TS-snippet directive + docs lint that auto-derives interface blocks from source. Recorded as a follow-on batch covering all three docs findings together. Rejected inside G45 itself per architecture-first scoping for a medium-severity docs fix; queued here as the canonical batched level-up so future drift on `SaivageRuntime`, `ChatChannel`, or the web-UI contract is caught by `npm run docs:build` rather than by hand-grep gates.

## 8. Operator runbook (per-batch validation + restart)

Strictest validation gate per batch — pick the line below verbatim when landing the batch. All commands run from the [../../../](../../../) saivage repo root unless noted.

- **B0**: `npm run docs:build` then source-side strict-grep + dist-side HTML grep + dist-side `.md.*.js` and `.lean.js` chunks for the G44 r4 needles. No daemon restart.
- **B2**: `npx tsc && vitest && npm run build && npm run docs:build && npm run lint`. Plus G32's four scoped greps, G33 gates #5/#6/#10–#12, G35b's four sentinel literals. Restart `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112).
- **B4**: `npx tsc && vitest`. Scanner regression test on the `existsSync` carve-out in [../../../src/config.ts](../../../src/config.ts) is a hard gate. Restart `saivage`, `diedrico`, `saivage-v3`.
- **B5**: `npx tsc && vitest && grep -rn PLAN_COMPLETE src/ prompts/` (must return zero). Restart `saivage`, `diedrico`, `saivage-v3`.
- **B6**: `npx tsc && vitest`. Restart `saivage`, `diedrico`, `saivage-v3`.
- **B7**: `npx tsc && vitest && npm run docs:build`. Operator-aware fail-loud change. Restart `saivage`, `diedrico`, `saivage-v3`.
- **B8**: `npx tsc && vitest`. Manual `jq` merge of per-host `.saivage/plan.json` + `.saivage/plan-history.json` (file contents must not reach the agent). Restart `saivage`, `diedrico`, `saivage-v3`.
- **B9**: `npx tsc && vitest && npm run build && npm run build:web && npm run docs:api && npm run docs:build && npm run lint`. Restart `saivage`, `saivage-v3`, `diedrico`.
- **B10**: `npx tsc && vitest`. Restart `saivage`, `diedrico`, `saivage-v3`.
- **B11**: `npx tsc && vitest && npm run docs:api && npm run lint`. G10 has no daemon impact; G08/G13 operator-gated.
- **B12**: `npm run typecheck` (vue-tsc) `&& npm run build:web`. Web-only rebuild + restart `saivage`, `saivage-v3`, `diedrico` operator-gated.
- **B13**: `npx tsc && vitest && npm run docs:build` plus the eager-block-scoped grep for `## Planning Guidelines` and `--- SKILL: planning`. Restart `saivage`, `diedrico`, `saivage-v3`.
- **B14**: `npx tsc && vitest && npm run build && npm run build:web` + `app.inject()` regression test against `registerNotesRoutes(app, runtime)`. G49 acceptance via `node --import tsx -e ...` against workspace-local `tmp/` smoke project. Restart `saivage`, `saivage-v3`, `diedrico`.
- **B15**: `npx tsc && vitest` (T1–T6 helpers + T7 leak test via `process.getActiveResourcesInfo()` per-kind histogram + `/proc/self/fd` length delta + T8 shutdown-only failure). Restart `saivage`, `saivage-v3`, `diedrico`.

Daemon restart commands (host LXC):

- `sudo lxc-attach -n saivage -- systemctl restart saivage.service` (10.0.3.111)
- `sudo lxc-attach -n saivage-v3 -- systemctl restart saivage.service` (10.0.3.112)
- `sudo lxc-attach -n diedrico -- systemctl restart saivage.service` (10.0.3.113)
- `sudo lxc-attach -n saivage-v3-getrich-v2 -- systemctl restart saivage-v3-getrich.service` (10.0.3.170) — only B2 touches code that this daemon runs, and only via shared `src/mcp/*`; verify with `curl -fsS http://10.0.3.170:8080/health` after each restart.

Rollback regime:

- Pre-B8 plan-server changes are single-commit revertable. Post-B8 (G28 merged), G27-only revert is forbidden; the merged `PlanDocument` is the new on-disk shape and rolling back G27 alone leaves `plan_complete_stage` rejecting all live stages with `VALIDATION_ERROR`. Revert G28 first, then G27.
- Provider deletions in B6 are revertable but require restoring the deleted `src/providers/{anthropic,openai-codex,openrouter}.ts` test fixtures verbatim. Prefer roll-forward.
- G47 (B14) breaks `subscribers.json` schema intentionally. No shim; on rollback, hand-rewrite `.saivage/telegram/subscribers.json` on each affected host to the legacy bare-array shape.

## 9. Files-touched index (conflict map)

Files edited by more than one batch — the executing agent uses this to anticipate rebase conflicts and order branch landings. Files edited by exactly one batch are omitted.

- [../../../src/mcp/builtins.ts](../../../src/mcp/builtins.ts) — B2 (G30/G31/G32/G33/G34/G35b) and B9 (G12b `scanUntrustedText` deletion). Land B2 first; B9's deletion then operates on the post-B2 async-fs shape.
- [../../../src/mcp/plan-server.ts](../../../src/mcp/plan-server.ts) — B5 (G09 `plan_done` tool wiring) and B8 (G27/G28/G29 writer/reader split + `started_at`). B5 lands first per §6 final ordering; B8 rebases over G09's new tool and extends `PLAN_WRITER_TOOLS`/`PLAN_READER_TOOLS`.
- [../../../src/config.ts](../../../src/config.ts) — B2 (G31 `mcp.maxFileReadBytes`, G34 `mcp.fetchTimeoutMs` rename, G32 `mcp.maxSearch*`, G33 `webSearch.*`, G35b `security.envScrubber`), B4 (G37 async-fs migration with `existsSync` carve-out), B9 (G12b `security: { ... }` block drop). Highest-conflict file in the plan; land B2 → B4 → B9 in that order.
- [../../../src/server/server.ts](../../../src/server/server.ts) — B9 (G12b `/api/debug/security` route deletion) and B14 (G49 strict outbound parse + G50 `registerNotesRoutes` extraction). B9 first; B14's extraction operates on the post-B9 surface.
- [../../../src/server/telegram-bot.ts](../../../src/server/telegram-bot.ts) — B14 (G47 explicit denial + G50 `noteManager` plumb on the Telegram chat construction site). Both inside the same batch; G47 lands first within B14.
- [../../../src/agents/base.ts](../../../src/agents/base.ts) — B5 (G09 `detectTerminalToolCall` hook + abort re-check) and B11 (G13 drop of the unused `checkConvention` import at L35). B5 first.
- [../../../src/routing/resolver.ts](../../../src/routing/resolver.ts) — B7 only, but four findings (G23/G24/G25/G26) touch it in the strict C-Resolver order; treat the four as one merge unit.
- [../../../src/providers/router.ts](../../../src/providers/router.ts) — B6 only, both G21 and G22 edit it; merge them as one commit set after G20's deletions land.
- [../../../src/store/project.ts](../../../src/store/project.ts) — B7 (G26 drops the legacy seeder stub) and B11 (G08 export `SaivageConfigSchema` + replace handwritten seed). B7 first per §6.
- [../../../src/bootstrap.ts](../../../src/bootstrap.ts) — B5 (G09 wiring of `plan_done` into the planner construction path), B14 (G50 plumbing `runtime.noteManager` into `createChildSpawner` + `runPlanner`), B15 (G48 AST-invariant test pins the final shape). Land in §6 order.
- [../../../src/cli.ts](../../../src/cli.ts) — B14 (G50 CLI inspector `AgentContext.noteManager`) and B15 (G48 thin re-export + AST invariant). B14 first; B15 freezes the post-B14 shape.
- [../../../web/src/components/AgentsView.vue](../../../web/src/components/AgentsView.vue) → [../../../web/src/components/agents/AgentsView.vue](../../../web/src/components/agents/AgentsView.vue) — B12 only (G41 + G46), but G46 is the decomposition pass that removes the old monolith; G41 lands first within B12 so the narrowed types are available to the leaf components.
- [../../05-MCP-SERVICES.md](../../05-MCP-SERVICES.md) — B2 (G31 doc crumb). Single-batch but listed because it sits inside `SPEC/v2/` rather than `docs/`.

Files unique to one batch (no conflict expected) are omitted from this index — see each batch's Files list in §5 for the full per-batch surface.

## 10. Principles cross-reference

For each new principle, the table below pins the finding(s) that enforce it, the batch where the enforcement lands, and the single grep gate (or test) that pins the principle in regression suites.

| Principle | Findings | Batch(es) | Regression pin |
|-----------|----------|-----------|----------------|
| **P1 — No regex for parsing user intent** | [G09](G09/APPROVED.md), [G11](G11/APPROVED.md), [G47](G47/APPROVED.md), [G49](G49/APPROVED.md) | B5, B9, B14 | `grep -rn PLAN_COMPLETE src/ prompts/` returns zero (B5); `grep -rn 'restart.*planner.*regex\|restartPlannerHeuristic' src/` returns zero (B9); `WsInboundSchema.parse` is the only inbound parser at both WS boundaries (B14). |
| **P2 — Avoid hardcoded values; config files own tunables** | [G35b](G35b/APPROVED.md), [G42](G42/APPROVED.md) | B2, B13 | `grep -rn SECRET_ENV_PATTERNS src/` returns zero (B2); `target_agents:` is required-explicit (no `.default([])`) in `BuiltinSkillFrontmatterSchema` (B13). |
| **P3 — No fragile agent-tool-call heuristics; treat agents as adults** | [G12b](G12b/APPROVED.md) | B9 | 13-needle grep gate (PromptInjection, promptInjectionCop, prompt-injection-cop, scanUntrustedText, prompt_injection_scan, injectionScanner, injectionModel, maxScanLengthBytes, securityModel, `security:` literal, SecurityStatusRing, securityStatusRing, /api/debug/security) returns zero across `src/`, `web/src/`, `docs/`, `prompts/`. |

The three principles do not generate new findings of their own beyond the listed ones — the metaplan executor adds the regression pins above to the lint pipeline so subsequent round-3 reviews catch any re-introduction without re-deriving the principle from first principles.

## 11. Out of scope

The following are explicitly NOT in this metaplan and must not be opportunistically bundled into any of B0–B15:

- **F-G20-RENAME** — rename `OpenAIProvider` → `OpenAICompatProvider` after G20/G21/G22 land. Separate ticket because it churns import sites across the agents/ subtree and would obscure the router-cleanup diff.
- **F-G20-OPENAI-PKG** — audit whether the `openai` npm package is still a runtime dependency after the concrete provider classes are deleted. Filed against `package.json`; not blocking B6.
- **G45 design B** — build-time TS-snippet directive for docs interface blocks; see §7 deferred. Roll it up with G40/G44 in the docs-lint level-up batch, not inside B0.
- **G51** — partial `bootstrap()` teardown transactionality. See §7; the workaround is operator-visible (`pkill -f saivage`).
- **Round-3 review findings** — anything noticed during execution of B0–B15 that is not an APPROVED.md finding from round 2. File as a new G## under `SPEC/v2/review-2026-05-round3/` rather than expanding scope of an in-flight batch.

## 12. Final landing checklist (per batch)

Each batch lands as a single commit set (or a small ordered sequence inside the batch per the C-* chain). Before declaring a batch landed, the executing agent must:

1. Run the strictest validation command listed in §8 for that batch and capture exit code 0.
2. Run any batch-specific grep gates (B2/B5/B9/B13/B14) and confirm zero matches for the negative patterns.
3. For batches that restart daemons, run the LXC restart commands in §8 and verify `curl -fsS http://<ip>:8080/health` returns 200 for every affected daemon.
4. Update [../../../docs/internals/](../../../docs/internals/) if the batch's `Files` list includes any `docs/internals/*.md` entry (B0, B2, B7, B9, B12, B13).
5. Append a one-line landed-on entry to this metaplan's git-blame-tracked log (a future round-3 reviewer reconstructs landing order from `git log -- 99-METAPLAN.md`).

When all 14 batches have landed, round 2 is closed and the deferred items in §7 + §11 form the seed inventory for round 3.
