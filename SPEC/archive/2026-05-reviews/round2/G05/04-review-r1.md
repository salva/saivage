# G05 - Review r1

## Verdict

The analysis is largely correct and the finding is real. The five worker subclasses still repeat the same initial-message skeleton and factory flow, and the commit-clause drift is visible in [src/agents/coder.ts](../../../../src/agents/coder.ts#L69-L70), [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L69-L71), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L68-L69), [src/agents/designer.ts](../../../../src/agents/designer.ts#L70-L71), and [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L89-L93). The analysis also correctly fixes the original issue note's stale claim about reviewer-only handoff behavior: all five current builders call the same `buildHandoffContext(..., includeTasks: true)` shape.

Changes are required before approval. Proposal B can be the right architecture-first answer, but as written it is not yet clean enough to justify the extra blast radius. It claims roster alignment while adding a second worker-spec registry, and the plan leaves the new constructor/rendering API, behavior tests, and live-validation scope too loose.

## Analysis Review

**Correctness.** The source facts match the checkout. The base worker currently receives pre-rendered strings through `WorkerAgentConfig` at [src/agents/worker.ts](../../../../src/agents/worker.ts#L30-L48), while each subclass owns its own `static create`, `loadRolePrompt`, `buildEagerBlock`, and `buildXxxMessage` path at [src/agents/coder.ts](../../../../src/agents/coder.ts#L16-L50), [src/agents/researcher.ts](../../../../src/agents/researcher.ts#L16-L50), [src/agents/data-agent.ts](../../../../src/agents/data-agent.ts#L15-L49), [src/agents/designer.ts](../../../../src/agents/designer.ts#L16-L50), and [src/agents/reviewer.ts](../../../../src/agents/reviewer.ts#L18-L66). The duplicated factory call sites are indeed centralized in bootstrap today at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L318-L379).

**Completeness.** The analysis properly scopes manager/planner/inspector/chat out of the initial-message refactor. It also identifies that `ROLE_TO_TASK_TYPE` already owns the role-to-task default at [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25-L35), which matters for avoiding another copy in the new renderer.

**Design framing.** Proposal A is a solid focused fix. Proposal B is directionally reasonable only if it truly reduces the number of role metadata owners. The current text does not yet meet that bar.

## Required Changes

1. **Do not introduce `WORKER_ROLE_SPECS` as a second role registry while claiming roster-as-source-of-truth.** The design says the roster gains role-spec authority at [02-design-r1.md](02-design-r1.md#L103), and later says B aligns with the G01-G04 roster pattern at [02-design-r1.md](02-design-r1.md#L176-L184). The plan then creates a separate `WORKER_ROLE_SPECS` registry that "slots cleanly next to `ROSTER`" at [03-plan-r1.md](03-plan-r1.md#L49-L53) and [03-plan-r1.md](03-plan-r1.md#L84-L85). That is the same drift shape G01 is trying to eliminate, not a completion of it.

   The next round should choose one clear contract. Either put the worker message/factory metadata on `ROSTER` itself, or add roster accessors that derive the spec from fields owned by `ROSTER`. If the writer keeps a separate registry, then Proposal B should stop claiming roster alignment and should probably lose to Proposal A on simplicity. This also needs cross-finding coordination with approved G01, which explicitly subsumes G02-G04 through roster-derived helpers in [../G01/APPROVED.md](../G01/APPROVED.md#L5). Today the code already has multiple role metadata owners: roster fields at [src/agents/roster.ts](../../../../src/agents/roster.ts#L33-L40), worker entries at [src/agents/roster.ts](../../../../src/agents/roster.ts#L79-L167), and a separate `WorkerRole` plus `ROLE_TO_TASK_TYPE` table at [src/agents/task-report.ts](../../../../src/agents/task-report.ts#L25-L35). B must reduce that count, not add another table.

2. **Make the new `WorkerRoleSpec` / constructor / renderer API internally consistent and compile-checkable.** The design says `WorkerAgent`'s constructor simplifies to `(ctx, input, spec, config?)` with no positional `initialMessage` or `eagerSkillBlock` plumbing at [02-design-r1.md](02-design-r1.md#L101-L103). The same design's `ctor` type is `new (ctx, input, spec, config?) => WorkerAgent` at [02-design-r1.md](02-design-r1.md#L109-L117), but the file-edits section calls `new spec.ctor(ctx, input, spec, eagerSkillBlock, initialMessage)` at [02-design-r1.md](02-design-r1.md#L126-L129). The plan then defines yet another constructor shape with `eagerSkillBlock` and `initialMessage` before `config` at [03-plan-r1.md](03-plan-r1.md#L9-L14). It also says `buildInitialMessage` is colocated and plain `async function` at [03-plan-r1.md](03-plan-r1.md#L12), but reviewer follow-up imports it from `./worker.js` at [03-plan-r1.md](03-plan-r1.md#L31-L34), while the design also calls it non-exported/protected at [02-design-r1.md](02-design-r1.md#L101-L102) and [02-design-r1.md](02-design-r1.md#L129-L135).

   The next round needs a single exact API: one `WorkerRoleSpec` type, one constructor signature, one exported or protected renderer entry point, and one reviewer follow-up call that TypeScript can actually compile. If empty nominal subclasses remain, the plan must state whether they rely on the inherited base constructor or define explicit constructors. Do not leave this as an implementation guess.

3. **Add behavior coverage for the factory/bootstrap change, not only renderer snapshots and a registry existence test.** The proposed snapshots at [03-plan-r1.md](03-plan-r1.md#L44-L48) prove the string renderer. The roster/spec cross-check at [03-plan-r1.md](03-plan-r1.md#L49-L53) proves a table has entries. Neither proves that the runtime constructs the right subclass, preserves `onActivity`, normalizes worker task types, or keeps reviewer session reuse working after replacing all five `XxxAgent.create(...)` calls in bootstrap at [03-plan-r1.md](03-plan-r1.md#L36-L40).

   Add at least one consumer-level test around `WorkerAgent.createWorker` or `createChildSpawner`. It should cover a normal worker and the reviewer branch, because reviewer has the stage cache at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L284-L368) and a special `agent instanceof ReviewerAgent ? agent.review(...) : agent.run()` path at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L402-L403). This is the behavioral surface Proposal B changes; a golden snapshot of `buildInitialMessage` is not enough.

4. **Fix live-validation and rollback scope.** The plan tells the implementer to restart `saivage.service` on the harness and dispatch a live task at [03-plan-r1.md](03-plan-r1.md#L61-L73). That is too casual for a source change under [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L318-L379) and [src/agents/worker.ts](../../../../src/agents/worker.ts#L30-L48). The `saivage` source is loaded by multiple v2 deployments, and G01's approved deployment note names `saivage`, `diedrico`, and `saivage-v3` as affected bind-mounted v2 harnesses at [../G01/APPROVED.md](../G01/APPROVED.md#L9). The workspace guidance also requires reading the handoff before changing Saivage deployments or runtime state.

   The next plan should either keep validation local by default (`typecheck`, targeted tests, full agent tests, build), or make live validation explicitly operator-gated and cover every affected v2 harness with service/mount checks and health probes. Do not document a single-container restart/dispatch as the normal validation path. The rollback section at [03-plan-r1.md](03-plan-r1.md#L77-L81) should carry the same deployment boundary.

## Verified Good

- The analysis correctly treats the message builder duplication as internal refactor surface, not a public API compatibility problem.
- Proposal A is a good fallback if Proposal B remains registry-heavy. It removes the duplicated body while preserving the current worker lifecycle boundary at [02-design-r1.md](02-design-r1.md#L14-L85).
- The no-backward-compat posture is respected: the writer proposes deletion of old builders/factories rather than aliases or shims at [02-design-r1.md](02-design-r1.md#L147-L153).
- The validation sweep includes the right local commands, especially `pnpm typecheck`, `pnpm test -- src/agents`, `pnpm build`, and grep checks for removed builders/factories at [03-plan-r1.md](03-plan-r1.md#L65-L72). Those should stay after the live-validation scope is fixed.

## Required Change Count

4

VERDICT: CHANGES_REQUESTED