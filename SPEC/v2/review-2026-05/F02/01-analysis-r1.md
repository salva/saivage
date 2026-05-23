# F02 — Analysis (r1)

## Problem restated

The set of agent roles is enumerated independently in ~16 places across `src/` and `SPEC/v2/`. The enumerations do not agree on which roles exist, which are workers, which are dispatchable, or which have priority. A new contributor cannot answer "what are the agents?" from any single file.

The operator constraint for this issue is explicit: **implementation behaviour is authoritative over the SPEC, and the live in-tree agents must all be preserved.** The fix therefore consolidates the enumerations around the implemented roster, and updates SPEC docs to match. Designer's fate is handled by F01 (operator says wire it in); the roster mechanism designed here must accept a designer entry the moment F01 lands without further schema/dispatcher edits.

## Actual differences

Every enumeration and the roles it lists (Y = present, blank = missing):

| Enumeration site | planner | manager | coder | researcher | data_agent | reviewer | inspector | chat | designer | other |
|---|---|---|---|---|---|---|---|---|---|---|
| `AgentRole` union [src/agents/types.ts](src/agents/types.ts#L20-L28) | Y | Y | Y | Y | Y | Y | Y | Y | | |
| `AgentStateSchema.agent_type` [src/types.ts](src/types.ts#L268-L285) | Y | Y | Y | Y | Y | Y | Y | Y | | |
| `TaskSchema.assigned_to` [src/types.ts](src/types.ts#L109) | | | Y | Y | Y | Y | | | | |
| `TaskReportSchema.agent` [src/types.ts](src/types.ts#L160) | | | Y | Y | Y | Y | | | | |
| `DISPATCH_TOOLS` [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L16-L23) | | Y | Y | Y | Y | Y | Y | | | |
| `DISPATCH_ROLE_MAP` [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L26-L33) | | Y | Y | Y | Y | Y | Y | | | |
| `ROLE_DISPATCH_TOOLS` (caller-side tool exposure) [src/agents/base.ts](src/agents/base.ts#L953-L957) | Y(→mgr,insp) | Y(→cdr,rsr,da,rev) | | | | | | Y(→insp) | | |
| `ROLE_TOOL_FILTER` [src/agents/base.ts](src/agents/base.ts#L992-L1018) | Y | | Y | Y | Y | Y | Y | | | |
| `ROLE_ABORT_PRIORITY` [src/runtime/supervisor.ts](src/runtime/supervisor.ts#L14-L20) | | Y | Y | Y | Y | Y | | | | |
| `DEFAULT_SELF_CHECK_FREQUENCY` [src/runtime/self-check.ts](src/runtime/self-check.ts#L10-L19) | Y | Y | Y | Y | Y | Y | Y | Y | | |
| `CONVENTIONS` [src/agents/conventions.ts](src/agents/conventions.ts#L20-L66) | Y | Y | Y | Y | Y | Y | Y | Y | | |
| `models` block in `SaivageConfig` [src/config.ts](src/config.ts#L36-L50) | Y | Y | Y | Y | Y | Y | Y | Y | | orchestrator, executor, default |
| `ROUTING_ROLE_TO_MODEL_KEY` [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16) | Y | Y | Y | Y | Y | Y | Y | Y | | executor, supervisor, security, default |
| Spawner switch in bootstrap [src/server/bootstrap.ts](src/server/bootstrap.ts#L293-L370) | | Y | Y | Y | Y | Y | Y | | | |
| Planner prompt narrative [src/agents/planner.ts](src/agents/planner.ts#L24-L29) | Y | Y | Y | Y | | | Y | Y | | |
| Manager prompt narrative [src/agents/manager.ts](src/agents/manager.ts#L27-L33) | Y | Y | Y | Y | Y | Y | | | | |
| SPEC `assigned_to` [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L163) | | | Y | Y | | | | | | |
| SPEC `agent_type` [SPEC/v2/01-DATA-MODEL.md](SPEC/v2/01-DATA-MODEL.md#L351) | Y | Y | Y | Y | | | Y | Y | | |
| SPEC `00-AGENT-SYSTEM.md` §2.1–§2.6 | Y | Y | Y | Y | | | Y | Y | | |
| Designer file (orphan) [src/agents/designer.ts](src/agents/designer.ts#L74) | | | | | | | | | (Y standalone) | |

Distinct disagreements that change behaviour:

1. **Worker schema vs dispatcher.** `TaskSchema.assigned_to` allows four worker roles; the dispatcher additionally accepts `manager` and `inspector` as dispatchable. The worker enum is correct for `tasks.json` but is being silently used as a proxy for "dispatchable role" in informal reasoning.
2. **Planner's own prompt omits two of its system's workers.** The Planner narrative at [src/agents/planner.ts](src/agents/planner.ts#L24-L29) mentions Coder/Researcher only, never Data Agent or Reviewer. The Planner therefore has an incomplete mental model of the crew it ultimately directs.
3. **Supervisor abort priority omits planner, inspector, chat.** Excluding planner is correct (it must not be killed). Excluding inspector and chat is a policy that is not documented anywhere; nothing prevents an inspector hang from going un-aborted.
4. **SPEC `assigned_to` is only `coder`/`researcher`.** SPEC predates the data_agent and reviewer additions; per operator, the SPEC must be updated, not the code reverted.
5. **`models.executor` and `ROUTING_ROLE_TO_MODEL_KEY.executor` refer to a role that does not exist.** No agent has role `executor`; it is a vestigial config key from an earlier naming.
6. **Designer file exists at [src/agents/designer.ts](src/agents/designer.ts#L1-L267) but is not in any enumeration.** F01 mandates wiring it in; this issue must not pre-empt F01's decision but must leave room for it without further enum edits.

## Contract

Conceptually there is one canonical artefact — the **roster** — that all 16 sites are projecting incomplete views of. A role in the roster has:

- `role`: snake_case identifier (the `AgentRole` value).
- `worker`: boolean — appears in `TaskSchema.assigned_to`, `TaskReportSchema.agent`, and is dispatched by a `Manager` as task execution.
- `dispatchTool`: `run_<role>` tool name, or `null` if the role is created by bootstrap directly (planner, chat) and never appears in a `run_*` tool.
- `dispatchableBy`: set of parent roles whose system prompt exposes the `run_<role>` tool (i.e. populates `ROLE_DISPATCH_TOOLS`).
- `toolFilter`: filter category (`worker | reviewer | inspector | planner | chat | none`) consumed by `ROLE_TOOL_FILTER`.
- `abortPriority`: integer (lower = earlier abort target), or `null` to opt out of supervisor abort.
- `selfCheckFrequency`: integer (0 = disabled), consumed by `DEFAULT_SELF_CHECK_FREQUENCY`.
- `convention`: `{ writeTerritory, excludeTerritory, description }`, consumed by `CONVENTIONS`.
- `defaultModelKey`: `models.*` key that routing resolves for this role (e.g. planner/manager/inspector all resolve to `orchestrator` today per [src/routing/resolver.ts](src/routing/resolver.ts#L3-L16)).

Error modes: a role appearing in `tasks.json` `assigned_to` that is not a worker → Zod validation rejects. A `run_<role>` tool call for a role with `dispatchTool: null` → dispatcher returns "unknown tool". Each enumeration is derived purely from the roster, so adding a role is a one-file change.

Lifecycle: the roster is module-load time. There is no runtime mutation; it is consumed by Zod schemas at parse time, by base agent at prompt build time, by the supervisor at construction, and by the routing resolver lazily.

## Call sites & dependencies

Consumers that need the derived data:

- `src/types.ts` Zod schemas (build `TaskSchema.assigned_to`, `TaskReportSchema.agent`, `AgentStateSchema.agent_type` from the roster).
- `src/runtime/dispatcher.ts` (build `DISPATCH_TOOLS`, `DISPATCH_ROLE_MAP` from roster entries with `dispatchTool != null`).
- `src/agents/base.ts` (build `ROLE_DISPATCH_TOOLS`, `ROLE_TOOL_FILTER` from the roster).
- `src/runtime/supervisor.ts` (build `ROLE_ABORT_PRIORITY` by sorting roster entries with `abortPriority != null`).
- `src/runtime/self-check.ts` (build `DEFAULT_SELF_CHECK_FREQUENCY` map).
- `src/agents/conventions.ts` (build `CONVENTIONS` map).
- `src/config.ts` (`models` block keys are the union of `defaultModelKey` values plus the fixed extras `orchestrator`, `default`, `supervisor.model`, `security.injectionModel`).
- `src/routing/resolver.ts` (`ROUTING_ROLE_TO_MODEL_KEY` is the roster's `role -> defaultModelKey` map plus the fixed pseudo-roles `supervisor`, `security`, `default`).
- `src/server/bootstrap.ts` spawner switch — does NOT collapse via roster (each constructor signature differs); however it must validate that every roster entry whose role is dispatchable has a case in the switch (add a build-time exhaustiveness check).
- Inline system prompts in `src/agents/*.ts` — see F18 for prompt extraction; the consolidation here exposes a roster-description renderer (`renderRosterSummary(role)`) so prompts can include up-to-date prose without duplicating it.
- SPEC docs `00-AGENT-SYSTEM.md` and `01-DATA-MODEL.md` — updated by hand (one-time), then asserted by a doctests-style check that the SPEC enum lists match the roster.

Cross-issue dependencies:

- **F01 (designer orphan)**: after F02 lands, wiring designer in is a single roster-entry addition plus a spawner-switch case. F01's writer should depend on F02 being merged first.
- **F09 (worker helper duplication)**: deduplication of `normalizeTask`/`parseTaskReport`/`buildFailureReport` benefits from having a single `WorkerRole` discriminator type derived from the roster.
- **F18 (system prompt bloat)**: prompt extraction can consume `renderRosterSummary(role)` instead of re-typing the roster prose in each prompt file.
- **F04 (hardcoded default models)** and **F32 (undocumented config blocks)**: orthogonal; the roster's `defaultModelKey` field aligns with whatever those issues settle on for `models.*` defaults.
- **F23 (supervisor priority incomplete)**: subsumed in part — the roster makes `abortPriority` explicit per role; F23 then becomes a policy decision about which roles should get a non-null priority, not a structural fix.

## Constraints any solution must respect

1. **No backward compatibility.** Per workspace guideline, no transitional aliases for old role names, no `@deprecated` shims for `executor`, no parallel "old and new" maps. The migration deletes the old enumerations in the same change.
2. **Operator's roster directive.** Every currently-implemented agent stays in the roster: planner, manager, coder, researcher, data_agent, reviewer, inspector, chat. Designer is added by F01; F02 must leave the door open without forcing F01's hand.
3. **Skills/memory subsystem is out of scope.** `SkillEntry.target_agents` is typed `z.array(z.string())` and reads `AgentRole` only as a type for the loader's `context.agentRole`; this does not need changes here.
4. **SPEC follows implementation.** Update `SPEC/v2/00-AGENT-SYSTEM.md` and `SPEC/v2/01-DATA-MODEL.md` to enumerate data_agent and reviewer (and document the dispatch/abort model derived from the roster). The SPEC text describing what each role does is otherwise authoritative; only the role lists and `assigned_to`/`agent_type` enums change.
5. **Zod schemas must remain string-literal enums at runtime.** The roster derivation must produce literal tuples so `z.enum(...)` keeps its inferred string-literal union types — Zod cannot accept a plain `string[]`.
6. **No new docstrings/comments** on code not otherwise modified (per loop conventions).
7. **Validation at system boundaries only.** Internal consumers receive `AgentRole`-typed values; no defensive re-checks at each call site.
8. **`executor` model key is removed.** It refers to no agent. Removing it is consistent with constraint 1 (delete the old in the same change).
