# F12 — Plan r3 (Proposal A)

Implements Proposal A from [02-design-r3.md](02-design-r3.md): derive the inner wall-clock cap from `mcpConfig.shellTimeoutMs` inside the `registerBuiltinServices` closure, apply it as a hard clamp on caller-supplied `timeout_ms`, and reject impossible timing envelopes at config-schema load time.

## Changes from r2

- **Reconciled with F11's approved `registerBuiltinServices` shape.** The signature after F11 + F12 is now `registerBuiltinServices(runtime: McpRuntime, mcpConfig: SaivageConfig["mcp"], options?: BuiltinServicesOptions)` (Step 4 below) — not "unchanged" as r2 said. F12 reads `mcpConfig.shellTimeoutMs` from the closure rather than from a public `McpRuntime` field, so the F11 builtins-factory work and F12's inner-cap work share one argument.
- **Dropped the proposed `public readonly McpRuntime.shellTimeoutMs` field.** The runtime keeps `shellTimeoutMs` as a `private readonly` instance field (used only at the dispatch site); F12 no longer needs to expose it. Step 2 reflects this.
- **Removed the broken `public get shellTimeoutMs()` example** from r2's design — see [02-design-r3.md](02-design-r3.md). No accessor is now part of the plan; the only F12-introduced read of `shellTimeoutMs` is `mcpConfig.shellTimeoutMs` inside `registerBuiltinServices`.
- **Renamed `shellHandler` from a module-scope `const` to a factory-built closure** inside `registerBuiltinServices` (Step 4). F11 r2 step 6.3 already requires this pattern for the size-cap handlers; F12 joins it. Without this move there is no clean way to read `mcpConfig` from within the handler.
- **Updated the bootstrap call site** to pass `config.mcp` to `registerBuiltinServices` (Step 3) — F11 r2 step 6 already adds this; F12 confirms.
- Tests and validation commands are unchanged from r2.

## Cross-issue ordering

- **Must land after F11.** F11 r2 Proposal B introduces `config.mcp.shellTimeoutMs`, `config.mcp.shellTimeoutFloorMs`, removes the `SAIVAGE_SHELL_TIMEOUT_FLOOR_MS` env-var, **and changes `registerBuiltinServices` to take `config.mcp`** ([../F11/03-plan-r2.md](../F11/03-plan-r2.md#L93-L100)). F12 consumes all three. F11 r2 plan step 6.5 explicitly defers the `MAX_WALL_CLOCK_MS` derivation to F12 ([../F11/03-plan-r2.md](../F11/03-plan-r2.md#L101-L107)).
- If F11 ships with the constructor signature as `new McpRuntime(config.mcp, options)` (the slice variant), F12 Step 2 first widens it to `new McpRuntime(config, options)` because the runtime also reads `config.runtime.idleShutdownMs` / `healthCheckIntervalMs`. No semantic change.
- **No interaction with F28** ([src/mcp/registry.ts](src/mcp/registry.ts) vestigial persistence) or **F34** ([src/mcp/plan-server.ts](src/mcp/plan-server.ts) no caching).
- **No interaction with the skills/memory subsystem** (out of scope per `_LOOP-CONVENTIONS.md`).

## Ordered edit steps

### Step 1 — Export `WALL_CLOCK_HEADROOM_MS` from `builtins.ts`

File: [src/mcp/builtins.ts](src/mcp/builtins.ts#L36-L42).

1. Delete the `MAX_WALL_CLOCK_MS` constant and its preamble comment.
2. Add at module scope, before the other size/timeout consts:
   ```ts
   /** Headroom between the inner wall-clock cap and the outer McpRuntime
    *  race so the inner kill timer always wins and emits a structured result. */
   export const WALL_CLOCK_HEADROOM_MS = 30_000;
   ```
3. Delete `DEFAULT_MIN_TIMEOUT_MS` (already on F11 r2's deletion list at step 6.4; confirm it is gone).

### Step 2 — Pin `McpRuntime` constructor to full `SaivageConfig`

File: [src/mcp/runtime.ts](src/mcp/runtime.ts#L67-L172).

1. Change the constructor signature from
   ```ts
   constructor(config: SaivageConfig["runtime"], options: McpRuntimeOptions = {}) {
   ```
   to
   ```ts
   constructor(config: SaivageConfig, options: McpRuntimeOptions = {}) {
   ```
2. Update all reads inside the constructor from `config.*` (which previously was the `runtime` slice) to `config.runtime.*` — `maxServices`, `restartOnCrash`, `healthCheckIntervalMs`, `idleShutdownMs`.
3. Replace
   ```ts
   private static readonly IN_PROCESS_TIMEOUT_MS = 300_000;
   private static readonly SHELL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
   ```
   ([src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L172)) with **`private readonly`** instance fields:
   ```ts
   private readonly inProcessTimeoutMs: number;
   private readonly shellTimeoutMs: number;
   ```
   and assign in the constructor body:
   ```ts
   this.inProcessTimeoutMs = config.mcp.inProcessTimeoutMs;
   this.shellTimeoutMs = config.mcp.shellTimeoutMs;
   ```
   Both fields stay **private**. F12 does **not** add a public accessor; consumers that need `shellTimeoutMs` read `config.mcp.shellTimeoutMs` from their own `mcpConfig` parameter (see Step 4).
4. Update the two reads at [src/mcp/runtime.ts](src/mcp/runtime.ts#L184-L186):
   ```ts
   const timeoutMs = serviceName === "shell" ? this.shellTimeoutMs : this.inProcessTimeoutMs;
   ```

### Step 3 — Update bootstrap call site

File: [src/server/bootstrap.ts](src/server/bootstrap.ts#L140-L141).

1. `new McpRuntime(config.runtime)` → `new McpRuntime(config)`.
2. `registerBuiltinServices(mcpRuntime, { promptInjectionCop })` → `registerBuiltinServices(mcpRuntime, config.mcp, { promptInjectionCop })`. (F11 r2 step 6 already requires this; F12 confirms the call-site alignment.)

### Step 4 — Convert `shellHandler` to a factory closure inside `registerBuiltinServices` and apply the inner cap

File: [src/mcp/builtins.ts](src/mcp/builtins.ts#L375-L394) and [src/mcp/builtins.ts](src/mcp/builtins.ts#L1095-L1119).

After F11 r2 step 6.3, `registerBuiltinServices` already takes `mcpConfig: SaivageConfig["mcp"]` and closure-captures `MAX_OUTPUT`, `MAX_FETCH_CHARS`, `MAX_DOWNLOAD_BYTES` from it. F12 makes two changes in this same factory function:

1. **Signature** (confirm F11 shape; F12 does not change it again):
   ```ts
   export function registerBuiltinServices(
     runtime: McpRuntime,
     mcpConfig: SaivageConfig["mcp"],
     options: BuiltinServicesOptions = {},
   ): void
   ```

2. **Move `shellHandler` from module scope into the factory body**, alongside the F11-relocated `fetchHandler` / `downloadHandler` / etc. Inside its closure, replace:
   ```ts
   const effectiveTimeout = timeout ?? MAX_WALL_CLOCK_MS;
   ```
   with:
   ```ts
   const innerCapMs = mcpConfig.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS;
   const effectiveTimeout = Math.min(timeout ?? innerCapMs, innerCapMs);
   ```
   `WALL_CLOCK_HEADROOM_MS` is in scope (same module, Step 1). The schema refine in Step 6 guarantees `innerCapMs > 0`, so no runtime guard is needed.

3. The `runtime.registerInProcess("shell", shellTools, shellHandler);` line inside `registerBuiltinServices` now references the closure-local `shellHandler` (one identifier, scope changed); no other call-site updates.

### Step 5 — Verify no orphaned references

Run, in `/home/salva/g/ml/saivage`:
```bash
grep -rn 'MAX_WALL_CLOCK_MS\|DEFAULT_MIN_TIMEOUT_MS' src/
```
Must print **zero** matches. If anything remains, it is a missed call site; delete it.

Also confirm `McpRuntime` does not expose `shellTimeoutMs`:
```bash
grep -n 'public.*shellTimeoutMs\|get shellTimeoutMs' src/mcp/runtime.ts
```
Must print zero matches. If any appears, it is residue from r2's design and must be removed (the field stays private; F12 reads from `mcpConfig` instead).

### Step 6 — Add schema-level envelope validation

File: [src/config.ts](src/config.ts).

After F11 r2's `mcp: z.object({ ... }).default({})` block is in place, append a `.superRefine` to the `mcp` block:

```ts
import { WALL_CLOCK_HEADROOM_MS } from "./mcp/builtins.js";

// ... inside configSchema, replacing the bare mcp .default({}) ...
mcp: z.object({
  shellTimeoutMs: z.number().default(4 * 60 * 60 * 1000),
  shellTimeoutFloorMs: z.number().default(10 * 60 * 1000),
  inProcessTimeoutMs: z.number().default(300_000),
  maxOutputBytes: z.number().default(100 * 1024),
  maxFetchChars: z.number().default(200_000),
  maxDownloadBytes: z.number().default(250 * 1024 * 1024),
}).default({}).superRefine((mcp, ctx) => {
  if (mcp.shellTimeoutMs <= WALL_CLOCK_HEADROOM_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shellTimeoutMs"],
      message:
        `mcp.shellTimeoutMs must exceed WALL_CLOCK_HEADROOM_MS (${WALL_CLOCK_HEADROOM_MS}ms); ` +
        `got ${mcp.shellTimeoutMs}`,
    });
    return;
  }
  const innerCap = mcp.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS;
  if (mcp.shellTimeoutFloorMs > innerCap) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["shellTimeoutFloorMs"],
      message:
        `mcp.shellTimeoutFloorMs (${mcp.shellTimeoutFloorMs}) must not exceed the derived inner cap ` +
        `mcp.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS (${innerCap})`,
    });
  }
}),
```

Note: the import path `./mcp/builtins.js` creates a `config.ts → builtins.ts` dependency. Verify with `grep -n 'from "../config' src/mcp/builtins.ts` that the reverse import does **not** exist (it does not today; `builtins.ts` does not import `config.ts`, and F12 does not add such an import — `SaivageConfig["mcp"]` is a structural type parameter only, supplied at the `registerBuiltinServices` call site). If after F11 `builtins.ts` imports `config.ts`, move `WALL_CLOCK_HEADROOM_MS` to a small constants module under `src/mcp/timeouts.ts` (a new file) imported by both. **Step 6 fallback:** verify direction-of-import is one-way before merging.

### Step 7 — Update [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts)

The existing `beforeEach` block at [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L36-L51):

1. F11 r2 step 8.1 already replaces `process.env["SAIVAGE_SHELL_TIMEOUT_FLOOR_MS"] = "0"` with a config field on the constructed config, and updates the `registerBuiltinServices` call to pass `config.mcp` per the new signature. F12 changes the test's runtime construction to build a full `SaivageConfig` with the tight `shellTimeoutMs` (use a small `makeTestConfig(overrides)` helper local to this test file, or call `loadConfig({ ... overrides ... })`):
   ```ts
   const cfg = loadConfig({
     runtime: { maxServices: 50, restartOnCrash: true, healthCheckIntervalMs: 0, idleShutdownMs: 0 },
     mcp: { shellTimeoutMs: 30_050, shellTimeoutFloorMs: 0 },
   });
   runtime = new McpRuntime(cfg);
   registerBuiltinServices(runtime, cfg.mcp);
   ```
   `shellTimeoutMs: 30_050` is the minimum valid value above `WALL_CLOCK_HEADROOM_MS`; it gives `innerCapMs = 50`. `shellTimeoutFloorMs: 0` disables the floor for tests.
2. Delete the `process.env["SAIVAGE_SHELL_TIMEOUT_FLOOR_MS"]` set/unset lines (already covered by F11 r2 step 8.1; F12 confirms they stay gone).

3. **Add new test**: `"clamps caller-supplied timeout_ms above the derived inner cap"`
   ```ts
   it("clamps caller-supplied timeout_ms above mcpConfig.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS", async () => {
     const result = await runtime.callTool("shell", "run_command", {
       command: "node -e \"setTimeout(() => {}, 60000)\"",
       timeout_ms: 9 * 60 * 60 * 1000,
     }) as { stderr: string; exitCode: number; duration_ms: number };
     expect(result.exitCode).toBe(124);
     expect(result.stderr).toContain("Command timed out after 50ms");
     expect(result.duration_ms).toBeLessThan(5_000); // well under the 30_050 outer race
   });
   ```

4. **Add new test**: `"applies the derived inner cap when timeout_ms is omitted"`
   ```ts
   it("applies mcpConfig.shellTimeoutMs - WALL_CLOCK_HEADROOM_MS as the wall-clock cap when timeout_ms is omitted", async () => {
     const result = await runtime.callTool("shell", "run_command", {
       command: "node -e \"setTimeout(() => {}, 60000)\"",
     }) as { stderr: string; exitCode: number; duration_ms: number };
     expect(result.exitCode).toBe(124);
     expect(result.stderr).toContain("Command timed out after 50ms");
     expect(result.duration_ms).toBeLessThan(5_000);
   });
   ```

Both tests run in ~50–100 ms each (the inner kill timer fires at 50 ms). The outer race at 30_050 ms is never reached. The structured-message assertion (`"Command timed out after 50ms"`) proves the inner handler's `runShellCommand` timeout path won — see [src/mcp/builtins.ts](src/mcp/builtins.ts#L579) for the message source.

5. The existing tests at [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts#L100-L114) (`"times out shell commands only when the caller requests it"`, with `timeout_ms: 20`) currently rely on a 4 h `SHELL_TIMEOUT_MS` allowing arbitrarily small `timeout_ms` values. After F12 they still pass because `Math.min(20, 50) === 20`; no change needed. Confirm with a re-run.

### Step 8 — Add config-schema validation tests

File: [src/config.test.ts](src/config.test.ts).

Add a new describe block (or extend an existing one):

```ts
describe("mcp timing envelope validation", () => {
  it("rejects shellTimeoutMs <= WALL_CLOCK_HEADROOM_MS", () => {
    expect(() => loadConfig({ mcp: { shellTimeoutMs: 25_000 } }))
      .toThrow(/WALL_CLOCK_HEADROOM_MS/);
  });

  it("rejects shellTimeoutMs exactly equal to WALL_CLOCK_HEADROOM_MS", () => {
    expect(() => loadConfig({ mcp: { shellTimeoutMs: 30_000 } }))
      .toThrow(/WALL_CLOCK_HEADROOM_MS/);
  });

  it("rejects shellTimeoutFloorMs > shellTimeoutMs - WALL_CLOCK_HEADROOM_MS", () => {
    expect(() =>
      loadConfig({ mcp: { shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_200_000 } }),
    ).toThrow(/inner cap/);
  });

  it("accepts shellTimeoutFloorMs === shellTimeoutMs - WALL_CLOCK_HEADROOM_MS (boundary)", () => {
    const cfg = loadConfig({ mcp: { shellTimeoutMs: 1_200_000, shellTimeoutFloorMs: 1_170_000 } });
    expect(cfg.mcp.shellTimeoutFloorMs).toBe(1_170_000);
  });

  it("accepts the default config", () => {
    const cfg = loadConfig({});
    expect(cfg.mcp.shellTimeoutMs).toBe(14_400_000);
    expect(cfg.mcp.shellTimeoutFloorMs).toBe(600_000);
  });
});
```

Use whatever `loadConfig`-equivalent helper [src/config.test.ts](src/config.test.ts) already uses; if the test file uses `configSchema.parse(...)` directly, mirror that style.

### Step 9 — Update existing `McpRuntime` test sites

The `McpRuntime` constructor signature changed (Step 2.1) from `(config: SaivageConfig["runtime"], ...)` to `(config: SaivageConfig, ...)`. F11 r2 step 8.2 already says to update these for the F11-driven changes; F12 verifies and tightens.

1. [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts) (if present): every `new McpRuntime({ ... })` site must pass a full `SaivageConfig` with both `runtime` and `mcp` blocks (use `loadConfig({...})`).
2. Any other test that constructs `McpRuntime` directly: same change. Find them with `grep -rn 'new McpRuntime(' src/ tests/`.
3. Any other test that calls `registerBuiltinServices(...)` directly: ensure the second argument is the `config.mcp` slice. Find them with `grep -rn 'registerBuiltinServices(' src/ tests/`.

## Test strategy

### Existing tests that exercise the affected paths

| Step | Test file |
|---|---|
| 1 (export const) | covered by 7's recompile |
| 2 (McpRuntime ctor) | [src/mcp/runtime.test.ts](src/mcp/runtime.test.ts) (Step 9) |
| 4 (inner cap clamp) | new cases in [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) (Step 7.3–4) |
| 6 (schema refine) | new cases in [src/config.test.ts](src/config.test.ts) (Step 8) |
| 7 (no regression) | [src/mcp/builtins.test.ts](src/mcp/builtins.test.ts) existing cases |

### Validation commands

From `/home/salva/g/ml/saivage`:

```bash
npm run typecheck
npm run build

# Schema validation:
npx vitest run src/config.test.ts

# Inner-cap derivation + clamp + structured timeout message:
npx vitest run src/mcp/builtins.test.ts

# Constructor signature change (if file exists):
npx vitest run src/mcp/runtime.test.ts

# Subsystem sweep:
npx vitest run src/mcp/

# Orphan-reference check:
grep -rn 'MAX_WALL_CLOCK_MS\|DEFAULT_MIN_TIMEOUT_MS' src/   # must print nothing
grep -n 'public.*shellTimeoutMs\|get shellTimeoutMs' src/mcp/runtime.ts   # must print nothing

# Full suite as the final gate:
npx vitest run
```

The two new `builtins.test.ts` cases use `node -e "setTimeout(() => {}, 60000)"` and are killed by the inner timer at ~50 ms; total Vitest wall-clock for the two added cases is well under 1 second. No `it("...", { timeout: 90_000 }, ...)` extension is needed.

## Rollback strategy

Single commit. Revert restores:
- `MAX_WALL_CLOCK_MS = 4 * 60 * 60 * 1000 - 30_000` and `effectiveTimeout = timeout ?? MAX_WALL_CLOCK_MS`.
- `shellHandler` as a module-scope `const`.
- `McpRuntime` constructor's `SaivageConfig["runtime"]` signature.
- `registerBuiltinServices(runtime, options)` two-arg signature.
- The `bootstrap.ts` `new McpRuntime(config.runtime)` and `registerBuiltinServices(mcpRuntime, { ... })` sites.
- The `.superRefine` on `configSchema.mcp` (impossible envelopes can be loaded again).

The new test cases are dropped with the same revert. No on-disk state changes, no migration, no schema-shape change beyond the `.superRefine` (which is additive — removing it widens the accepted set, never narrows it).

## Risk register

- **F11 not yet landed.** If F11's `config.mcp` block and `registerBuiltinServices(runtime, mcpConfig, options)` signature are not in place when F12 is attempted, Steps 1–4 cannot complete cleanly. F12 strictly depends on F11. If urgency forces F12 first, fold the F11 `mcp` block keys (`shellTimeoutMs`, `shellTimeoutFloorMs`, `inProcessTimeoutMs`) into F12; this is a contingency, not the plan.
- **Schema import direction.** Step 6's `import { WALL_CLOCK_HEADROOM_MS } from "./mcp/builtins.js"` in `src/config.ts` creates a one-way dependency. Verify (`grep -n 'from "../config' src/mcp/builtins.ts`) that `builtins.ts` does not import `config.ts`. After F11 r2 step 6.3, `registerBuiltinServices` receives config values via a parameter (`mcpConfig: SaivageConfig["mcp"]`), so `builtins.ts` only needs the `SaivageConfig` type — that lives in `src/config.ts` already as a type-only import, but a type-only import does not create a runtime cycle. If a future change adds a runtime-value import from `builtins.ts` → `config.ts`, hoist `WALL_CLOCK_HEADROOM_MS` to a small standalone constants module.
- **Constructor widening in tests.** Several test files construct `McpRuntime` directly; Step 9 catches them. Vitest will fail loudly on type mismatch; this is a deliberate boundary check, not a hidden regression.
- **Boundary test value.** The schema test at Step 8 case 4 (`shellTimeoutFloorMs === shellTimeoutMs - WALL_CLOCK_HEADROOM_MS`) verifies the boundary is *inclusive* (allowed); if the refine is mis-written with `>=` instead of `>`, this test fails. The refine in Step 6 uses `>` for the floor check.
- **Worker prompt drift left in place.** This plan intentionally leaves the `600000 / 1800000 / 3600000` literals in the six agent prompts ([src/agents/coder.ts](src/agents/coder.ts#L64), [src/agents/manager.ts](src/agents/manager.ts#L140), [src/agents/researcher.ts](src/agents/researcher.ts#L62), [src/agents/data-agent.ts](src/agents/data-agent.ts#L55), [src/agents/reviewer.ts](src/agents/reviewer.ts#L45), [src/agents/inspector.ts](src/agents/inspector.ts#L74)). They remain LLM hints; the new `Math.min` clamp protects the invariant regardless. If an operator drops `shellTimeoutMs` close to (but still above) `WALL_CLOCK_HEADROOM_MS`, the prompts will recommend values far above the derived cap — the runtime will clamp them down silently. That is acceptable per the analysis r2 narrowing; the alternative (Proposal B) is tracked in [02-design-r3.md](02-design-r3.md) for future revisit.
- **`shellHandler` scope move.** Moving the handler from module scope into the `registerBuiltinServices` closure means any test that imported `shellHandler` by name from `builtins.ts` (i.e. without going through `registerBuiltinServices` → `runtime.callTool`) would break. Grep `grep -rn "import.*shellHandler\|{ *shellHandler" src/ tests/` before merging; the current tree has no such imports (handlers are exercised via `runtime.callTool`), so this is a forward-only check.
