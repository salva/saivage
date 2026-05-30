# Saivage v2 Systematic Review — Round 2 (2026-05) — Issue Inventory

Companion to [00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md). Produced after the round-1 metaplan (F01–F35) was fully executed; see [../review-2026-05/00-INDEX.md](../review-2026-05/00-INDEX.md) and [../review-2026-05/99-METAPLAN.md](../review-2026-05/99-METAPLAN.md) for round-1 context.

Numbering uses prefix `G` (round-2 / "generation 2") to keep stable cross-references from round-1 untouched. Findings are stable — do not renumber.

44 findings total. Per-issue dual-LLM artifacts will live in `GNN-<slug>/` directories alongside each issue file.

## Severity / transversality summary

| Severity | Count |
|---|---|
| critical | 0 |
| high | 11 |
| medium | 23 |
| low | 10 |

| Transversality | Count |
|---|---|
| architectural | 6 |
| cross-cutting | 16 |
| local | 22 |

## Findings — agents / chat / security / runtime / store (G01–G19)

| ID | Title | Subsystem | Category | Severity | Transversality |
|---|---|---|---|---|---|
| [G01](G01-supervisor-abort-priority-duplicates-roster.md) | Supervisor `ABORT_PRIORITY` duplicates and drifts from `ROSTER.abortPriority` (regression of F23) | runtime/agents | inconsistency | high | cross-cutting |
| [G02](G02-dispatcher-limits-omit-designer.md) | Dispatcher `enforceDispatchLimits` silently omits the `designer` role | runtime | inconsistency | medium | cross-cutting |
| [G03](G03-role-tool-filter-ignores-roster.md) | `ROLE_TOOL_FILTER` ignores `roster.toolFilter` and omits half the roles | agents | inconsistency | high | cross-cutting |
| [G04](G04-manager-validate-final-response-hardcoded-tools.md) | `ManagerAgent.validateFinalResponse` hardcodes the dispatch-tool list | agents | inconsistency | medium | local |
| [G05](G05-worker-message-builder-duplicated-5x.md) | Worker initial-message builders duplicated across five agent files | agents | bad-design | medium | cross-cutting |
| [G06](G06-stash-uses-sync-fs.md) | `runtime/stash.ts` uses synchronous fs in the agent hot path (regression of F22) | runtime | bad-design | medium | cross-cutting |
| [G07](G07-compaction-fallback-orphan-tool-results.md) | Compaction fallback truncation can leave orphaned `tool_result` blocks | runtime | half-implemented | medium | local |
| [G08](G08-seedproject-writes-saivagejson-without-schema.md) | `seedProject` writes `saivage.json` raw, bypassing `SaivageConfigSchema` | store | bad-design | medium | local |
| [G09](G09-planner-plan-complete-text-protocol.md) | Planner uses regex-on-LLM-text to detect `PLAN_COMPLETE` termination | agents | short-sighted | medium | local |
| [G10](G10-appenddoc-read-modify-write-race.md) | `appendDoc` has a read-modify-write race and exists only for tests | store | dead-code | low | local |
| [G11](G11-chat-restart-regex-english-only.md) | Chat explicit-restart detection uses English-only regex | chat | short-sighted | medium | local |
| [G12](G12-prompt-injection-cop-fail-open-silent.md) | `prompt-injection-cop` fails open silently with no operator visibility | security | bad-design | medium | local |
| [G13](G13-conventions-file-mixes-two-concerns.md) | `agents/conventions.ts` mixes territory rules with the chat-command registry | agents/chat | bad-design | low | local |

## Findings — providers / auth / routing / mcp / knowledge / config / types (G20–G39)

| ID | Title | Subsystem | Category | Severity | Transversality |
|---|---|---|---|---|---|
| [G20](G20-dead-concrete-provider-classes.md) | Dead concrete provider classes never instantiated by the router | providers | dead-code | high | architectural |
| [G21](G21-router-provider-name-quadruple-duplication.md) | Provider-name list duplicated four times inside `router.ts` | providers | bad-design | medium | local |
| [G22](G22-router-dead-copilot-oauth-mapping.md) | Router carries a dead `copilot` entry in PROVIDER_TO_OAUTH | providers | dead-code | low | local |
| [G23](G23-resolver-silent-profile-cycle.md) | Routing resolver silently truncates rule chains on profile cycles | routing | bad-design | medium | local |
| [G24](G24-resolver-redundant-zod-parse.md) | Routing resolver re-parses the project routing schema on every call | routing | over-featurism | low | local |
| [G25](G25-resolver-fail-open-allowed-models.md) | Resolver fails open when `allowed_models` filters out every candidate | routing | bad-design | medium | cross-cutting |
| [G26](G26-resolver-legacy-source-tier.md) | Resolver still exposes a `"legacy"` source tier in its merge order | routing | dead-code | low | local |
| [G27](G27-plan-server-started-at-equals-completed-at.md) | `plan_complete_stage` writes `started_at = completed_at` | mcp | bad-design | medium | local |
| [G28](G28-plan-server-cross-doc-atomicity-gap.md) | `plan_complete_stage` lacks cross-document atomicity (acknowledged in code) | mcp | half-implemented | high | cross-cutting |
| [G29](G29-plan-server-serialize-blocks-reads.md) | `serializeOp` queues read-only tool calls behind every writer | mcp | over-featurism | low | local |
| [G30](G30-builtins-filesystem-sync-fs.md) | MCP `filesystem` builtin still uses blocking sync fs (regression class of F22) | mcp | bad-design | high | cross-cutting |
| [G31](G31-builtins-read-file-no-size-cap.md) | `read_file` builtin slurps entire files with no size or chunk cap | mcp | short-sighted | medium | local |
| [G32](G32-builtins-search-files-find-subprocess.md) | `search_files` shells out to the POSIX `find` binary | mcp | bad-design | medium | local |
| [G33](G33-builtins-web-search-ddg-regex.md) | `web_search` builtin scrapes DuckDuckGo HTML with regex | mcp | short-sighted | medium | local |
| [G34](G34-builtins-fetch-url-no-streaming-cap.md) | `fetch_url` buffers full response before applying any size cap | mcp | short-sighted | medium | local |
| [G35](G35-builtins-secret-env-regex-too-broad.md) | `SECRET_ENV_PATTERNS` regex strips legitimate env vars | mcp | bad-design | low | local |
| [G36](G36-auth-store-sync-fs.md) | Auth profile store reads/writes credentials with blocking sync fs | auth | bad-design | high | cross-cutting |
| [G37](G37-config-sync-fs-and-stale-cache.md) | `loadConfig` is sync-fs and caches without mtime invalidation | config | bad-design | medium | cross-cutting |
| [G38](G38-knowledge-store-process-local-locks-only.md) | Knowledge store mutexes are process-local; no inter-process file lock | knowledge | race-condition | high | architectural |
| [G39](G39-knowledge-store-lock-chain-poisoning.md) | Knowledge `acquire()` permanently poisons a lock key if any holder rejects | knowledge | race-condition | high | cross-cutting |

## Findings — server / channels / web / docs / spec / skills (G40–G59)

| ID | Title | Subsystem | Category | Severity | Transversality |
|---|---|---|---|---|---|
| [G40](G40-web-ui-doc-massively-drifted.md) | Web UI doc massively drifted (tabs, WS protocol, auth) | docs | docs-drift | high | architectural |
| [G41](G41-app-title-sync-reads-wrong-state-fields.md) | `App.vue` title sync reads wrong `/api/state` fields | web | inconsistency | medium | local |
| [G42](G42-builtin-skills-agenttypes-silently-ignored.md) | Built-in skills' `agentTypes:` silently ignored by loader | skills | bad-design | high | architectural |
| [G43](G43-planning-skill-fictional-plan-format.md) | `planning` skill teaches fictional plan format with non-existent `executor` role | skills | docs-drift | high | architectural |
| [G44](G44-internals-channels-doc-regression-of-F35.md) | `docs/internals/channels.md` regression of F35 — references deleted CLI/oneshot channels | docs | docs-drift | medium | local |
| [G45](G45-internals-server-runtime-shape-drift.md) | `docs/internals/server.md` `SaivageRuntime` shape and shutdown flow are fictional | docs | docs-drift | medium | local |
| [G46](G46-agents-view-monolith.md) | `AgentsView.vue` 1,492-line monolith mixes four surfaces | web | bad-design | medium | local |
| [G47](G47-telegram-bot-auth-and-startup-issues.md) | Telegram bot: silent unauthorized drop, unawaited `bot.start()`, boot hydration bypasses allowlist | channels | bad-design | medium | local |
| [G48](G48-cli-inspect-runtime-leak-on-throw.md) | `saivage inspect` leaks runtime on `inspector.run()` throw | server | bad-design | low | local |
| [G49](G49-usewebsocket-send-leaky-envelope.md) | `useWebSocket.send` accepts raw string, forcing every caller to hand-encode the envelope | web | bad-design | low | local |
| [G50](G50-note-manager-per-request-instantiation.md) | `NoteManager` re-instantiated on every `/api/notes*` request | server | bad-design | low | local |

## Major themes (cross-finding)

1. **Roster contract erosion** — G01, G02, G03, G04 are four hand-rolled parallel tables that should derive from `ROSTER`. The `chat` role having an unfiltered tool surface (G03) combined with G12's silent fail-open prompt-injection cop is a real attack surface, not a hygiene issue.
2. **Async-fs regression class** — F22 made the knowledge store async but did not propagate. G06 (stash), G30 (mcp filesystem), G36 (auth store), G37 (config) all block the event loop on every call.
3. **Provider layer fossilisation** — G20, G21, G22 show ~1000 lines of provider abstractions that the router never instantiates; the router carries duplicated string tables and dead OAuth mappings.
4. **Plan server transactional gaps** — G27, G28, G29 in `mcp/plan-server.ts` together describe a writer that knowingly skips cross-document atomicity, synthesises a timestamp, and over-serialises reads.
5. **Knowledge store concurrency model is fundamentally wrong** — G38 (process-local locks only) + G39 (permanent lock-chain poisoning) make the architecturally most important correctness gaps in the codebase.
6. **Docs drift after the round-1 deletions** — G40, G44, G45 are doc files that still describe the world before F35's channel deletion and the round-1 server refactors.
7. **Skills declare metadata the loader ignores** — G42, G43 expose that the skill frontmatter contract is unenforced; agents can be steered by skill text claiming behavior that does not exist.
