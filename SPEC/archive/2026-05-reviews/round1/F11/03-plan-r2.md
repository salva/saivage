# F11 — Plan r2 (Proposal B)

Implements Proposal B from [02-design-r2.md](02-design-r2.md): delete dead `?? DEFAULT_*` fallbacks; promote the small operator-facing set to `SaivageConfig`; keep everything else inline (renaming function-local consts to module-scope where it aids visibility).

## Changes from r1

- **Step 7 removed.** No longer deletes the `EventBus` constructor `handlerTimeoutMs` parameter; that parameter is a real test seam used by [src/events/bus.test.ts](src/events/bus.test.ts#L154-L167). The parameter and its default stay exactly as today. (Subsequent steps renumbered.)
- **Test strategy overhauled.** r1's validation commands ran Vitest against source paths (e.g. `npx vitest run src/runtime/supervisor.ts`). The repo's [vitest.config.ts](vitest.config.ts#L5-L8) only includes `src/**/*.test.ts` and `tests/**/*.test.ts`, and has `passWithNoTests: true`, so those commands matched zero tests and silently passed. r2:
  - Replaces every source-file glob with the actual `*.test.ts` file path.
  - Adds two **new** focused test files (`src/runtime/supervisor.test.ts`, `src/runtime/notes.test.ts`) where direct coverage of the changed behaviour did not exist, and names the specific cases each must contain.
  - Tightens which existing test files cover which step.
- No other content changes; the schema additions, deletions, and consumer rewires are unchanged.

## Ordered edit steps

### Step 1 — Extend `SaivageConfig` schema

File: [src/config.ts](src/config.ts).

In the existing `configSchema` definition:

1. Extend the `runtime` block:
   ```ts
   runtime: z.object({
     maxServices: z.number().default(50),
     restartOnCrash: z.boolean().default(true),
     continuousImprovement: z.boolean().default(true),
     healthCheckIntervalMs: z.number().default(30_000),
     idleShutdownMs: z.number().default(300_000),
     recoveryDelayMs: z.number().default(60_000),
     notes: z.object({
       volatileTtlMs: z.number().default(2 * 60 * 60 * 1000),
     }).default({}),
   }).default({}),
   ```
2. Extend the `supervisor` block with `forceCancelDelayMs: z.number().default(600_000)`.
3. Add a new top-level `mcp` block:
   ```ts
   mcp: z.object({
     shellTimeoutMs: z.number().default(4 * 60 * 60 * 1000),
     shellTimeoutFloorMs: z.number().default(10 * 60 * 1000),
     inProcessTimeoutMs: z.number().default(300_000),
     maxOutputBytes: z.number().default(100 * 1024),
     maxFetchChars: z.number().default(200_000),
     maxDownloadBytes: z.number().default(250 * 1024 * 1024),
   }).default({}),
   ```

No change to `writeDefaultConfig` literal payload: Zod defaults fill in absent keys at load time, and the on-disk default config should stay minimal.

### Step 2 — Delete dead fallbacks in supervisor

File: [src/runtime/supervisor.ts](src/runtime/supervisor.ts).

1. Delete `DEFAULT_MODEL`, `DEFAULT_INTERVAL_MS`, `DEFAULT_THRESHOLD`, `DEFAULT_LOG_LINES` ([L8-L11](src/runtime/supervisor.ts#L8-L11)).
2. Delete the `FORCE_CANCEL_DELAY_MS` module const ([L12](src/runtime/supervisor.ts#L12)).
3. Inside the constructor body, replace the `?? DEFAULT_…` fallbacks with direct reads — the Zod schema guarantees they are non-`undefined`:
   ```ts
   this.modelSpec = modelSpecOverride ?? config.supervisor.model;
   this.intervalMs = config.supervisor.intervalMs;
   this.threshold = config.supervisor.consecutiveStuckVerdicts;
   this.logLines = config.supervisor.logLines;
   this.forceCancelDelayMs = config.supervisor.forceCancelDelayMs;
   ```
4. Add `private readonly forceCancelDelayMs: number;` field and replace the inline `FORCE_CANCEL_DELAY_MS` use at [L113](src/runtime/supervisor.ts#L113) with `this.forceCancelDelayMs`.

Cross-link: F04 will handle the residual coupling on `supervisor.model` vs `security.injectionModel` and the orchestrator default.

### Step 3 — Delete dead fallbacks in prompt-injection-cop

File: [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts).

1. Delete `DEFAULT_SCAN_MODEL` and `DEFAULT_MAX_SCAN_CHARS` ([L26-L27](src/security/prompt-injection-cop.ts#L26-L27)).
2. In `createPromptInjectionCop` ([L52-L62](src/security/prompt-injection-cop.ts#L52-L62)), replace the `?? DEFAULT_…` fallbacks with direct reads of `security.injectionModel` and `security.maxScanLengthBytes`.

### Step 4 — Move `NoteManager` TTL into config

File: [src/runtime/notes.ts](src/runtime/notes.ts).

1. Delete the `static readonly DEFAULT_VOLATILE_TTL_MS` ([L60](src/runtime/notes.ts#L60)).
2. Change `cleanupStaleNotes(ttlMs: number = NoteManager.DEFAULT_VOLATILE_TTL_MS)` ([L217](src/runtime/notes.ts#L217)) to require an explicit `ttlMs: number` argument.
3. Update all callers (grep `cleanupStaleNotes` and `DEFAULT_VOLATILE_TTL_MS`) to pass `config.runtime.notes.volatileTtlMs`. If a `NoteManager` instance already holds a `SaivageConfig`, source it from there.

### Step 5 — Move planner recovery delay into config

File: [src/server/bootstrap.ts](src/server/bootstrap.ts).

1. Delete `const RECOVERY_DELAY_MS = 60 * 1000;` ([L494](src/server/bootstrap.ts#L494)).
2. In the planner-recovery loop, replace `RECOVERY_DELAY_MS` with `config.runtime.recoveryDelayMs` (config is already in scope at this layer).

### Step 6 — Move MCP timeouts/caps into config

Files: [src/mcp/runtime.ts](src/mcp/runtime.ts), [src/mcp/builtins.ts](src/mcp/builtins.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts).

1. `McpRuntime` constructor: accept a `SaivageConfig` (or `config.mcp` slice). Replace `IN_PROCESS_TIMEOUT_MS` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L168)) and `SHELL_TIMEOUT_MS` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L171)) with `private readonly inProcessTimeoutMs` / `shellTimeoutMs` initialised from config; update the dispatch site ([L186-L187](src/mcp/runtime.ts#L186-L187)) to use the instance fields.
2. In `bootstrap.ts`, pass the loaded `SaivageConfig` when constructing `McpRuntime`.
3. In `builtins.ts`: change the exported `registerBuiltins`/factory signature to take `config.mcp`. Replace the module-level `MAX_OUTPUT`, `MAX_FETCH_CHARS`, `MAX_DOWNLOAD_BYTES` consts with closure-captured locals derived from the config arg.
4. Delete `DEFAULT_MIN_TIMEOUT_MS` and the `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS` env-var handling ([L377-L408](src/mcp/builtins.ts#L377-L408)); source the floor from `config.mcp.shellTimeoutFloorMs`.
5. **Do not touch `MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30_000`** — that derivation is F12's territory. After step 6.1, `SHELL_TIMEOUT_MS` is no longer a module constant; replace the derivation with an inline `const maxWallClockMs = config.mcp.shellTimeoutMs - 30_000;` at the top of the shell-builtin function. F12 will replace this with the proper invariant.

### Step 7 — Rename function-local consts to module-scope

Purely cosmetic visibility cleanup. No behaviour change.

1. [src/agents/planner.ts](src/agents/planner.ts#L192): hoist `const MAX_NUDGES = 15;` from inside the run loop to module scope.
2. [src/agents/base.ts](src/agents/base.ts#L478-L480): hoist `BASE_DELAY_S`, `BACKOFF_MULT`, `MAX_DELAY_S` from inside `callLLM()` to module scope, named `LLM_BACKOFF_BASE_SECONDS`, `LLM_BACKOFF_MULT`, `LLM_BACKOFF_MAX_SECONDS`.
3. [src/server/cli.ts](src/server/cli.ts#L373): hoist `PLANNER_SHUTDOWN_TIMEOUT_MS` to module scope.

Leave `MAX_DIAGNOSTIC_ENTRIES`, `MAX_CONSECUTIVE_INVALID`, `MAX_INVALID_FINAL_RESPONSES`, `MAX_PENDING_MESSAGES`, `MAX_OUTPUT` (after step 6, where applicable), `PROCESS_KILL_GRACE_MS`, `OUTPUT_GROWTH_POLL_MS`, `MAX_SCAN_DECODE_BYTES`, `LOG_BUFFER_LIMIT`, `TG_MAX_LENGTH`, `RESPONSES_ITEM_ID_LIMIT`, and the `EventBus` test-seam parameter as they are.

### Step 8 — Update existing tests

1. [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts): the existing test that exercises the shell-timeout floor via `process.env["SAIVAGE_SHELL_TIMEOUT_FLOOR_MS"] = "0"` is now obsolete. Replace it with a construction of the builtins factory using a `config.mcp.shellTimeoutFloorMs: 0`; delete the `beforeEach`/`afterEach` env-mutation block.
2. [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts): update each `new McpRuntime(...)` site to pass a config (or `config.mcp` slice) with the defaults; no behavioural change expected.
3. [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts): update any test that constructed the cop with a `partial` security config to provide the full `security` block (now that the in-file `?? DEFAULT_*` fallbacks are gone, the test fixtures must supply the same defaults Zod would).
4. [src/config.test.ts](src/config.test.ts): add the new-defaults assertions (see Step 10).

No change required for [src/events/bus.test.ts](src/events/bus.test.ts) — the `new EventBus(10)` test seam at [L154-L167](src/events/bus.test.ts#L154-L167) is preserved by Step 7's "leave the `EventBus` test-seam parameter as is".

No change required for the `transientCap` subclass-override seam exercised by [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L32-L37).

### Step 9 — Add focused test files for newly-config-driven behaviour

The repo has no `src/runtime/supervisor.test.ts` or `src/runtime/notes.test.ts` today (verified by `find src -name "*.test.ts"`). Without them, the only coverage of supervisor force-cancel and notes TTL would be incidental. Add the following focused files:

1. **New file `src/runtime/supervisor.test.ts`** containing at minimum:
   - `it("uses config.supervisor.forceCancelDelayMs for the second cancel pass", ...)` — construct `RuntimeSupervisor` with `config.supervisor.forceCancelDelayMs: 50`, drive the cancel path with fake timers (`vi.useFakeTimers()` / `vi.advanceTimersByTimeAsync(50)`), assert the second cancel signal fires at the configured delay (not at the prior hardcoded `600_000`).
   - `it("uses config.supervisor.intervalMs / threshold / logLines without fallbacks", ...)` — pass a config with non-default values for each, observe they are honoured (regression guard for the deleted `?? DEFAULT_*`).
2. **New file `src/runtime/notes.test.ts`** containing at minimum:
   - `it("cleanupStaleNotes(ttlMs) removes notes older than the supplied TTL", ...)` — write two volatile notes, advance the `mtime` of one beyond a TTL of `1000` ms (via `fs.utimes`), call `cleanupStaleNotes(1000)`, assert exactly the old one is removed.
   - `it("cleanupStaleNotes requires an explicit ttlMs argument", ...)` — type-level + behaviour assertion that the parameter is required (the deleted default would have masked this).

### Step 10 — Add config-default assertions

Extend [src/config.test.ts](src/config.test.ts) with:

1. Defaults assertions on an empty input (`loadConfig({})` or equivalent):
   - `runtime.recoveryDelayMs === 60_000`
   - `runtime.notes.volatileTtlMs === 7_200_000`
   - `supervisor.forceCancelDelayMs === 600_000`
   - `mcp.shellTimeoutMs === 14_400_000`
   - `mcp.shellTimeoutFloorMs === 600_000`
   - `mcp.inProcessTimeoutMs === 300_000`
   - `mcp.maxOutputBytes === 102_400`
   - `mcp.maxFetchChars === 200_000`
   - `mcp.maxDownloadBytes === 262_144_000`
2. Override one of each in a sample config object and assert the loaded value matches.

### Step 11 — Web SPA literals (informational)

Out of scope for this commit. Document in [01-analysis-r2.md](01-analysis-r2.md) (already done) that the duplicated `8000` poll literals in `App.vue`, `DebugView.vue`, `PlanView.vue` and `4000`/`5000` in `StatusPanel.vue`/`AgentsView.vue` should be deduplicated into a small `web/src/composables/usePollInterval.ts` in a follow-up. F11 leaves them.

## Test strategy

### Existing tests that exercise the affected paths

| Step | Test file |
|---|---|
| 2 (supervisor) | new [src/runtime/supervisor.test.ts](src/runtime/supervisor.test.ts) (Step 9.1) |
| 3 (prompt-injection-cop) | [src/security/prompt-injection-cop.test.ts](src/security/prompt-injection-cop.test.ts) |
| 4 (notes TTL) | new [src/runtime/notes.test.ts](src/runtime/notes.test.ts) (Step 9.2) |
| 6 (MCP runtime + builtins) | [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts), [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) |
| 7 (renames only) | covered by [src/agents/agents.test.ts](src/agents/agents.test.ts) compile/run; no behaviour change |
| 8/10 (config defaults) | [src/config.test.ts](src/config.test.ts) |
| EventBus seam preserved | [src/events/bus.test.ts](src/events/bus.test.ts) (unchanged) |

### Validation commands

Each command targets an actual `*.test.ts` file (verified with `find src -name "*.test.ts"`). The repo uses Vitest per [vitest.config.ts](vitest.config.ts#L5-L8); the include pattern is `src/**/*.test.ts` and `tests/**/*.test.ts` and `passWithNoTests: true`, so command paths must point at real test files (the new ones from Step 9 are created as part of this change before these commands are useful).

```bash
npm run typecheck
npm run build

# Focused tests for the steps that change behaviour:
npx vitest run src/config.test.ts
npx vitest run src/runtime/supervisor.test.ts   # new file from Step 9.1
npx vitest run src/runtime/notes.test.ts        # new file from Step 9.2
npx vitest run src/mcp/runtime.test.ts src/mcp/builtins.test.ts
npx vitest run src/security/prompt-injection-cop.test.ts

# Preserved test seam:
npx vitest run src/events/bus.test.ts

# Full suite as the final gate:
npx vitest run
```

Before running the focused commands for the two new files, confirm they exist (`ls src/runtime/supervisor.test.ts src/runtime/notes.test.ts`); if not, Step 9 was skipped and must be completed first — do not rely on `passWithNoTests` to make this look green.

## Rollback strategy

Single squash commit. Revert restores prior behaviour exactly; no data migrations, no on-disk format changes (Zod defaults absorb missing keys both directions).

## Cross-issue ordering

- **Must land before F04**: F04's recommended cleanup of the duplicated `"github-copilot/gpt-5.4"` model string assumes the `?? DEFAULT_SCAN_MODEL` dead fallback in [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L26) is already gone. F11 deletes it.
- **Must land before F12**: F12 will replace `MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30_000` with a proper derivation; F11 first turns `SHELL_TIMEOUT_MS` into `config.mcp.shellTimeoutMs` (the single source of truth F12 needs).
- **Should land before F20**: F20 makes `maxContextTokens` per-model; once that's in, the MCP output caps (now in config) may want to be re-derived from real context size. Doing F11 first means F20 has a single config block to read from.
- **Should land after F33 is at least scoped**: F33 catalogues the drift between `cli.ts initProject` defaults and `config.ts` schema defaults. F11 *adds* config keys but does not touch `initProject`'s payload (relies on Zod defaults). If F33 lands first, this becomes a no-op concern; if F11 lands first, F33's inventory needs to include the new keys.
- Independent of F07: F07 fixes the token estimator divisor (`4`). That divisor is *not* in F11's scope (changing it is a behaviour change, not a configurability question).
