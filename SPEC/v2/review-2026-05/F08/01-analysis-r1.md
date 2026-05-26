# F08 — Analysis (r1)

## Problem restated

`writeRuntimeState` writes the runtime state document twice on every call: once to the SPEC-current path `paths.runtimeState` (`<project>/.saivage/tmp/state/runtime.json`), then a second time to a legacy mirror at `<project>/.saivage/runtime/runtime-state.json`. The mirror is a pure write — no production code path reads it. The duplication is locked in only by a single unit-test assertion plus an apologetic paragraph inside the planner system prompt that documents the mirror as a "compatibility" artefact.

Concretely:

- Dual-write body: [src/runtime/recovery.ts](src/runtime/recovery.ts#L297-L307).
- Path-derivation helper: [src/runtime/recovery.ts](src/runtime/recovery.ts#L309-L315).
- Sole test that pins the dual-write in place: [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1026-L1043).
- Planner system-prompt paragraph that explains the mirror to the LLM: [src/agents/planner.ts](src/agents/planner.ts#L47).

`writeRuntimeState` is called every time an agent ticks (worker started, worker stopped, worker activity heartbeat, stage change). The mirror therefore doubles disk traffic on what is already the busiest write path in the runtime: each `writeDoc` performs `writeFileSync` + `fsyncSync(fd)` + `renameSync` + `fsyncSync(parentDir)` ([src/store/documents.ts](src/store/documents.ts#L63-L97)). The dual-write turns one such sequence into two, on the synchronous Node event loop, on every agent activity event.

## Actual differences

The two destinations carry the same bytes — `writeDoc(path, state, RuntimeStateSchema)` followed by `writeDoc(legacyPath, state, RuntimeStateSchema)`. There is no schema drift, no field difference, no "the legacy one had this old shape" complication. The mirror is byte-identical to the primary file as long as the primary write succeeds; if the primary write throws, the mirror is not written (because the throw happens before the second call).

The only semantic asymmetry is the path: the SPEC-current path lives under `tmp/state/` (alongside `shutdown-request.json` and `shutdown-summary.json`, see [src/store/project.ts](src/store/project.ts#L74-L76)); the mirror lives directly under `.saivage/runtime/`, a directory that has no other purpose and would not exist at all if the mirror were dropped.

## Contract

`writeRuntimeState(path: string, state: RuntimeState): void`

- **Input**: the project's canonical runtime-state path (always `paths.runtimeState`) and a fully-formed `RuntimeState` (validated by `RuntimeStateSchema` in [src/types.ts](src/types.ts)).
- **Output**: nothing; throws if either underlying `writeDoc` rejects the input or fails to land on disk.
- **Side-effect (current)**: writes to `path`; if `path` ends in `tmp/state/runtime.json`, additionally writes the same payload to `<saivageDir>/runtime/runtime-state.json`. The second write is silently skipped for any other shape of `path` (e.g. test-only `runtime.json` at the temp-dir root, see [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L1045-L1053) where `tracker = new RuntimeTracker(statePath)` is given a flat path).
- **Side-effect (target)**: writes to `path` only.
- **Error mode**: any `writeDoc` failure propagates; no retry; the runtime tracker swallows nothing.

## Call sites & dependencies

Writers of `writeRuntimeState` — all paths feed `paths.runtimeState`, i.e. the dual-write branch:

- [src/server/bootstrap.ts](src/server/bootstrap.ts#L199) — initial state write at startup.
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L235) — final "idle" write on graceful shutdown.
- [src/server/bootstrap.ts](src/server/bootstrap.ts#L688) — failure-state write on planner crash.
- [src/runtime/recovery.ts](src/runtime/recovery.ts#L402) — `RuntimeTracker.flush()`, the hot-path writer driven by `agentStarted`/`agentStopped`/`agentActivity`/`setCurrentStage`.

`RuntimeTracker.flush()` is itself driven from [src/server/bootstrap.ts](src/server/bootstrap.ts#L298-L487) on every per-agent `onActivity` callback, every stage switch, and every spawner start/stop.

Readers of `paths.runtimeState` (primary path) — all consume it via `paths.runtimeState`, never via a hardcoded `runtime/runtime-state.json` literal:

- [src/runtime/recovery.ts](src/runtime/recovery.ts#L47-L48) — `isAnotherInstanceRunning`.
- [src/runtime/recovery.ts](src/runtime/recovery.ts#L183) — `recoverFromCrash` reading the prior state.
- [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L38) — `readOptionalDoc(project.paths.runtimeState, …)`.
- [src/server/server.ts](src/server/server.ts#L129), [src/server/server.ts](src/server/server.ts#L181), [src/server/server.ts](src/server/server.ts#L475-L498) — three HTTP endpoints.
- [src/server/cli.ts](src/server/cli.ts#L143) — `saivage status`.
- [src/agents/chat.ts](src/agents/chat.ts#L347) — chat agent surfacing live agent state.

Readers of the legacy mirror `<saivageDir>/runtime/runtime-state.json`:

- None in `src/`. Confirmed by `rg -n 'runtime-state\.json' --type ts` returning only the writer (`recovery.ts`), the test (`runtime.test.ts`), and the planner-prompt mention (`planner.ts`).
- The web UI fetches runtime state via `/api/status` ([src/server/server.ts](src/server/server.ts#L475-L498)), which reads `paths.runtimeState` — not the mirror.

Schemas constraining the document:

- `RuntimeStateSchema` in [src/types.ts](src/types.ts) — applies identically to both paths; deleting the mirror does not require any schema change.

## Constraints any solution must respect

1. **Architecture-first, no backward compat.** The mirror and everything that exists only because of it (helper function, asserting test, planner-prompt paragraph) is deleted in the same change. No fallback "if mirror exists, read it once and migrate" code is added.
2. **Hot-path semantics unchanged.** `writeRuntimeState` is still synchronous (moving `documents.ts` to `fs/promises` is F22's problem). The primary write must still happen with `writeDoc`'s atomic + fsynced semantics — durability of the primary file is the whole reason crash recovery works.
3. **No leftover-cleanup shim.** If a deployed project has a pre-existing `<saivageDir>/runtime/runtime-state.json` on disk from prior runs, it stays there as an orphan file. We do not add a transitional "delete the old file on startup" step — that is itself a backward-compat shim. Operators who care can `rm -rf .saivage/runtime/`.
4. **Test surface stays meaningful.** The asserting test is removed, not rewritten to assert the negation (a test that asserts "the mirror is **not** written" would be defending a deletion forever, which is over-engineering). Other tests that assert `writeRuntimeState` to a non-`tmp/state/runtime.json` path keep working because the helper currently no-ops for those paths anyway.
5. **Out-of-scope boundaries.** The mention in the planner prompt is in scope (it exists to explain the mirror). The wider system-prompt bloat problem is F18; we don't touch other parts of the prompt. Skills/memory paths are not affected — F08 lives entirely inside the runtime subsystem.
6. **Cross-issue contract.** F22 (sync fs) cites F08 as the "doubles the fsync cost" amplifier; deleting the mirror halves the per-tick fsync count and reduces F22's symptom severity but does not solve F22. F06 (dispatcher notes side-channel) and F24 (shutdown handoff delete-on-read) are independent. F08 must not preempt F22's eventual move to async I/O, nor F24's rework of shutdown summary lifecycle.
