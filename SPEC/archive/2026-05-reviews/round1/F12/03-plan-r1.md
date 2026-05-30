# F12 — Plan r1 (Proposal A)

Implementation plan for the recommended proposal: derive the inner wall-clock cap from `config.mcp.shellTimeoutMs` and apply it as a hard clamp on agent-supplied `timeout_ms` inside the shell handler.

## Cross-issue ordering

- **Must land after F11.** F11 r2 Proposal B introduces `config.mcp.shellTimeoutMs`, `config.mcp.shellTimeoutFloorMs`, and removes the `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS` env-var. F12 consumes both. If F11 ships first, F12 is a clean ~30-line edit. If F12 must ship before F11 for some operational reason, fold the two `config.mcp` keys into F12 and treat the rest of `config.mcp` as F11's responsibility — there is no in-between safe ordering.
- **No interaction with F28** ([src/mcp/registry.ts](src/mcp/registry.ts) vestigial persistence) or **F34** ([src/mcp/plan-server.ts](src/mcp/plan-server.ts) no caching). Land independently.
- **No interaction with the skills/memory subsystem** (out of scope per `_LOOP-CONVENTIONS.md`).

## Edit steps (in order)

1. **Add `McpRuntime.shellTimeoutMs` accessor.** In [src/mcp/runtime.ts](src/mcp/runtime.ts#L165-L171), replace
   ```ts
   private static readonly IN_PROCESS_TIMEOUT_MS = 300_000;
   private static readonly SHELL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
   ```
   with `private readonly` instance fields populated from the `SaivageConfig.mcp` block (already passed via constructor after F11). Add a public `get shellTimeoutMs(): number { return this.#shellTimeoutMs; }`. Update the two reads at [src/mcp/runtime.ts](src/mcp/runtime.ts#L184-L186) to use the instance fields.

2. **Delete `MAX_WALL_CLOCK_MS` literal.** In [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L42), remove the constant and its preamble comment. Add at the same file scope:
   ```ts
   /** Headroom between the inner wall-clock cap and the outer McpRuntime
    *  race so the inner kill timer always wins and emits a structured result. */
   const WALL_CLOCK_HEADROOM_MS = 30_000;
   ```

3. **Inject `runtime` into the shell handler.** `registerBuiltinServices(runtime, …)` already exists; ensure `shellHandler` is defined as a closure inside `registerBuiltinServices` (or receives `runtime` via the existing factory wiring) so `runtime.shellTimeoutMs` is in scope. Inside `shellHandler` ([src/mcp/builtins.ts](src/mcp/builtins.ts#L375-L394)) replace
   ```ts
   const effectiveTimeout = timeout ?? MAX_WALL_CLOCK_MS;
   ```
   with
   ```ts
   const innerCapMs = runtime.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS;
   const effectiveTimeout = Math.min(timeout ?? innerCapMs, innerCapMs);
   ```

4. **Verify no other reads of `MAX_WALL_CLOCK_MS`.** Run `grep -n MAX_WALL_CLOCK_MS src/` — must return zero matches after step 2.

5. **Update / add tests in [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts).**
   - The existing setup at [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L43-L59) already constructs `new McpRuntime(...)`; after F11 lands, the constructor signature includes the `mcp` block. Pass `{ shellTimeoutMs: 2_000, shellTimeoutFloorMs: 0, … }` for tests; the existing `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS=0` line is removed by F11.
   - Add a new test: `"clamps agent-supplied timeout_ms to runtime.shellTimeoutMs - 30_000"`. Construct a runtime with `shellTimeoutMs: 5_000`; invoke `run_command` with `timeout_ms: 9 * 60 * 60 * 1000`; assert the returned `CommandResult` has `exitCode: 124` (timeout path) and `duration_ms` ≈ `5_000 - 30_000` … negative — so for the unit test pick `shellTimeoutMs: 60_000` and `timeout_ms: 9 * 60 * 60 * 1000`, assert `duration_ms <= 30_000` (the inner kill fires before the outer race). Use a long-running command like `node -e "setInterval(()=>{},1000)"` to keep the process alive.
   - Add a second test: `"omitted timeout_ms uses runtime.shellTimeoutMs - 30_000 as the wall-clock cap"`. Same setup, no `timeout_ms`; same assertion.

6. **Imports.** [src/mcp/builtins.ts](src/mcp/builtins.ts) already imports `McpRuntime` as a type (`import type { McpRuntime, InProcessToolHandler }`); no new imports needed because `runtime.shellTimeoutMs` is a number access through the existing factory parameter, not a static class reference.

## Test strategy

**Existing tests that cover this path:**
- [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) — `"shell run_command respects timeout_ms"` and the `clampTimeout` floor tests. These continue to assert (a) explicit `timeout_ms` is honoured when ≤ inner cap, (b) values below the floor are raised. After F12 they also implicitly cover the upper clamp (the new `Math.min`).
- [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts) (if it exists; see note below) — covers `withTimeout` race. No assertion change needed; the outer race remains identical, only its trigger condition (agent oversupplies `timeout_ms`) is now unreachable.

**New tests (in [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts)):**

1. `"clamps agent-supplied timeout_ms above runtime.shellTimeoutMs - 30_000"` — described in step 5.
2. `"omitted timeout_ms uses runtime.shellTimeoutMs - 30_000"` — described in step 5.

**Exact validation commands** (from `/home/salva/g/ml/saivage`):

```bash
npm run typecheck
npm run build
npx vitest run src/mcp/builtins.test.ts
npx vitest run src/mcp/  # broader MCP-subsystem sweep
grep -rn MAX_WALL_CLOCK_MS src/  # must print nothing
```

If `src/mcp/runtime.test.ts` does not exist, the `npx vitest run src/mcp/` line still passes because Vitest globs only test files; do not create a new test file for `runtime.ts` as part of F12.

## Rollback strategy

Single commit. Revert restores `MAX_WALL_CLOCK_MS = 4 * 60 * 60 * 1000 - 30_000` and the `effectiveTimeout = timeout ?? MAX_WALL_CLOCK_MS` line; the new test cases are dropped with the same revert. No on-disk state changes, no migration, no schema change beyond the `config.mcp.shellTimeoutMs` key (owned by F11 — F12's revert leaves it in place, harmless).

## Risk register

- **F11 not yet landed.** If F11's `config.mcp` block is not in place when F12 is attempted, the `McpRuntime` constructor change in step 1 must include a minimal local addition of `shellTimeoutMs` (and `inProcessTimeoutMs`) to `SaivageConfig` to unblock; coordinate with F11 owner to avoid duplicate keys.
- **Test runtime budget.** The new tests start real child processes with a short `shellTimeoutMs` (60s) but kill them within ~30s; vitest default timeout is 5s and must be raised on those tests with `it("...", { timeout: 90_000 }, ...)`.
- **Worker prompt drift left in place.** This plan intentionally leaves the `600000 / 1800000 / 3600000` literals in the six agent prompts. They remain LLM hints rather than enforced contracts; the new `Math.min` clamp protects the invariant regardless. If an operator drops `shellTimeoutMs` below 1h in a future config, the prompts will recommend values above the new cap — the runtime will clamp them down silently. That is acceptable; the alternative (Proposal B) is tracked in [02-design-r1.md](02-design-r1.md) for future revisit.
