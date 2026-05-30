# G48 — Plan (Round 2)

- **Analysis**: [01-analysis-r2.md](01-analysis-r2.md)
- **Design**: [02-design-r2.md](02-design-r2.md)
- **Round 1**: [03-plan-r1.md](03-plan-r1.md), [04-review-r1.md](04-review-r1.md)

## 0. r2 deltas (vs. r1 plan)

| r1 step | r2 step |
|---|---|
| Insert helper inline in [src/server/cli.ts](../../../../src/server/cli.ts); export as `__withRuntime`. | Create new module [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) with `withRuntime`, `startAction`, `inspectAction`. Update [src/server/cli.ts](../../../../src/server/cli.ts) to import and wire them. |
| Rewrite `start` body inline. | `start` becomes `.action(startAction)`. Prefix change `Fatal:` → `Error:` is now intentional and documented. |
| Rewrite `inspect` body inline. | `inspect` becomes `.action(inspectAction)`. |
| One new test file [src/server/cli.test.ts](../../../../src/server/cli.test.ts). | Three new test files (see §1, step 4-6). |
| Manual grep checks in §3.4. | Step 6 — automated AST invariant test. |
| T1-T7 only. | T1-T8 (T8 = shutdown-only failure on success path). |

## 1. Sequenced steps

### Step 1 — Create [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts)

New file. Contents per [02-design-r2.md §1.1](02-design-r2.md): module docstring, top-level imports (`node:path` and `./bootstrap.js`), `withRuntime`, `startAction`, `InspectOptions`, `inspectAction`, type re-export of `SaivageRuntime`.

Verify no top-level side effects (no `program`, no `parse`, no `console.log`, no `process.on(...)`).

### Step 2 — Update [src/server/cli.ts](../../../../src/server/cli.ts)

Two edits:

1. Add `import { startAction, inspectAction } from "./cli-actions.js";` near the top, alongside `import { Command } from "commander";` at [src/server/cli.ts L5](../../../../src/server/cli.ts#L5).
2. Replace the inline action bodies at [src/server/cli.ts L60-L98](../../../../src/server/cli.ts#L60-L98) (`start`) and [src/server/cli.ts L218-L269](../../../../src/server/cli.ts#L218-L269) (`inspect`) with `.action(startAction)` / `.action(inspectAction)` respectively. Keep `.command(...)`, `.description(...)`, and (for inspect) `.option(...)` chains unchanged.

After this step, `cli.ts` no longer references `bootstrap`, `runPlanner`, `InspectorAgent`, `agentId`, `inspectionId`, or `SaivageRuntime` except inside the `serve` action body ([src/server/cli.ts L307-L390](../../../../src/server/cli.ts#L307-L390)). Run `npm run build` after this step to confirm dead-import errors are surfaced and cleaned up.

### Step 3 — Run build + existing tests

```bash
cd /home/salva/g/ml/saivage
npm run build
npm test
```

Existing suites must stay green. No production behaviour change is in effect for `inspect` until step 2 lands (which it has by now); the test-suite additions follow.

### Step 4 — Create unit-test file [src/server/cli-actions.test.ts](../../../../src/server/cli-actions.test.ts)

Tests T1-T8. Top of file:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as bootstrapModule from "./bootstrap.js";
import { withRuntime, type SaivageRuntime } from "./cli-actions.js";

vi.mock("./bootstrap.js", async (orig) => {
  const real = await orig<typeof bootstrapModule>();
  return { ...real, bootstrap: vi.fn(), runPlanner: vi.fn() };
});

const fakeRuntime = (shutdown = vi.fn().mockResolvedValue(undefined)) =>
  ({
    project: { projectRoot: "/tmp/x", saivageDir: "/tmp/x/.saivage" },
    shutdown,
  }) as unknown as SaivageRuntime;

let exitSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.exitCode = undefined;
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit:${code ?? 0}`);
  }) as never);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(bootstrapModule.bootstrap).mockReset();
  vi.mocked(bootstrapModule.runPlanner).mockReset();
});
```

#### T1 — Happy path

```ts
it("calls shutdown exactly once and exits 0 on the happy path", async () => {
  const shutdown = vi.fn().mockResolvedValue(undefined);
  vi.mocked(bootstrapModule.bootstrap).mockResolvedValue(fakeRuntime(shutdown));
  await expect(withRuntime(undefined, async () => {})).rejects.toThrow("__exit:0");
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(exitSpy).toHaveBeenCalledWith(0);
});
```

#### T2 — Callback throws

```ts
it("logs Error:, calls shutdown once, exits 1 on callback throw", async () => {
  const shutdown = vi.fn().mockResolvedValue(undefined);
  vi.mocked(bootstrapModule.bootstrap).mockResolvedValue(fakeRuntime(shutdown));
  await expect(withRuntime(undefined, async () => { throw new Error("boom"); }))
    .rejects.toThrow("__exit:1");
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
});
```

#### T3 — Bootstrap throws

```ts
it("does not call shutdown and exits 1 when bootstrap rejects", async () => {
  vi.mocked(bootstrapModule.bootstrap).mockRejectedValue(new Error("bootstrap failed"));
  const shutdown = vi.fn();
  await expect(withRuntime(undefined, async () => { shutdown(); }))
    .rejects.toThrow("__exit:1");
  expect(shutdown).not.toHaveBeenCalled();
  expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: bootstrap failed"));
});
```

#### T4 — Callback sets exitCode

```ts
it("preserves process.exitCode set by the callback", async () => {
  const shutdown = vi.fn().mockResolvedValue(undefined);
  vi.mocked(bootstrapModule.bootstrap).mockResolvedValue(fakeRuntime(shutdown));
  await expect(withRuntime(undefined, async () => { process.exitCode = 1; }))
    .rejects.toThrow("__exit:1");
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(errSpy).not.toHaveBeenCalled();
});
```

#### T5 — Shutdown failure during callback failure

```ts
it("logs both errors when shutdown rejects after a callback throw", async () => {
  const shutdown = vi.fn().mockRejectedValue(new Error("shutdown failed"));
  vi.mocked(bootstrapModule.bootstrap).mockResolvedValue(fakeRuntime(shutdown));
  await expect(withRuntime(undefined, async () => { throw new Error("boom"); }))
    .rejects.toThrow("__exit:1");
  expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
  expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Shutdown error: shutdown failed"));
});
```

#### T6 — Exactly-once shutdown when both fail

```ts
it("calls shutdown exactly once when callback throws and sets exitCode", async () => {
  const shutdown = vi.fn().mockResolvedValue(undefined);
  vi.mocked(bootstrapModule.bootstrap).mockResolvedValue(fakeRuntime(shutdown));
  await expect(withRuntime(undefined, async () => {
    process.exitCode = 1;
    throw new Error("boom");
  })).rejects.toThrow("__exit:1");
  expect(shutdown).toHaveBeenCalledTimes(1);
});
```

#### T8 — Shutdown-only failure on success path (NEW)

This pins the chosen contract: a teardown-only failure logs `Shutdown error:` but does **not** override the action's success.

```ts
it("logs Shutdown error: but exits 0 when only shutdown rejects on a successful run", async () => {
  const shutdown = vi.fn().mockRejectedValue(new Error("teardown failed"));
  vi.mocked(bootstrapModule.bootstrap).mockResolvedValue(fakeRuntime(shutdown));
  await expect(withRuntime(undefined, async () => {})).rejects.toThrow("__exit:0");
  expect(shutdown).toHaveBeenCalledTimes(1);
  expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Shutdown error: teardown failed"));
  expect(errSpy).not.toHaveBeenCalledWith(expect.stringContaining("Error: teardown failed"));
  expect(exitSpy).toHaveBeenCalledWith(0);
});
```

### Step 5 — Create e2e leak-detection file [src/server/cli-actions.e2e.test.ts](../../../../src/server/cli-actions.e2e.test.ts)

Standalone file. **No** `vi.mock("./bootstrap.js")` — this file exercises the real bootstrap and shutdown.

```ts
import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withRuntime } from "./cli-actions.js";

const LEAK_SENSITIVE_KINDS = [
  "ChildProcess", "Pipe", "PipeWrap", "Process",
  "Timeout", "FSReqCallback", "FileHandle", "HandleWrap",
] as const;

function histogram(kinds: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of kinds) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}

const isLinux = process.platform === "linux";
const fdCount = async () => (await readdir("/proc/self/fd")).length;

describe("G48 — resource-leak regression", () => {
  // The throw-path test: real bootstrap, force the callback to throw,
  // assert per-kind histogram and FD-count both collapse.
  it("collapses MCP/timer/FD resources after a throwing inspect run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "saivage-g48-"));
    const { seedProject } = await import("../store/project.js");
    await seedProject(dir, { name: "g48-test", objectives: ["test"] });

    const before = histogram(process.getActiveResourcesInfo());
    const fdBefore = isLinux ? await fdCount() : 0;

    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`__exit:${code ?? 0}`);
    }) as never);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(withRuntime(dir, async () => {
      throw new Error("simulated inspect failure");
    })).rejects.toThrow("__exit:1");

    // Two ticks: one for setImmediate, one for any queued child-exit signals.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    const after = histogram(process.getActiveResourcesInfo());
    for (const kind of LEAK_SENSITIVE_KINDS) {
      const a = after.get(kind) ?? 0;
      const b = before.get(kind) ?? 0;
      expect(a, `leaked ${a - b} extra ${kind} after shutdown`).toBeLessThanOrEqual(b);
    }

    if (isLinux) {
      const fdAfter = await fdCount();
      const ALLOWED_FD_SLACK = 2;
      expect(fdAfter, `FD count grew from ${fdBefore} to ${fdAfter}`)
        .toBeLessThanOrEqual(fdBefore + ALLOWED_FD_SLACK);
    }
  }, 60_000);
});
```

Notes:

- Test timeout 60s because real bootstrap warms up providers + MCP children. Local runs land at ~5-15s; CI may be slower.
- The throw path is exercised because that is the exact bug. A passing happy-path version would not differentiate this round from r1's leak; we explicitly target the regression surface.
- If `process.platform !== "linux"` the FD check is skipped per-assertion rather than skipping the whole test, so the kind-histogram still runs on macOS dev boxes.

### Step 6 — Create AST invariant file [src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts)

Automated replacement for r1's manual grep checks.

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

interface Site { fn: ts.FunctionLikeDeclarationBase | undefined; node: ts.CallExpression; }

function findBootstrapCalls(src: ts.SourceFile): Site[] {
  const sites: Site[] = [];
  const visit = (node: ts.Node, fn: ts.FunctionLikeDeclarationBase | undefined) => {
    const nextFn = (
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node)
    ) ? (node as ts.FunctionLikeDeclarationBase) : fn;

    if (ts.isCallExpression(node)) {
      const target = node.expression;
      if (ts.isIdentifier(target) && target.text === "bootstrap") {
        sites.push({ fn: nextFn, node });
      }
    }
    ts.forEachChild(node, (c) => visit(c, nextFn));
  };
  visit(src, undefined);
  return sites;
}

function findShutdownCallsInFn(fn: ts.Node): number {
  let count = 0;
  const visit = (n: ts.Node) => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === "shutdown"
    ) {
      count++;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return count;
}

function loadSource(rel: string): ts.SourceFile {
  const abs = resolve(__dirname, rel);
  return ts.createSourceFile(abs, readFileSync(abs, "utf-8"), ts.ScriptTarget.Latest, true);
}

describe("G48 — bootstrap/shutdown invariants", () => {
  it("cli-actions.ts has exactly one bootstrap() call, paired with shutdown() in the same function", () => {
    const src = loadSource("./cli-actions.ts");
    const sites = findBootstrapCalls(src);
    expect(sites, "expected exactly one bootstrap() call in cli-actions.ts").toHaveLength(1);
    for (const site of sites) {
      expect(site.fn, "bootstrap() must be inside a function").toBeDefined();
      const shutdowns = findShutdownCallsInFn(site.fn!);
      expect(shutdowns,
        "every bootstrap() in cli-actions.ts must be paired with a .shutdown() call in the same function",
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("cli.ts has exactly one bootstrap() call, inside the serve action only", () => {
    const src = loadSource("./cli.ts");
    const sites = findBootstrapCalls(src);
    expect(sites, "expected exactly one bootstrap() call in cli.ts (inside serve)").toHaveLength(1);
    // Cheap structural check: the enclosing function's parent chain reaches a
    // CallExpression on `program.command("serve...")`. We assert by string-
    // matching the enclosing source slice for the literal "serve" command.
    const site = sites[0]!;
    const fnText = site.fn!.getText(src);
    const enclosingSlice = src.text.slice(
      Math.max(0, site.fn!.pos - 200),
      Math.min(src.text.length, site.fn!.end + 50),
    );
    expect(enclosingSlice).toMatch(/\.command\(\s*"serve\b/);
    // Also: every bootstrap in serve's action must be paired with shutdown.
    expect(findShutdownCallsInFn(site.fn!)).toBeGreaterThanOrEqual(1);
    void fnText;
  });
});
```

The string-match-for-"serve" fallback is intentional: walking commander's chained-call AST to identify *which* `.command(...)` an `.action(...)` belongs to is more code than the invariant deserves. The 200-char prefix window is wide enough to capture the `.command("serve...")` and `.description(...)` chain that precedes any `.action(...)` body.

### Step 7 — Final validation

```bash
cd /home/salva/g/ml/saivage
npm run build
npm test
npx vitest run src/server/cli-actions.test.ts src/server/cli-actions.e2e.test.ts src/server/cli-actions.invariants.test.ts
```

All three new files must be green. The full `npm test` must remain green (no regressions in existing suites).

## 2. Order of file edits

1. Create [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) (step 1).
2. Edit [src/server/cli.ts](../../../../src/server/cli.ts) — import + two `.action(...)` rewrites (step 2).
3. `npm run build` and `npm test` — pre-regression baseline (step 3).
4. Create [src/server/cli-actions.test.ts](../../../../src/server/cli-actions.test.ts) (step 4, T1-T6 + T8).
5. Create [src/server/cli-actions.e2e.test.ts](../../../../src/server/cli-actions.e2e.test.ts) (step 5, T7).
6. Create [src/server/cli-actions.invariants.test.ts](../../../../src/server/cli-actions.invariants.test.ts) (step 6, AST checks).
7. Final validation (step 7).

## 3. Regression-test matrix

| # | File | Scenario | Assertion |
|---|---|---|---|
| T1 | cli-actions.test.ts | Happy path | shutdown × 1, exit 0 |
| T2 | cli-actions.test.ts | Callback throws | shutdown × 1, exit 1, `Error: boom` on stderr |
| T3 | cli-actions.test.ts | Bootstrap rejects | shutdown × 0, exit 1, `Error: ...` on stderr |
| T4 | cli-actions.test.ts | Callback sets `process.exitCode = 1` | shutdown × 1, exit 1, no `Error:` log |
| T5 | cli-actions.test.ts | Callback throws AND shutdown rejects | shutdown × 1, exit 1, both `Error:` and `Shutdown error:` on stderr |
| T6 | cli-actions.test.ts | Callback throws AND sets exitCode | shutdown × 1 (exactly once), exit 1 |
| T7 | cli-actions.e2e.test.ts | Real bootstrap + forced throw | per-kind histogram delta ≤ 0 for all leak-sensitive kinds; FD delta ≤ 2 on Linux |
| T8 | cli-actions.test.ts | Shutdown-only failure on success path | shutdown × 1, exit **0**, `Shutdown error:` on stderr, no `Error:` |

## 4. Risks & contingencies (updated)

| Risk | Mitigation |
|---|---|
| Vitest worker module-mocks `./bootstrap.js` for the unit-test file and accidentally affects the e2e file. | Vitest scopes `vi.mock` per-file. Confirmed by docs and by the existing split of `src/server/server.test.ts` (other suites in the same dir mock different modules). If a flake surfaces, split into separate `vitest --pool=forks` runs. |
| `runtime.shutdown()` itself hangs on a slow MCP child. | Out-of-baseline contingency: add `MCP_SHUTDOWN_TIMEOUT_MS` constant in cli-actions.ts and `Promise.race` it inside the finally. Not shipped unless T7 surfaces the hang. |
| Operator scripts depend on `Fatal:` from `start`. | Architecture-first policy approves the rename. `grep -rn 'Fatal:' src/ docs/ tests/` showed no other site depending on it. Documented in §5. |
| AST invariant test breaks if the codebase moves to a different bundler / minifies sources before test. | The test reads from `__dirname` — source-relative — so it runs against `src/`, not `dist/`. Vitest's default `transform: false` for `.ts` reads source. If a future config compiles sources before vitest sees them, the test reads the on-disk pre-compile file and continues to work. |
| T7 flakes on shared CI hosts because something outside the test pollutes the FD count. | Slack of 2 absorbs vitest's per-test log file FD. If the test flakes in practice, raise to 4 and document; do not silently widen. |

## 5. Rollout note

Operator-visible change: `saivage start` previously printed `Fatal: <message>` on a thrown error from the planner runtime. After this change it prints `Error: <message>` like every other short-lived runtime command. Exit code is unchanged (1). No other surface (commander subcommand names, options, stdout formatting, exit codes) changes.

Operator-visible fix: `saivage inspect` no longer hangs after a thrown failure inside the inspector or runtime. The process exits within one event-loop tick after `runtime.shutdown()` resolves. Subsequent `saivage inspect` / `saivage start` runs against the same project no longer hit "Another Saivage instance is already running" caused by an orphan lockfile.

Manual smoke (operator-side, optional, unchanged from r1):

1. In a scratch project, run `saivage inspect <path> bogus-scope` with `inspector.run()` patched to throw. Confirm the process exits within a second or two with exit code 1 — does *not* hang.
2. Immediately re-run `saivage inspect`. It must not report "Another Saivage instance is already running".
3. `ps -ef | grep -E 'mcp|saivage'` — confirm no orphan MCP children survive the failed run.

## 6. Done criteria

- All eight new tests (T1-T8) pass.
- `npm run build` and `npm test` pass cleanly on the full suite.
- The AST invariant test detects exactly one `bootstrap()` call in [src/server/cli.ts](../../../../src/server/cli.ts) (inside `serve`) and exactly one in [src/server/cli-actions.ts](../../../../src/server/cli-actions.ts) (inside `withRuntime`); both are paired with a `.shutdown()` call in the same function.
- [src/server/cli.ts](../../../../src/server/cli.ts) contains no references to `bootstrap`, `runPlanner`, `InspectorAgent`, `agentId`, `inspectionId`, or `SaivageRuntime` outside the `serve` action body.
- No new configuration keys; no new regex for parsing user intent; no new agent-tool-call heuristics — verified by reviewer in round 2's review.
- G51 (partial-bootstrap teardown) is filed as a separate finding; G48 does not block on it.
