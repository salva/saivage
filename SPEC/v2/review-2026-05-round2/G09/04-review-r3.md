# G09 - Review r3

Reviewed:
- [SPEC/v2/review-2026-05-round2/G09-planner-plan-complete-text-protocol.md](SPEC/v2/review-2026-05-round2/G09-planner-plan-complete-text-protocol.md#L1-L59)
- [SPEC/v2/review-2026-05-round2/G09/01-analysis-r3.md](SPEC/v2/review-2026-05-round2/G09/01-analysis-r3.md#L1-L82)
- [SPEC/v2/review-2026-05-round2/G09/02-design-r3.md](SPEC/v2/review-2026-05-round2/G09/02-design-r3.md#L1-L244)
- [SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L1-L473)
- [SPEC/v2/review-2026-05-round2/G09/04-review-r2.md](SPEC/v2/review-2026-05-round2/G09/04-review-r2.md#L1-L58)

## Summary

R3 fixes the main R2 direction on paper: the terminal hook is exclusive, the hook runs after the current abort-result branch, the planner consumes `pendingCompletion` on accepted success, and the legacy-token grep is now executable by constructing the negative-test token via concatenation.

I still cannot approve it. The remaining issues are narrower than R2, but they are protocol-correctness issues rather than wording issues: rejected `plan_done` batches can leave stale completion state behind, the abort test does not match the live dispatcher and private `BaseAgent` wiring, and the proposed test stub does not reproduce `McpRuntime.callTool` error semantics.

## Required changes

1. Clear or prevent stale `pendingCompletion` for rejected `plan_done` batches, not only for accepted success.

   R3 consumes the PlanService cell only after the override accepts a single successful `plan_done` batch in [SPEC/v2/review-2026-05-round2/G09/02-design-r3.md](SPEC/v2/review-2026-05-round2/G09/02-design-r3.md#L102-L121) and [SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L161-L179). But R3 also explicitly says that when the hook returns `null`, the cell "stays as-written by MCP for the next iteration to observe" in [SPEC/v2/review-2026-05-round2/G09/01-analysis-r3.md](SPEC/v2/review-2026-05-round2/G09/01-analysis-r3.md#L64).

   That leaves the exact stale-state class R2 was trying to remove. In the live dispatcher, local tools are executed before dispatch tools and before the final result array is returned ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L81-L135)). So a response like `[plan_add_stage, plan_done]` or `[plan_done, run_manager]` can execute `plan_done`, set `pendingCompletion`, then be rejected by the exclusivity hook because `toolCalls.length !== 1`. On the next turn, a single `plan_done` call can return `{ ok: true, recorded: false }` because the stale cell is still occupied; the hook does not inspect the result payload, consumes the old reason, and terminates on stale state. The same pollution can happen for duplicate `plan_done` calls in one batch or for any aborted path that returns before the hook consumes.

   Required fix: make non-terminal `plan_done` attempts cleanup-safe. Either do not record `pendingCompletion` until the terminal batch is accepted, or have the planner clear the PlanService cell for every rejected batch containing `plan_done` before continuing. The accepted terminal path must also prove the consumed completion belongs to the current tool call, for example by requiring the current dispatch result to represent a fresh record (`recorded: true`) or by carrying enough identity to avoid consuming an old pending reason. Add tests where a rejected batched `plan_done` is followed by a valid single `plan_done`; the second run must use the second reason and must not see `recorded: false` from stale state.

2. Make abort precedence real in the source and make the test executable against that source.

   R3 preserves the existing `if (dispatchResult.aborted)` check before the terminal hook in [SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L130-L146). That is necessary, but not sufficient against the current implementation. `BaseAgent.runLoop()` checks the abort signal at the top of the loop and after dispatch only looks at `dispatchResult.aborted` ([src/agents/base.ts](src/agents/base.ts#L229-L346)). The dispatcher sets `aborted = true` for local calls only when the signal is already aborted before that local call runs ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L93-L101)); the dispatch-tool abort branch returns an error result but does not set the `aborted` flag before returning ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L122-L135)).

   That means the proposed abort-first rule is still partly advisory. A signal that flips after a successful local `plan_done` but before the terminal hook can still be beaten by `tool_terminal` unless `runLoop` re-checks the actual abort signal after dispatch. Also, the proposed test in [SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L383-L390) says to use a pre-aborted signal or a stub dispatcher. A pre-aborted signal returns before the LLM call at [src/agents/base.ts](src/agents/base.ts#L229-L234), so it does not exercise terminal-tool ordering at all. A stub dispatcher is not a real seam: `BaseAgent` owns a private dispatcher field and constructs it internally ([src/agents/base.ts](src/agents/base.ts#L144-L181)).

   Required fix: update the design and plan so abort precedence is enforced by the actual code path, not only by `dispatchResult.aborted`. At minimum, `runLoop` should check `this.abortSignal?.aborted || dispatchResult.aborted` after pushing the tool results and before returning any terminal tool. If the design relies on `DispatchResult.aborted`, then the dispatcher must also set that flag for dispatch-tool abort returns. Replace the proposed abort test with an executable one, such as an in-process tool stub that flips the shared abort signal during `callTool`, or a focused `BaseAgent` subclass test that reaches post-dispatch terminal detection through public/protected seams.

3. Make the planner test stub match real `McpRuntime.callTool` error semantics.

   The R3 test fixture wires `mcpRuntime.callTool` to return `planService.plan_done(args)` directly in [SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L323-L325). The real runtime does not behave that way. For in-process services, `McpRuntime.callTool()` calls the registered handler, throws when the handler returns `isError`, and otherwise returns only `result.content` ([src/mcp/runtime.ts](src/mcp/runtime.ts#L168-L206)). The dispatcher then catches thrown tool errors and marks the tool result as `isError: true` ([src/runtime/dispatcher.ts](src/runtime/dispatcher.ts#L146-L197)).

   With the R3 stub, an empty reason returns a `PlanError` object as a successful callTool result, so the dispatcher will JSON-stringify it with `isError: false`. That contradicts the test comment in [SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L377-L380) and weakens the errored-`plan_done` regression. The test may still fail to terminate because the input reason is empty, but it is no longer proving the dispatch-result error branch that R2 asked for.

   Required fix: either instantiate a real `McpRuntime`, register the real `PlanService` in-process, and let `Dispatcher` exercise the production call path, or make the stub mirror production exactly: call `planService.handleToolCall()`, throw on `isError`, and return `content` on success. Then assert that the dispatch result for an empty reason is actually errored, not merely non-terminal by accident.

4. Fix the TypeScript hook signature and the PlanService import constraint.

   The hook snippets type tool-call inputs as `Record<string, unknown>` in [SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L113-L123) and [SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L161-L179). The live provider type has `ToolCallResult.input: unknown` ([src/providers/types.ts](src/providers/types.ts#L40-L48)), and `response.toolCalls` is a `ToolCallResult[]`. Passing it into a method that requires `Record<string, unknown>` will not type-check cleanly under the current strict project. The hook should accept the actual `ToolCallResult[]` type and narrow `tc.input` before reading `reason`.

   There is also an internal contradiction in the test plan: step 5 says no file under [src/agents](src/agents) may import or construct `PlanService` ([SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L103)), but step 14 imports and constructs it in [src/agents/planner.nudge.test.ts](src/agents/planner.nudge.test.ts) ([SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md](SPEC/v2/review-2026-05-round2/G09/03-plan-r3.md#L304-L325)). Either scope the constraint to production agent files, move the fixture to a non-agent test helper, or use a real `McpRuntime` fixture that keeps PlanService construction outside [src/agents](src/agents).

## Notes

The direction remains correct: no regex fallback, tagged `{ completion: "plan_done", summary }`, structural recovery discrimination, prompt cleanup, dashboard formatter, and a zero-match legacy-token grep are all aligned with the architecture-first/no-backward-compatibility rule. After the four fixes above, this should be close to approvable.

VERDICT: CHANGES_REQUESTED