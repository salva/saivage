# F33 r1 — Review

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- `F33-default-project-config-drift.md`
- `F33/01-analysis-r1.md`
- `F33/02-design-r1.md`
- `F33/03-plan-r1.md`

## Findings

### Analysis

The core drift is correctly identified: CLI init writes only `.saivage/config.json` with a project-level provider and empty notification channels, while `writeDefaultConfig` writes `.saivage/saivage.json` with different notification defaults and no on-disk orchestrator model ([src/server/cli.ts](src/server/cli.ts#L39-L68), [src/config.ts](src/config.ts#L204-L237)). The finding that `writeDefaultConfig` is dead under `src/` also matches the source spot-check.

One factual statement needs correction before this is handoff-ready: the analysis says `configSchema.notifications` is read by `loadConfig` and never wired anywhere else. It is already used by the Telegram path via `runtime.config.notifications` ([src/server/telegram-bot.ts](src/server/telegram-bot.ts#L80-L84)), while the web chat path still reads `runtime.project.config.notifications` ([src/server/server.ts](src/server/server.ts#L734-L741)). That distinction matters because the implementation plan must migrate the web path, not invent the runtime-config consumer from scratch.

The analysis also undercounts the surviving legacy model/provider path. Removing `ProjectConfigSchema.provider` alone does not remove project-level provider support because `ModelRoutingResolver` still accepts `provider` in `ProjectRoutingConfigLike` ([src/routing/resolver.ts](src/routing/resolver.ts#L79-L80)) and resolves through `this.project.provider` before falling back to a hardcoded model ([src/routing/resolver.ts](src/routing/resolver.ts#L278-L285)).

### Design

Proposal A is the right size for F33: a canonical seeder is a clean fix for two drifting writers, and moving notifications to `saivage.json` respects the system-level/project-level split. The design also correctly rejects a migration shim and deletes the dead writer.

However, Proposal A says “No legacy `provider:` support remains anywhere,” but its stated scope does not include the resolver interface or fallback logic that still preserve that support ([src/routing/resolver.ts](src/routing/resolver.ts#L79-L80), [src/routing/resolver.ts](src/routing/resolver.ts#L278-L293)). That is a project-guideline issue, not a style preference: if `provider` is removed from the schema, the old provider path must be removed from the routing contract and tests in the same change.

The “no default model” wording is also too strong for the scoped design. The plan removes the schema-level Anthropic default, but the routing resolver still hardcodes `openai-codex/gpt-5.3-codex` as the terminal fallback ([src/routing/resolver.ts](src/routing/resolver.ts#L135-L136), [src/routing/resolver.ts](src/routing/resolver.ts#L285-L293)), and `ModelRouter` still has its own Anthropic fallback ([src/providers/router.ts](src/providers/router.ts#L204)). Either the design must explicitly include those removals here, or it must narrow the claim and state that F04 owns the remaining hardcoded model behavior.

### Plan

The plan is close, but it has several executability gaps:

- It says the net result is that only `seedProject` exists, but it does not update the public barrel export that still exports `initProject` ([src/index.ts](src/index.ts#L28-L33)). If `initProject` is removed, this is a build break.
- It changes `configSchema.models` away from the Anthropic default, but does not update the existing config test that asserts that exact default ([src/config.test.ts](src/config.test.ts#L30-L34)). The validation suite would fail as written.
- It instructs new tests to parse `saivage.json` with `configSchema`, but `configSchema` is currently not exported ([src/config.ts](src/config.ts#L34)). The plan should either export a deliberately named parser/schema or use `loadConfig(true, projectRoot)` in the test.
- The stale-reference sweep searches for `config.provider` but misses the actual provider fallback references in `ModelRoutingResolver` (`this.project.provider`), so the proposed cleanup would leave forbidden legacy behavior in place.

## Required changes

1. Revise the analysis to accurately describe notification consumers: Telegram already uses `runtime.config.notifications`, while web chat still uses `runtime.project.config.notifications`. Keep the plan’s migration of the web path, but ground it in the actual current split.
2. Expand Proposal A and the plan to remove the full legacy provider path if `ProjectConfigSchema.provider` is deleted: update `ProjectRoutingConfigLike`, `resolveLegacyModels`, `resolveSource`, and the affected routing tests. If any remaining hardcoded model fallback is intentionally deferred to F04, say that precisely and stop calling F33’s outcome “no default model.”
3. Resolve the `initProject`/`seedProject` final API explicitly and update every affected public export and caller, including [src/index.ts](src/index.ts#L28-L33). Do not leave a transitional alias unless the design explains why it is not backward-compatibility preservation.
4. Add the missing test updates to the plan: adjust [src/config.test.ts](src/config.test.ts#L30-L34), and specify whether new seed tests use `loadConfig` or an exported schema/parser.
5. Tighten the stale-reference sweep so it catches `this.project.provider`, `ProjectRoutingConfigLike.provider`, hardcoded fallback sources, `initProject` exports, and notification reads from `runtime.project.config`.

## Strengths

- The writer correctly identifies the two drifting writers and the dead `writeDefaultConfig` surface.
- Proposal A is appropriately scoped for F33 and avoids a broad config-file merger before F02/F04/F32 settle.
- The test strategy includes focused seed assertions and full-suite validation, which is the right blast-radius check for schema cleanup.

VERDICT: CHANGES_REQUESTED