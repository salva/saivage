# F33 r1 — Analysis

## Problem restated

A fresh `saivage init <path>` writes `.saivage/config.json` but never writes `.saivage/saivage.json`. The function intended to seed `saivage.json` (`writeDefaultConfig`) exists but has zero callers in `src/`, so it is effectively dead code. When `saivage.json` is later created by other means (operator hand-edit, GetRich-v2 seed scripts, copy-paste from another project), the two files express overlapping defaults that disagree about three things:

1. **Default provider/orchestrator model.**
   - CLI init writes `provider: "openai-codex/gpt-5.3-codex"` into `config.json` ([src/server/cli.ts](src/server/cli.ts#L42-L46)).
   - `writeDefaultConfig` writes `models: {}` into `saivage.json` ([src/config.ts](src/config.ts#L209)), so `models.orchestrator` is absent on disk; the schema's `models.default({ orchestrator: "anthropic/claude-sonnet-4-20250514" })` only fires when the entire `models` key is missing ([src/config.ts](src/config.ts#L35-L49)). Net effect: the on-disk `saivage.json` carries no orchestrator, the in-source schema advertises Anthropic Sonnet 4, and the CLI advertises OpenAI Codex GPT-5.3.

2. **Default notification channels.**
   - CLI init: `channels: []` ([src/server/cli.ts](src/server/cli.ts#L50-L52)).
   - `writeDefaultConfig`: `channels: ["web"]` ([src/config.ts](src/config.ts#L226)).
   - Schema fallback when key missing: `channels: ["web"]` ([src/config.ts](src/config.ts#L106-L111)).

3. **Default `min_severity` for notification filters.**
   - CLI init: `"warning"` ([src/server/cli.ts](src/server/cli.ts#L53)).
   - `writeDefaultConfig`: `"info"` ([src/config.ts](src/config.ts#L227)).
   - Schema fallback: `"info"` ([src/config.ts](src/config.ts#L12)).

Beyond the disagreement, two structural problems compound the drift:

- `notifications` is declared in **both** schemas: `ProjectConfigSchema` ([src/types.ts](src/types.ts#L16-L33)) and `configSchema` ([src/config.ts](src/config.ts#L106-L111)). Two writers, two readers, two on-disk locations for the same logical setting.
- `provider` (a single string) lives in `ProjectConfigSchema` ([src/types.ts](src/types.ts#L14)). `models.orchestrator` (a string-or-array role assignment) lives in `configSchema` ([src/config.ts](src/config.ts#L36-L49)). Both encode "which model do we run with by default" but with different granularity, different vocabulary, and different files.

## Actual differences

Side-by-side of what gets written on a fresh init versus what `writeDefaultConfig` would write if called:

| Concept              | CLI init → `.saivage/config.json`              | `writeDefaultConfig` → `.saivage/saivage.json`        |
| -------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| Default model        | `provider: "openai-codex/gpt-5.3-codex"`       | `models: {}` (schema default `anthropic/claude-sonnet-4-20250514` does not fire because `models` key is present) |
| Notification channels| `[]` (notifications disabled)                  | `["web"]` (notifications go to web UI)                |
| `min_severity`       | `"warning"`                                    | `"info"`                                              |
| `categories`         | `[]`                                           | `[]`                                                  |
| Provider registry    | n/a (not a project-config concept)             | `anthropic / openai / ollama / llamacpp` seeded       |
| MCP servers          | n/a                                            | `playwright` seeded                                   |

`writeDefaultConfig` is dead code: `grep -rn writeDefaultConfig src --include='*.ts'` returns only the definition. The user's recorded experience ("`initProjectTree`/seed helpers can clobber `.saivage/saivage.json`") matches this picture — because `saivage init` does not produce `saivage.json`, third-party tooling fills the gap with its own defaults that disagree with the CLI's `config.json`.

## Contract

Two distinct contracts overlap:

- **Project bootstrap.** Input: target directory, optional name, optional objectives list. Output: a `.saivage/` tree containing both `config.json` (project-level identity + per-project routing/skills knobs) and `saivage.json` (system-level providers/agents/runtime/notifications), seeded knowledge subtrees, and `.gitignore`. Failure mode today: only `config.json` is created; `saivage.json` is missing; consumers fall back to schema defaults whose values disagree with what the CLI announces.
- **Notification defaults.** Input: any of the project lifecycle events listed in `categories`. Output: channel selection + severity gate. Failure mode today: two schemas, two files, two defaults; no single source of truth.

## Call sites & dependencies

- `initProject(projectRoot, config)` ([src/store/project.ts](src/store/project.ts#L94-L124)) is the only writer of `config.json`. It is called from:
  - `src/server/cli.ts` (init command) ([src/server/cli.ts](src/server/cli.ts#L39-L68)).
  - Tests: [src/store/project.test.ts](src/store/project.test.ts#L43-L113).
- `writeDefaultConfig(projectRoot?)` ([src/config.ts](src/config.ts#L204-L237)) has no callers under `src/` (verified by ripgrep).
- `loadConfig` ([src/config.ts](src/config.ts#L181-L198)) reads `saivage.json`; on missing file, `raw = {}` and Zod fills in defaults — meaning the absence of `saivage.json` is silently masked, which is precisely why the drift went unnoticed.
- `loadProject` ([src/store/project.ts](src/store/project.ts#L65-L91)) reads `config.json` via `ProjectConfigSchema`.
- `ProjectConfigSchema.notifications` is consumed by notification routing in the runtime; `configSchema.notifications` is read by `loadConfig` and never wired anywhere else (this is part of F32, but it matters here: there is one consumer and two producers).

## Constraints any solution must respect

1. **No backward compatibility.** Per project guideline #1, do not keep both schemas, do not add a "migration shim", do not leave `writeDefaultConfig` as a deprecated alias. Whatever schema and writer survive must be the only one.
2. **No new docstrings/comments on untouched code**; only on code that is otherwise being modified.
3. **No emojis.**
4. **System-level vs project-level separation must remain real, not merely lexical.** `saivage.json` legitimately holds host-level data (providers, MCP servers, ports). `config.json` legitimately holds per-project identity (project name, objectives). The fix must not collapse these into one file just to dodge the duplication; it must collapse only the genuinely-duplicated concept (`notifications`, and the conceptual overlap between `provider` and `models.orchestrator`).
5. **`saivage init` must produce a runnable project on its own.** It is not acceptable to leave `saivage.json` unwritten and rely on schema defaults firing later: that hides the drift instead of fixing it.
6. **The dead `writeDefaultConfig` cannot survive untouched.** Either it becomes the canonical seeder called from `initProject`, or it is deleted in favor of a new canonical seeder.
7. **Skills/memory subsystem is out of scope** per `_LOOP-CONVENTIONS.md`. The skills knowledge tree seeding inside `initProject` ([src/store/project.ts](src/store/project.ts#L120-L124)) must be preserved as-is; only the config seeding part is in scope.
8. **Cross-link to F02 / F04.** The chosen default model (project-level) must not re-encode another hardcoded string; it should reuse whatever single source of truth F04 establishes. The agent roster underlying `models.*` keys must not drift from F02's canonical roster.

## Cross-references

- **F02** (agent-roster-drift): `configSchema.models` enumerates `orchestrator / planner / manager / coder / researcher / data_agent / reviewer / inspector / executor / chat / default`. That key set must remain consistent with whatever roster F02 settles on; this fix should not freeze a stale roster into a seed function.
- **F04** (hardcoded-default-models): the operator comment on F04 says "No model should be hard-coded. If no model is set in the config, the system must just fail to work and report the issue." That directly applies here. The cleanest fix removes default model strings from the schema and the seed entirely (no `provider:` string in `config.json`, no `models.orchestrator` schema default in `saivage.json`); `loadConfig`/`loadProject` are left to validate at boundaries, and downstream consumers fail loudly when no model is configured. F33's plan must align with F04's: do not invent yet another default.
- **F32** (saivage-config-undocumented-blocks): the duplicate `notifications` block is exactly the kind of thing F32 flags; consolidating notifications into one schema also reduces F32's documentation burden.
