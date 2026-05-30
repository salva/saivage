# Saivage v2 Review 2026-05 — Metaplan

Authoritative sequencing for the 35 reviewer-approved findings in this review. Repo root: `/home/salva/g/ml/saivage`. Workspace conventions in [`_LOOP-CONVENTIONS.md`](_LOOP-CONVENTIONS.md), subsystem map in [`00-SUBSYSTEM-MAP.md`](00-SUBSYSTEM-MAP.md), inventory in [`00-INDEX.md`](00-INDEX.md).

This document is a sequencing plan only. It does NOT replace the per-issue plans; it merely declares the order in which they should be applied and which validation gates run between batches.

## Mandatory project guidelines (apply to every batch)

1. Architecture-first. NO backward compatibility. No migration shims, no `@deprecated` aliases, no "old + new during rollout", no transitional feature flags. Delete the old in the same change.
2. Clean code. No abstractions used once. No premature configurability. No defensive code at internal boundaries. Aggressively remove dead code instead of preserving it.
3. No new comments/docstrings on lines you are not otherwise editing. No emojis anywhere.

## Out-of-scope boundary (do not touch in any batch)

These areas are owned by a separate concurrent agent. Cross-coordinate at boundaries, do not edit:

- [src/skills/](../../../src/skills/) and its tests.
- [SPEC/v2/skills/](../skills/) and [SPEC/v2/skills-memory/](../skills-memory/).
- [src/chat/slashCommands.ts](../../../src/chat/slashCommands.ts) and `parseSlashCommand` / `runSlashCommand` (the `/skills`, `/memories`, `/remember`, `/forget` family).
- The `parseSlashCommand` call site inside [src/agents/chat.ts](../../../src/agents/chat.ts#L300-L334).
- Any `MEMORY_SKILL_HELP_ROWS` copied verbatim by F30.

Cross-cutting coordination required (informational, not source edits):

- F22 expects the skills/memory async pass (`src/knowledge/store.ts`, `src/knowledge/integration.ts`, `writeRecordAtomic`, `rebuildIndex`) to land in the same merge window. Coordinate but do not edit those files inside F22's batch on this side.
- F18 introduces `{{slash_commands_table}}` rendered only from the local-Chat command surface; the seven memory/skill `/help` rows continue to come from the other agent's `cmdHelp` Markdown table (F30 carries them verbatim as `MEMORY_SKILL_HELP_ROWS`).
- F30 strictly stays on the chat-agent side of the boundary; it must not import from or modify `src/chat/slashCommands.ts`.

## Per-issue table

ID, slug, chosen proposal, one-line summary, importance / transversality / blast radius, final-round files.

| ID | Slug | Prop | Summary | Imp. | Trans. | Blast | Files |
|---|---|---|---|---|---|---|---|
| F01 | designer-agent-orphan | C | Reinstate `DesignerAgent` as a `WorkerAgent` subclass and widen role enums after F09. | low | low | low | [F01/APPROVED.md](F01/APPROVED.md), [F01/02-design-r2.md](F01/02-design-r2.md), [F01/03-plan-r2.md](F01/03-plan-r2.md) |
| F02 | agent-roster-drift | A | `[done]` Single `src/agents/roster.ts` source of truth for `AgentRole`, `WorkerRole`, `DispatchableRole`, dispatch tools, model keys; SPEC parity test. | high | high | high | [F02/APPROVED.md](F02/APPROVED.md), [F02/02-design-r2.md](F02/02-design-r2.md), [F02/03-plan-r2.md](F02/03-plan-r2.md) |
| F03 | naive-json-extraction | B | Shared `src/parse-llm-json.ts` (`extractJsonCandidates`, `parseLlmJson`, `parseLlmJsonAs`); silent-success parser branches deleted. | high | high | med | [F03/APPROVED.md](F03/APPROVED.md), [F03/02-design-r3.md](F03/02-design-r3.md), [F03/03-plan-r3.md](F03/03-plan-r3.md) |
| F04 | hardcoded-default-models | A | Drop hardcoded `models.*` defaults; add boot-time `validateModelCoverage` throwing `MissingModelForRoleError`. | med | high | med | [F04/APPROVED.md](F04/APPROVED.md), [F04/02-design-r3.md](F04/02-design-r3.md), [F04/03-plan-r3.md](F04/03-plan-r3.md) |
| F05 | supervisor-regex-undermines-llm | B | Delete `normalizeNonStuckOperationalVerdict` and the three `looksLike*` regex predicates; let the supervisor's LLM verdict pass through. | med | med | low | [F05/APPROVED.md](F05/APPROVED.md), [F05/02-design-r2.md](F05/02-design-r2.md), [F05/03-plan-r2.md](F05/03-plan-r2.md) |
| F06 | dispatcher-notes-sidechannel | B | Replace `__saivage_pending_user_notes` tool-result contamination with a typed `InputChannel` (`drain` + `onContextReset`) on `BaseAgent`. | med | med | med | [F06/APPROVED.md](F06/APPROVED.md), [F06/02-design-r4.md](F06/02-design-r4.md), [F06/03-plan-r4.md](F06/03-plan-r4.md) |
| F07 | token-estimation-chars-over-4 | B | Synchronous `ModelProvider.countTokens` capability + `BaseProvider` default; running token counter on `BaseAgent`; tiktoken via `src/runtime/token-counting.ts`. | med | high | high | [F07/APPROVED.md](F07/APPROVED.md), [F07/02-design-r3.md](F07/02-design-r3.md), [F07/03-plan-r4.md](F07/03-plan-r4.md) |
| F08 | legacy-runtime-state-mirror | A | Delete `legacyRuntimeStatePath`, the double-write, the test asserting the mirror, and the planner-prompt bullet. | low | low | low | [F08/APPROVED.md](F08/APPROVED.md), [F08/02-design-r4.md](F08/02-design-r4.md), [F08/03-plan-r1.md](F08/03-plan-r1.md) |
| F09 | worker-agent-helpers-duplicated | C | `[done]` Extract `src/agents/task-report.ts` + `src/agents/worker.ts` (`WorkerAgent`); collapse coder/researcher/data-agent/reviewer duplication; delete `designer.ts`. Inspector did not migrate (returns `InspectionReport`). | high | high | high | [F09/APPROVED.md](F09/APPROVED.md), [F09/02-design-r2.md](F09/02-design-r2.md), [F09/03-plan-r2.md](F09/03-plan-r2.md) |
| F10 | web-styles-orphan | A | Delete orphan `web/src/styles.css`; fix two stale references in `docs/internals/web-internals.md`. | low | low | low | [F10/APPROVED.md](F10/APPROVED.md), [F10/02-design-r1.md](F10/02-design-r1.md), [F10/03-plan-r1.md](F10/03-plan-r1.md) |
| F11 | magic-constants-not-in-config | B | Promote operator-facing constants (notes TTL, supervisor force-cancel, MCP shell timeout floor/cap) to `SaivageConfig`; delete dead `?? DEFAULT_*` fallbacks. | med | high | med | [F11/APPROVED.md](F11/APPROVED.md), [F11/02-design-r2.md](F11/02-design-r2.md), [F11/03-plan-r2.md](F11/03-plan-r2.md) |
| F12 | mcp-cross-file-magic-coupling | A | Derive `MAX_WALL_CLOCK_MS` from `mcpConfig.shellTimeoutMs` inside `registerBuiltinServices`; reject impossible envelopes at schema load. | med | med | low | [F12/APPROVED.md](F12/APPROVED.md), [F12/02-design-r3.md](F12/02-design-r3.md), [F12/03-plan-r3.md](F12/03-plan-r3.md) |
| F13 | base-agent-error-regex-brittle | B | Typed `ProviderError` classified at the provider boundary; Anthropic uses `APIError.type`, OpenAI uses `instanceof`, `Headers.get` for retry-after. | med | med | med | [F13/APPROVED.md](F13/APPROVED.md), [F13/02-design-r3.md](F13/02-design-r3.md), [F13/03-plan-r3.md](F13/03-plan-r3.md) |
| F14 | reviewer-double-push | B | `[done]` Absorb the reviewer-side double-push fix into F09's `WorkerAgent` extraction; planner-nudge duplicate assistant push deleted in its own one-line edit. | med | low | low | [F14/APPROVED.md](F14/APPROVED.md), [F14/02-design-r2.md](F14/02-design-r2.md), [F14/03-plan-r3.md](F14/03-plan-r3.md) |
| F15 | oauth-token-resolution-overlap | A | Delete `injectOAuthTokens`, the `OAUTH_TO_PI` map, and the dead `oauthToProviderName` helper; lazy `resolveApiKey` becomes the only path. | low | low | low | [F15/APPROVED.md](F15/APPROVED.md), [F15/02-design-r2.md](F15/02-design-r2.md), [F15/03-plan-r1.md](F15/03-plan-r1.md) |
| F16 | telegram-bot-userid-as-chatid | B | Persist Telegram notification subscriptions (`telegram-subscriptions.json`) keyed by chat id; `/subscribe` and `/unsubscribe` slash commands. | high | low | med | [F16/APPROVED.md](F16/APPROVED.md), [F16/02-design-r2.md](F16/02-design-r2.md), [F16/03-plan-r2.md](F16/03-plan-r2.md) |
| F17 | telegram-markdown-converter | A | Replace the bespoke Markdown→HTML converter with `telegramify-markdown` (MarkdownV2); add span-aware oversize splitter. | low | low | low | [F17/APPROVED.md](F17/APPROVED.md), [F17/02-design-r3.md](F17/02-design-r3.md), [F17/03-plan-r3.md](F17/03-plan-r3.md) |
| F18 | system-prompt-bloat | B | Externalize role prompts to `prompts/<role>.md` with shared partials in `prompts/shared/`; loader in `src/agents/prompts.ts`; `tsup` ships them. | med | high | high | [F18/APPROVED.md](F18/APPROVED.md), [F18/02-design-r2.md](F18/02-design-r2.md), [F18/03-plan-r2.md](F18/03-plan-r2.md) |
| F19 | provider-barrel-incomplete | B | Delete the incomplete `src/providers/index.ts` barrel; consumers already use deep imports. | low | low | low | [F19/APPROVED.md](F19/APPROVED.md), [F19/02-design-r2.md](F19/02-design-r2.md), [F19/03-plan-r2.md](F19/03-plan-r2.md) |
| F20 | max-context-tokens-hardcoded | B | Replace `maxContextTokens(model)` with a per-model `ModelCapabilities { contextWindow, tokenEncoding }`; `BaseProvider.countTokens` reads encoding from it; F07 per-provider overrides deleted. | med | high | med | [F20/APPROVED.md](F20/APPROVED.md), [F20/02-design-r2.md](F20/02-design-r2.md), [F20/03-plan-r2.md](F20/03-plan-r2.md) |
| F21 | copilot-hardcoded-headers | A | Make Copilot `editor-version`, `editor-plugin-version`, `User-Agent` operator-configurable via `SaivageConfig`. | med | low | low | [F21/APPROVED.md](F21/APPROVED.md), [F21/02-design-r2.md](F21/02-design-r2.md), [F21/03-plan-r4.md](F21/03-plan-r4.md) |
| F22 | documents-store-sync-fs | A | Convert `src/store/documents.ts` to `node:fs/promises`; cascade `async`/`await` through `PlanService.init`, bootstrap, agent factories, notes API, shutdown handoff, fatal handler. | high | high | high | [F22/APPROVED.md](F22/APPROVED.md), [F22/02-design-r2.md](F22/02-design-r2.md), [F22/03-plan-r2.md](F22/03-plan-r2.md) |
| F23 | supervisor-priority-incomplete | B | Replace `ROLE_ABORT_PRIORITY` array with a typed `Record<AgentRole, number>`; register `ChatAgent` in `agentRegistry` at both WebSocket and Telegram construction sites. | med | med | low | [F23/APPROVED.md](F23/APPROVED.md), [F23/02-design-r3.md](F23/02-design-r3.md), [F23/03-plan-r3.md](F23/03-plan-r3.md) |
| F24 | shutdown-handoff-delete-on-read | A | Rename consumed handoff files to `${path}.consumed` instead of deleting; consume claims first, then formats. | med | med | low | [F24/APPROVED.md](F24/APPROVED.md), [F24/02-design-r2.md](F24/02-design-r2.md), [F24/03-plan-r2.md](F24/03-plan-r2.md) |
| F25 | prompt-injection-cop-regex-fp | B | Delete `BLOCK_PATTERNS` / `SUSPICIOUS_PATTERNS` / `scanHeuristically`; cop is LLM-only with fail-open. | med | low | low | [F25/APPROVED.md](F25/APPROVED.md), [F25/02-design-r2.md](F25/02-design-r2.md), [F25/03-plan-r2.md](F25/03-plan-r2.md) |
| F26 | spa-auth-state-duplicated | A | Shared `web/src/composables/useAuthState.ts`; remove duplicated `"unauthorized"` paths in `App.vue` and `useWebSocket.ts`; title watcher gains `unauthorized` source. | low | low | low | [F26/APPROVED.md](F26/APPROVED.md), [F26/02-design-r1.md](F26/02-design-r1.md), [F26/03-plan-r2.md](F26/03-plan-r2.md) |
| F27 | oauth-client-ids-in-source | A | Move OAuth client ids to `src/auth/defaults.ts`; expose `oauth.{anthropic,openaiCodex,githubCopilot}.clientId` in `SaivageConfig`. | low | low | low | [F27/APPROVED.md](F27/APPROVED.md), [F27/02-design-r1.md](F27/02-design-r1.md), [F27/03-plan-r1.md](F27/03-plan-r1.md) |
| F28 | mcp-registry-unused | B | Delete `src/mcp/registry.ts`; move `ServiceEntry` / `ToolEntry` to `src/mcp/types.ts`; drop `status` and `"generated"` origin variant. | low | low | low | [F28/APPROVED.md](F28/APPROVED.md), [F28/02-design-r2.md](F28/02-design-r2.md), [F28/03-plan-r2.md](F28/03-plan-r2.md) |
| F29 | pi-ai-as-any-and-synthesis | A | Concentrate pi-ai casts in `src/providers/pi-ai-types.ts` (`piGetModel`, `piGetModels`, `UnknownModelError`); narrow on `Model.api` discriminant. | med | low | low | [F29/APPROVED.md](F29/APPROVED.md), [F29/02-design-r2.md](F29/02-design-r2.md), [F29/03-plan-r2.md](F29/03-plan-r2.md) |
| F30 | chat-slash-commands-triplicated | B | New `src/chat/localCommands.ts`: `LOCAL_COMMAND_HANDLERS satisfies Record<LocalChatCommandName, ...>`; delete `cmdHelp`, move `cmdNote` / `cmdRestartPlanner` out of `ChatAgent`. Chat-side only; skills/memory untouched. | low | low | low | [F30/APPROVED.md](F30/APPROVED.md), [F30/02-design-r2.md](F30/02-design-r2.md), [F30/03-plan-r2.md](F30/03-plan-r2.md) |
| F31 | base-agent-prompt-doc-mismatch | A | Closure-by-reference: F18's prompt externalization automatically retires the stale `BaseAgentConfig.systemPrompt` JSDoc claim. | low | low | low | [F31/APPROVED.md](F31/APPROVED.md), [F31/02-design-r1.md](F31/02-design-r1.md), [F31/03-plan-r1.md](F31/03-plan-r1.md) |
| F32 | saivage-config-undocumented-blocks | B | Delete the schema mirror in `SPEC/v2/01-DATA-MODEL.md § 1`; promote `docs/guide/config-runtime.md` to canonical operator prose; point SPEC at `src/config.ts`. | med | med | low | [F32/APPROVED.md](F32/APPROVED.md), [F32/02-design-r1.md](F32/02-design-r1.md), [F32/03-plan-r2.md](F32/03-plan-r2.md) |
| F33 | default-project-config-drift | A | Rename `initProject` to `seedProject`; trim `ProjectConfig` to project-scoped fields; clean up `routing-resolver` leftovers (`project-default` source, `ProjectRoutingConfigLike.provider`). | med | med | med | [F33/APPROVED.md](F33/APPROVED.md), [F33/02-design-r2.md](F33/02-design-r2.md), [F33/03-plan-r2.md](F33/03-plan-r2.md) |
| F34 | plan-server-no-cache-or-read-gate | B | In-memory plan + history cache in `PlanService`; `init()` loads from disk; mutations write-through; cache replaces per-call `readDoc`. | med | med | med | [F34/APPROVED.md](F34/APPROVED.md), [F34/02-design-r2.md](F34/02-design-r2.md), [F34/03-plan-r2.md](F34/03-plan-r2.md) |
| F35 | cli-channel-orphan | B | Delete the unused `src/channels/cli.ts`, `src/channels/oneshot.ts`, and `src/channels/index.ts`. | low | low | low | [F35/APPROVED.md](F35/APPROVED.md), [F35/02-design-r1.md](F35/02-design-r1.md), [F35/03-plan-r1.md](F35/03-plan-r1.md) |

Total issues covered: 35.

## Batch ordering

Seven batches. Within each batch, apply issues in the listed order. Between batches, run the validation gate at the bottom of this document.

### Batch 1 — Agent roster, worker lifecycle, double-push (4 issues; F02, F09, F14 landed pre-commit; F01 remaining)

Goal: lock the canonical agent surface so downstream provider/MCP/prompt work has a stable target. This is the most architecturally transversal block.

Issues in order:

1. **F02** `[landed]` — declared canonical `roster.ts`; all role enums, dispatch tools, `models.*` keys, conventions, abort priorities, self-check frequencies, and the planner-prompt roster summary are derived from it; SPEC↔roster parity test in place. Provides `WORKER_ROLES`, `ALL_ROLES`, `DispatchableRole` consumed by F09 / F01 / F23.
2. **F09** `[landed]` — extracted `task-report.ts` + `WorkerAgent`; collapsed coder / researcher / data-agent / reviewer duplication; deleted orphan `designer.ts`. Inspector did NOT migrate (returns `InspectionReport`, not `TaskReport`) — see "Open follow-ups" below. F14's reviewer-side double-push deletion is absorbed here.
3. **F01** — reinstate `DesignerAgent extends WorkerAgent`; widen role enums (`AgentRole`, `WorkerRole`, `TaskSchema.type`/`assigned_to`, `TaskReportSchema.agent`, `AgentStateSchema.agent_type`), routing resolver, self-check schedule, dispatcher map, Manager prompt. Strictly after F02 + F09. **(Only remaining Batch 1 item.)**
4. **F14** `[landed]` — single-line planner-nudge duplicate-assistant-push deletion + two regression tests (reviewer / planner). Reviewer half landed via F09.

Cross-batch dependencies:

- Provides `AgentRole`, `WorkerRole`, `DispatchableRole`, `WorkerAgent`, `task-report.ts` consumed by Batch 2 (F18 prompt loader uses roles), Batch 3 (F04 / F07 / F20 / F13 iterate over roles), Batch 4 (F23 uses `Record<AgentRole, number>`).

Validation (run from `/home/salva/g/ml/saivage`):

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

Targeted vitest run for affected paths:

```bash
npx vitest run src/agents src/runtime/dispatcher.test.ts src/runtime/self-check.test.ts
```

Rollback: `git revert <range>` of the four batch commits in reverse order. No on-disk state implications.

### Batch 2 — Shared LLM-JSON parser and prompt externalization (4 issues)

Goal: stop the two biggest "free-form text crossing into structured land" hazards (greedy JSON regex) and move every role prompt out of TypeScript so prompt iteration is deploy-free.

Issues in order:

1. **F03** — add `src/parse-llm-json.ts`; rewrite worker `parseTaskReport`, inspector parser, manager stage decomposer, supervisor `parseVerdict` to use `parseLlmJsonAs`. Independent of F01; prefer to land before F05 (supervisor) and before F09 only if F09 has not started — F03 and F09 are non-conflicting either way (per F03 plan §"Cross-issue ordering").
2. **F18** — create `prompts/` tree (shared partials + per-role files); `src/agents/prompts.ts` loader with partial expansion + `{{slash_commands_table}}` substitution from `LOCAL_CHAT_COMMANDS`; `tsup` ships `prompts/` into `dist/`; every agent constructor switches to `loadRolePrompt(role)`.
3. **F31** — closure-by-reference: verify F18 removed the stale `prompts/<role>.md` JSDoc fragment from `BaseAgentConfig.systemPrompt`. Pure administrative close-out (no source edits unless F18 is descoped, in which case fall back to Proposal B's one-line JSDoc fix).
4. **F30** — `src/chat/localCommands.ts` with `LOCAL_COMMAND_HANDLERS satisfies Record<LocalChatCommandName, LocalCommandHandler>`; delete `cmdHelp`; move `cmdNote` / `cmdRestartPlanner` out of `ChatAgent`. Strictly chat-side; do not touch `src/chat/slashCommands.ts` or the memory/skill rows.

Cross-batch dependencies:

- F18 depends on F02's `ALL_ROLES` (for prompt-loader coverage assertions) and F09's `WorkerAgent` (for the worker-contract partial).
- F30 depends on F18's `LOCAL_CHAT_COMMANDS` export.
- F31 depends on F18.
- F03 is consumed by F05 in Batch 4.

Validation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx vitest run src/parse-llm-json.test.ts src/agents src/chat
```

Manual smoke (post-build, on the `saivage-v3` LXC if redeployed): `curl -fsS http://10.0.3.112:8080/health`.

Rollback: `git revert <range>`. No on-disk state implications (prompts shipped from `dist/`).

### Batch 3 — Provider, routing, model identifiers, token counting (9 issues)

Goal: remove every hardcoded model identifier outside the provider layer, replace ad-hoc error/regex/token heuristics with typed capabilities, and consolidate pi-ai's bridge.

Issues in order:

1. **F19** — delete `src/providers/index.ts` after pre-flight grep confirms no consumer. Clears import surface noise for the rest of the batch.
2. **F27** — `src/auth/defaults.ts` + `oauth.*.clientId` config block; remove inline OAuth client-id constants from the three auth flows.
3. **F15** — delete `injectOAuthTokens`, `OAUTH_TO_PI`, `oauthToProviderName`. Lazy `resolveApiKey` becomes the only path.
4. **F29** — `src/providers/pi-ai-types.ts` (`piGetModel`, `piGetModels`, `UnknownModelError`); narrow on `Model.api`; eliminate scattered `as any` / `as unknown as`.
5. **F13** — `src/providers/error.ts` with `ProviderError`, `classifyProviderError`; Anthropic uses `APIError.type`, OpenAI uses `instanceof`, `Headers.get` for retry-after; hoist `providerName` in `ModelRouter.callProvider`.
6. **F21** — operator-configurable `editor-version`, `editor-plugin-version`, `User-Agent` for Copilot via `SaivageConfig`; constructor + setter + router wiring.
7. **F04** — drop the hardcoded `models.*` defaults from `configSchema`; add `src/config-validation.ts` (`MissingModelForRoleError`, `validateModelCoverage`); rewrite the `AgentContext.modelSpec` JSDoc example; production-source sweep gate.
8. **F07** — `src/runtime/token-counting.ts` (`countWithTiktoken`, `countTextWithTiktoken`); `ModelProvider.countTokens` capability; `BaseProvider` default + per-provider overrides including the load-bearing `PiAiProvider.countTokens` over the five live `piProvider` registrations; running token counter on `BaseAgent`.
9. **F20** — `ModelCapabilities { contextWindow, tokenEncoding }` per model; `BaseProvider.countTokens` reads encoding from it; F07's per-provider `countTokens` overrides are deleted in this step; `defaultContextWindow` moves to `runtimeProviderConfigSchema`.

Cross-batch dependencies:

- F04 must precede F32 (Batch 7) because F32 stops the SPEC mirror that documents the missing-defaults policy.
- F07 must precede F20.
- F13 is consumed by F22 indirectly (provider error path is invoked from async `chat`) but does not require ordering with F22.

Validation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx vitest run src/providers src/auth src/routing src/security
```

Sweep gate (F04): `rg -n '"(anthropic|openai|openai-codex|github-copilot|openrouter|ollama|llamacpp|opencode|opencode-go|pi-ai)/[a-z0-9.-]+"' src --type ts -g '!*.test.ts'` must return zero matches outside `src/providers/`.

Rollback: `git revert <range>`. State implications: operators relying on the previous hardcoded model defaults will get a fatal `MissingModelForRoleError` on next boot until `models.default` is set; document in the batch commit message. OAuth client-id rotation now requires a config edit instead of a rebuild.

### Batch 4 — Runtime constants, MCP, dispatcher, supervisor, shutdown (8 issues)

Goal: pull the operational knobs into `SaivageConfig`, fix the dispatcher side-channel, close two safety holes (shutdown delete-on-read, supervisor regex undermining).

Issues in order:

1. **F11** — extend `SaivageConfig` (`runtime.notes.volatileTtlMs`, `runtime.recoveryDelayMs`, `runtime.healthCheckIntervalMs`, `runtime.idleShutdownMs`, `supervisor.forceCancelDelayMs`, `mcp.shellTimeoutMs`, `mcp.shellTimeoutFloorMs`); delete dead `?? DEFAULT_*` fallbacks; do NOT touch `EventBus.handlerTimeoutMs` parameter (load-bearing test seam).
2. **F12** — derive `MAX_WALL_CLOCK_MS` from `mcpConfig.shellTimeoutMs` inside `registerBuiltinServices` closure; reject impossible timing envelopes at schema load (depends on F11).
3. **F28** — delete `src/mcp/registry.ts`; move `ServiceEntry` / `ToolEntry` to `src/mcp/types.ts`; drop `status` field and `"generated"` origin variant.
4. **F06** — `InputChannel { drain, onContextReset }` on `BaseAgent`; `NoteChannel` replaces `__saivage_pending_user_notes` tool-result contamination; `getUnacknowledgedNotes` / `getPermanentNotes` deleted; `compactWithReinjection` extended to fire `onContextReset` on every channel.
5. **F08** — delete `legacyRuntimeStatePath`, the double-write in `writeRuntimeState`, the mirror test, and the planner-prompt bullet. Run before F22 so F22's async cascade has one fewer write path to convert.
6. **F05** — delete `normalizeNonStuckOperationalVerdict` and the three `looksLike*` predicates; let supervisor LLM verdict pass through (depends on F03).
7. **F23** — replace `ROLE_ABORT_PRIORITY` array with typed `Record<AgentRole, number>` (depends on F02); register `ChatAgent` in `runtime.agentRegistry` at WebSocket and Telegram construction sites.
8. **F24** — rename consumed handoff files to `${path}.consumed` instead of deleting; reorder `consumeShutdownHandoff` to claim-then-format; add `renameDoc` primitive to `documents.ts`.

Cross-batch dependencies:

- F11 must precede F12, F22 (`mcp.shellTimeoutMs` becomes a constructor argument), and F32 (`SaivageConfig` shape stabilization).
- F03 (Batch 2) must precede F05.
- F02 (Batch 1) must precede F23.
- F22 (Batch 5) will convert the new sync `renameDoc` from F24 to async; F24 lands sync first and F22 flips it as part of its sweep.

Validation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx vitest run src/runtime src/mcp src/config.test.ts src/events
```

Rollback: `git revert <range>`. State implications: operators with pre-existing `shutdown-summary.json` / `shutdown-request.json` files at upgrade time will see them renamed to `.consumed` on first consume; that is the intended behaviour. New `SaivageConfig` keys are mandatory; the schema rejects pre-existing `saivage.json` files that omit them. Operators must re-run `saivage init` (or hand-edit) to add the new keys; stale top-level keys removed by this batch are likewise rejected rather than stripped (architecture-first rule: no backward compatibility).

### Batch 5 — Document store async + plan-server cache (2 issues)

Goal: eliminate the largest performance and correctness liability in the runtime (sync `fs` everywhere) and add the in-memory plan cache that it unblocks. Cross-team handshake required.

Issues in order:

1. **F22** — `src/store/documents.ts` rewritten on `node:fs/promises`; cascade `async`/`await` through `PlanService.init`, bootstrap, agent factories, `NoteManager` + `RuntimeTracker`, `shutdown-handoff.ts`, the fatal handler, every CLI command, and `buildHandoffContext`. **Hard cross-team handshake**: skills/memory subsystem must land its async pass (`src/knowledge/store.ts`, `src/knowledge/integration.ts`, `writeRecordAtomic`, `rebuildIndex`) in the same merge window; F22 does not unilaterally rewrite that subsystem.
2. **F34** — `PlanService` gains `plan: Plan | null` + `history: PlanHistory` cache; `init()` loads from disk; mutations are write-through then commit; `opQueue` replaces `mutationQueue`. Strictly after F22.

Cross-batch dependencies:

- F08 (Batch 4) preferred to land before F22 (kills the legacy mirror cheaply); not blocking.
- F24's `renameDoc` is flipped from sync to async inside F22's sweep.
- Coordinate skills/memory async cascade with the other agent — boundary is `src/knowledge/` and the `SPEC/v2/skills*` directories.

Validation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx vitest run src/store src/mcp/plan-server.test.ts src/runtime/recovery.test.ts src/runtime/shutdown-handoff.test.ts
```

Health probe after redeploy (per workspace LXC conventions):

```bash
curl -fsS http://10.0.3.112:8080/health
```

Rollback: `git revert <range>`. State implications: no on-disk format changes; the file contracts are unchanged. If a sister-agent's knowledge subsystem PR is not ready, hold F22 — do not split the async cascade.

### Batch 6 — Telegram, security, web, local dead code (6 issues)

Goal: close the user-id-as-chat-id correctness bug, replace the bespoke Telegram Markdown converter, remove the false-positive prompt-injection regex layer, deduplicate SPA auth handling, delete remaining orphan modules.

Issues in order:

1. **F16** — persistent `TelegramSubscriptions` document keyed by chat id; new `paths.telegramSubscriptions`; `/subscribe` and `/unsubscribe` commands; boot uses `readDocOrNull` to honour missing-file semantics.
2. **F17** — add `telegramify-markdown` dependency (MarkdownV2); delete `markdownToTelegramHtml` and `escapeHtml`; add span-aware oversize splitter (`splitSourceForTelegram`).
3. **F25** — delete `BLOCK_PATTERNS`, `SUSPICIOUS_PATTERNS`, `scanHeuristically`, `shouldAskModel`; narrow `PromptInjectionScanResult.scanner` to `"llm" | "disabled" | "skipped"`; cop fails open on LLM failure.
4. **F26** — `web/src/composables/useAuthState.ts`; `useWebSocket` drops `"unauthorized"` status; `App.vue` watcher gains `unauthorized` source so title reruns on auth close.
5. **F10** — delete `web/src/styles.css`; fix two stale bullets in `docs/internals/web-internals.md`.
6. **F35** — delete `src/channels/cli.ts`, `src/channels/oneshot.ts`, `src/channels/index.ts` after pre-flight grep.

Cross-batch dependencies:

- F22's async store is in place; F16 writes the subscriptions file via the async `writeDoc`. Order F16 after F22.
- F17 introduces a new npm dependency — run `npm install` and commit `package-lock.json` in the same change.

Validation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npx vitest run src/channels src/server/telegram-bot src/security src/mcp/builtins.test.ts
cd web && npm run build && cd ..
```

Rollback: `git revert <range>`. State implications: pre-existing operator runbooks that referenced the heuristic-only prompt-injection mode will need to provision a scan model. Telegram operators must re-issue `/subscribe` once after upgrade (no auto-migration of pre-F16 implicit subscriptions; deliberate per F16 design).

### Batch 7 — Default project config and SPEC documentation (2 issues)

Goal: finalize the project-init contract and retire the SPEC schema-mirror in favour of the live Zod schema. Strictly last because F32 depends on the final `SaivageConfig` shape settled by F02 + F04 + F11 + F33.

Issues in order:

1. **F33** — `seedProject` replaces `initProject`; `ProjectConfig` trimmed to project-scoped fields (`project_name`, `objectives`, `model_overrides`, `routing`, `skills`); web-chat notifications move to `runtime.config.notifications`; clean up `routing-resolver` leftovers (`project-default` source-union member, `ProjectRoutingConfigLike.provider`, two branches in `resolveLegacyModels` / `resolveSource`).
2. **F32** — rewrite `SPEC/v2/01-DATA-MODEL.md § 1` as a pointer to `src/config.ts` and `docs/guide/config-runtime.md`; repair the existing config-location mismatch in `docs/guide/config-runtime.md`; verify SPEC cross-links resolve via `npm run docs:build`.

Cross-batch dependencies:

- Must follow F02, F04, F11, F33 (the final two are inside this batch). Hence batch order: F33 then F32.
- F33 touches `src/routing/resolver.ts` — verify no merge conflict with Batch 3 (F04 / F07 / F20 touched the resolver). Resolve by re-running the resolver test file: `npx vitest run src/routing/resolver.test.ts`.

Validation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run docs:build
npx vitest run src/store/project.test.ts src/config.test.ts src/routing/resolver.test.ts
```

Rollback: `git revert <range>`. State implications: existing on-disk `.saivage/config.json` files written by the old `initProject` carry the trimmed-out keys; the F33 plan must switch the `ProjectConfig` schema to `.strict()` so those stale keys are surfaced as errors at load time, and the seeding command rewrites the file with only the project-scoped shape. No silent-strip fallback (architecture-first rule: no backward compatibility).

## Cross-batch dependency summary

```text
Batch 1 (F02 [done] -> F09 [done] -> F01, F14 [done])
  |--> Batch 2 (F03, F18 -> F31, F30)
  |       |--> Batch 4 (F05 needs F03)
  |       |--> Batch 7 (F32 needs settled config shape)
  |--> Batch 3 (F19, F27, F15, F29, F13, F21, F04, F07 -> F20)
  |       |--> Batch 7 (F32 needs F04)
  |--> Batch 4 (F11 -> F12, F28, F06, F08, F05, F23, F24)
  |       |--> Batch 5 (F22 prefers F08; F22 flips F24's renameDoc)
  |--> Batch 5 (F22 -> F34)
  |       |--> Batch 6 (F16 uses async writeDoc)
  |--> Batch 6 (F16, F17, F25, F26, F10, F35)
  |--> Batch 7 (F33 -> F32)
```

Additional cross-batch edges:

- F02 [done] -> F18 (prompt loader iterates `ALL_ROLES`).
- F02 [done] -> F23 (priority `Record<AgentRole, number>` derived from `ROSTER`).

Honored explicit ordering: **F22 before F34** (Batch 5 internal). **F02 before F01** (Batch 1). **F09 before F01** (Batch 1). **F11 before F12** (Batch 4). **F07 before F20** (Batch 3). **F18 before F30, F31** (Batch 2). **F03 before F05** (Batches 2 → 4). **F02, F04, F11, F33 before F32** (Batches 1, 3, 4, 7). **F02 before F18, F23** (Batch 1 → 2, 4).

## Open follow-ups

- **Inspector non-migration**: `InspectorAgent` still extends `BaseAgent` post-F09 because it returns `InspectionReport`, not `TaskReport`. Decide before Batch 2 whether to (a) close as expected, (b) widen `WorkerAgent` to accept both report shapes, or (c) leave inspector independent and re-classify in F01's plan.

## Global validation gate (run between batches)

From `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

All four must pass before opening the next batch. Live deployment validation (only when redeploying `saivage-v3` LXC per the workspace handoff conventions, not per-batch):

```bash
curl -fsS http://10.0.3.112:8080/health
```

## Stop and request user approval before implementation

This metaplan is sequencing only. Before implementing any batch, stop and explicitly ask the user to confirm:

1. The batch ordering above.
2. Whether the skills/memory async cascade required by Batch 5 (F22) is in flight on the other agent's side.
3. Which batch to start with and whether to land each batch as a single PR or as multiple commits within one PR.
4. Whether F02 / F09 / F14 working-tree changes have been committed; if not, whether to roll them into Batch 1's commit-block or commit them first.
5. Whether `InspectorAgent` non-migration in F09 closes the issue as-is, defers to F01, or opens a new finding (see Open follow-ups).

Do not begin implementation until that confirmation is received.
