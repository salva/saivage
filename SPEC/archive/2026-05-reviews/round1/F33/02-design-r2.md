# F33 r2 — Design

## Changes from r1

- Proposal A's scope now explicitly includes the routing-resolver cleanup that follows from deleting `ProjectConfigSchema.provider`: removing `ProjectRoutingConfigLike.provider`, the two `this.project.provider` branches in `resolveLegacyModels` / `resolveSource`, and the `"project-default"` member of the `source` union. r1's "no legacy `provider:` support remains anywhere" claim is now actually true within Proposal A's stated scope rather than aspirational.
- Tightened the claim about hardcoded model strings. Proposal A removes the *schema-level* `models.default({ orchestrator: ... })` literal and the CLI-literal `provider: "openai-codex/gpt-5.3-codex"`, but explicitly leaves the two terminal hardcoded fallbacks in `routing/resolver.ts` and `providers/router.ts` to F04. The previous "no default model" wording is replaced with a precise scope statement.
- Proposal A now states that `initProject` is fully replaced by `seedProject` (single name, no transitional alias) and that the public barrel export is updated in the same change.

## Proposal A — Focused fix: single `seedProject` writes both files, no schema-level model default, no project-level provider field

### Scope (files touched)

- [src/store/project.ts](src/store/project.ts#L94-L127): `initProject` is renamed to `seedProject` (single rename, no alias). The new signature is `seedProject(projectRoot: string, opts: { name?: string; objectives?: string[] }): ProjectContext`. The body writes both `config.json` and `saivage.json` and calls `initProjectTree`.
- [src/server/cli.ts](src/server/cli.ts#L32-L75): the inline `config` literal disappears; the CLI calls `seedProject(path, { name: opts.name, objectives: opts.objectives })` directly.
- [src/config.ts](src/config.ts#L204-L237): `writeDefaultConfig` is **deleted**. The canonical `saivage.json` seed lives in `seedProject`.
- [src/config.ts](src/config.ts#L34-L49): the `.default({ orchestrator: "anthropic/claude-sonnet-4-20250514" })` on `models` becomes `.default({})`.
- [src/types.ts](src/types.ts#L14): `ProjectConfigSchema.provider` is **removed**.
- [src/types.ts](src/types.ts#L16-L33): the `notifications` block on `ProjectConfigSchema` is **removed**. Notifications live only in `configSchema`.
- [src/routing/resolver.ts](src/routing/resolver.ts#L78-L82): `provider?: string` is **removed** from `ProjectRoutingConfigLike`.
- [src/routing/resolver.ts](src/routing/resolver.ts#L278-L285): the `if (this.project.provider) return [this.project.provider];` branch in `resolveLegacyModels` is **removed**.
- [src/routing/resolver.ts](src/routing/resolver.ts#L287-L293): the `if (this.project.provider) return "project-default";` branch in `resolveSource` is **removed**.
- [src/routing/resolver.ts](src/routing/resolver.ts#L99): `"project-default"` is **removed** from the `ResolvedModelRoute["source"]` union (now unreachable).
- [src/server/server.ts](src/server/server.ts#L734): the web chat path is migrated from `runtime.project.config.notifications?.filters` to `runtime.config.notifications.filters`, matching what `src/server/telegram-bot.ts` already does. This is the one consumer of `ProjectConfigSchema.notifications` and must be migrated in the same commit that removes the schema field.
- [src/index.ts](src/index.ts#L37-L41): the barrel export of `initProject` is replaced with `seedProject`.
- [src/config.test.ts](src/config.test.ts#L30-L34): the `expect(config.models.orchestrator).toBe("anthropic/claude-sonnet-4-20250514")` assertion is changed to `expect(config.models.orchestrator).toBeUndefined()`.
- [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L4-L130): the `provider: "github-copilot/gpt-5.4"` lines are dropped from the four `new ModelRoutingResolver(...)` invocations. None of the assertions depend on the `project-default` source, so the test bodies do not change beyond input cleanup.
- [src/store/project.test.ts](src/store/project.test.ts#L18-L113): the `defaultConfig()` helper is deleted; every call site uses `seedProject(projectRoot, { name: "test-project", objectives: ["test"] })`. Two new assertions are added covering the seeded `saivage.json` (see plan).

### What gets added

- One canonical seeder: `seedProject(projectRoot, { name, objectives })`. It writes `config.json` (project identity + empty `model_overrides` + routing + skills; no `provider`, no `notifications`), writes `saivage.json` (providers/agents/runtime/notifications/mcpServers — the body currently inside `writeDefaultConfig`, minus `models: {}` which becomes implicit via the `models.default({})` schema rewrite), then calls `initProjectTree(projectRoot)`.
- A single home for the `notifications` block: `configSchema`. Single declaration, single writer (the seed), two readers (`telegram-bot.ts` and `server.ts`), both reading from `runtime.config.notifications`.

### What gets removed

- `writeDefaultConfig` (dead code, plus it disagreed with the CLI).
- `ProjectConfigSchema.provider` and `ProjectRoutingConfigLike.provider` (overlap with `models.orchestrator`).
- The `models.default({ orchestrator: ... })` literal in `configSchema`.
- The `notifications` block on `ProjectConfigSchema`.
- The inline `config` object literal in the CLI's `init` action.
- The `initProject` symbol (renamed to `seedProject`; no alias).
- The `defaultConfig()` test helper in `src/store/project.test.ts`.
- The `this.project.provider` branches in `resolveLegacyModels` and `resolveSource`.
- The `"project-default"` member of the `ResolvedModelRoute["source"]` union.

### Risk

- Medium. Touching `ProjectConfigSchema` invalidates any on-disk `config.json` that carries `provider` or `notifications` fields. Per project guideline #1, that is the intended outcome (no migration shim); existing projects in the workspace (`saivage-v3`, GetRich v2) will have their `config.json` regenerated by the operator. Listed under "Cross-issue ordering" in the plan.
- Low for the `saivage.json` change: schema parsing tolerates the absence of the removed `models.default`, because `.default({})` still produces a valid object.
- Low for the routing-resolver edits: `provider` is only ever read by `resolveLegacyModels` and `resolveSource`; nothing else in the codebase reads `ProjectRoutingConfigLike.provider`.

### What it enables (cross-link)

- **F02** (agent roster): with `seedProject` as the single bootstrap entry point, the roster used in `models` keys becomes a single anchor for F02's fix.
- **F04** (hardcoded models): F33 actively removes the schema-level `anthropic/claude-sonnet-4-20250514` default and the CLI-literal `openai-codex/gpt-5.3-codex` string. The two remaining hardcoded fallbacks ([src/routing/resolver.ts](src/routing/resolver.ts#L131), [src/providers/router.ts](src/providers/router.ts#L204)) are explicitly left to F04 with this design naming them.
- **F32** (config blocks undocumented): consolidating `notifications` into one schema halves what F32 needs to document.

### What it forbids

- No "legacy `provider:`" support remains anywhere in the F33-covered surface. The schema field is gone, the routing-resolver field is gone, the routing-resolver branches are gone, the `project-default` source label is gone.
- No second writer of `saivage.json` may be reintroduced; `writeDefaultConfig` does not get exhumed.
- No transitional `initProject` alias survives the change.

### Out of F33 scope (explicit)

- The hardcoded `"openai-codex/gpt-5.3-codex"` at [src/routing/resolver.ts](src/routing/resolver.ts#L131) — terminal fallback in `resolve()`. Owned by **F04**.
- The hardcoded `"anthropic/claude-sonnet-4-20250514"` at [src/providers/router.ts](src/providers/router.ts#L204) — fallback in `ModelRouter.resolveModelForRole`. Owned by **F04**.
- Collapsing `config.json` and `saivage.json` into a single file. Owned by Proposal B (filed as a follow-up after F02 / F04 / F32 settle).

### Recommendation note

This is the smallest fix that resolves the literal drift, deletes the dead code, removes the worst schema-level hardcoded model string, and fully eliminates the project-level `provider` concept from the codebase F33 owns. It does not address "why are there two config files at all", which Proposal B addresses.

---

## Proposal B — One level up: collapse `config.json` and `saivage.json` into a single seeded file

### Scope (files touched)

- [src/types.ts](src/types.ts#L11-L45): `ProjectConfigSchema` is removed.
- [src/config.ts](src/config.ts#L34-L113): `configSchema` absorbs `project_name`, `objectives`, `model_overrides`, `routing`, `skills`, and `agents` — i.e., everything currently in `ProjectConfigSchema` except `provider` (deleted as in Proposal A) and `notifications` (already present in `configSchema`).
- [src/store/project.ts](src/store/project.ts): `loadProject` reads only `saivage.json`. `initProject` is renamed `seedProject`; it writes a single canonical `saivage.json` and calls `initProjectTree`.
- [src/server/cli.ts](src/server/cli.ts#L32-L75): `init` calls `seedProject(path, { name, objectives })`.
- Every call site that reads `ctx.config.<X>` for the consolidated fields is updated to read from the unified config.
- `writeDefaultConfig` deleted as in Proposal A.
- Routing-resolver `provider` cleanup as in Proposal A.

### What gets added

- A single `SaivageConfigSchema` that holds *both* project identity (`project_name`, `objectives`) and system settings (providers, models, runtime, notifications, mcpServers). Single file: `.saivage/saivage.json`. Single writer: `seedProject`. Single reader: `loadConfig` (which `loadProject` calls).

### What gets removed

- `ProjectConfigSchema` and `ProjectConfig` type.
- `config.json` as a file format — the file no longer exists in fresh projects.
- The `models.default(...)` literal in `configSchema`.
- The `notifications` block on `ProjectConfigSchema` (already only-here once `ProjectConfigSchema` is deleted).
- `writeDefaultConfig` (dead).
- `discoverProject` ([src/store/project.ts](src/store/project.ts#L49-L60)) and `resolveProjectRoot` ([src/config.ts](src/config.ts#L116-L135)) currently search for either `config.json` or `saivage.json`; they collapse into one rule ("look for `.saivage/saivage.json`").
- Routing-resolver `provider` field + branches.

### Risk

- High in absolute change-volume: every place that touches `ProjectConfig` or reads `loadProject(...).config` has to be updated. Risk per touch is low because field names overlap heavily.
- Operator-facing: existing projects must regenerate `.saivage/saivage.json` and delete `.saivage/config.json`. Per project guideline #1, acceptable — no migration shim — but explicit operator notice required.

### What it enables

- **F02**: one schema, one canonical agent roster.
- **F04**: same removal as Proposal A; plus downstream code stops having to know which file holds the model setting.
- **F32**: cuts F32's documentation work roughly in half.

### What it forbids

- No second file ("project config") reintroduced. No `provider` string at the project level.

### Recommendation note

Architecturally correct destination, but a larger change touching many call sites. If F33 ships first, before F02/F04/F32 land, Proposal B forces all of them to revisit migrated code. Proposal B is filed as a follow-up after F02/F04/F32 settle.

---

## Recommendation

**Proposal A.**

Rationale:

1. **Scope discipline.** F33 was filed as a localized drift between two specific writers. Proposal A fully fixes that drift, deletes the dead `writeDefaultConfig`, removes the schema-level hardcoded model string, removes the project-level `provider` field everywhere F33 owns, and consolidates `notifications` onto one schema with both consumers — without dragging the entire `ProjectConfigSchema` / `SaivageConfig` split into the change.
2. **Cross-issue ordering.** F02 (agent roster) and F32 (config blocks undocumented) are still in flight. Proposal B's heavy refactor of `configSchema` would either pre-empt F02's roster decision or force F02 to chase a moving schema. Proposal A leaves the two-file split intact, so F02 and F32 can settle on their own without coordination.
3. **Architecture-first compliance.** Proposal A still deletes dead code, eliminates the worst schema-level hardcoded model string, removes the `provider`/`notifications` duplication, and renames the entry point without an alias — i.e., it does not preserve "old + new" anywhere.
4. **Reversibility.** Promoting `seedProject` to Proposal B's full unification is a follow-up rather than a rewrite once F02/F04/F32 are approved.

Proposal B is the better long-term destination and is filed as a follow-up issue once F02/F04/F32 are approved.
