# G05 — APPROVED

**Chosen proposal**: Proposal B (refined; per [02-design-r3.md](02-design-r3.md)) — `ROSTER.workerInit` becomes the single owner of worker initial-message metadata; one exported pure `buildInitialMessage` helper; one `WorkerAgent` constructor signature `(ctx, input, role, eagerSkillBlock, initialMessage, config?)` with `WorkerAgent.createWorker<T>(...)` factory; bodyless pure-worker subclasses; reviewer-only override surface; `WORKER_CTORS` is plain ctor wiring; compile-time anchor `[Extract<..., { worker: true; workerInit: null }>] extends [never]` plus runtime per-role `hasWorkerCtor(role)` cross-check; duplicate `WorkerRole` union in `src/agents/task-report.ts` is deleted and imported from `src/agents/roster.ts`.

**Approved by**: GPT-5.5 (copilot) reviewer at round 3 — see [04-review-r3.md](04-review-r3.md). All three r2 changes addressed.

**Implementation pointer**: [03-plan-r3.md](03-plan-r3.md). Includes migration of the four direct-constructor call sites in [src/agents/agents.test.ts](../../../../src/agents/agents.test.ts) to `await WorkerAgent.createWorker<XxxAgent>(...)`, plus a `new ...Agent(` grep gate.

**Daemon impact**: `saivage` (10.0.3.111), `diedrico` (10.0.3.113), `saivage-v3` (10.0.3.112) — all bind-mount the saivage source. `saivage-v3-getrich-v2` (10.0.3.170) unaffected.
