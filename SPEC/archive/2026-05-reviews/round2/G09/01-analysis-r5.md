# G09 — Analysis r5

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**r4 docs**: [./01-analysis-r4.md](./01-analysis-r4.md), [./02-design-r4.md](./02-design-r4.md), [./03-plan-r4.md](./03-plan-r4.md)
**r4 review**: [./04-review-r4.md](./04-review-r4.md) (CHANGES_REQUESTED, 2 narrow test changes; core architecture approved-equivalent)

The r4 architecture is accepted by the reviewer ([./04-review-r4.md](./04-review-r4.md#L19-L21)): stateless [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) `plan_done`, dropped `AgentContext.planService` ([src/agents/types.ts](../../../../src/agents/types.ts#L30-L56)), post-dispatch `this.abortSignal?.aborted || dispatchResult.aborted` gate in [src/agents/base.ts](../../../../src/agents/base.ts#L335-L346), and a typed hook signature using `ToolCallResult[]` ([src/providers/types.ts](../../../../src/providers/types.ts#L17-L48)) and `DispatchResult` ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L35-L40)). r5 only addresses the two narrow test issues from [./04-review-r4.md](./04-review-r4.md#L25-L28).

## r5 deltas vs r4

- §A NEW (replaces r4 §C/§3.2 test-construction guidance). Fix the `PlannerAgent` test instantiation. r4 says `new PlannerAgent(ctx, childSpawner, { abortSignal })` ([./02-design-r4.md](./02-design-r4.md#L240-L251), [./03-plan-r4.md](./03-plan-r4.md#L376-L379)). The current constructor signature in [src/agents/planner.ts](../../../../src/agents/planner.ts#L45-L50) is `(ctx, childSpawner, initialMessage, eagerSkillBlock, config?)`, so the config object is silently bound to `initialMessage` and `abortSignal` never reaches `BaseAgentConfig.abortSignal` at [src/agents/base.ts](../../../../src/agents/base.ts#L93-L111). r5 uses the async factory `PlannerAgent.create(ctx, childSpawner, { abortSignal })` at [src/agents/planner.ts](../../../../src/agents/planner.ts#L31-L43) consistently in every rewritten test, so the abort-mid-call regression actually exercises the post-dispatch gate at [src/agents/base.ts](../../../../src/agents/base.ts#L335-L346).
- §B NEW (replaces r4 §A's two-clean-cycle stale-state regression). Drop the r4 "second cycle uses the second reason" test ([./02-design-r4.md](./02-design-r4.md#L261-L262), [./03-plan-r4.md](./03-plan-r4.md#L394-L400)) — it is two clean planner runs and does not exercise the rejected-batch path the reviewer required in r3 and re-required in r4 ([./04-review-r3.md](./04-review-r3.md#L17-L25), [./04-review-r4.md](./04-review-r4.md#L17-L21)). Replace it with a single-`planner.run()` regression where call 1 emits a rejected batch `[plan_add_stage, plan_done({ reason: "old" })]` and call 2 emits a single `plan_done({ reason: "new" })`; result is `{ completion: "plan_done", summary: "new" }` and the stub `mcpRuntime.callTool` is invoked twice for `plan_done`. This locks in both single-call exclusivity AND current-call reason selection after a rejected prior attempt — exactly the contract called out at [./04-review-r4.md](./04-review-r4.md#L20-L21).

Every other element of [./01-analysis-r4.md](./01-analysis-r4.md), [./02-design-r4.md](./02-design-r4.md), and [./03-plan-r4.md](./03-plan-r4.md) is retained verbatim.

## A. Why the r4 planner test construction is invalid

The reviewer's first required change ([./04-review-r4.md](./04-review-r4.md#L11-L15)) is correct on the literal types. The relevant code in [src/agents/planner.ts](../../../../src/agents/planner.ts#L30-L50) defines two surfaces:

```ts
static async create(
  ctx: AgentContext,
  childSpawner: ChildSpawner,
  config?: Partial<BaseAgentConfig>,
): Promise<PlannerAgent> {
  const initialMessage = await buildPlannerMessage(ctx);
  const eagerSkillBlock = await buildEagerBlock(
    ctx.project.projectRoot,
    "planner",
    "Strategic planning and stage dispatch",
  );
  return new PlannerAgent(ctx, childSpawner, initialMessage, eagerSkillBlock, config);
}

constructor(
  ctx: AgentContext,
  childSpawner: ChildSpawner,
  initialMessage: string,
  eagerSkillBlock: string,
  config?: Partial<BaseAgentConfig>,
) { ... }
```

`config` is the THIRD argument to the async factory and the FIFTH argument to the constructor. r4's `new PlannerAgent(ctx, childSpawner, { abortSignal })` ([./02-design-r4.md](./02-design-r4.md#L240-L251), [./03-plan-r4.md](./03-plan-r4.md#L376-L379)) binds `{ abortSignal }` to `initialMessage`, leaves `eagerSkillBlock` undefined, and never populates `BaseAgentConfig.abortSignal` ([src/agents/base.ts](../../../../src/agents/base.ts#L93-L111), [src/agents/base.ts](../../../../src/agents/base.ts#L168-L216)). The mid-call abort regression in r4 test 6 ([./03-plan-r4.md](./03-plan-r4.md#L447-L465)) therefore does not exercise the new live-signal gate at [src/agents/base.ts](../../../../src/agents/base.ts#L335-L346) — it would either crash (TypeScript strict typing on `string`) or, if cast, fall through to the standard tool-terminal path.

r5 fixes this by going through the async factory in every test that needs an `abortSignal`:

```ts
const { ctx, abortSignal } = makePlannerContext(tmpDir, router);
const planner = await PlannerAgent.create(ctx, childSpawner, { abortSignal });
```

The factory at [src/agents/planner.ts](../../../../src/agents/planner.ts#L31-L43) builds the real `initialMessage` and `eagerSkillBlock` from the test fixture (`ctx.project.projectRoot` is a `tmpDir` under the test's `mkdtempSync`, with `.saivage/` materialised by `ensureDir` in the existing `makePlannerContext`). `buildPlannerMessage` and `buildEagerBlock` read project state from that directory; they do not require any extra wiring beyond what `makePlannerContext` already produces.

The constructor-style alternative `new PlannerAgent(ctx, childSpawner, "", "", { abortSignal })` is also valid per the reviewer ([./04-review-r4.md](./04-review-r4.md#L15-L15)) and matches the production constructor positionally; r5 prefers the factory because it is the same path the real bootstrap uses ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) constructs planners via the async factory), so tests exercise the same `initialMessage` / `eagerSkillBlock` plumbing that production does.

The fix applies CONSISTENTLY to every test that constructs a `PlannerAgent` in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts), not just the abort-mid-call test. The existing F14 test at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L77-L153) already uses a synchronous construction pattern that must be migrated to `await PlannerAgent.create(...)` as part of this fix.

## B. Why the rejected-batch-then-valid-single regression is the actual contract

The reviewer's second required change ([./04-review-r4.md](./04-review-r4.md#L17-L21)) is correct: r4's "second cycle uses the second reason" test ([./02-design-r4.md](./02-design-r4.md#L261-L262), [./03-plan-r4.md](./03-plan-r4.md#L394-L400)) runs two clean, separate planner cycles with one `plan_done` each and asserts the second `summary` is `"second"`. That asserts only that two separate constructions of `PlannerAgent` do not share state — which is trivially true once `AgentContext.planService` is dropped (r4 §A, [./01-analysis-r4.md](./01-analysis-r4.md#L17-L18)) — and exercises NEITHER the exclusivity hook nor the post-rejection current-call selection.

The exact contract called out in [./04-review-r3.md](./04-review-r3.md#L17-L25) and re-required in [./04-review-r4.md](./04-review-r4.md#L20-L21) is a SINGLE planner run with two router turns:

- **Turn 1 (router call 1)**: `toolCalls = [plan_add_stage(valid), plan_done({ reason: "old" })]`, `finishReason: "tool_use"`. The dispatcher executes both — `plan_add_stage` returns `{ ok: true }`, `plan_done` validates and returns `{ ok: true }` (validation passes because `reason` is non-empty trimmed). The override at [src/agents/planner.ts](../../../../src/agents/planner.ts) (the one r4 added at §2.2 of [./02-design-r4.md](./02-design-r4.md#L195-L233)) checks `toolCalls.length !== 1` and returns `null`. `runLoop` does NOT take the terminal branch; the iteration continues.
- **Turn 2 (router call 2)**: `toolCalls = [plan_done({ reason: "new" })]`, `finishReason: "tool_use"`. The override sees `toolCalls.length === 1`, the dispatch result is non-errored, and reads `tc.input.reason === "new"`. `runLoop` returns `finishReason: "tool_terminal"` with `terminal.data = { reason: "new" }`. The planner's outer loop in [src/agents/planner.ts](../../../../src/agents/planner.ts#L70-L116) returns `{ kind: "success", data: { completion: "plan_done", summary: "new" } }`.

What this test locks in:

- **Exclusivity** on `plan_done` (the override's `toolCalls.length !== 1` guard at [./02-design-r4.md](./02-design-r4.md#L199-L201)). A batched `plan_done` does NOT terminate, regardless of whether the dispatched `plan_done` validated successfully on its own.
- **Current-call reason selection after a rejected prior attempt**. The model's first `plan_done` had `reason: "old"`. The successful, observable `summary` is `"new"` — i.e. r4's design that the override reads `tc.input.reason` from the CURRENT call (not from any earlier turn) is exercised end-to-end. If a future refactor accidentally read `reason` from a prior turn, the dispatch history, or a shared cell, this test fails with `summary === "old"`.
- **Two `mcpRuntime.callTool` invocations for `plan_done`**, one per turn. Stub instrumentation counts calls so any future short-circuit that skipped the second MCP call (e.g. dedup by reason, or a cached completion) is caught.

This test SUBSUMES r4's two-clean-cycle test for the stale-state contract: if a single `PlannerAgent` does not carry rejected-batch state across its own turns, then a fortiori two independent `PlannerAgent` instances do not share state. r5 therefore replaces (not supplements) the r4 test.

The legacy-token regression test (r4 test 7 at [./03-plan-r4.md](./03-plan-r4.md#L476-L482)), the F14 invariant test (r4 test 8 at [./03-plan-r4.md](./03-plan-r4.md#L484-L492)), the dispatcher-error-conversion test (r4 test 5 at [./03-plan-r4.md](./03-plan-r4.md#L437-L445)), and the abort-mid-call test (r4 test 6 at [./03-plan-r4.md](./03-plan-r4.md#L447-L465), with the §A construction fix applied) are retained verbatim.

## C. r4 claims that survive r5 unchanged

- The stateless `PlanService.plan_done` in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) (r4 §1 of [./02-design-r4.md](./02-design-r4.md#L40-L48)) with `{ ok: true } | PlanError` return type.
- The dropped `AgentContext.planService` ([src/agents/types.ts](../../../../src/agents/types.ts#L30-L56)) and the dropped step-5 "no PlanService import under [src/agents](../../../../src/agents)" constraint ([./01-analysis-r4.md](./01-analysis-r4.md#L80-L82)).
- The post-dispatch `this.abortSignal?.aborted || dispatchResult.aborted` gate in [src/agents/base.ts](../../../../src/agents/base.ts#L335-L346) (r4 §2.1 of [./02-design-r4.md](./02-design-r4.md#L57-L88)).
- The typed `detectTerminalToolCall(toolCalls: ToolCallResult[], dispatchResult: DispatchResult)` hook on `BaseAgent` and the `PlannerAgent` override that narrows `tc.input` from `unknown` and matches results by `toolUseId` (r4 §D.1 of [./01-analysis-r4.md](./01-analysis-r4.md#L100-L132)).
- The `mcpRuntime.callTool` stub that throws on validation failure (mirrors [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L206), caught by [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197)) and returns content on success (r4 §C of [./01-analysis-r4.md](./01-analysis-r4.md#L66-L77)).
- The legacy-token concatenation rule `const LEGACY_TOKEN = "PLAN_" + "COMPLETE"` and the `grep -rn PLAN_COMPLETE src/ prompts/` post-condition (r3 §C, retained at [./01-analysis-r4.md](./01-analysis-r4.md#L143-L144)).
- Prompt rewrites in [prompts/planner.md](../../../../prompts/planner.md) and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L525-L549), recovery-loop discriminator `isPlanDoneCompletion`, dashboard formatter entry in [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts), and `plan_done` in `PLAN_TOOLS` at [src/agents/base.ts](../../../../src/agents/base.ts#L1084-L1089).

## D. Validation surface (forward-looking; full contract in Plan r5)

- `npx tsc --noEmit` (strict): every `PlannerAgent` construction in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) uses `await PlannerAgent.create(...)`. The previously-broken `new PlannerAgent(ctx, childSpawner, { abortSignal })` shape would fail strict typing (`{ abortSignal: ... }` is not assignable to `string`), so the fix is type-required, not optional.
- Focused vitest in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts): the rejected-batch-then-valid-single test asserts `result.kind === "success"`, `result.data === { completion: "plan_done", summary: "new" }`, and `planDoneCallCount === 2`. All other r4 tests retained.
- Full vitest: workspace green.
- `npm run build`: `dist/cli.js` produced.
- `grep -rn PLAN_COMPLETE src/ prompts/` returns zero matches (no `--exclude`, no `--include`).
