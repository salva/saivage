# G50 - Review (Round 2)

## Verdict

Approved. Round 2 resolves the two round-1 blockers: the HTTP regression test now exercises the real request route registration and spies on the runtime-owned manager, and the `AgentContext` propagation audit is explicit enough to keep the implementation from relying on build errors as the only discovery mechanism.

## Findings

No blocking findings.

## Verification Notes

- The HTTP regression test is now a real handler-path test. Design section 4.6 introduces `registerNotesRoutes(app, runtime)`, and design section 7 / plan section 3.1 mount that helper into a Fastify app, drive it with `app.inject(...)`, and attach `vi.spyOn(...)` to the shared `noteManager` instance passed in the runtime stub. A handler that reverted to `new NoteManager(runtime.project.paths.notes)` would not trigger those spies, so the test catches the round-1 failure mode.
- The route coverage is sufficient. The proposed GET case spies on `listNotes`, and the ack/delete/clear case spies on `acknowledgeNote`, `deleteNote`, and `clearNotes`, covering all four `/api/notes*` handlers through the same mounted helper.
- The live `AgentContext` construction audit is complete for the current source. The round-2 analysis enumerates the five production materialisation sites: `createChildSpawner`, `runPlanner`, `/ws` chat, Telegram chat, and CLI inspector. A live source check shows the remaining `AgentContext` mentions are consumers, return types, or helper casts rather than additional production context builders.
- The six typed test helpers are also enumerated: `makeReviewerContext` and `makeChatContext` in `src/agents/agents.test.ts`, `makeContext` in `src/agents/chat.lifecycle.test.ts`, `makePlannerContext` in `src/agents/planner.nudge.test.ts`, the local helper in `src/agents/base.compaction.test.ts`, and `makeContext` in `src/agents/conversation-snapshot.test.ts`.
- Making `AgentContext.noteManager` required is the right compile-fail mechanism. Typed helper literals fail directly, and the untyped `/ws`, Telegram, and CLI inspector literals remain checked when passed to `ChatAgent.create(...)` or `InspectorAgent.create(...)` because those factory signatures require `AgentContext`.

## Non-Blocking Note

The third delivered-set test in design section 7 is weaker than its surrounding prose suggests: `GET /api/notes` does not itself mutate the `delivered` cursor, so that case alone would not prove the HTTP handler uses the singleton. This does not block approval because the first two spy-based `app.inject(...)` tests are explicitly the primary regression guards and do prove the shared-instance route path. During implementation, the delivered-set case can be kept as a supplemental identity check or reworded so it is not mistaken for the route-path proof.

## Approval Basis

Round 2 now gives implementers a concrete helper extraction, a request-level regression test that fails on per-request `NoteManager` construction, a full context wiring list, and a required type contract that catches missed sites. That satisfies the round-1 review expectations without adding compatibility shims or broadening the scope beyond G50.

VERDICT: APPROVED