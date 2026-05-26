# G05 - Review r3

## Verdict

Round 3 resolves the three changes requested in [04-review-r2.md](04-review-r2.md). The revised analysis, design, and plan now explicitly cover the existing direct-constructor test migration, make the worker-init and worker-constructor exhaustiveness checks enforceable, and remove the duplicated `WorkerRole` union source from `task-report.ts` by reusing the roster-derived type.

No further changes are required for this finding.

## Verified Changes

1. **Direct-constructor tests are now in scope.** [01-analysis-r3.md](01-analysis-r3.md), [02-design-r3.md](02-design-r3.md), and [03-plan-r3.md](03-plan-r3.md) all identify the four old-shape call sites in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) and plan their migration to `await WorkerAgent.createWorker<XxxAgent>(...)`. The plan also adds a `new ...Agent(` grep gate, so the validation no longer silently assumes those tests remain unchanged.

2. **Exhaustiveness checks are real.** The r2 `Exclude<..., null>` compile anchor is replaced with the wrapped-tuple `Extract<..., { worker: true; workerInit: null }>` guard, which fails typecheck when any worker roster entry keeps `workerInit: null`. The runtime ctor check now exports `hasWorkerCtor(role)` from [src/agents/worker.ts](../../../../src/agents/worker.ts) and asserts it per `WORKER_ROLES` after importing subclass modules for registration side effects. The plan also adds an every-role `createWorker` smoke case, so unregistered roles fail through both the inspector and runtime path.

3. **The duplicated `WorkerRole` source is closed.** [03-plan-r3.md](03-plan-r3.md) step 0 deletes the local union in [src/agents/task-report.ts](../../../../src/agents/task-report.ts), imports `WorkerRole` from [src/agents/roster.ts](../../../../src/agents/roster.ts), and re-exports it for existing consumers. `ROLE_TO_TASK_TYPE` remains where `normalizeTask` uses it, but its key set is now roster-derived, which satisfies the r2 request without forcing unrelated import churn.

## Non-blocking Note

[01-analysis-r3.md](01-analysis-r3.md) opens by saying r2 analysis sections 1-8 are unchanged, then immediately amends section 7. I am not counting this as a required change because the r3 delta list and amended section 7 make the intended correction unambiguous.

## Required Change Count

0

VERDICT: APPROVED