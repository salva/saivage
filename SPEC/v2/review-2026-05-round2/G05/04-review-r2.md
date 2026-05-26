# G05 - Review r2

## Verdict

Round 2 resolves the broad shape of the round-1 feedback: `WORKER_ROLE_SPECS` is gone, the new worker constructor/rendering API is mostly single-path, a consumer-level spawner test is now planned, and live validation is local-by-default with operator-gated container work. The direction is right.

Changes are still required before approval. The r2 documents leave two compile/test enforcement gaps and one remaining role-source-of-truth gap that undercut the claims made in the deltas.

## Required Changes

1. **Update the existing direct-constructor tests for the new constructor API.** The design removes per-subclass constructors and says the nominal subclasses inherit the new base constructor at [02-design-r2.md](02-design-r2.md#L13-L15), while the plan says existing agent tests remain unchanged and pass at [03-plan-r2.md](03-plan-r2.md#L448). That is not true in the current checkout: [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L136), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L200), [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L375), and [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts#L550) directly instantiate `ReviewerAgent`, `CoderAgent`, and `DesignerAgent` with the old `(ctx, input)` shape.

   The next plan must explicitly migrate those tests to `WorkerAgent.createWorker(...)`, a shared test factory, or the full new constructor signature with fixture `initialMessage` and `eagerSkillBlock`. Otherwise `pnpm test -- src/agents` cannot be the validation gate the plan promises.

2. **Make the worker-init and worker-ctor exhaustiveness checks real.** The design claims the residual `WORKER_CTORS` table is exhaustive-checked at [02-design-r2.md](02-design-r2.md#L11) and [02-design-r2.md](02-design-r2.md#L273). The planned roster test does not verify that: [03-plan-r2.md](03-plan-r2.md#L403-L417) imports the subclass modules, then checks `expect(() => WorkerAgent["createWorker"]).toBeDefined()`, which passes even if `WORKER_CTORS` is empty for every role.

   The compile-time anchor has the same problem. [03-plan-r2.md](03-plan-r2.md#L147-L152) uses `Exclude<..., null> extends WorkerInitMeta`, so a future `worker: true` roster entry with `workerInit: null` is removed from the union before the check and does not fail typecheck. Replace it with a check that the complete worker-entry union extends `{ workerInit: WorkerInitMeta }`, or an explicit `Extract<..., { worker: true; workerInit: null }> extends never` guard. For ctor registration, export a narrow test-only helper such as `hasWorkerCtor(role)`, or exercise `createWorker` per `WORKER_ROLES` with mocked handoff/eager loading so an unregistered role fails.

3. **Close the remaining duplicated `WorkerRole` source, or narrow the single-source claim.** r2 correctly moves worker-init metadata to `ROSTER`, but the proposed worker import block still pulls `type WorkerRole` from [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25) at [03-plan-r2.md](03-plan-r2.md#L168-L171), while [src/agents/roster.ts](../../../../src/agents/roster.ts#L213) already derives `WorkerRole` from `ROSTER`. That leaves the worker role set duplicated exactly where the design claims roster authority.

   The clean fix is to make `task-report.ts` import `WorkerRole` from `roster.ts` and key `ROLE_TO_TASK_TYPE` with that type, or move the default task type into `workerInit` if the intent is truly one worker-role metadata owner. If the writer intentionally wants to leave `ROLE_TO_TASK_TYPE` as a second owner for now, the design should stop saying the worker-role metadata owner count is one.

## Verified Good

- The r1 registry objection is mostly addressed: `workerInit` lives on `ROSTER`, and the residual class map is framed as constructor wiring rather than role metadata.
- The constructor/renderer API is no longer contradictory in the main flow: one exported `buildInitialMessage`, one `WorkerAgent.createWorker`, and bodyless nominal subclasses are now specified.
- The plan adds the required consumer-level coverage around `createChildSpawner`, including normal-worker construction and reviewer stage-cache reuse.
- Live validation is fixed: mandatory validation is local (`pnpm typecheck`, agent tests, build, grep checks), and container restarts are explicitly operator-gated across the three bind-mounted v2 harnesses.

## Required Change Count

3

VERDICT: CHANGES_REQUESTED