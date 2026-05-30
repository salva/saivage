# G45 — Design r2

Round: 2 (writer: Claude Opus 4.7).
Prereq: [01-analysis-r2.md](./01-analysis-r2.md).
Prior round: [02-design-r1.md](./02-design-r1.md), [04-review-r1.md](./04-review-r1.md).

## Round-2 deltas vs r1

- Corrected the `ServerOptions` claim (finding 2 of review r1): the doc should render the parameter as **optional** (`options?: ServerOptions`) with the in-source default annotated, because [src/server/server.ts](../../../../src/server/server.ts#L52-L55) gives the parameter a defaulted value and TypeDoc treats it as optional at the call site.
- Refreshed source anchors throughout against the current checkout (return shape now at [src/server/server.ts](../../../../src/server/server.ts#L723-L727); runtime shutdown closure now at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245); child-spawner now at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L281-L287)).
- The structural recommendation (Proposal A: manual rewrite) stands; review r1 explicitly accepted it.

## Goals

- The `SaivageRuntime` interface block, the `startServer` signature, and the "Graceful shutdown" section in [docs/internals/server.md](../../../../docs/internals/server.md) must describe the code that actually exists in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [src/server/server.ts](../../../../src/server/server.ts), and [src/server/cli.ts](../../../../src/server/cli.ts).
- Layer ownership of every shutdown step must be unambiguous: the doc must answer "who calls this step?" correctly without further reading.
- Architecture-first, no backward compat: if a doc structure encourages the same drift to recur, change the structure rather than re-syncing the same prose for the fourth time.
- No new code unless it pays for itself in this finding plus G40 / G44.

## Non-goals

- Reorganising the rest of [docs/internals/server.md](../../../../docs/internals/server.md) (Static assets, Routes, etc. are correct).
- Touching the `start` / `serve` / `inspect` runtime behaviour. G45 is a docs finding only.
- Building a generic VitePress plugin to ingest TS for arbitrary symbols — bounded scope, not a platform.

## Proposal A — Manual rewrite, no shims

Edit [docs/internals/server.md](../../../../docs/internals/server.md) in place so the three fictional sections match reality, then stop. Concretely:

1. Replace the `interface SaivageRuntime { … }` block at [docs/internals/server.md](../../../../docs/internals/server.md#L26-L36) with the verbatim text of the interface in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66) (13 fields with their JSDoc comments summarised). Add a sentence explicitly noting that the field annotations come from the source.
2. Replace the `startServer` signature at [docs/internals/server.md](../../../../docs/internals/server.md#L42-L50) with the real one. The parameter must be rendered as optional with the in-source default annotated:

   ```ts
   function startServer(
     runtime: SaivageRuntime,
     options?: ServerOptions, // defaults to { port: 8080, host: "0.0.0.0" }
   ): Promise<{ close: () => Promise<void> }>;
   ```

   Add a one-liner noting that the only method on the returned object is `close`; `stop` does not exist and code that calls `stop` will either throw a TypeError or, with optional chaining, silently leak the Fastify socket.
3. Rewrite the "Graceful shutdown" section ([docs/internals/server.md](../../../../docs/internals/server.md#L70-L80)) into two subsections:
   - "CLI-driven teardown (`serve` command)" — five steps as actually performed at [src/server/cli.ts](../../../../src/server/cli.ts#L351-L386), explicitly naming `serve` as the owner.
   - "`runtime.shutdown()`" — the seven steps from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L229-L245), with a note that `start` and `inspect` use this directly and never touch Fastify or Telegram.
4. Drop the `spawn: ChildSpawner` line entirely; mention in prose that the child-spawner is constructed by the free function `createChildSpawner(runtime)` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L281-L287) and is not stored on the runtime object.
5. Remove the fictional `abort(reason)` mention; do not replace it. (The dispatcher's abort plumbing already has its own page at [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md).)
6. Correct the persisted status: the doc must say the final on-disk status is `"idle"`, with a cross-link to [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md) for the runtime-state schema. Do not pretend `"stopped"` exists.

Pros:

- Smallest diff. Zero new code. Lowest risk of side effects.
- Solves the immediate harm.
- Trivially reviewable.

Cons:

- This is the third manual re-sync of the same kind of doc in one review round. Nothing prevents the fourth.
- Future contributors must remember to update both the markdown and the TS when `SaivageRuntime` changes; the linter/CI does not catch it.

## Proposal B — Auto-render the interface, narrative stays manual

Replace the duplicated TS block with a build-time injection from the real source file. Keep the prose, the lifecycle description, and the section structure manual. Concretely:

1. Add a tiny VitePress markdown loader (or a `tsup`-time markdown preprocessor — same effect) that recognises a directive of the form

   ```
   <!-- saivage:ts-snippet src=src/server/bootstrap.ts symbol=SaivageRuntime -->
   ```

   and, at docs-build time, replaces the line with a fenced `ts` code block extracted from the TS file. Implementation: parse the named file with the project's existing TypeScript compiler API (not a brace-matching regex) and emit the bracketed body. No persistent generated file on disk; the snippet lives only in the built site.

2. Use the directive for `SaivageRuntime`, `ServerOptions`, and the `startServer` declaration line in `docs/internals/server.md`. The same directive can be applied to G40 / G44 to close the recurrence in one move.

3. Rewrite the "Graceful shutdown" section manually as in Proposal A — narrative ordering and ownership claims are not auto-derivable from the TS and should stay editorial.

4. Add a docs lint that fails the build if a directive points at a missing symbol or file, so a TS rename surfaces immediately in `npm run docs:build`.

Pros:

- Architectural fix: the duplicated TS-in-markdown surface goes away, which is what the recurrence pattern argues for.
- Per the project rule "remove obsolete code rather than keep shims", this *removes* a class of hand-copied snippets rather than re-syncing them.
- Amortises across G40 / G44; the third occurrence is what pays for the tool.
- The build-time lint converts future drift from a silent landmine into a CI failure.

Cons:

- New code in the docs build path: ~80–150 lines of TS in `docs/.vitepress/`.
- The TS-parsing helper must handle the realistic shapes used in `bootstrap.ts` (interface with JSDoc comments, exported types).
- The G45 issue itself is medium severity and could be closed with Proposal A alone; the level-up only pays if we also use it for G40 / G44.

## Recommendation: Proposal A, with the level-up tracked as a separate batched finding

Reasoning:

- G45 is a documentation-drift finding. The smallest correct doc rewrite is the most reviewer-vetted and lowest-risk fix and closes the actual harm — readers see truthful prose immediately.
- The recurrence argument (Proposal B) is real and important, but it is not specific to G45; it spans G40 / G44 / G45. The right design move is to land the docs-corrective fix here and open (or attach to) a single batched "auto-render TS-in-markdown" plan that handles all three together. Bundling the tool into G45 would expand its blast radius beyond what the finding describes and would let G40 / G44 stay broken while the tool is built.
- Project rules forbid migration shims and reward removing duplicated structure, but they also forbid over-engineering: building the auto-render tool *inside* a medium-severity docs fix is over-scope. Better to keep G45 surgical and queue Proposal B as its own design under the review-round metaplan.

If the metaplan reviewer disagrees and wants the auto-render landed first, swap to Proposal B and apply the same content edits *through* the directive. Either way, the prose corrections from §3 below are required.

## Final shape after Proposal A

Section-by-section of the new [docs/internals/server.md](../../../../docs/internals/server.md):

- "Bootstrap" prose stays. Step 3 of the bullet list keeps `EventBus`, `ModelRouter`, `McpRuntime`, `NoteManager`, `Recovery`, `Supervisor`; add `PlanService`, `PlannerControl`, `RuntimeTracker` — they are constructed in `bootstrap` too. Drop the `ChildSpawner` bullet (it is not constructed in bootstrap; it is built on demand by `createChildSpawner` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L281-L287)).
- The TS interface block is replaced by the 13-field interface from [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66), in source order, with the JSDoc comments preserved.
- The `startServer` block is replaced by the real signature: `options?: ServerOptions` (defaulted in source), returning `{ close: () => Promise<void> }`.
- A new short paragraph names the two CLI entry points that long-run vs one-shot: `serve` (long-running, calls `startServer` + `runPlannerWithRecovery`) and `start` (one-shot, calls `runPlanner`). The doc currently conflates the two.
- "Graceful shutdown" splits into "CLI-driven teardown" (the five-step `serve` sequence) and "`runtime.shutdown()`" (the seven-step closure). Each step cites the file + line where it lives.
- Final status persisted is `"idle"`. Sentence appended: "There is no `"stopped"` runtime status; see [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md) for the full state machine."

## Risks and how to control them

- Risk: rewriting "Graceful shutdown" subtly contradicts [docs/internals/supervisor.md](../../../../docs/internals/supervisor.md) or [docs/internals/abort-recovery.md](../../../../docs/internals/abort-recovery.md). Control: grep both files for `runtime.shutdown` / `stop the supervisor` / `runtime status` and reconcile any contradictions in the same PR.
- Risk: copying JSDoc comments out of `bootstrap.ts` into markdown is the exact failure mode that produced G45. Control: keep comments minimal in the doc and end the section with "Authoritative source: [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L47-L66) — open the file rather than rely on this block if they ever diverge."
- Risk: the doc as published references docs anchors (`./supervisor#shutdown-handoff`, etc.). Control: rebuild VitePress locally (`npm run docs:build`) and confirm no broken links before submitting.

## Acceptance criteria

- The three sections cited in G45 (interface block, `startServer` signature, graceful-shutdown list) match the real TS at the cited line numbers when the PR lands.
- No field on the runtime block is missing from `SaivageRuntime` in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) and vice versa.
- The shutdown section explicitly attributes each step to either the CLI command (`serve`) or `runtime.shutdown`.
- `npm run docs:build` passes.
- The grep gate in the plan (covering both `runtime.<dotted-field>` references and the literal stale TS field declarations) returns zero matches against the rewritten file.
