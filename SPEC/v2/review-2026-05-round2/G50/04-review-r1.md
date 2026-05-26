# G50 - Review (Round 1)

## Verdict

Changes requested. The round 1 analysis/design correctly identifies the ownership problem and chooses the right singleton direction, but the implementation plan's regression coverage is not yet strong enough to prove the HTTP request path uses the singleton.

## Findings

1. **The proposed multi-request identity test is not actually a request-path test.**
   Plan section 3.1 reads `runtime.noteManager` twice and then calls `pullDeliverables()` twice on that same reference. That proves the runtime property is stable, but it would still pass if the four `/api/notes*` handlers kept constructing fresh `new NoteManager(runtime.project.paths.notes)` instances. The static grep guard would catch that exact source pattern, but it is not a substitute for the requested multi-request behavioral test. The plan should add a request-level assertion, for example by testing a Fastify app/route factory with a stub `runtime.noteManager`, or by starting the server on an ephemeral port and issuing multiple `/api/notes*` requests, then asserting every notes operation hit the same runtime-owned object.

2. **`AgentContext` propagation is directionally right but under-enumerated.**
   The design correctly threads `NoteManager` through `AgentContext`, and bootstrap's Planner/child-spawner contexts are called out. The live source has additional `AgentContext` literals outside that narrow path: web chat in `src/server/server.ts`, Telegram chat in `src/server/telegram-bot.ts`, the CLI inspector path in `src/server/cli.ts`, and several typed test helpers under `src/agents/*.test.ts`. Because the design says the field is required for every context rather than split into notes/no-notes variants, the plan should explicitly wire or update these sites. Relying on `npm run build` to discover them is useful validation, but the plan should not leave them implicit.

## What Is Solid

- The source inventory is correct. Live `rg -n "NoteManager" src` shows the four HTTP constructions in `src/server/server.ts`, one bootstrap cleanup construction in `src/server/bootstrap.ts`, and one Planner construction in `src/agents/planner.ts`, plus exports/type references and unit-test constructions.
- The analysis correctly identifies `NoteManager.delivered: Set<string>` as shared mutable process state. That makes a runtime-owned singleton the right contract, not just a small allocation cleanup.
- The preferred ownership model is sound: construct one `NoteManager` during bootstrap, expose it on `SaivageRuntime`, pass it through `AgentContext`, use it in Planner's `NoteChannel`, and remove the handler-local constructions directly.
- The plan honors the no-shim/no-backward-compatibility principle: it deletes the redundant `new NoteManager(...)` calls instead of adding lazy global registries or compatibility helpers.
- Bootstrap cleanup is correctly folded onto the same instance, so startup cleanup, HTTP mutations, and Planner delivery state all share one object.

## Test Expectations For Round 2

- Add a real multi-request test that exercises the `/api/notes*` handlers and proves they call `runtime.noteManager`, not a freshly constructed manager.
- Keep the Planner/context identity test, but make it concrete: either assert the context builder copies `runtime.noteManager` by reference, or construct the Planner through the real path and verify its `NoteChannel`/acknowledgment path uses that same manager.
- Keep the static grep guard, preferably matching `new NoteManager(` under `src/` and allowing only `src/server/bootstrap.ts` plus direct `NoteManager` unit tests.

## New-Principles Compliance

The newer principles are not materially applicable here: there is no UI, provider routing, credential, deployment, or runtime-state format change. The relevant workspace principle is the no-shim/no-backward-compatibility rule, and the design follows it.

VERDICT: CHANGES_REQUESTED