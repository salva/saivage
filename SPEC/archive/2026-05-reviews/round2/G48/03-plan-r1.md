# G48 — Plan (Round 1)

- **Analysis**: [01-analysis-r1.md](01-analysis-r1.md)
- **Design**: [02-design-r1.md](02-design-r1.md)

## 1. Sequenced steps

### Step 1 — Add `withRuntime` helper

Edit [src/server/cli.ts](../../../../src/server/cli.ts):

- Add at top of file (next to `import { Command } from "commander";` at [L5](../../../../src/server/cli.ts#L5)):

  ```ts
  import type { SaivageRuntime } from "./bootstrap.js";
  ```
- Insert the `withRuntime` helper immediately after `installRecoverableSocketErrorGuard` ([L18-L31](../../../../src/server/cli.ts#L18-L31)) per design §3.2.

The helper is module-private (not exported in production), but exposed to tests via a single named export: `export { withRuntime as __withRuntime };`. The leading double-underscore signals "test seam, not stable API". No other file imports it.

### Step 2 — Rewrite `start` action

Replace the body of `program.command("start [project-path]").action(...)` at [src/server/cli.ts L60-L98](../../../../src/server/cli.ts#L60-L98) with the `withRuntime` delegation form from design §1 (Proposal B). The switch on `result.kind` moves inside the callback. `runPlanner` import stays dynamic inside the callback.

### Step 3 — Rewrite `inspect` action

Replace the body of `program.command("inspect <project-path> <scope>").action(...)` at [src/server/cli.ts L217-L270](../../../../src/server/cli.ts#L217-L270) with the `withRuntime` delegation form from design §1. `InspectorAgent`, `agentId`, `inspectionId` imports stay dynamic inside the callback.

### Step 4 — New test file

Create [src/server/cli.test.ts](../../../../src/server/cli.test.ts) — see §3.

### Step 5 — Build + tests + grep sanity

```bash
cd saivage
npm run build
npm test
grep -nE 'await runtime\.shutdown\(\)' src/server/cli.ts   # MUST appear only inside withRuntime + inside serve
grep -nE 'await bootstrap\(' src/server/cli.ts             # MUST appear only inside withRuntime + inside serve
```

The grep checks codify the lifecycle invariant: every call to `bootstrap(...)` inside cli.ts must be paired with a `runtime.shutdown()` in the same lexical scope. `serve` is the lone exception and is allowed to own both.

## 2. Order of file edits

1. [src/server/cli.ts](../../../../src/server/cli.ts#L1-L17) — type-only import.
2. [src/server/cli.ts](../../../../src/server/cli.ts#L18-L31) — insert `withRuntime`.
3. [src/server/cli.ts](../../../../src/server/cli.ts#L60-L98) — rewrite `start`.
4. [src/server/cli.ts](../../../../src/server/cli.ts#L217-L270) — rewrite `inspect`.
5. [src/server/cli.test.ts](../../../../src/server/cli.test.ts) — new test file.

## 3. Regression test plan

### 3.1 Test seam

The vitest specs import `withRuntime` via the `__withRuntime` re-export added in step 1. They do not invoke commander; they call `withRuntime(undefined, async (rt) => {...})` directly with a stubbed `bootstrap`.

`bootstrap` is mocked via `vi.mock("./bootstrap.js")` to return a fake runtime:

```ts
const shutdownSpy = vi.fn().mockResolvedValue(undefined);
const fakeRuntime: Partial<SaivageRuntime> = {
  project: { projectRoot: "/tmp/x", saivageDir: "/tmp/x/.saivage", paths: { runtimeState: "/tmp/x/.saivage/runtime/runtime.json", notes: "/tmp/x/.saivage/notes" } } as any,
  shutdown: shutdownSpy,
};
vi.mocked(bootstrap).mockResolvedValue(fakeRuntime as SaivageRuntime);
```

`process.exit` is stubbed at the top of each test:

```ts
const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
  throw new Error(`__exit:${code ?? 0}`);
}) as never);
```

so the helper's terminal `process.exit(...)` raises a tagged sentinel error the test can catch, rather than killing the vitest worker.

### 3.2 New tests (all in [src/server/cli.test.ts](../../../../src/server/cli.test.ts))

T1. **Happy path**: callback returns; `shutdown` called exactly once; `process.exit(0)` requested.

```ts
await expect(withRuntime(undefined, async () => {})).rejects.toThrow("__exit:0");
expect(shutdownSpy).toHaveBeenCalledTimes(1);
expect(exitSpy).toHaveBeenCalledWith(0);
```

T2. **Callback throws**: shutdown still runs exactly once; `process.exit(1)` requested; the thrown message is on stderr.

```ts
const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
await expect(withRuntime(undefined, async () => { throw new Error("boom"); }))
  .rejects.toThrow("__exit:1");
expect(shutdownSpy).toHaveBeenCalledTimes(1);
expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
```

T3. **Bootstrap throws**: shutdown is *not* called (no runtime to shut down); `process.exit(1)`.

```ts
vi.mocked(bootstrap).mockRejectedValueOnce(new Error("bootstrap failed"));
await expect(withRuntime(undefined, async () => {})).rejects.toThrow("__exit:1");
expect(shutdownSpy).not.toHaveBeenCalled();
```

T4. **`process.exitCode` set by callback is respected**: callback returns normally after `process.exitCode = 1`; shutdown runs; exit code 1 propagates.

```ts
await expect(withRuntime(undefined, async () => { process.exitCode = 1; }))
  .rejects.toThrow("__exit:1");
expect(shutdownSpy).toHaveBeenCalledTimes(1);
process.exitCode = undefined; // restore
```

T5. **`shutdown()` rejection is logged but does not mask the original failure**: callback throws "boom"; shutdown throws "shutdown failed"; both are on stderr; exit code is 1.

```ts
shutdownSpy.mockRejectedValueOnce(new Error("shutdown failed"));
const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
await expect(withRuntime(undefined, async () => { throw new Error("boom"); }))
  .rejects.toThrow("__exit:1");
expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error: boom"));
expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Shutdown error: shutdown failed"));
```

T6. **Exactly-once shutdown**: callback throws AND sets `process.exitCode` — shutdown still runs exactly once.

```ts
await expect(withRuntime(undefined, async () => {
  process.exitCode = 1;
  throw new Error("boom");
})).rejects.toThrow("__exit:1");
expect(shutdownSpy).toHaveBeenCalledTimes(1);
```

### 3.3 Resource-leak detection test (end-to-end against a real runtime)

T7. **`process.getActiveResourcesInfo()` collapses after `withRuntime` resolves through the throw path.** This is the deterministic operator-side regression — the issue's core symptom.

Because building a real runtime requires a project tree, this test uses a temp `.saivage/` seeded by `seedProject`, the actual `bootstrap()`, and forces `fn` to throw. After the helper's `finally` runs (intercepted before `process.exit` via the same `exitSpy` seam), the test inspects the active-resource snapshot.

```ts
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";

it("collapses active resources after a throwing inspect run", async () => {
  const dir = await mkdtemp(join(tmpdir(), "saivage-g48-"));
  const { seedProject } = await import("../store/project.js");
  await seedProject(dir, { name: "g48-test", objectives: ["test"] });

  const baseline = new Set(process.getActiveResourcesInfo());

  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`__exit:${code ?? 0}`);
  }) as never);

  await expect(withRuntime(dir, async () => {
    throw new Error("simulated inspect failure");
  })).rejects.toThrow("__exit:1");

  // Give the event loop one tick to flush MCP child process exit signals.
  await new Promise<void>((r) => setImmediate(r));

  const after = process.getActiveResourcesInfo();
  const leaked = after.filter((kind) => !baseline.has(kind) && !TEST_HARNESS_KINDS.has(kind));
  expect(leaked).toEqual([]);
});

const TEST_HARNESS_KINDS = new Set([
  "TTYWrap", "PipeWrap", "Timeout", "Immediate", "TickObject",
  "FSReqCallback", "FSEvent",
]);
```

The allow-list `TEST_HARNESS_KINDS` is the exhaustive set of resource kinds vitest is permitted to keep alive between tests. The kinds that *must* disappear are the ones associated with MCP child process IPC (`ChildProcess`, `Pipe`, `Process`), the runtime lockfile (`FileHandle`), and the supervisor interval (`Timeout` *attributable to* the supervisor — which is why we compare against `baseline`, taken before bootstrap, instead of against an empty set).

If the test ever flakes on `Timeout` kind, that is a real bug — the supervisor's interval is not unref-ed during teardown, and the analysis should be re-opened.

This test is tagged `// G48 — resource-leak regression` so future authors do not weaken it.

### 3.4 Non-functional checks

- `npm run build` — must succeed.
- `grep -nE 'await runtime\.shutdown\(\)' src/server/cli.ts` — appears only inside `withRuntime` (one occurrence) and inside `serve`'s SIGINT handler (one occurrence at [L380](../../../../src/server/cli.ts#L380)). Two total matches.
- `grep -nE 'await bootstrap\(' src/server/cli.ts` — appears only inside `withRuntime` and inside `serve`. Two total matches.
- `npm test -- src/server/cli.test.ts` — green.
- `npm test` — full saivage suite green.

### 3.5 Manual smoke (operator-side, optional)

Out of automated scope but recommended in the rollout note:

1. In a scratch project, run `saivage inspect <path> bogus-scope` with `inspector.run()` patched to throw (or with an unreachable LLM endpoint configured). Confirm the process exits within a second or two and returns to the shell prompt with exit code 1 — does *not* hang.
2. Immediately re-run `saivage inspect`. It must not report "Another Saivage instance is already running" — confirms the runtime lockfile was released.
3. `ps -ef | grep -E 'mcp|saivage'` — confirm no orphan children survive the failed run.

## 4. Risks & contingencies

| Risk | Mitigation |
|---|---|
| `runtime.shutdown()` itself hangs (MCP child ignores SIGTERM). | Plan does NOT add a timeout in the first round — the issue is about the *absent* shutdown call, not a slow one. If T7 surfaces a real shutdown-hang, add a `MCP_SHUTDOWN_TIMEOUT_MS` sibling to `PLANNER_SHUTDOWN_TIMEOUT_MS` ([src/server/cli.ts L7](../../../../src/server/cli.ts#L7)) and `Promise.race` it inside `withRuntime`. Track as a follow-up note. |
| `process.exit(0)` in test harness kills the vitest worker. | Mitigated by `exitSpy` seam (§3.1). |
| `start` action loses observable behaviour during the rewrite. | The switch on `result.kind` is preserved verbatim inside the callback; only the surrounding lifecycle moves. Existing manual operators of `saivage start` see identical stdout/stderr and exit codes. No `saivage start` tests exist today, so there is no automated guard — flagged in the rollout note. |
| The new `__withRuntime` re-export becomes a load-bearing API. | The leading double-underscore is the established convention in this codebase for test seams (verify with `grep -rn '__' src/`) and we add a comment on the export line: `// test-only seam; do not import outside tests`. |

## 5. Done criteria

- All seven new tests (T1-T7) pass.
- `npm run build` and `npm test` pass cleanly.
- The two grep sanity checks in §3.4 return exactly two matches each.
- The `inspect` action and the `start` action both delegate to `withRuntime`; `serve` is untouched.
- T7 (active-resource snapshot) returns an empty leaked-resource list after a forced throw.
- No new configuration keys; no new regex; no new agent-tool-call heuristics — verified by reviewer in round 2.
