# F33 r2 - Review

## Reviewer

GPT-5.5 (copilot)

## Documents reviewed

- `F33-default-project-config-drift.md`
- `F33/04-review-r1.md`
- `F33/01-analysis-r2.md`
- `F33/02-design-r2.md`
- `F33/03-plan-r2.md`

## Findings

### Analysis

The r1 notification-consumer blocker is fixed. The analysis now accurately distinguishes Telegram's existing runtime-config reader at [src/server/telegram-bot.ts](src/server/telegram-bot.ts#L80-L84) from the web chat path's project-config reader at [src/server/server.ts](src/server/server.ts#L734-L741), and it correctly makes only the web path a migration target.

The legacy provider surface is also described accurately. The r2 analysis covers the project schema field in [src/types.ts](src/types.ts#L11-L45), the CLI literal in [src/server/cli.ts](src/server/cli.ts#L32-L75), the resolver's separate `ProjectRoutingConfigLike.provider` contract and `project-default` source at [src/routing/resolver.ts](src/routing/resolver.ts#L78-L100), and the live resolver branches at [src/routing/resolver.ts](src/routing/resolver.ts#L278-L293). The F04 deferral for the remaining hardcoded fallback strings is explicit and no longer overclaims that F33 removes every default model in the system.

### Design

Proposal A now includes the full cleanup implied by deleting project-level `provider`: schema removal, resolver-contract removal, resolver-branch removal, source-union cleanup, and routing test updates. It also settles the API shape clearly: `initProject` is replaced by `seedProject`, with no transitional alias, and the public barrel export is updated at [src/index.ts](src/index.ts#L37-L42). That satisfies the no-backward-compatibility guideline.

The design keeps Proposal B as a legitimate follow-up without making it a prerequisite for this issue. That is acceptable because Proposal A resolves the filed drift, deletes the dead writer at [src/config.ts](src/config.ts#L204-L237), and consolidates notifications without collapsing the entire two-file config model before F02/F04/F32 settle.

### Plan

The implementation plan is executable. It gives ordered edits for [src/store/project.ts](src/store/project.ts#L94-L127), [src/server/cli.ts](src/server/cli.ts#L32-L75), [src/config.ts](src/config.ts#L34-L49), [src/types.ts](src/types.ts#L11-L45), [src/routing/resolver.ts](src/routing/resolver.ts#L78-L100), [src/server/server.ts](src/server/server.ts#L734-L741), and [src/index.ts](src/index.ts#L37-L42). The stale-reference sweep now includes the important missed terms from r1: `this.project.provider`, `ProjectRoutingConfigLike`, `runtime.project.config.notifications`, `initProject`, `writeDefaultConfig`, and `project-default`.

The test updates are concrete and aimed at the actual current tests: [src/config.test.ts](src/config.test.ts#L30-L34) loses the Anthropic orchestrator default assertion, [src/routing/resolver.test.ts](src/routing/resolver.test.ts#L4-L130) drops the project-provider constructor inputs, and [src/store/project.test.ts](src/store/project.test.ts#L18-L113) moves from `initProject(defaultConfig())` to `seedProject(...)` while adding `loadConfig(true, projectRoot)` assertions for seeded `saivage.json`. The validation commands use the required Vitest/typecheck/build convention.

## Required changes

None.

## Strengths

- The r2 revision fixes each r1 blocker rather than narrowing the wording around it.
- Proposal A is focused but still deletes the obsolete surfaces in the same change.
- The plan includes the public export, resolver cleanup, web notification reader, and focused tests an implementer needs to avoid a half-migration.

VERDICT: APPROVED