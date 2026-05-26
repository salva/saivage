# G05 — Plan r3

**Finding**: [../G05-worker-message-builder-duplicated-5x.md](../G05-worker-message-builder-duplicated-5x.md)
**Analysis**: [01-analysis-r3.md](01-analysis-r3.md)
**Design**: [02-design-r3.md](02-design-r3.md) — Proposal B (refined), three r2→r3 patches applied.
**Round-2 review**: [04-review-r2.md](04-review-r2.md) — CHANGES_REQUESTED (3 items).

## Round 3 deltas vs r2

Three reviewer-mandated changes applied:

1. **Migrate existing direct-constructor tests** in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) at L136, L200, L375, L550 to `WorkerAgent.createWorker<XxxAgent>(...)` — step 5b. Without this, `pnpm test -- src/agents` is not a real validation gate.
2. **Real exhaustiveness checks** — compile-time anchor uses `[Extract<..., { worker: true; workerInit: null }>] extends [never]` (step 1c), and runtime cross-check exports a new `hasWorkerCtor(role)` helper from [src/agents/worker.ts](../../../../src/agents/worker.ts) and asserts it per `WorkerRole` (step 2 + step 6b).
3. **Single-source `WorkerRole`** — [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25) imports `WorkerRole` from [src/agents/roster.ts](../../../../src/agents/roster.ts#L213) and re-exports it (step 0).

Everything else in [03-plan-r2.md](03-plan-r2.md) carries forward verbatim except where steps are explicitly amended below.

Blast radius after r3: **7 production files modified, 1 production file added** (`prompt-keys.ts`), **3 test files modified, 2 test files added** — 13 paths total. The seventh production file is [src/agents/task-report.ts](../../../../src/agents/task-report.ts) (the `WorkerRole` import); the third modified test file is [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts).

---

## Sequenced steps

### 0. Re-source `WorkerRole` from `roster.ts` (new in r3).

In [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25):

- Delete the local union declaration `export type WorkerRole = "coder" | "researcher" | "data_agent" | "reviewer" | "designer";`.
- Add `import type { WorkerRole } from "./roster.js";` near the existing imports.
- Add `export type { WorkerRole };` immediately after the import so existing consumers (chiefly [src/agents/worker.ts](../../../../src/agents/worker.ts)) continue to import `WorkerRole` from `./task-report.js` without import-path churn.
- Keep `const ROLE_TO_TASK_TYPE: Record<WorkerRole, Task["type"]> = { coder: "code", researcher: "research", data_agent: "data", reviewer: "review", designer: "design" };` — the literal is unchanged; only the key type now resolves through the roster.
- After step 0, `tsc --noEmit` is the canary: if the literal omits a `WorkerRole` (or adds an extra key not in the roster's `worker: true` set), the `Record<WorkerRole, ...>` check fails.

No other call site changes for `WorkerRole`. `roster.ts` already declares it at [src/agents/roster.ts](../../../../src/agents/roster.ts#L213); no edit there for this step.

### 1. Break the prompt-key import cycle and add `workerInit` to `ROSTER`.

Carries [03-plan-r2.md step 1](03-plan-r2.md) verbatim for substeps 1a, 1b, and the per-entry `workerInit` literals in 1c. **Replace** the compile-time anchor in 1c with:

```ts
// Compile-time guard: every entry with worker: true must have a non-null workerInit.
// Wrapped-tuple form prevents the bare `extends never` distribution.
type _WorkerEntriesWithNullInit = Extract<
  (typeof ROSTER)[number],
  { worker: true; workerInit: null }
>;
type _EveryWorkerHasInit = [_WorkerEntriesWithNullInit] extends [never] ? true : never;
const _everyWorkerHasInit: _EveryWorkerHasInit = true;
void _everyWorkerHasInit;
```

The accessor `getWorkerInitMeta(role: WorkerRole)` is unchanged from r2.

### 2. Add renderer, ctor registry, `createWorker`, and `hasWorkerCtor` in `WorkerAgent`.

Carries [03-plan-r2.md step 2](03-plan-r2.md) verbatim, plus this addition next to `registerWorkerCtor` in [src/agents/worker.ts](../../../../src/agents/worker.ts):

```ts
export function hasWorkerCtor(role: WorkerRole): boolean {
  return WORKER_CTORS.has(role);
}
```

`getWorkerCtor` keeps its existing throw-on-missing behaviour and stays internal; `hasWorkerCtor` is the test-facing inspector.

### 3. Shrink the four pure-worker subclasses to declarations.

Unchanged — see [03-plan-r2.md step 3](03-plan-r2.md).

### 4. Rebuild `reviewer.ts` on top of the shared renderer.

Unchanged — see [03-plan-r2.md step 4](03-plan-r2.md).

### 5. Wire the new factory into bootstrap **and migrate existing direct-constructor tests**.

**5a.** Bootstrap wiring is unchanged — see [03-plan-r2.md step 5](03-plan-r2.md): each of the five `case` branches in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L317-L383) flips to `await WorkerAgent.createWorker<XxxAgent>(ctx, workerInput, role, { onActivity: ... })`.

**5b.** Migrate the four old-shape constructor call sites in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) (new in r3):

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L136): replace

  ```ts
  const agent = new ReviewerAgent(ctx, firstInput);
  ```

  with

  ```ts
  const agent = await WorkerAgent.createWorker<ReviewerAgent>(ctx, firstInput, "reviewer");
  ```

  and ensure the enclosing `it(...)` callback is `async` (it already is, since the test awaits `agent.review(...)`).

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L200): identical change (same line shape, second reviewer test).

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L375): replace

  ```ts
  const agent = new CoderAgent(
    makeReviewerContext(tmpDir, router, { ... }),
    makeWorkerInput("task-1", "Do one thing"),
  );
  ```

  with

  ```ts
  const agent = await WorkerAgent.createWorker<CoderAgent>(
    makeReviewerContext(tmpDir, router, { ... }),
    makeWorkerInput("task-1", "Do one thing"),
    "coder",
  );
  ```

- [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L550): replace

  ```ts
  const agent = new DesignerAgent(
    makeReviewerContext(tmpDir, router2, { ... }),
    input,
  );
  ```

  with

  ```ts
  const agent = await WorkerAgent.createWorker<DesignerAgent>(
    makeReviewerContext(tmpDir, router2, { ... }),
    input,
    "designer",
  );
  ```

- Add `WorkerAgent` to the existing agent import in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts): `import { CoderAgent, DesignerAgent, ManagerAgent, ReviewerAgent, WorkerAgent } from "./...";` (the exact import line uses the same module specifier(s) already in the file; add `WorkerAgent` from `./worker.js` if it is not already pulled in transitively through the subclass imports).

- The four migrated tests pass no `config` and no `onActivity` (none of them currently do); `createWorker`'s 4-arg shape with omitted `config?` matches that. The test bodies (router stubs, MCP runtime stubs, `await agent.review(...)`, `await agent.run()`, expectations on `calls`, `JSON.stringify(...)` contains assertions, etc.) are not modified.

- Reviewer regression at L200 keeps asserting the "no duplicated final assistant message" behaviour ([src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L200)); the `agent.review(...)` calls happen against the `WorkerAgent.createWorker`-built reviewer instance and exercise the same `injectMessage` follow-up path.

### 6. Add tests.

**6a.** Snapshot test for the renderer — unchanged from [03-plan-r2.md step 6a](03-plan-r2.md).

**6b.** Roster cross-check — replace the body in [03-plan-r2.md step 6b](03-plan-r2.md) with:

```ts
import { WORKER_ROLES, getWorkerInitMeta, getRoster } from "./roster.js";
import { hasWorkerCtor } from "./worker.js";

it("every WorkerRole has a workerInit on ROSTER and a registered ctor", async () => {
  // Import once so subclass modules execute their registerWorkerCtor calls.
  await import("./coder.js");
  await import("./researcher.js");
  await import("./designer.js");
  await import("./data-agent.js");
  await import("./reviewer.js");

  for (const role of WORKER_ROLES) {
    const meta = getWorkerInitMeta(role);
    expect(meta.heading).not.toBe("");
    expect(meta.invalidFinalResponseMessage).not.toBe("");
    expect(meta.promptKey).not.toBe("");
    expect(getRoster(role).worker).toBe(true);
    // Per-role ctor registration check; fails the role's assertion specifically.
    expect(hasWorkerCtor(role)).toBe(true);
  }
});

it("non-worker roles have workerInit: null", () => {
  for (const role of ["planner", "manager", "inspector", "chat"] as const) {
    expect(getRoster(role).workerInit).toBeNull();
  }
});
```

The `expect(hasWorkerCtor(role)).toBe(true)` line replaces the r2 `expect(() => WorkerAgent["createWorker"]).toBeDefined()`, which always passed. If a future subclass forgets the trailing `registerWorkerCtor(...)` call, Vitest reports `expected false to be true` against the specific role string from `WORKER_ROLES`.

**6c.** Consumer-level spawner test — carries [03-plan-r2.md step 6c](03-plan-r2.md) and adds one extra case to make ctor registration runtime-fatal as well:

- **Case 4 — every WorkerRole spawns**: with `runtime.runLoop` stubbed to a no-op and `buildEagerBlock` mocked to return `""`, iterate `WORKER_ROLES` and call `await WorkerAgent.createWorker(ctx, fixtureInput, role)` for each. Assert no throw. This catches an unregistered role that somehow eluded 6b (e.g., a subclass file deleted but its `WORKER_ROLES` entry not), and also catches a `getWorkerInitMeta` regression (the call path threads through it).

### 7. Build and run tests (mandatory validation).

```bash
cd /home/salva/g/ml/saivage && pnpm typecheck && pnpm test -- src/agents && pnpm build
```

Expectations:

- `pnpm typecheck` is green. The wrapped-tuple `_EveryWorkerHasInit` anchor in [src/agents/roster.ts](../../../../src/agents/roster.ts) refuses to compile if any `worker: true` entry has `workerInit: null` (or omits the field, which infers `null`). The `Record<WorkerRole, Task["type"]>` typing of `ROLE_TO_TASK_TYPE` in [src/agents/task-report.ts](../../../../src/agents/task-report.ts) refuses to compile if the literal misses a `WorkerRole`.
- `pnpm test -- src/agents` is green. The six new snapshots are committed on first run; the roster cross-check passes for every `WorkerRole`; [src/agents/worker-spawn.test.ts](../../../../src/agents/worker-spawn.test.ts) cases 1–4 pass; the four migrated tests in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) (L136, L200, L375, L550) pass against the new construction API; the remaining agent tests are untouched and pass.
- `pnpm build` (tsup) is green.

### 8. Grep verifications (mandatory; amended).

```bash
cd /home/salva/g/ml/saivage
grep -rn -E "build(Coder|Researcher|Designer|DataAgent|Reviewer)Message" src/ test/  # 0
grep -rn -E "\.(Coder|Researcher|Designer|DataAgent|Reviewer)Agent\.create\b" src/ test/  # 0
grep -rn -E "new (Coder|Researcher|Designer|DataAgent|Reviewer)Agent\(" src/ test/  # 0  (new in r3)
grep -rn "WorkerAgent\.createWorker" src/ test/                                          # 5 in bootstrap.ts + 4 in agents.test.ts + N in worker-spawn.test.ts
grep -rn "if you create review files\.\|if you modify files\." src/agents                # only in src/agents/worker.ts
grep -rn "WorkerAgentConfig" src/ test/                                                  # 0
grep -rn "loadRolePrompt(" src/agents/{coder,researcher,designer,data-agent,reviewer}.ts # 0
grep -n "export type WorkerRole" src/agents/task-report.ts                               # 0  (new in r3 — old declaration deleted)
grep -n "export type { WorkerRole }" src/agents/task-report.ts                           # 1  (new in r3 — re-export)
grep -n "hasWorkerCtor" src/agents                                                        # 1 in worker.ts (export) + 1 in roster.test.ts (use)
```

### 9. Optional live validation (operator-gated; unchanged from r2).

Unchanged — see [03-plan-r2.md step 9](03-plan-r2.md). Local-only mandatory gate; container restarts are operator-gated and cover the three bind-mounted v2 harnesses (`saivage` 10.0.3.111, `diedrico` 10.0.3.113, `saivage-v3` 10.0.3.112) in the order `saivage-v3` → `diedrico` → `saivage`. `saivage-v3-getrich-v2` (10.0.3.170) runs Saivage v3 and is unaffected.

### 10. Validation outputs.

Mandatory:

- `pnpm typecheck` — green; the new wrapped-tuple anchor in [src/agents/roster.ts](../../../../src/agents/roster.ts) and the `Record<WorkerRole, …>` typing in [src/agents/task-report.ts](../../../../src/agents/task-report.ts) both compile.
- `pnpm test -- src/agents` — green; six new snapshots present; roster cross-check passes with `hasWorkerCtor` per role; [src/agents/worker-spawn.test.ts](../../../../src/agents/worker-spawn.test.ts) cases 1–4 pass; the four migrated tests in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) pass.
- `pnpm build` — green.
- Grep verifications in step 8 (including the three new lines) match.

Operator-gated (only if step 9 was exercised): unchanged from [03-plan-r2.md step 10](03-plan-r2.md).

## Rollback

Unchanged from [03-plan-r2.md §Rollback](03-plan-r2.md). The refactor remains a pure source-tree change with no on-disk format / API contract / provider-routing impact. The r3 patches (test migrations, anchor swap, `WorkerRole` re-source) are all reverted by the same `git revert <merge-commit>`.

## Cross-finding

Unchanged from [03-plan-r2.md §Cross-finding](03-plan-r2.md). The r3 patches reinforce the G01 single-source pattern (one canonical `WorkerRole`, one exhaustively-checked `workerInit`, one inspector-backed ctor registry) without expanding scope.
