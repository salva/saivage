# F33 r2 — Analysis

## Changes from r1

- Corrected the "Call sites & dependencies" claim about `notifications`. The previous text said `configSchema.notifications` is "read by `loadConfig` and never wired anywhere else", which is wrong: the Telegram dispatcher already reads `runtime.config.notifications` from `saivage.json`, while only the web chat path still reads `runtime.project.config.notifications` from `config.json`. Updated to describe the split accurately, because the plan's migration target depends on knowing the current state.
- Expanded the legacy provider footprint section. r1 implied that deleting `ProjectConfigSchema.provider` and the `models.default(...)` schema literal was sufficient. It is not: the routing resolver carries its own `ProjectRoutingConfigLike.provider` field, a `this.project.provider` branch in `resolveLegacyModels`, a `project-default` source label in `resolveSource`, plus a terminal hardcoded `"openai-codex/gpt-5.3-codex"` fallback. `ModelRouter` also has its own hardcoded `"anthropic/claude-sonnet-4-20250514"` fallback. r2 lists those explicitly and assigns each to either F33 or F04 scope.
- Added the dead-export observation: `initProject` is exported from the public barrel ([src/index.ts](src/index.ts#L37-L41)). Replacing it without updating the barrel would be a build break; r1 missed this.
- Added test surface inventory: `src/config.test.ts` asserts the very orchestrator default that this issue removes; `src/routing/resolver.test.ts` passes `provider: "github-copilot/gpt-5.4"` into the resolver constructor.

## Problem restated

A fresh `saivage init <path>` writes `.saivage/config.json` but never writes `.saivage/saivage.json`. The function intended to seed `saivage.json` (`writeDefaultConfig` at [src/config.ts](src/config.ts#L204-L237)) exists but has zero callers in `src/`, so it is effectively dead code. When `saivage.json` is later created by other means (operator hand-edit, GetRich-v2 seed scripts, copy-paste from another project), the two files express overlapping defaults that disagree about three things:

1. **Default provider/orchestrator model.**
   - CLI init writes `provider: "openai-codex/gpt-5.3-codex"` into `config.json` ([src/server/cli.ts](src/server/cli.ts#L45)).
   - `writeDefaultConfig` writes `models: {}` into `saivage.json` ([src/config.ts](src/config.ts#L209)), so `models.orchestrator` is absent on disk; the schema's `models.default({ orchestrator: "anthropic/claude-sonnet-4-20250514" })` only fires when the entire `models` key is missing ([src/config.ts](src/config.ts#L34-L49)). Net effect: the on-disk `saivage.json` carries no orchestrator, the in-source schema advertises Anthropic Sonnet 4, and the CLI advertises OpenAI Codex GPT-5.3.

2. **Default notification channels.**
   - CLI init: `channels: []` ([src/server/cli.ts](src/server/cli.ts#L51-L52)).
   - `writeDefaultConfig`: `channels: ["web"]` ([src/config.ts](src/config.ts#L223-L226)).
   - Schema fallback when key missing: `channels: ["web"]` ([src/config.ts](src/config.ts#L106-L111)).

3. **Default `min_severity` for notification filters.**
   - CLI init: `"warning"` ([src/server/cli.ts](src/server/cli.ts#L54)).
   - `writeDefaultConfig`: `"info"` ([src/config.ts](src/config.ts#L225)).
   - Schema fallback: `"info"` ([src/config.ts](src/config.ts#L12)).

Beyond the disagreement, two structural problems compound the drift:

- `notifications` is declared in **both** schemas: `ProjectConfigSchema` ([src/types.ts](src/types.ts#L16-L33)) and `configSchema` ([src/config.ts](src/config.ts#L101-L108)). Two writers, two readers (see below), two on-disk locations for the same logical setting.
- `provider` (a single string) lives in `ProjectConfigSchema` ([src/types.ts](src/types.ts#L14)). `models.orchestrator` (a string-or-array role assignment) lives in `configSchema` ([src/config.ts](src/config.ts#L36-L49)). Both encode "which model do we run with by default" but with different granularity, different vocabulary, and different files. The drift is not limited to the schemas: it has also propagated into the routing resolver (see "Surviving legacy-provider path" below).

## Actual differences

Side-by-side of what gets written on a fresh init versus what `writeDefaultConfig` would write if called:

| Concept              | CLI init -> `.saivage/config.json`              | `writeDefaultConfig` -> `.saivage/saivage.json`        |
| -------------------- | ----------------------------------------------- | ------------------------------------------------------ |
| Default model        | `provider: "openai-codex/gpt-5.3-codex"`        | `models: {}` (schema default `anthropic/claude-sonnet-4-20250514` does not fire because `models` key is present) |
| Notification channels| `[]` (notifications disabled)                   | `["web"]` (notifications go to web UI)                 |
| `min_severity`       | `"warning"`                                     | `"info"`                                               |
| `categories`         | `[]`                                            | `[]`                                                   |
| Provider registry    | n/a (not a project-config concept)              | `anthropic / openai / ollama / llamacpp` seeded        |
| MCP servers          | n/a                                             | `playwright` seeded                                    |

`writeDefaultConfig` is dead code: `grep -rn writeDefaultConfig src --include='*.ts'` returns only the definition. The user's recorded experience ("`initProjectTree`/seed helpers can clobber `.saivage/saivage.json`") matches this picture — because `saivage init` does not produce `saivage.json`, third-party tooling fills the gap with its own defaults that disagree with the CLI's `config.json`.

## Notification consumers (corrected)

There are two consumers of the `notifications` block today, reading from two different sources:

- **Telegram dispatcher**: reads `runtime.config.notifications.filters` (i.e., from `saivage.json` via `loadConfig`) at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L80-L84).
- **Web chat / SSE path**: reads `runtime.project.config.notifications?.filters` (i.e., from `config.json` via `loadProject`) at [src/server/server.ts](src/server/server.ts#L734).

Net effect of the present state:

- Telegram's filter set comes from `saivage.json` (`["web"]`, `min_severity: "info"` by schema default).
- The web chat path's filter set comes from `config.json` (`[]`, `min_severity: "warning"` per CLI init).
- These can disagree by construction and frequently do.

The fix must therefore land both consumers on the same source. Since `notifications` is a runtime/system concern (which channels exist, which severities to publish), `saivage.json` is the correct home, and the web path must be migrated to `runtime.config.notifications` to match Telegram.

## Surviving legacy-provider path (corrected)

Removing `ProjectConfigSchema.provider` from the schema is **not** sufficient to remove project-level provider support. The provider concept has leaked into the routing resolver via a separate, structurally identical field:

- [src/routing/resolver.ts](src/routing/resolver.ts#L78-L82): `ProjectRoutingConfigLike` carries `provider?: string`.
- [src/routing/resolver.ts](src/routing/resolver.ts#L278-L285): `resolveLegacyModels` returns `[this.project.provider]` when nothing else matches.
- [src/routing/resolver.ts](src/routing/resolver.ts#L287-L293): `resolveSource` returns `"project-default"` when `this.project.provider` is set.
- [src/routing/resolver.ts](src/routing/resolver.ts#L131): a terminal hardcoded `"openai-codex/gpt-5.3-codex"` is returned by `resolve()` when nothing else produced a model. **Deferred to F04** (its existence is exactly what F04's operator comment forbids; F33 leaves it in place but documents the deferral).
- [src/providers/router.ts](src/providers/router.ts#L204): `ModelRouter.resolveModelForRole` has a hardcoded `"anthropic/claude-sonnet-4-20250514"` fallback. **Deferred to F04** for the same reason.

F33 scope therefore covers, in addition to r1's list:

1. Delete `provider?: string` from `ProjectRoutingConfigLike`.
2. Delete the `if (this.project.provider) return [this.project.provider];` branch in `resolveLegacyModels`.
3. Delete the `if (this.project.provider) return "project-default";` branch in `resolveSource`.
4. Drop the `"project-default"` member from the `ResolvedModelRoute["source"]` union ([src/routing/resolver.ts](src/routing/resolver.ts#L99)) — it becomes unreachable.
5. Update `src/routing/resolver.test.ts` to drop the now-rejected `provider: "github-copilot/gpt-5.4"` lines from the four test inputs that pass them.

F33 explicitly does **not** touch the two hardcoded model strings at [src/routing/resolver.ts](src/routing/resolver.ts#L131) and [src/providers/router.ts](src/providers/router.ts#L204); those are F04's responsibility, and the design now states this precisely instead of overpromising "no default model".

## Contract

Two distinct contracts overlap:

- **Project bootstrap.** Input: target directory, optional name, optional objectives list. Output: a `.saivage/` tree containing both `config.json` (project-level identity + per-project routing/skills knobs) and `saivage.json` (system-level providers/agents/runtime/notifications), seeded knowledge subtrees, and `.gitignore`. Failure mode today: only `config.json` is created; `saivage.json` is missing; consumers fall back to schema defaults whose values disagree with what the CLI announces.
- **Notification defaults.** Input: any of the project lifecycle events listed in `categories`. Output: channel selection + severity gate. Failure mode today: two schemas, two files, two consumers, two disagreeing defaults; no single source of truth.

## Call sites & dependencies

- `initProject(projectRoot, config)` ([src/store/project.ts](src/store/project.ts#L94-L127)) is the only writer of `config.json`. It is called from:
  - `src/server/cli.ts` (init command) ([src/server/cli.ts](src/server/cli.ts#L32-L75)).
  - Tests: [src/store/project.test.ts](src/store/project.test.ts#L31-L113).
  - It is also re-exported from the public barrel at [src/index.ts](src/index.ts#L37-L41); removing the symbol therefore requires a barrel edit.
- `writeDefaultConfig(projectRoot?)` ([src/config.ts](src/config.ts#L204-L237)) has no callers under `src/` (verified by ripgrep). It is not re-exported from the barrel.
- `loadConfig` ([src/config.ts](src/config.ts#L181-L198)) reads `saivage.json`; on missing file, `raw = {}` and Zod fills in defaults — meaning the absence of `saivage.json` is silently masked, which is precisely why the drift went unnoticed.
- `loadProject` ([src/store/project.ts](src/store/project.ts#L63-L91)) reads `config.json` via `ProjectConfigSchema`.
- `ProjectConfigSchema.notifications` is consumed by [src/server/server.ts](src/server/server.ts#L734) (web chat severity filter).
- `configSchema.notifications` is consumed by [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L80-L84) (Telegram channel/severity filter).
- `ProjectRoutingConfigLike.provider` ([src/routing/resolver.ts](src/routing/resolver.ts#L78-L82)) is the secondary home of "project-level provider"; reachable from `ModelRoutingResolver` via `bootstrap` at [src/server/bootstrap.ts](src/server/bootstrap.ts#L127) which passes `project.config` directly into the resolver.
- The orchestrator default value is asserted by name in [src/config.test.ts](src/config.test.ts#L33) (`expect(config.models.orchestrator).toBe("anthropic/claude-sonnet-4-20250514")`); the assertion has to change in lockstep with the schema.
- The legacy `provider` field is fed by name into [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L8) and three other constructor invocations in the same file.

## Constraints any solution must respect

1. **No backward compatibility.** Per project guideline #1, do not keep both schemas, do not add a "migration shim", do not leave `writeDefaultConfig` as a deprecated alias, do not keep both `initProject` and `seedProject`. Whatever schema, writer, and exported symbol survive must be the only one.
2. **No new docstrings/comments on untouched code**; only on code that is otherwise being modified.
3. **No emojis.**
4. **System-level vs project-level separation must remain real, not merely lexical.** `saivage.json` legitimately holds host-level data (providers, MCP servers, ports). `config.json` legitimately holds per-project identity (project name, objectives). The fix must not collapse these into one file just to dodge the duplication; it must collapse only the genuinely-duplicated concept (`notifications`, and the conceptual overlap between `provider` and `models.orchestrator`).
5. **`saivage init` must produce a runnable project on its own.** It is not acceptable to leave `saivage.json` unwritten and rely on schema defaults firing later: that hides the drift instead of fixing it.
6. **The dead `writeDefaultConfig` cannot survive untouched.** Either it becomes the canonical seeder called from `seedProject`, or it is deleted in favor of a new canonical seeder.
7. **Skills/memory subsystem is out of scope** per `_LOOP-CONVENTIONS.md`. The skills knowledge tree seeding inside `initProject` ([src/store/project.ts](src/store/project.ts#L125)) must be preserved as-is; only the config seeding part is in scope.
8. **F04 owns hardcoded model strings.** F33 must remove the *schema-level* hardcoded orchestrator default and the *CLI-literal* provider string, but the two hardcoded fallbacks deep in routing (`openai-codex/gpt-5.3-codex` in `resolver.ts`, `anthropic/claude-sonnet-4-20250514` in `router.ts`) belong to F04. The design must say this explicitly rather than overpromise.
9. **Cross-link to F02.** The roster of `models.*` keys must not freeze a stale agent list into the seed.

## Cross-references

- **F02** (agent-roster-drift): `configSchema.models` enumerates `orchestrator / planner / manager / coder / researcher / data_agent / reviewer / inspector / executor / chat / default`. That key set must remain consistent with whatever roster F02 settles on; this fix should not freeze a stale roster into a seed function.
- **F04** (hardcoded-default-models): the operator comment on F04 says "No model should be hard-coded. If no model is set in the config, the system must just fail to work and report the issue." F33 removes the schema-level orchestrator default and the CLI-literal `provider` string — that is the part F33 owns. The two remaining hardcoded fallbacks ([src/routing/resolver.ts](src/routing/resolver.ts#L131), [src/providers/router.ts](src/providers/router.ts#L204)) remain F04's responsibility. F33 does not claim "no default model anywhere".
- **F32** (saivage-config-undocumented-blocks): the duplicate `notifications` block is exactly the kind of thing F32 flags; consolidating notifications into one schema also reduces F32's documentation burden.
