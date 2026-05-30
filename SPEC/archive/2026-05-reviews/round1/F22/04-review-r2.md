# F22 — Document Store Sync FS — Review r2

## Reviewer

`GPT-5.5 (copilot)`

## Documents reviewed

- [SPEC/v2/review-2026-05/F22-documents-store-sync-fs.md](SPEC/v2/review-2026-05/F22-documents-store-sync-fs.md)
- [SPEC/v2/review-2026-05/F22/04-review-r1.md](SPEC/v2/review-2026-05/F22/04-review-r1.md)
- [SPEC/v2/review-2026-05/F22/01-analysis-r2.md](SPEC/v2/review-2026-05/F22/01-analysis-r2.md)
- [SPEC/v2/review-2026-05/F22/02-design-r2.md](SPEC/v2/review-2026-05/F22/02-design-r2.md)
- [SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md)
- Spot-checks: [src/store/documents.ts](src/store/documents.ts), [src/store/project.ts](src/store/project.ts), [src/server/cli.ts](src/server/cli.ts), [src/server/bootstrap.ts](src/server/bootstrap.ts), [src/runtime/notes.ts](src/runtime/notes.ts), [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts), [src/runtime/recovery.ts](src/runtime/recovery.ts), [src/agents/handoff.ts](src/agents/handoff.ts), [src/mcp/plan-server.ts](src/mcp/plan-server.ts), [src/knowledge/store.ts](src/knowledge/store.ts), [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts).

## Findings

### Analysis

The r2 analysis resolves the r1 factual gaps. The core store diagnosis still matches the code: [src/store/documents.ts](src/store/documents.ts#L8-L17) imports only synchronous filesystem primitives, and `writeDoc` still does tmp-write, file fsync, rename, and parent-directory fsync synchronously in [src/store/documents.ts](src/store/documents.ts#L59-L84). The expanded caller inventory correctly includes the public barrel exports in [src/index.ts](src/index.ts#L25-L34), the project-store functions in [src/store/project.ts](src/store/project.ts#L51-L127), and the CLI/bootstrap cascade through [src/server/cli.ts](src/server/cli.ts#L68-L506) and [src/server/bootstrap.ts](src/server/bootstrap.ts#L111-L255).

The notes API is now accurate. The actual free function is `createUserNote` in [src/runtime/notes.ts](src/runtime/notes.ts#L30-L47), and the `NoteManager` surface named in r2 matches [src/runtime/notes.ts](src/runtime/notes.ts#L69-L217). The caller spot-check also matches: chat and MCP create notes at [src/agents/chat.ts](src/agents/chat.ts#L315) / [src/agents/chat.ts](src/agents/chat.ts#L465) and [src/mcp/notes-server.ts](src/mcp/notes-server.ts#L26), planner consumes/acknowledges at [src/agents/planner.ts](src/agents/planner.ts#L204-L257), dispatcher peeks at [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L317), and bootstrap cleans up at [src/server/bootstrap.ts](src/server/bootstrap.ts#L185).

The shutdown and fatal-handler inventory is also correct. The three handoff exports in [src/runtime/shutdown-handoff.ts](src/runtime/shutdown-handoff.ts#L22-L99) are all document-store consumers, and the bootstrap/CLI callers are the ones r2 lists: [src/server/bootstrap.ts](src/server/bootstrap.ts#L226-L255) and [src/server/cli.ts](src/server/cli.ts#L229). The fatal handler in [src/server/bootstrap.ts](src/server/bootstrap.ts#L674-L703) is a real non-awaitable path and deserves the explicit escape hatch.

The knowledge boundary is now framed honestly. Spot-checking found the two `documents.ts`-backed write/ensure sites in [src/knowledge/store.ts](src/knowledge/store.ts#L248-L250) and [src/knowledge/store.ts](src/knowledge/store.ts#L414), plus the lifecycle wrappers/callers in [src/knowledge/lifecycle.ts](src/knowledge/lifecycle.ts#L117-L628). One sentence says "nine" `writeRecordAtomic` lifecycle sites while enumerating ten; the enumeration itself is complete, so this is editorial rather than a blocking factual gap.

### Design

Proposal A is now concrete enough to hand to an implementer. It keeps the architecture-first rule intact by converting the existing document-store names rather than introducing `readDocSync`/`writeDocSync`, and it explicitly accepts the public API shape change from [src/index.ts](src/index.ts#L25-L34). The r1 blockers around `PlanService`, `buildHandoffContext`, notes, shutdown handoff, the fatal handler, and the knowledge boundary all have chosen designs rather than placeholders.

The agent-construction design is the right answer to the `await`-before-`super()` problem. `buildHandoffContext` is currently synchronous in [src/agents/handoff.ts](src/agents/handoff.ts#L18-L78) and is called from the pre-`super()` message builders in planner/manager/worker agents, for example [src/agents/planner.ts](src/agents/planner.ts#L168-L188), [src/agents/manager.ts](src/agents/manager.ts#L372), and [src/agents/coder.ts](src/agents/coder.ts#L249). Static async factories are a small mechanical adaptation rather than a new abstraction layer.

The cross-team knowledge handshake is acceptable under the review constraints. It does not pretend a fire-and-forget promise would preserve `writeRecordAtomic`'s atomicity contract, and it does not add a permanent duplicate document-store API. It correctly makes F22 contingent on skills/memory sign-off instead of silently crossing the out-of-scope boundary.

### Plan

The r2 plan is executable. It enumerates the direct conversion of [src/store/documents.ts](src/store/documents.ts), the project-store and CLI awaits, the bootstrap updates, `RuntimeTracker` coalescing in [src/runtime/recovery.ts](src/runtime/recovery.ts#L299-L411), async notes, async shutdown handoff, async handoff-context construction, `PlanService.init()` for [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L65-L70), server-route async I/O, and the relevant tests.

Two implementation notes are worth carrying forward, but neither requires another writer round. First, after `PlanService` methods become async, `recoverFromCrash` must also await its `planService.plan_get()` call in [src/runtime/recovery.ts](src/runtime/recovery.ts#L190-L194); this follows from the plan's step 11 and TypeScript will catch it. Second, one fatal-handler note still mentions `initProjectTree` as if its seed writes stay sync, while step 2 clearly converts [src/store/project.ts](src/store/project.ts#L139-L174) to `fs/promises`; treat that as an editorial leftover.

The validation list is now broad enough for the blast radius: document-store and project-store tests, runtime/shutdown handoff, agent construction, knowledge store/integration tests, and full type/build checks. The optional smoke/fatal-handler probes are appropriately marked optional.

## Required changes

None.

## Strengths

- The r2 documents directly address every r1 required change without adding compatibility shims or a split sync/async API.
- The chosen design handles the genuinely awkward spots (`buildHandoffContext`, `RuntimeTracker`, `PlanService`, fatal handlers) with small, local mechanisms.
- The knowledge-subsystem boundary is explicit and prevents the most dangerous failure mode: unawaited writes inside the atomic record path.

VERDICT: APPROVED
