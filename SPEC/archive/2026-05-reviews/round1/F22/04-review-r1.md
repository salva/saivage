# F22 — Document Store Sync FS — Review r1

## Reviewer

`GPT-5.5 (copilot)`

## Documents reviewed

- [SPEC/v2/review-2026-05/F22-documents-store-sync-fs.md](SPEC/v2/review-2026-05/F22-documents-store-sync-fs.md)
- [SPEC/v2/review-2026-05/F22/01-analysis-r1.md](01-analysis-r1.md)
- [SPEC/v2/review-2026-05/F22/02-design-r1.md](02-design-r1.md)
- [SPEC/v2/review-2026-05/F22/03-plan-r1.md](03-plan-r1.md)
- Spot-checks: [src/store/documents.ts](src/store/documents.ts), [src/server/server.ts](src/server/server.ts), plus caller greps for document-store consumers and async cascade points.

## Findings

### Analysis

The core diagnosis is correct: [src/store/documents.ts](src/store/documents.ts#L9-L156) is fully synchronous, and high-fan-out HTTP handlers still combine document helpers with direct `node:fs` sync calls in [src/server/server.ts](src/server/server.ts#L295-L662). The analysis also correctly identifies that async conversion is not just a store-module rewrite; it affects runtime state writes, chat persistence, notes, plan tools, project initialization/loading, and tests.

However, the caller inventory is not complete enough to support the recommended full async conversion. The public barrel re-exports the document-store functions in [src/index.ts](src/index.ts#L25-L34), so this is also a public API shape change. More importantly, making [src/store/project.ts](src/store/project.ts#L51-L127) async cascades into bootstrap and the CLI, with direct call sites at [src/server/bootstrap.ts](src/server/bootstrap.ts#L111-L117) and many CLI commands such as [src/server/cli.ts](src/server/cli.ts#L68), [src/server/cli.ts](src/server/cli.ts#L133-L141), [src/server/cli.ts](src/server/cli.ts#L181), [src/server/cli.ts](src/server/cli.ts#L221), [src/server/cli.ts](src/server/cli.ts#L303), [src/server/cli.ts](src/server/cli.ts#L430), and [src/server/cli.ts](src/server/cli.ts#L506). Those are not just incidental; without updating them, `ProjectContext` becomes a `Promise<ProjectContext>` at runtime.

The out-of-scope knowledge interaction is understated. The analysis says the async `writeDoc` impact is two call sites in [src/knowledge/store.ts](src/knowledge/store.ts#L222-L383), but those calls sit inside `writeRecordAtomic` and `rebuildIndex`, which are called repeatedly from [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L117-L628). Adding `await` there is not a one-line signature-compatible touch; either those knowledge APIs become async and cascade through the skills/memory subsystem, or the design must choose a different boundary. Fire-and-forget promises inside `writeRecordAtomic`/`rebuildIndex` would break the atomicity/error contract.

### Design

Proposal A is directionally the right end state, and rejecting a permanent mixed sync/async store API is consistent with the project guideline against parallel old/new paths. The runtime-state coalescing queue is also a necessary design element once writes become asynchronous.

The design contains factual API errors in the notes surface: it lists `NoteManager.createNote` and `loadNote` in [SPEC/v2/review-2026-05/F22/02-design-r1.md](SPEC/v2/review-2026-05/F22/02-design-r1.md#L19), but the code has standalone `createUserNote` in [src/runtime/notes.ts](src/runtime/notes.ts#L30) and no `loadNote`; the relevant class methods include `getUnacknowledgedNotes`, `peekUnacknowledgedNotes`, `getPermanentNotes`, `acknowledgeNotes`, and `cleanupStaleNotes` in [src/runtime/notes.ts](src/runtime/notes.ts#L69-L217). Their callers include [src/agents/planner.ts](src/agents/planner.ts#L204-L257), [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L317), [src/server/bootstrap.ts](src/server/bootstrap.ts#L185), [src/agents/chat.ts](src/agents/chat.ts#L315-L465), and [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L26). This is enough of a mismatch that an implementer would not have a reliable edit map.

The design also treats the knowledge touch as "only required" at two awaited `writeDoc` calls in [SPEC/v2/review-2026-05/F22/02-design-r1.md](02-design-r1.md#L26-L40). That is factually wrong for an awaited async store and conflicts with the out-of-scope boundary. The design must either explicitly block F22 on skills/memory approval for the full async cascade, or propose a clean architecture-level boundary that keeps knowledge-store signatures coherent without preserving a duplicate document-store API.

### Plan

The plan is not executable as written because it leaves several nontrivial sync contracts unresolved:

- `buildHandoffContext` is synchronous in [src/agents/handoff.ts](src/agents/handoff.ts#L18), but it reads documents and is called while building constructor `initialMessage` strings across planner/manager/worker agents, for example [src/agents/planner.ts](src/agents/planner.ts#L289), [src/agents/manager.ts](src/agents/manager.ts#L372), [src/agents/coder.ts](src/agents/coder.ts#L249), [src/agents/researcher.ts](src/agents/researcher.ts#L245), [src/agents/reviewer.ts](src/agents/reviewer.ts#L186), [src/agents/designer.ts](src/agents/designer.ts#L176), [src/agents/data-agent.ts](src/agents/data-agent.ts#L159), and [src/agents/inspector.ts](src/agents/inspector.ts#L204). "Make it async and cascade await" is not enough because class constructors cannot `await` before `super`; the plan needs a concrete construction pattern.
- `writeRuntimeState` is called from the fatal handler at [src/server/bootstrap.ts](src/server/bootstrap.ts#L688-L700). If it becomes async, the current synchronous try/catch no longer guarantees the error state is flushed before `setImmediate(() => process.exit(1))`. The plan mentions the normal awaited writes at [SPEC/v2/review-2026-05/F22/03-plan-r1.md](SPEC/v2/review-2026-05/F22/03-plan-r1.md#L109-L112), but it does not address this special path.
- Shutdown handoff functions read/write/delete documents in [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L22-L85), and bootstrap/CLI currently call them synchronously at [src/server/bootstrap.ts](src/server/bootstrap.ts#L226-L255) and [src/server/cli.ts](src/server/cli.ts#L221-L229). The plan says the exported functions become async, but does not enumerate these required awaits or the test updates beyond a broad note.
- The `PlanService` constructor still calls `ensureDir` synchronously in [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L58-L72). The plan leaves this as "hoist to a static factory or lazy init" in [SPEC/v2/review-2026-05/F22/03-plan-r1.md](SPEC/v2/review-2026-05/F22/03-plan-r1.md#L101) rather than choosing one concrete edit path and updating [src/server/bootstrap.ts](src/server/bootstrap.ts#L148-L155).

## Required changes

1. Revise the caller inventory and plan to include all direct and cascaded consumers affected by async `documents.ts`: public barrel exports, `store/project` callers in bootstrap and CLI, shutdown handoff, fatal runtime-state write, `buildHandoffContext` agent-constructor usage, notes/urgent-note paths, and the relevant tests.

2. Replace the "two one-line awaits" knowledge claim with a real boundary decision. Either coordinate and plan the async cascade through `writeRecordAtomic`, `rebuildIndex`, and `src/knowledge/lifecycle.ts`, or choose an architecture-first alternative that keeps that out-of-scope subsystem coherent without unawaited writes or a permanent duplicate document-store API.

3. Correct the notes API facts: use `createUserNote`, remove nonexistent `NoteManager.createNote`/`loadNote`, and include `getUnacknowledgedNotes`, `peekUnacknowledgedNotes`, `getPermanentNotes`, `acknowledgeNotes`, `cleanupStaleNotes`, `scanForUrgentNotes`, their callers, and their tests in the async migration plan.

4. Make the nontrivial async construction paths concrete: pick the `PlanService` init/factory shape, define how agent handoff context is produced before superclass construction, and define how fatal-handler runtime-state persistence behaves when the write API returns a promise.

5. Expand the validation list to include the tests the current plan misses or underweights: [src/store/project.test.ts](src/store/project.test.ts), [src/knowledge/store.test.ts](src/knowledge/store.test.ts), [src/knowledge/integration.test.ts](src/knowledge/integration.test.ts), [src/runtime/shutdown-handoff.test.ts](src/runtime/shutdown-handoff.test.ts), and focused CLI/bootstrap coverage if no existing tests exercise the async project-loading commands.

## Strengths

- The issue severity and main event-loop risk are well supported by the current sync implementation.
- Proposal A correctly preserves the tmp-write/rename/fsync durability contract and avoids a permanent sync/async split in the main document-store API.
- The proposed `RuntimeTracker` coalescer is the right kind of small abstraction: it addresses a real ordering/backpressure problem created by async writes without turning the store into a larger framework.

VERDICT: CHANGES_REQUESTED