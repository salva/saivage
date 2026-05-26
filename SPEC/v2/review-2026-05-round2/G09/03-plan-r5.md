# G09 — Plan r5

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis (r5)**: [./01-analysis-r5.md](./01-analysis-r5.md)
**Design (r5)**: [./02-design-r5.md](./02-design-r5.md)
**r4 plan**: [./03-plan-r4.md](./03-plan-r4.md)
**r4 review**: [./04-review-r4.md](./04-review-r4.md)

All edits are inside `/home/salva/g/ml/saivage`. Paths below are repo-relative to that root. r5 is a narrow test-side fix on top of r4; every production step from [./03-plan-r4.md](./03-plan-r4.md) is retained verbatim. Only step 14 is modified.

## r5 deltas vs r4

1. **Step 14(b/c) — test-fixture construction.** Every `PlannerAgent` construction in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) goes through the async factory `await PlannerAgent.create(ctx, childSpawner, { abortSignal })` defined at [src/agents/planner.ts](../../../../src/agents/planner.ts#L31-L43). The r4 form `new PlannerAgent(ctx, childSpawner, { abortSignal })` ([./03-plan-r4.md](./03-plan-r4.md#L376-L379)) is invalid against the constructor signature `(ctx, childSpawner, initialMessage, eagerSkillBlock, config?)` at [src/agents/planner.ts](../../../../src/agents/planner.ts#L45-L50); the config object would bind to `initialMessage` and `abortSignal` would never reach `BaseAgentConfig.abortSignal` at [src/agents/base.ts](../../../../src/agents/base.ts#L93-L111).
2. **Step 14(c) — replace test 2.** Drop r4 test 2 "second cycle uses the second reason" ([./03-plan-r4.md](./03-plan-r4.md#L394-L400)) and replace it with a single-`planner.run()` regression where router turn 1 emits a rejected batch `[plan_add_stage, plan_done({ reason: "old" })]` and turn 2 emits a single `plan_done({ reason: "new" })`. Asserts `result === { kind: "success", data: { completion: "plan_done", summary: "new" } }` and that the stub `mcpRuntime.callTool` was invoked twice for `plan_done`. Locks in single-call exclusivity AND current-call reason selection after a rejected prior attempt, exactly as required at [./04-review-r4.md](./04-review-r4.md#L20-L21).

Every other step from [./03-plan-r4.md](./03-plan-r4.md) is retained unchanged.

## Steps

### 1. Add stateless `plan_done` to `PlanService`

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L25-L37).

### 2. Wire `plan_done` into the MCP dispatcher

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L39-L51).

### 3. Add the `plan_done` tool schema

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L53-L70).

### 4. ~~Add `planService` to `AgentContext`~~ (DELETED in r4, stays deleted)

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L72-L74).

### 5. ~~Pass `planService` through every agent context~~ (DELETED in r4, stays deleted)

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L76-L80).

### 6. Add `detectTerminalToolCall` hook to `BaseAgent` and widen `runLoop`

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L82-L156). Combined abort check `this.abortSignal?.aborted || dispatchResult.aborted` at [src/agents/base.ts](../../../../src/agents/base.ts#L335-L346), typed hook signature using `ToolCallResult[]` ([src/providers/types.ts](../../../../src/providers/types.ts#L17-L48)) and `DispatchResult` ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L35-L40)).

### 7. Add `plan_done` to `PLAN_TOOLS`

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L158-L161).

### 8. Implement the `PlannerAgent` terminal-tool override and consume the new finishReason

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L163-L218).

### 9. Rewrite the planner startup message

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L220-L224).

### 10. Rewrite the planner system prompt

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L226-L243).

### 11. Update the recovery loop discriminator

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L245-L278).

### 12. Rewrite `RECOVERY_PROMPT` and `CONTINUOUS_IMPROVEMENT_PROMPT`

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L280-L285).

### 13. Add the dashboard formatter entry

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L287-L289).

### 14. Rewrite the planner tests (REVISED — async-factory construction + rejected-batch-then-valid-single)

In [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts):

**(a) File header + token constant.** Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L295-L317).

**(b) Fixture — stub `mcpRuntime` mirrors `McpRuntime` semantics + plumb `abortSignal`.** Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L319-L368) for the `validatePlanDone` helper, `RuntimeToolEntry` registrations, `opts.onPlanDoneCall` hook, and `abortSignal` plumbing in the returned `ctx`.

The CALL-SITE pattern changes. r4's snippet ([./03-plan-r4.md](./03-plan-r4.md#L376-L379))

```ts
const { ctx, abortSignal } = makePlannerContext(tmpDir, router);
const planner = new PlannerAgent(ctx, childSpawner, { abortSignal });
```

is invalid: the `PlannerAgent` constructor at [src/agents/planner.ts](../../../../src/agents/planner.ts#L45-L50) takes `(ctx, childSpawner, initialMessage, eagerSkillBlock, config?)`, so `{ abortSignal }` would bind to `initialMessage` (a `string`) and `abortSignal` would never reach `BaseAgentConfig.abortSignal` at [src/agents/base.ts](../../../../src/agents/base.ts#L93-L111). r5 uses the async factory at [src/agents/planner.ts](../../../../src/agents/planner.ts#L31-L43):

```ts
const { ctx, abortSignal } = makePlannerContext(tmpDir, router, { abortSignal: { aborted: false } });
const planner = await PlannerAgent.create(ctx, childSpawner, { abortSignal });
```

For tests that don't need an abort signal, the config-less form:

```ts
const { ctx } = makePlannerContext(tmpDir, router);
const planner = await PlannerAgent.create(ctx, childSpawner);
```

This pattern applies CONSISTENTLY to every `PlannerAgent` construction in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts), including the existing F14 invariant test at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L77-L153) (test 8 in the describe block), which currently uses a direct `new PlannerAgent(...)` and must be migrated.

**(c) Replace the `describe` body with the eight tests below.** Tests 1, 3, 4, 5, 6, 7, 8 are retained from [./03-plan-r4.md](./03-plan-r4.md#L388-L492) with their bodies unchanged EXCEPT that every `PlannerAgent` construction goes through `await PlannerAgent.create(...)` per (b). Test 2 is REPLACED.

```ts
describe("PlannerAgent — plan_done terminal protocol", () => {
  it("terminates on a single plan_done tool call", async () => {
    // Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L390-L392);
    // construction migrated:
    //   const { ctx } = makePlannerContext(tmpDir, router);
    //   const planner = await PlannerAgent.create(ctx, childSpawner);
  });

  it("a rejected batched plan_done followed by a valid single plan_done uses the second reason", async () => {
    // Router emits two scripted turns inside ONE planner.run():
    //   Turn 1: toolCalls = [
    //     { id:"tc-add",  name:"plan_add_stage", input:{ /* valid plan_add_stage args */ } },
    //     { id:"tc-done", name:"plan_done",      input:{ reason:"old" } },
    //   ], finishReason:"tool_use".
    //   Turn 2: toolCalls = [
    //     { id:"tc-done-2", name:"plan_done", input:{ reason:"new" } },
    //   ], finishReason:"tool_use".
    //
    // Fixture:
    //   let planDoneCallCount = 0;
    //   const { ctx } = makePlannerContext(tmpDir, router, {
    //     onPlanDoneCall: () => { planDoneCallCount += 1; },
    //   });
    //   const planner = await PlannerAgent.create(ctx, childSpawner);
    //   const result = await planner.run();
    //
    // Mechanism:
    //   - Turn 1: dispatcher executes plan_add_stage ({ ok:true }) and
    //     plan_done({ reason:"old" }) ({ ok:true }, validation passes).
    //     The override at [src/agents/planner.ts](../../../../src/agents/planner.ts)
    //     fails `toolCalls.length !== 1` and returns null. runLoop continues.
    //   - Turn 2: dispatcher executes plan_done({ reason:"new" })
    //     ({ ok:true }). The override sees toolCalls.length === 1, matches
    //     by toolUseId, narrows tc.input.reason, and returns
    //     { name:"plan_done", data:{ reason:"new" } }. runLoop returns
    //     finishReason:"tool_terminal". The planner's outer loop returns
    //     { kind:"success", data:{ completion:"plan_done", summary:"new" } }.
    //
    // Asserts:
    //   expect(result).toEqual({
    //     kind: "success",
    //     data: { completion: "plan_done", summary: "new" },
    //   });
    //   expect(router.calls).toHaveLength(2);
    //   expect(planDoneCallCount).toBe(2);
    //
    // Locks in:
    //   - Single-call exclusivity ([src/agents/planner.ts](../../../../src/agents/planner.ts)
    //     override `toolCalls.length !== 1` guard).
    //   - Current-call reason selection (`summary === "new"`, not "old").
    //   - Two MCP invocations for plan_done (no short-circuit, no caching).
    //
    // This subsumes r4's "two clean cycles" stale-state test: if a single
    // PlannerAgent does not carry rejected-batch state across its own turns,
    // two independent instances cannot share state either.
  });

  it("does not terminate when plan_done is batched with another plan tool", async () => {
    // Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L402-L407);
    // construction migrated. Distinct from test 2: subsequent router turns
    // return text-only, so the planner falls through to the nudge branch
    // and returns kind:"failure" after MAX_NUDGES — exercising the nudge
    // path explicitly.
  });

  it("does not terminate when plan_done is batched with a dispatch tool", async () => {
    // Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L409-L412);
    // construction migrated.
  });

  it("does not terminate when the plan_done dispatch result is an error", async () => {
    // Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L414-L422);
    // construction migrated. The validatePlanDone throw path produces
    // isError:true via [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197)
    // and the override returns null.
  });

  it("aborts when the abort signal flips during mcpRuntime.callTool", async () => {
    // Unchanged behaviour from [./03-plan-r4.md](./03-plan-r4.md#L424-L440);
    // construction migrated:
    //   const abortSignal = { aborted: false };
    //   const { ctx } = makePlannerContext(tmpDir, router, {
    //     abortSignal,
    //     onPlanDoneCall: () => { abortSignal.aborted = true; },
    //   });
    //   const planner = await PlannerAgent.create(ctx, childSpawner, { abortSignal });
    //
    // With the async factory, { abortSignal } now reaches BaseAgentConfig
    // ([src/agents/base.ts](../../../../src/agents/base.ts#L93-L111))
    // and BaseAgent stores it as `this.abortSignal`. The combined gate
    // `this.abortSignal?.aborted || dispatchResult.aborted`
    // at [src/agents/base.ts](../../../../src/agents/base.ts#L335-L346)
    // reads aborted:true after dispatch and returns
    // finishReason:"abort". The terminal hook is NOT invoked.
    //
    // Asserts result.kind === "abort".
  });

  it("does not terminate on a bare legacy-text response", async () => {
    // Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L468-L474);
    // construction migrated. Uses LEGACY_TOKEN (concatenated).
  });

  it("does not duplicate the nudged assistant message in this.messages", async () => {
    // F14 invariant. Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L476-L484);
    // construction migrated from the current direct `new PlannerAgent(...)`
    // at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L77-L153)
    // to `await PlannerAgent.create(ctx, childSpawner)`.
  });
});
```

The two r5 deltas are local to:

- The fixture call sites in (b): every `new PlannerAgent(...)` becomes `await PlannerAgent.create(...)`.
- Test 2 in (c): r4's two-clean-cycle test is replaced by the rejected-batch-then-valid-single regression described above.

Tests 3, 4, 5, 6, 7, 8 retain their r4 bodies; only their construction line changes.

### 15. Add `PlanService` unit tests

Unchanged from [./03-plan-r4.md](./03-plan-r4.md#L494-L520).

### 16. Type-check, lint, unit-test, build, post-condition grep

From `/home/salva/g/ml/saivage`, run in order:

```bash
npx tsc --noEmit
npx eslint .
npx vitest run src/agents/planner.nudge.test.ts src/runtime/runtime.test.ts
npx vitest run
npm run build
grep -rn PLAN_COMPLETE src/ prompts/
```

Acceptance:

- `npx tsc --noEmit` → 0 errors. The r5 fix is type-required: `new PlannerAgent(ctx, childSpawner, { abortSignal })` fails strict typing because `{ abortSignal: { aborted: boolean } }` is not assignable to the constructor's third parameter `initialMessage: string` ([src/agents/planner.ts](../../../../src/agents/planner.ts#L45-L50)). With `await PlannerAgent.create(ctx, childSpawner, { abortSignal })` the config flows through the third-parameter `Partial<BaseAgentConfig>` slot ([src/agents/planner.ts](../../../../src/agents/planner.ts#L31-L43)) and `tsc` resolves cleanly.
- `npx eslint .` → 0 errors.
- Focused vitest: all eight tests in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) green. Test 2 in particular asserts `{ kind: "success", data: { completion: "plan_done", summary: "new" } }`, `router.calls.length === 2`, and `planDoneCallCount === 2`. Test 6 asserts `result.kind === "abort"` with the abort signal correctly delivered through `PlannerAgent.create`. All four `plan_done` tests in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) green.
- Full vitest: workspace green.
- `npm run build` → `dist/cli.js` produced without TS errors.
- `grep -rn PLAN_COMPLETE src/ prompts/` → zero matches. No `--exclude`, no `--include`. The legacy token only appears in `SPEC/v2/review-2026-05-round2/G09/*.md`.

## Validation

- **Static**: `npx tsc --noEmit` passes (the constructor-signature fix is type-required); `npx eslint .` passes; the production grep returns zero across the executable tree.
- **Focused unit**: see step 16. Test 1 covers happy-path single-turn termination. Test 2 is the rejected-batch-then-valid-single regression (review point 2 at [./04-review-r4.md](./04-review-r4.md#L17-L21)). Tests 3, 4 cover exclusivity for siblings. Test 5 covers the dispatcher-error-conversion path. Test 6 covers post-dispatch abort precedence with the abort signal correctly threaded via `PlannerAgent.create` (review point 1 at [./04-review-r4.md](./04-review-r4.md#L11-L15)). Test 7 uses the concatenated `LEGACY_TOKEN`. Test 8 is the F14 invariant rewritten to exercise the new termination path.
- **Full vitest**: workspace green. The async-factory migration does not affect any tests outside [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts).
- **Build**: `npm run build` succeeds.

## Rollback

Identical to [./03-plan-r4.md](./03-plan-r4.md#L532-L532). `git restore -- src/mcp/plan-server.ts src/agents/base.ts src/agents/planner.ts src/agents/planner.nudge.test.ts src/runtime/runtime.test.ts src/server/bootstrap.ts prompts/planner.md web/src/utils/toolFormatters.ts` returns the planner to the legacy free-text protocol. No on-disk format change is introduced anywhere (`plan_done` does not write disk), so no state cleanup is required.

## Operator-gated saivage-v3 restart

Identical to [./03-plan-r4.md](./03-plan-r4.md#L536-L537). Scoped to saivage v2 under `/home/salva/g/ml/saivage`. The saivage-v3 harness at `/home/salva/g/ml/saivage-v3` and the LXC service `saivage.service` on `saivage-v3` (10.0.3.112) are NOT affected by this plan. Defer container restart until the operator confirms.
