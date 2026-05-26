# G09 - Review r4

Reviewed:
- [SPEC/v2/review-2026-05-round2/G09-planner-plan-complete-text-protocol.md](SPEC/v2/review-2026-05-round2/G09-planner-plan-complete-text-protocol.md#L1-L59)
- [SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md](SPEC/v2/review-2026-05-round2/00-SUBSYSTEM-MAP.md#L1-L195)
- [SPEC/v2/review-2026-05-round2/G09/01-analysis-r4.md](SPEC/v2/review-2026-05-round2/G09/01-analysis-r4.md#L1-L196)
- [SPEC/v2/review-2026-05-round2/G09/02-design-r4.md](SPEC/v2/review-2026-05-round2/G09/02-design-r4.md#L1-L340)
- [SPEC/v2/review-2026-05-round2/G09/03-plan-r4.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r4.md#L1-L537)
- [SPEC/v2/review-2026-05-round2/G09/04-review-r1.md](SPEC/v2/review-2026-05-round2/G09/04-review-r1.md#L1-L78), [SPEC/v2/review-2026-05-round2/G09/04-review-r2.md](SPEC/v2/review-2026-05-round2/G09/04-review-r2.md#L1-L58), [SPEC/v2/review-2026-05-round2/G09/04-review-r3.md](SPEC/v2/review-2026-05-round2/G09/04-review-r3.md#L1-L82)
- [src/agents/base.ts](src/agents/base.ts#L221-L346), [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L35-L135), [src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L146-L197), [src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L206), [src/mcp/plan-server.ts](src/mcp/plan-server.ts#L343-L408), [src/agents/planner.ts](src/agents/planner.ts#L30-L116), [src/agents/types.ts](src/agents/types.ts#L30-L56), [src/providers/types.ts](src/providers/types.ts#L17-L48)

## Findings

1. The abort-signal test fixture passes the config object to the wrong `PlannerAgent` parameter.

   [SPEC/v2/review-2026-05-round2/G09/02-design-r4.md](SPEC/v2/review-2026-05-round2/G09/02-design-r4.md#L240-L251) and [SPEC/v2/review-2026-05-round2/G09/03-plan-r4.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r4.md#L376-L379) say to instantiate the planner as `new PlannerAgent(ctx, childSpawner, { abortSignal })` and claim this matches the existing constructor surface. It does not. The static factory accepts `config` as the third argument, but the constructor's third and fourth arguments are `initialMessage` and `eagerSkillBlock`; `config` is fifth ([src/agents/planner.ts](src/agents/planner.ts#L30-L50)). At runtime, that object would be treated as the initial message, and the abort signal would never reach `BaseAgentConfig.abortSignal` ([src/agents/base.ts](src/agents/base.ts#L93-L111), [src/agents/base.ts](src/agents/base.ts#L168-L216)).

   This means the proposed mid-call abort test does not actually exercise the new production gate `this.abortSignal?.aborted || dispatchResult.aborted`. It is the same executability class as the R3 abort-test objection, although R4 has made real progress on the production mechanism. Required change: instantiate through `await PlannerAgent.create(ctx, childSpawner, { abortSignal })`, or call the constructor with explicit initial/eager strings and put the config in the fifth slot, for example `new PlannerAgent(ctx, childSpawner, "", "", { abortSignal })`. Apply that correction consistently in the rewritten planner tests.

2. The promised stale-state regression test is still not the rejected-batch-then-valid-single sequence required by R3.

   R4's analysis correctly states that the reviewer asked for a rejected batched `plan_done` followed by a valid single `plan_done`, with the second reason winning ([SPEC/v2/review-2026-05-round2/G09/01-analysis-r4.md](SPEC/v2/review-2026-05-round2/G09/01-analysis-r4.md#L37-L43); prior requirement at [SPEC/v2/review-2026-05-round2/G09/04-review-r3.md](SPEC/v2/review-2026-05-round2/G09/04-review-r3.md#L17-L25)). But the R4 test plan replaces that with two clean successful planner cycles, one with reason `first` and one with reason `second` ([SPEC/v2/review-2026-05-round2/G09/02-design-r4.md](SPEC/v2/review-2026-05-round2/G09/02-design-r4.md#L261-L262), [SPEC/v2/review-2026-05-round2/G09/03-plan-r4.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r4.md#L394-L400)). The batched tests then go only to text-only nudges and failure ([SPEC/v2/review-2026-05-round2/G09/03-plan-r4.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r4.md#L402-L415)).

   The stateless `PlanService.plan_done` design itself is sound: deleting `pendingCompletion`, `consumePendingCompletion`, and `AgentContext.planService` removes the stale-cell class from the production path, and reading the current `tc.input` only after a non-error result is consistent with the live dispatcher and MCP runtime ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L81-L135), [src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L206)). The validation plan still needs the exact regression that was requested. Required change: add a single planner run where call 1 emits a rejected batch such as `[plan_add_stage, plan_done({ reason: "old" })]`, call 2 emits a single `plan_done({ reason: "new" })`, and the result is `{ completion: "plan_done", summary: "new" }` with two `plan_done` `mcpRuntime.callTool` invocations. That locks in both exclusivity and current-call reason selection after a rejected prior attempt.

## Notes

The core R4 architecture is otherwise aligned with the project rules. Dropping the service-side completion cell is cleaner than R3's shared mutable state, and the proposed post-dispatch check of `this.abortSignal?.aborted || dispatchResult.aborted` is the right live-code surface for abort precedence. The typed hook signature using `ToolCallResult[]` and `DispatchResult` also matches the provider and dispatcher contracts.

## Required changes

1. Fix the planner test construction so `abortSignal` is passed through the actual `PlannerAgent` API and the mid-call abort test exercises [src/agents/base.ts](src/agents/base.ts#L335-L346) for real.
2. Replace or supplement the two-clean-cycle stale-state test with the rejected batched `plan_done` followed by valid single `plan_done` regression described above.

VERDICT: CHANGES_REQUESTED