# F34 r2 — Analysis

## Changes from r1

- Reversed cross-issue ordering to land **after** F22, consistent with approved F22 ([SPEC/v2/review-2026-05/F22/01-analysis-r2.md](SPEC/v2/review-2026-05/F22/01-analysis-r2.md#L202), [SPEC/v2/review-2026-05/F22/02-design-r2.md](SPEC/v2/review-2026-05/F22/02-design-r2.md#L149), [SPEC/v2/review-2026-05/F22/03-plan-r2.md](SPEC/v2/review-2026-05/F22/03-plan-r2.md#L11-L13)). F34 r1's claim that F34 must precede F22 contradicted the approved F22 contract and is withdrawn.
- Re-framed the contract section against the post-F22 `documents.ts` (async) and `PlanService` shape (async methods, `init()` method, no `ensureDir` in the constructor).
- Tightened constraint #2 (atomicity contract): the relevant invariant after F22 is the async tmp+rename+fsync in [src/store/documents.ts](src/store/documents.ts) as rewritten by F22's step 1.

The substantive problem statement, evidence, and call-site inventory are unchanged: this is a writer/scope revision driven by ordering, not by new findings.

## Problem restated

`PlanService` re-reads `plan.json` and `plan-history.json` from disk on every single tool invocation, with no in-memory cache. Its `mutationQueue` serialises mutating tool calls but does not gate reads: read tools bypass the queue entirely.

Concrete read-per-call sites in the current source ([src/mcp/plan-server.ts](src/mcp/plan-server.ts)):

- `plan_get` reads plan.json — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L81-L85).
- `plan_get_stage` reads plan.json AND history.json — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L88-L105).
- `plan_get_current_stage` reads plan.json — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L108-L113).
- Every mutating tool also begins with a `readDocOrNull` (e.g. `plan_add_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L141-L143), `plan_remove_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L161-L163), `plan_set_current` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L179-L181), `plan_complete_stage` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L205-L207), `plan_get_history` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L257-L258)).
- `handleToolCall` only routes mutators through `serializeMutation`; readers fall straight through to `handleToolCallInner` — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L298-L309).
- `isMutatingPlanTool` enumerates only the seven write tools — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L522-L530).

Read primitives used: `readDocOrNull` (existsSync + readFileSync + JSON.parse + Zod) — [src/store/documents.ts](src/store/documents.ts#L30-L36); writes use atomic tmp+rename — [src/store/documents.ts](src/store/documents.ts#L60-L96).

## Why this is wrong

Two distinct defects:

1. **Re-read per call.** Every plan tool re-parses both JSON files. With history accumulating, `plan_get_stage` parses both documents to look up a single ID. The planner agent calls `plan_get` / `plan_get_current_stage` on every reasoning step. Multiply by the number of concurrent worker MCP sessions and by the per-call overhead of `readFile` + `JSON.parse` + Zod parse against a multi-KB history document.

2. **Reads bypass `mutationQueue`.** The queue serialises mutating tool calls so they execute in source order; reads do not enter the queue. After F22 lands, `writeDoc` is async and a queued mutation no longer completes atomically within a single Node tick — its sequence of `await open / writeFile / sync / close / rename / open / sync / close` interleaves with any concurrent read that arrived before the await chain completed. Two real failure modes appear:
   - **Read-after-write ordering**: a `plan_get` that arrived after a queued `plan_set_stages` but before that mutation's `await writeDoc` finishes will return the pre-mutation state. The MCP contract today implicitly guarantees in-order semantics because everything is sync; once writes are async, the queue must gate reads to preserve it.
   - **Stale-window observability**: while a mutator awaits `writeDoc`, it has read and mutated an in-memory copy of the plan but has not yet committed it; a concurrent read sees the on-disk pre-state. There is no transactional snapshot — the read sees neither "before" nor "after" relative to the in-flight mutation in any defined way.

3. **Cross-document non-atomicity.** `plan_get_stage` reads plan.json then history.json as two separate awaits. A `plan_complete_stage` between them writes plan.json first, then history.json — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L242-L244). A reader interleaved with completion can see a stage absent from both (race: read plan after completion's plan write, read history before completion's history write).

## Contract (post-F22)

`PlanService` is the single in-process owner of `plan.json` and `plan-history.json` for one project. Construction at [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L63-L68) is a no-IO assignment after F22's step 11: `ensureDir` moves out of the constructor into a new `async init(): Promise<void>` invoked once from `bootstrap`. Exposed via `handleToolCall(name, args) -> { content, isError }` plus the direct method surface (used by `recovery.ts`); after F22 every public method is `async`.

- Input: tool name (eleven supported) + JSON args matching `getToolSchemas()`.
- Output: typed `Plan` / `Stage` / `PlanHistory` / `CompletedStage` / `PlanError`, returned as a `Promise<...>`.
- Side effects: atomic JSON writes via `await writeDoc(...)` to `plan.json` and `plan-history.json`, archival via `archiveStage` on completion, git commits via injected `gitCommitFn`.
- Lifecycle: instantiated once per project in `bootstrap.ts`, `init()` awaited at construction time, reused for the process lifetime.

## Call sites & dependencies

- Construction and tool registration: [src/server/bootstrap.ts](src/server/bootstrap.ts#L148-L162). Post-F22 this site is `const planService = new PlanService(...); await planService.init();`.
- Direct use of `planService.plan_get()` outside the MCP envelope: [src/runtime/recovery.ts](src/runtime/recovery.ts#L206). Post-F22 this becomes `await planService.plan_get()` because the method is async.
- Re-exported as public API: [src/index.ts](src/index.ts#L78).
- Tests: `src/mcp/plan-server.test.ts` (exists; relies on disk file inspection between calls). F22's step 15 has already converted these to async `it` callbacks.
- Web UI: `web/src/` issues plan REST/WS calls to the server, which dispatch into `planService.handleToolCall`. Web has no direct file access.

External writers to `plan.json`: in principle git checkouts can rewrite the file (e.g. branch switch). Today that is not a supported operation while the agent is running, and `PlanService` does not watch the file.

## Constraints any solution must respect

1. **Single-owner-per-process** is already true (one `PlanService` per project, instantiated in bootstrap). No need to design for cross-process consistency.
2. **Atomic writes must remain**: post-F22 `writeDoc` is async with tmp+rename+fsync+dir-fsync; F34 only touches the read path and the in-process cache. It must not weaken writes.
3. **History must be appended atomically with plan changes in `plan_complete_stage`**: the current code does two separate `writeDoc` calls — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L242-L244). Cross-document atomicity at the disk layer is out of scope for F34 (would need a single combined document or a journal); F34 must, at minimum, make in-memory views snapshot-consistent across the two documents.
4. **Architecture-first**: no transitional `if (cache) ... else readFromDisk` shim. The cache replaces the disk-read path entirely; reads no longer touch disk after `init()`.
5. **No external writers** to `plan.json` / `plan-history.json` while the service is running. The cache can be populated once at `init()` and stay authoritative; the design must not pretend otherwise (no fs watchers, no re-validation).
6. **Out of scope**: the `skills/` and `memory/` archival side effect inside `plan_complete_stage` (calls `archiveStage`) — [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L249-L253). Per `_LOOP-CONVENTIONS.md` boundaries we leave that call untouched.
7. **Related issues** the fix must respect:
   - **F22 (sync fs) lands first.** F34 targets the post-F22 async `documents.ts` and `PlanService.init()` shape. It does NOT convert writes to async itself — F22 already did. F34 only swaps the bodies from `await readDocOrNull(...)` to in-memory cache access, and wraps reads (in addition to writes) through the queue.
   - F08 (legacy mirror): unrelated mirror in `recovery.ts`, untouched here.
   - F12 (MCP magic coupling): no constants changed.
