# G09 - Review r1

Reviewed:
- [SPEC/v2/review-2026-05-round2/G09/01-analysis-r1.md](SPEC/v2/review-2026-05-round2/G09/01-analysis-r1.md#L1-L106)
- [SPEC/v2/review-2026-05-round2/G09/02-design-r1.md](SPEC/v2/review-2026-05-round2/G09/02-design-r1.md#L1-L118)
- [SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md#L1-L135)
- [SPEC/v2/review-2026-05-round2/G09-planner-plan-complete-text-protocol.md](SPEC/v2/review-2026-05-round2/G09-planner-plan-complete-text-protocol.md#L1-L59)

## Summary

Proposal B is the correct architectural direction. Proposal A should remain rejected: hardening the regex preserves the text protocol that this finding is supposed to remove, and it conflicts with the architecture-first/no-backward-compatibility guideline.

The analysis is mostly correct and the plan is close, but round 1 still has correctness and testability blockers. The biggest issue is that the proposed implementation treats `plan_done` as terminal while the current `BaseAgent.runLoop()` does not return to `PlannerAgent` after a tool call.

## Required changes

1. Make `plan_done` terminate on the tool call, not on a later text-only assistant turn.

   [SPEC/v2/review-2026-05-round2/G09/02-design-r1.md](SPEC/v2/review-2026-05-round2/G09/02-design-r1.md#L59-L64) says the runtime detects the `plan_done` call between `runLoop()` iterations, and [SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md#L72-L73) rewrites the existing two-call test as though the second response can be a terminal tool call. In the source, [src/agents/base.ts](src/agents/base.ts#L229-L343) only returns when `response.toolCalls.length === 0`; after a tool call it injects the tool result and loops into another LLM call. [src/agents/planner.ts](src/agents/planner.ts#L70-L116) therefore cannot consume pending completion immediately after the `plan_done` tool_use. As written, completion still depends on an extra text-only assistant turn, and the proposed test will not reach the planner outer loop after call 2.

   Required fix: specify a concrete terminal-tool path. A small focused hook or `runLoop` return condition after successful `plan_done` is fine; a broad terminal-tool framework is not needed. The test must assert that the planner succeeds from the `plan_done` tool call itself and does not require an extra model turn.

2. Pass the live `PlanService` explicitly; do not resolve or recreate it from `mcpRuntime`.

   [SPEC/v2/review-2026-05-round2/G09/02-design-r1.md](SPEC/v2/review-2026-05-round2/G09/02-design-r1.md#L64-L73) says the same `PlanService` instance already exists in the agent context. It does not. [src/server/bootstrap.ts](src/server/bootstrap.ts#L51-L53) owns `planService` on `SaivageRuntime`, and [src/server/bootstrap.ts](src/server/bootstrap.ts#L156-L169) registers that exact instance as the in-process MCP service. But [src/agents/types.ts](src/agents/types.ts#L30-L36) gives agents only `mcpRuntime`, and [src/server/bootstrap.ts](src/server/bootstrap.ts#L484-L498) builds the planner context without `planService`.

   Required fix: either add `planService` to `AgentContext` or pass `runtime.planService` directly through `PlannerAgent.create`/the constructor. The plan must explicitly forbid constructing a second `PlanService` inside `PlannerAgent`, because that would consume a different in-memory completion flag than the MCP dispatcher writes.

3. Make the recovery discriminator structural to `plan_done`, not merely `hasSummary`.

   [SPEC/v2/review-2026-05-round2/G09/02-design-r1.md](SPEC/v2/review-2026-05-round2/G09/02-design-r1.md#L66-L68) correctly says the discriminator should become "did the planner emit a `plan_done` tool_use this run?" The plan then changes the recovery loop to `result.kind === "success" && hasSummary(result.data)` in [SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md#L49-L66). That is not a structural completion check; [src/server/bootstrap.ts](src/server/bootstrap.ts#L825-L827) shows `hasSummary` is just a generic string-shape guard.

   Required fix: have `PlannerAgent` return a distinct completion data shape such as `{ completion: "plan_done", summary: reason }` or `{ kind: "plan_done", reason }`, then make [src/server/bootstrap.ts](src/server/bootstrap.ts#L619-L644) key continuous-improvement restart/termination on that shape. This keeps the new protocol machine-checkable and avoids treating any future planner success summary as project completion.

4. Fix the `plan_done` method type and validate the MCP dispatch path.

   [SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md#L9-L12) specifies `async plan_done(args: { reason: string }): Promise<{ ok: true; recorded: boolean }>` while also saying empty reasons return `planError("VALIDATION_ERROR", ...)`. Source is strict TypeScript per [tsconfig.json](tsconfig.json#L1-L20), and [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L29-L35) already models plan errors as a union.

   Required fix: type `plan_done` as `Promise<{ ok: true; recorded: boolean } | PlanError>` or equivalent. The new validation test should cover both the direct method and [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L367-L408) through `handleToolCall`, so an empty reason is verified to become an MCP error result instead of only a direct return value.

5. Correct the test and validation commands.

   The proposed planner test in [SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md#L72-L75) must be rewritten after required change 1, because a `plan_done` tool call is not currently a `runLoop()` return. The current test context also exposes no plan tools because `getAllTools` returns an empty array in [src/agents/planner.nudge.test.ts](src/agents/planner.nudge.test.ts#L63-L64); the updated test must include a `plan_done` tool schema so the dispatcher can find it and call the stub `mcpRuntime.callTool`.

   The validation command in [SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md#L93-L102) also passes [src/mcp/plan-server.ts](src/mcp/plan-server.ts) to Vitest even though it is a source file, not a test file. Replace that with the actual test file that covers PlanService, or rely on [src/runtime/runtime.test.ts](src/runtime/runtime.test.ts#L348-L510) if that remains the chosen home for PlanService tests.

6. Remove the regex fallback from the rollback section.

   [SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r1.md#L126-L126) suggests a partial rollback that keeps `plan_done` while restoring the old regex fallback. Even as an emergency rollback note, that is a backward-compatible shim and contradicts the stated project rule. Rollback should be a clean revert of this finding's change, not a mixed protocol mode.

## Cross-finding notes

- G07: The claim that `plan_done` retires the compaction marker-loss mode is valid only after required change 1. If completion still waits for a later text-only turn, the design has not fully made the tool call the terminal event.
- G04/G11: The batching note is correct. G09 should be the canonical pattern for removing free-text control protocols, so it needs the structural completion data shape from required change 3.

VERDICT: CHANGES_REQUESTED