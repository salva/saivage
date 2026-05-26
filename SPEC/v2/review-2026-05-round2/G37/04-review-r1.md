# G37 - Review (r1)

Reviewer: GPT-5.5

Verdict: Changes requested.

## Axis Check

- Config sync-fs coverage is complete for live [src/config.ts#L2](../../../../src/config.ts#L2), [src/config.ts#L208](../../../../src/config.ts#L208), [src/config.ts#L268-L270](../../../../src/config.ts#L268-L270), and [src/config.ts#L279-L280](../../../../src/config.ts#L279-L280).
- Cache deletion is justified. The cache at [src/config.ts#L258-L276](../../../../src/config.ts#L258-L276) has weak benefit after bootstrap/CLI force-loads and mostly helps a few OAuth client-id reads; deleting it is simpler than a watcher that would not refresh boot-time router/resolver/supervisor snapshots.
- The `loadConfig` await cascade is traced for bootstrap, CLI, and the three OAuth drivers: [src/server/bootstrap.ts#L127-L129](../../../../src/server/bootstrap.ts#L127-L129), [src/server/cli.ts#L276-L290](../../../../src/server/cli.ts#L276-L290), [src/server/cli.ts#L429-L435](../../../../src/server/cli.ts#L429-L435), [src/auth/anthropic.ts#L47-L52](../../../../src/auth/anthropic.ts#L47-L52), [src/auth/openai-codex.ts#L57-L62](../../../../src/auth/openai-codex.ts#L57-L62), and [src/auth/github-copilot.ts#L66-L68](../../../../src/auth/github-copilot.ts#L66-L68). The missing piece is not a `loadConfig` caller; it is the live `ensureDir` dependency described below.
- Keeping `resolveProjectRoot` sync is acceptable as a documented path-discovery boundary. It is currently a bounded parent walk in [src/config.ts#L197-L215](../../../../src/config.ts#L197-L215), and `configPath()` is still used from synchronous error construction in [src/providers/router.ts#L202-L205](../../../../src/providers/router.ts#L202-L205) and [src/runtime/supervisor.ts#L60-L63](../../../../src/runtime/supervisor.ts#L60-L63). The regression guard must keep this carve-out narrow.
- G30 as a hard prerequisite is correct because the shared scanner is a G30 output per [G30/APPROVED.md#L7](../G30/APPROVED.md#L7). The current checkout does not yet contain that scanner, so G37 implementation must be rebased after G30 lands.

## Findings

1. High - `ensureDir` deletion and sequencing are wrong as written.

   Round 1 says the config `ensureDir` export is unused and re-exported from the barrel in [01-analysis-r1.md#L145-L159](01-analysis-r1.md#L145-L159), then deletes the barrel export in [02-design-r1.md#L92-L104](02-design-r1.md#L92-L104) and [03-plan-r1.md#L54-L61](03-plan-r1.md#L54-L61). Live code contradicts both parts. [src/auth/store.ts#L10](../../../../src/auth/store.ts#L10) imports `ensureDir` from config and [src/auth/store.ts#L59-L60](../../../../src/auth/store.ts#L59-L60) calls it, so deleting [src/config.ts#L279-L280](../../../../src/config.ts#L279-L280) breaks the pre-G36 tree. Separately, [src/index.ts#L28-L36](../../../../src/index.ts#L28-L36) re-exports the async store helper from [src/store/documents.ts#L165-L166](../../../../src/store/documents.ts#L165-L166), not the sync config helper, so Step 2 would remove an unrelated public export.

   Required r2 change: remove the [src/index.ts#L28-L36](../../../../src/index.ts#L28-L36) deletion and the barrel-cleanliness test from [03-plan-r1.md#L192-L209](03-plan-r1.md#L192-L209). Then either make G36 a hard prerequisite as well, since G36 rewrites [src/auth/store.ts](../../../../src/auth/store.ts#L8-L10) per [G36/APPROVED.md#L3](../G36/APPROVED.md#L3), or have G37 update [src/auth/store.ts#L10](../../../../src/auth/store.ts#L10) and [src/auth/store.ts#L59-L60](../../../../src/auth/store.ts#L59-L60) in the same PR. The current claim that G36 and G37 are independent in [01-analysis-r1.md#L167-L172](01-analysis-r1.md#L167-L172) and [03-plan-r1.md#L252-L260](03-plan-r1.md#L252-L260) is false if G37 deletes config `ensureDir`.

2. Medium - The no-sync-fs regression guard needs one tight shape, not a broad fallback.

   The design proposes a new guard in [02-design-r1.md#L145-L155](02-design-r1.md#L145-L155) with a source-wide root, broad skip paths, and allowed names that include `createWriteStream` and `existsSync`; the plan later narrows it to [src/config.ts](../../../../src/config.ts#L1) in [03-plan-r1.md#L157-L176](03-plan-r1.md#L157-L176). The narrow form is the acceptable one. If the fallback in [03-plan-r1.md#L181-L186](03-plan-r1.md#L181-L186) scans the whole source tree while globally allowing `existsSync`, the documented `resolveProjectRoot` boundary stops being a boundary and future sync fs in unrelated modules can slip through.

   Required r2 change: after G30 lands, state the exact shipped scanner API and use a config-only root or an explicit post-filter to [src/config.ts](../../../../src/config.ts#L1). The only allowed sync use for this finding should be [src/config.ts#L208](../../../../src/config.ts#L208); do not broaden `existsSync` across `src`.

3. Medium - The new config tests will fail as sketched.

   [src/config.test.ts#L10-L12](../../../../src/config.test.ts#L10-L12) creates only the temporary project root. Existing tests create the config directory before writing [src/config.test.ts#L50-L53](../../../../src/config.test.ts#L50-L53). The new cases in [03-plan-r1.md#L127-L149](03-plan-r1.md#L127-L149) write directly to the config file without first creating its parent directory, and [03-plan-r1.md#L153-L155](03-plan-r1.md#L153-L155) claims the file already uses an async pattern even though the live imports are sync fs helpers at [src/config.test.ts#L1-L4](../../../../src/config.test.ts#L1-L4).

   Required r2 change: add the needed async imports and create the config directory before each new write, or keep the existing sync test helpers and use the established mkdir/write pattern. The test intent is good; the fixture mechanics need to match live code.

4. Low - The malformed JSON semantics sentence is internally inconsistent.

   [02-design-r1.md#L68-L73](02-design-r1.md#L68-L73) says current behavior silently parses malformed JSON as `{}`, then immediately says malformed JSON throws before Zod. Live [src/config.ts#L267-L270](../../../../src/config.ts#L267-L270) has no catch around `JSON.parse`, so malformed JSON throws. Keep the proposed rejection test, but fix the prose.

## Summary

The core design direction is sound: make `loadConfig` async, delete the stale module cache, keep `resolveProjectRoot` sync as a documented path-discovery boundary, and depend on G30 for the shared scanner. The round needs revision because it misidentifies the barrel `ensureDir` export, misses the live config `ensureDir` consumer in auth store, and therefore understates the G36 sequencing constraint.

VERDICT: CHANGES_REQUESTED