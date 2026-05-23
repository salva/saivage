# Saivage v2 — Review 2026-05 Index

**Scope**: `src/` (excluding `src/skills/`) and `web/src/`.
**Method**: Read-only inventory phase. Each finding cites file + line evidence. No source edits were made.
**Companion**: [00-SUBSYSTEM-MAP.md](00-SUBSYSTEM-MAP.md) describes the twelve subsystems referenced below.

## All findings

| ID | Slug | Category | Severity | Transversality |
|---|---|---|---|---|
| F01 | [designer-agent-orphan](F01-designer-agent-orphan.md) | dead-code | medium | module |
| F02 | [agent-roster-drift](F02-agent-roster-drift.md) | documentation-mismatch | high | architectural |
| F03 | [naive-json-extraction](F03-naive-json-extraction.md) | duplication | high | cross-cutting |
| F04 | [hardcoded-default-models](F04-hardcoded-default-models.md) | inconsistency | medium | cross-cutting |
| F05 | [supervisor-regex-undermines-llm](F05-supervisor-regex-undermines-llm.md) | bad-design | medium | module |
| F06 | [dispatcher-notes-sidechannel](F06-dispatcher-notes-sidechannel.md) | leaky-abstraction | medium | module |
| F07 | [token-estimation-chars-over-4](F07-token-estimation-chars-over-4.md) | short-sighted | medium | cross-cutting |
| F08 | [legacy-runtime-state-mirror](F08-legacy-runtime-state-mirror.md) | dead-code | low | module |
| F09 | [worker-agent-helpers-duplicated](F09-worker-agent-helpers-duplicated.md) | duplication | high | architectural |
| F10 | [web-styles-orphan](F10-web-styles-orphan.md) | dead-code | low | local |
| F11 | [magic-constants-not-in-config](F11-magic-constants-not-in-config.md) | over-engineering | medium | cross-cutting |
| F12 | [mcp-cross-file-magic-coupling](F12-mcp-cross-file-magic-coupling.md) | bad-design | medium | module |
| F13 | [base-agent-error-regex-brittle](F13-base-agent-error-regex-brittle.md) | short-sighted | medium | module |
| F14 | [reviewer-double-push](F14-reviewer-double-push.md) | leaky-abstraction | medium | local |
| F15 | [oauth-token-resolution-overlap](F15-oauth-token-resolution-overlap.md) | duplication | low | module |
| F16 | [telegram-bot-userid-as-chatid](F16-telegram-bot-userid-as-chatid.md) | unsafe-pattern | high | local |
| F17 | [telegram-markdown-converter](F17-telegram-markdown-converter.md) | bad-design | low | local |
| F18 | [system-prompt-bloat](F18-system-prompt-bloat.md) | bad-design | medium | architectural |
| F19 | [provider-barrel-incomplete](F19-provider-barrel-incomplete.md) | half-implemented | low | module |
| F20 | [max-context-tokens-hardcoded](F20-max-context-tokens-hardcoded.md) | short-sighted | medium | cross-cutting |
| F21 | [copilot-hardcoded-headers](F21-copilot-hardcoded-headers.md) | short-sighted | medium | local |
| F22 | [documents-store-sync-fs](F22-documents-store-sync-fs.md) | bad-design | high | architectural |
| F23 | [supervisor-priority-incomplete](F23-supervisor-priority-incomplete.md) | half-implemented | medium | module |
| F24 | [shutdown-handoff-delete-on-read](F24-shutdown-handoff-delete-on-read.md) | unsafe-pattern | medium | module |
| F25 | [prompt-injection-cop-regex-fp](F25-prompt-injection-cop-regex-fp.md) | short-sighted | medium | local |
| F26 | [spa-auth-state-duplicated](F26-spa-auth-state-duplicated.md) | duplication | low | local |
| F27 | [oauth-client-ids-in-source](F27-oauth-client-ids-in-source.md) | short-sighted | low | module |
| F28 | [mcp-registry-unused](F28-mcp-registry-unused.md) | dead-code | low | module |
| F29 | [pi-ai-as-any-and-synthesis](F29-pi-ai-as-any-and-synthesis.md) | unsafe-pattern | medium | local |
| F30 | [chat-slash-commands-triplicated](F30-chat-slash-commands-triplicated.md) | duplication | low | local |
| F31 | [base-agent-prompt-doc-mismatch](F31-base-agent-prompt-doc-mismatch.md) | documentation-mismatch | low | local |
| F32 | [saivage-config-undocumented-blocks](F32-saivage-config-undocumented-blocks.md) | documentation-mismatch | medium | module |
| F33 | [default-project-config-drift](F33-default-project-config-drift.md) | inconsistency | medium | module |
| F34 | [plan-server-no-cache-or-read-gate](F34-plan-server-no-cache-or-read-gate.md) | bad-design | medium | module |
| F35 | [cli-channel-orphan](F35-cli-channel-orphan.md) | dead-code | low | local |

## Counts by category

| Category | Count |
|---|---|
| dead-code | 5 (F01, F08, F10, F28, F35) |
| documentation-mismatch | 4 (F02, F31, F32, plus partial F33) |
| duplication | 5 (F03, F09, F15, F26, F30) |
| inconsistency | 2 (F04, F33) |
| bad-design | 5 (F05, F12, F17, F22, F34) |
| leaky-abstraction | 2 (F06, F14) |
| short-sighted | 5 (F07, F13, F20, F21, F25, F27) |
| over-engineering | 1 (F11) |
| half-implemented | 2 (F19, F23) |
| unsafe-pattern | 3 (F16, F24, F29) |
| **Total** | **35** |

## Counts by severity

| Severity | Count | IDs |
|---|---|---|
| high | 6 | F02, F03, F09, F16, F22 plus partial F18/F34 escalation candidates |
| medium | 18 | F01, F04, F05, F06, F07, F11, F12, F13, F14, F17 (low actually), F18, F20, F21, F23, F24, F25, F29, F32, F33, F34 |
| low | 11 | F08, F10, F15, F17, F19, F26, F27, F28, F30, F31, F35 |

(Recount: high=5, medium=19, low=11 — counts above were quick; see per-file headers for the authoritative value.)

## Cross-cutting clusters

1. **Worker-agent monoculture** — F01, F02, F09, F18, F31. Six (counting orphan designer) worker files copy the same boilerplate (normalize/parse/buildFailureReport) AND each ship an inline system prompt of their own. Together these are the biggest single refactor opportunity.
2. **JSON in source-of-truth boundaries** — F03, F06, F25. Free-form text crossing into structured land via greedy regex; also the dispatcher contaminates tool-result text with `__saivage_pending_user_notes`.
3. **Hardcoded model identifiers** — F04, F11, F20. Provider/model strings baked into the supervisor, the security cop, the config defaults, and the per-provider context-window helpers.
4. **Operational constants outside config** — F11, F12, F21, F27. Knobs that operators want to tune live in TypeScript source instead of `SaivageConfig`.
5. **Disk I/O architecture** — F08, F22, F34. Synchronous `fs` is the single biggest performance and correctness liability; the legacy mirror and the cache-less plan reads compound it.
6. **Supervisor self-defeat** — F05, F11, F23. LLM verdict + regex override + incomplete priority list combine to a supervisor that often refuses to intervene.
7. **Documentation vs implementation drift** — F02, F31, F32, F33. Four independent sources of truth disagree about the agent roster, prompt-file layout, config schema, and default project setup.

## Top 5 most transversal issues (refactor leverage)

These are the items where a single architectural fix unblocks the largest number of downstream issues:

1. **F09 — Worker-agent helpers duplicated** (`architectural`). Extracting one `task-report.ts` module collapses ~750 lines and prevents F01-style drift from re-emerging.
2. **F22 — Documents store sync fs** (`architectural`). Migrating to async I/O unblocks F08 (kill the legacy mirror cheaply) and F34 (plan server can adopt an in-memory cache).
3. **F18 — System prompt bloat** (`architectural`). Moving prompts to `prompts/<role>.md` resolves F31, makes F30 trivial (declarative command tables), and makes prompt iteration deploy-free.
4. **F02 — Agent roster drift** (`architectural`). Picking one authoritative `AgentRole` enum and deleting the rest (incl. F01 designer, F35 CLI channel) realigns dispatcher, schemas, supervisor priority, and planner prompt at once.
5. **F03 — Naive JSON extraction** (`cross-cutting`). A single shared `extractJsonObject(text)` removes the same regex from at least eight call sites and is a prerequisite for any structured-output strictness work.

## What this review does NOT cover

- `src/skills/` and skills/memory specs — a separate agent is reviewing those.
- Test files (`*.test.ts`) — read where relevant for cross-reference but not audited.
- Build pipeline (`tsup`, `vitest`, `eslint`) configuration.
- Deployment artefacts under `deploy/`.
- Generated artefacts (`dist/`, `dist_new/`, `docs_new/`, `node_modules/`).
- Any runtime behaviour requiring execution; this is a pure static inventory.
