# F11 — Plan r1 (Proposal B)

Implements Proposal B from [02-design-r1.md](02-design-r1.md): delete dead `?? DEFAULT_*` fallbacks; promote the small operator-facing set to `SaivageConfig`; keep everything else inline (renaming function-local consts to module-scope where it aids visibility).

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

### Step 7 — Tighten `EventBus.handlerTimeoutMs`

File: [src/events/bus.ts](src/events/bus.ts).

1. No caller overrides `handlerTimeoutMs` ([L54-L57](src/events/bus.ts#L54-L57)). Delete the constructor parameter and use the module-scope `HANDLER_TIMEOUT_MS = 5_000` directly. If a future caller needs it back, add it back then.

### Step 8 — Rename function-local consts to module-scope

Purely cosmetic visibility cleanup. No behaviour change.

1. [src/agents/planner.ts](src/agents/planner.ts#L192): hoist `const MAX_NUDGES = 15;` from inside the run loop to module scope.
2. [src/agents/base.ts](src/agents/base.ts#L478-L480): hoist `BASE_DELAY_S`, `BACKOFF_MULT`, `MAX_DELAY_S` from inside `callLLM()` to module scope, named `LLM_BACKOFF_BASE_SECONDS`, `LLM_BACKOFF_MULT`, `LLM_BACKOFF_MAX_SECONDS`.
3. [src/server/cli.ts](src/server/cli.ts#L373): hoist `PLANNER_SHUTDOWN_TIMEOUT_MS` to module scope.

Leave `MAX_DIAGNOSTIC_ENTRIES`, `MAX_CONSECUTIVE_INVALID`, `MAX_INVALID_FINAL_RESPONSES`, `MAX_PENDING_MESSAGES`, `MAX_OUTPUT` (after step 6, where applicable), `PROCESS_KILL_GRACE_MS`, `OUTPUT_GROWTH_POLL_MS`, `MAX_SCAN_DECODE_BYTES`, `LOG_BUFFER_LIMIT`, `TG_MAX_LENGTH`, `RESPONSES_ITEM_ID_LIMIT` as they are.

### Step 9 — Update tests

1. [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L43): replaces `process.env["SAIVAGE_SHELL_TIMEOUT_FLOOR_MS"] = "0"` with passing a `SaivageConfig` (or `mcp` slice) whose `shellTimeoutFloorMs: 0` overrides the default; delete the `beforeEach`/`afterEach` env-mutation block.
2. Any test constructing `EventBus` with an explicit `handlerTimeoutMs` argument: update call. (Grep confirms current state; if none, no change.)
3. `transientCap` test seam in [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts#L32-L37) is preserved (no change).
4. Add minimal coverage for the new config keys:
   - `src/config.test.ts` (or whichever existing config test file applies): assert defaults — `runtime.recoveryDelayMs === 60_000`, `runtime.notes.volatileTtlMs === 7_200_000`, `supervisor.forceCancelDelayMs === 600_000`, `mcp.shellTimeoutMs === 14_400_000`, `mcp.maxOutputBytes === 102_400`, etc.
   - Override one of each in a sample config object and assert the loaded value matches.

### Step 10 — Web SPA literals (informational)

Out of scope for this commit. Document in `01-analysis-r1.md` (already done) that the duplicated `8000` poll literals in `App.vue`, `DebugView.vue`, `PlanView.vue` and `4000`/`5000` in `StatusPanel.vue`/`AgentsView.vue` should be deduplicated into a small `web/src/composables/usePollInterval.ts` in a follow-up. F11 leaves them.

## Test strategy

**Existing tests that exercise the affected paths:**
- [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) — shell-timeout floor.
- [src/runtime/notes.test.ts] (if present; grep before edit) — TTL behaviour.
- [src/agents/base.test.ts] family — `transientCap`, backoff sleep paths (already mock `setTimeout`).
- [src/agents/conversation-snapshot.test.ts](src/agents/conversation-snapshot.test.ts) — preserves the `transientCap` override seam.

**New tests:**
- Config-default assertions per step 9.4 above.
- A focused test that `McpRuntime` constructed with a custom `config.mcp.shellTimeoutMs` propagates it to the shell-tool path.
- A focused test that `NoteManager.cleanupStaleNotes` uses the supplied `ttlMs` (it already does; verify the explicit-argument variant).

**Commands:**

```bash
npm run typecheck
npm run build
npx vitest run src/config.test.ts
npx vitest run src/runtime/supervisor.ts
npx vitest run src/runtime/notes.ts
npx vitest run src/mcp
npx vitest run src/events/bus.ts
```

End with the full suite:

```bash
npx vitest run
```

## Rollback strategy

Single squash commit. Revert restores prior behaviour exactly; no data migrations, no on-disk format changes (Zod defaults absorb missing keys both directions).

## Cross-issue ordering

- **Must land before F04**: F04's recommended cleanup of the duplicated `"github-copilot/gpt-5.4"` model string assumes the `?? DEFAULT_SCAN_MODEL` dead fallback in [src/security/prompt-injection-cop.ts](src/security/prompt-injection-cop.ts#L26) is already gone. F11 deletes it.
- **Must land before F12**: F12 will replace `MAX_WALL_CLOCK_MS = SHELL_TIMEOUT_MS - 30_000` with a proper derivation; F11 first turns `SHELL_TIMEOUT_MS` into `config.mcp.shellTimeoutMs` (the single source of truth F12 needs).
- **Should land before F20**: F20 makes `maxContextTokens` per-model; once that's in, the MCP output caps (now in config) may want to be re-derived from real context size. Doing F11 first means F20 has a single config block to read from.
- **Should land after F33 is at least scoped**: F33 catalogues the drift between `cli.ts initProject` defaults and `config.ts` schema defaults. F11 *adds* config keys but does not touch `initProject`'s payload (relies on Zod defaults). If F33 lands first, this becomes a no-op concern; if F11 lands first, F33's inventory needs to include the new keys.
- Independent of F07: F07 fixes the token estimator divisor (`4`). That divisor is *not* in F11's scope (changing it is a behaviour change, not a configurability question).
