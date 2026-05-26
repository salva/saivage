# G09 — Design r5

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis**: [./01-analysis-r5.md](./01-analysis-r5.md)
**r4 docs**: [./02-design-r4.md](./02-design-r4.md), [./03-plan-r4.md](./03-plan-r4.md)
**r4 review**: [./04-review-r4.md](./04-review-r4.md)

The core direction is unchanged and approved-equivalent per [./04-review-r4.md](./04-review-r4.md#L19-L21): stateless [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) `plan_done`, dropped `AgentContext.planService`, post-dispatch `this.abortSignal?.aborted || dispatchResult.aborted` in [src/agents/base.ts](../../../../src/agents/base.ts#L335-L346), and a typed `detectTerminalToolCall(toolCalls: ToolCallResult[], dispatchResult: DispatchResult)` hook with the planner override narrowing `tc.input` from `unknown`. r5 modifies only two localised parts of the r4 test surface in response to [./04-review-r4.md](./04-review-r4.md#L25-L28).

## r5 deltas vs r4

1. **Test-fixture construction**. Every `PlannerAgent` construction in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) goes through the async factory `await PlannerAgent.create(ctx, childSpawner, { abortSignal })` defined at [src/agents/planner.ts](../../../../src/agents/planner.ts#L31-L43). r4's `new PlannerAgent(ctx, childSpawner, { abortSignal })` ([./02-design-r4.md](./02-design-r4.md#L240-L251), [./03-plan-r4.md](./03-plan-r4.md#L376-L379)) is invalid against the constructor signature `(ctx, childSpawner, initialMessage, eagerSkillBlock, config?)` at [src/agents/planner.ts](../../../../src/agents/planner.ts#L45-L50); the config object would bind to `initialMessage` and `abortSignal` would never reach `BaseAgentConfig.abortSignal` at [src/agents/base.ts](../../../../src/agents/base.ts#L93-L111).
2. **Rejected-batch-then-valid-single regression**. Replace r4's two-clean-cycle "second cycle uses the second reason" test ([./02-design-r4.md](./02-design-r4.md#L261-L262), [./03-plan-r4.md](./03-plan-r4.md#L394-L400)) with a single `planner.run()` whose router emits a rejected batch on turn 1 and a valid single `plan_done` on turn 2. The result locks in both single-call exclusivity AND current-call reason selection after a rejected prior attempt, exactly as required at [./04-review-r4.md](./04-review-r4.md#L20-L21).

Every other element of [./02-design-r4.md](./02-design-r4.md) — the `PlanService.plan_done` body, `AgentContext` reverted to its r2-pre-state, the typed hook signature, the planner override body, the prompt rewrites, the recovery-loop discriminator, the legacy-token concatenation rule, the dashboard formatter entry, the clean-revert rollback — is retained verbatim.

## 1. Production code — unchanged from r4

The production surface from [./02-design-r4.md](./02-design-r4.md) §1 and §2 is retained without modification. r5 is purely a test-side fix; no production source file is touched beyond what r4 already specifies.

- `PlanService.plan_done` body at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) — unchanged from [./02-design-r4.md](./02-design-r4.md#L40-L48).
- `BaseAgent.runLoop` post-dispatch block at [src/agents/base.ts](../../../../src/agents/base.ts#L335-L346) — unchanged from [./02-design-r4.md](./02-design-r4.md#L57-L88).
- `BaseAgent.detectTerminalToolCall` default hook — unchanged from [./02-design-r4.md](./02-design-r4.md#L90-L101).
- `PlannerAgent.detectTerminalToolCall` override at [src/agents/planner.ts](../../../../src/agents/planner.ts) — unchanged from [./02-design-r4.md](./02-design-r4.md#L120-L153). It already reads `reason` from `tc.input` on the current call, after asserting `result.isError === false` and matching by `toolUseId`, so the rejected-batch-then-valid-single test in §3.3 below is satisfied by r4's production override without further change.
- `PlannerAgent.run()` outer loop tagged-completion branch — unchanged from [./02-design-r4.md](./02-design-r4.md#L175-L188).

## 2. Test fixture — `PlannerAgent` construction via the async factory

The fixture `makePlannerContext` from [./02-design-r4.md](./02-design-r4.md#L268-L325) is retained verbatim, including the `validatePlanDone` helper that throws on validation failure, the `RuntimeToolEntry` registrations for `plan_done`, `plan_add_stage`, and `run_manager`, the `opts.onPlanDoneCall` hook, and the `abortSignal` plumbing.

The single change is at every CALL SITE that constructs a `PlannerAgent`. r4 used:

```ts
// r4 (BROKEN): config is silently bound to initialMessage.
const { ctx, abortSignal } = makePlannerContext(tmpDir, router);
const planner = new PlannerAgent(ctx, childSpawner, { abortSignal });
```

r5 uses the async factory:

```ts
// r5 (CORRECT): config flows to BaseAgentConfig.abortSignal via PlannerAgent.create.
const { ctx, abortSignal } = makePlannerContext(tmpDir, router);
const planner = await PlannerAgent.create(ctx, childSpawner, { abortSignal });
```

The factory at [src/agents/planner.ts](../../../../src/agents/planner.ts#L31-L43) builds `initialMessage` via `buildPlannerMessage(ctx)` and `eagerSkillBlock` via `buildEagerBlock(ctx.project.projectRoot, "planner", "Strategic planning and stage dispatch")`, then calls `new PlannerAgent(ctx, childSpawner, initialMessage, eagerSkillBlock, config)`. The fixture's `makePlannerContext` already materialises a temporary project root under `mkdtempSync` with `.saivage/` populated (per the existing pattern at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L29-L70)), so `buildPlannerMessage` and `buildEagerBlock` resolve without additional fixture wiring.

The async factory pattern propagates to EVERY test in `describe("PlannerAgent — plan_done terminal protocol")` and to the existing F14 invariant test at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L77-L153). Tests that did not previously pass an `abortSignal` use `await PlannerAgent.create(ctx, childSpawner)` (config-less form).

The constructor-style alternative `new PlannerAgent(ctx, childSpawner, "", "", { abortSignal })` is also semantically valid (the reviewer explicitly allows it at [./04-review-r4.md](./04-review-r4.md#L15-L15)). r5 prefers the factory because it matches the production construction path used in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) and exercises the real `initialMessage` and `eagerSkillBlock` plumbing.

## 3. Test surface

### 3.1 Module-level token constant

Unchanged from [./02-design-r4.md](./02-design-r4.md#L240-L257). `const LEGACY_TOKEN = "PLAN_" + "COMPLETE";` at module scope; the post-condition `grep -rn PLAN_COMPLETE src/ prompts/` returns zero matches.

### 3.2 Stub `mcpRuntime` mirrors production semantics

Unchanged from [./02-design-r4.md](./02-design-r4.md#L268-L325). The `validatePlanDone` helper throws on validation failure (mirrors [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L206)); the stub returns `{ ok: true }` on success. The `opts.onPlanDoneCall` hook is fired BEFORE validation so tests can both count invocations and observe the call.

To make the new rejected-batch test observable, the fixture additionally exposes a simple counter that increments on every successful `plan_done` validation. The cleanest way is to use `opts.onPlanDoneCall` as a counter callback:

```ts
let planDoneCallCount = 0;
const { ctx, abortSignal } = makePlannerContext(tmpDir, router, {
  onPlanDoneCall: () => { planDoneCallCount += 1; },
});
const planner = await PlannerAgent.create(ctx, childSpawner);
```

`planDoneCallCount` is asserted directly in the rejected-batch test (§3.3 test 2). No other field on the fixture changes.

### 3.3 Required tests in `src/agents/planner.nudge.test.ts`

`describe("PlannerAgent — plan_done terminal protocol")` contains the following eight tests. Tests 1, 3, 4, 5, 6, 7, 8 are retained from [./02-design-r4.md](./02-design-r4.md#L259-L335) with their bodies unchanged EXCEPT that every `PlannerAgent` construction goes through `await PlannerAgent.create(...)` per §2. Test 2 is replaced.

1. **terminates on a single `plan_done` tool call** — unchanged from r4 test 1 at [./02-design-r4.md](./02-design-r4.md#L259-L261); construction migrated to `await PlannerAgent.create(ctx, childSpawner)`.

2. **a rejected batched `plan_done` followed by a valid single `plan_done` uses the second reason** (REPLACES r4 test 2)

   Stub a router with two scripted turns inside a single `planner.run()`:

   ```ts
   const router = {
     calls: [] as Array<{ messages: unknown[] }>,
     call: vi.fn(async (_modelSpec: string, args: { messages: unknown[] }) => {
       router.calls.push({ messages: args.messages });
       if (router.calls.length === 1) {
         return {
           content: "",
           toolCalls: [
             { id: "tc-add",  name: "plan_add_stage", input: { /* valid plan_add_stage args */ } },
             { id: "tc-done", name: "plan_done",      input: { reason: "old" } },
           ],
           finishReason: "tool_use",
           usage: { /* ... */ },
         };
       }
       if (router.calls.length === 2) {
         return {
           content: "",
           toolCalls: [
             { id: "tc-done-2", name: "plan_done", input: { reason: "new" } },
           ],
           finishReason: "tool_use",
           usage: { /* ... */ },
         };
       }
       throw new Error("unexpected third router call");
     }),
   };

   let planDoneCallCount = 0;
   const { ctx } = makePlannerContext(tmpDir, router, {
     onPlanDoneCall: () => { planDoneCallCount += 1; },
   });
   const planner = await PlannerAgent.create(ctx, childSpawner);

   const result = await planner.run();

   expect(result).toEqual({
     kind: "success",
     data: { completion: "plan_done", summary: "new" },
   });
   expect(router.calls).toHaveLength(2);
   expect(planDoneCallCount).toBe(2);
   ```

   **Why this asserts both exclusivity AND current-call reason selection:**

   - **Exclusivity**: on turn 1 the router emits two tool calls. The dispatcher executes both — `plan_add_stage` is a registered `plan_*` tool that the stub returns `{ ok: true }` for, and `plan_done({ reason: "old" })` validates successfully. The override at [src/agents/planner.ts](../../../../src/agents/planner.ts) (r4 §2.2 of [./02-design-r4.md](./02-design-r4.md#L195-L233)) sees `toolCalls.length === 2`, fails the `toolCalls.length !== 1` guard, and returns `null`. `runLoop` continues to turn 2.
   - **Current-call reason selection**: on turn 2 the router emits a single `plan_done({ reason: "new" })`. The override sees `toolCalls.length === 1`, matches `result.isError === false` via `toolUseId === "tc-done-2"`, narrows `tc.input.reason` and returns `{ name: "plan_done", data: { reason: "new" } }`. `runLoop` returns `finishReason: "tool_terminal"`. The planner's outer loop returns `{ kind: "success", data: { completion: "plan_done", summary: "new" } }`.
   - **Two MCP invocations**: `planDoneCallCount === 2` asserts the stub `mcpRuntime.callTool` was invoked for `plan_done` on BOTH turns. If a future refactor accidentally short-circuited the second MCP call (e.g. by reading a cached completion from turn 1), this assertion fails.
   - **Reason is from the second turn, not the first**: `summary === "new"` (not `"old"`). If a future refactor read `reason` from a prior turn's `tc.input`, the dispatch history, or any other reach-back, this assertion fails with `summary === "old"`.

   The test SUBSUMES the r4 two-clean-cycle stale-state contract: if a single `PlannerAgent` does not carry rejected-batch state across its own turns within one `run()`, then a fortiori two independent `PlannerAgent` instances do not share state. r5 therefore replaces (not supplements) the r4 test.

3. **does not terminate when `plan_done` is batched with another plan tool** — unchanged from r4 test 3 at [./02-design-r4.md](./02-design-r4.md#L264-L266); construction migrated to `await PlannerAgent.create(ctx, childSpawner)`. Distinct from test 2: subsequent router turns return text-only so the planner falls through to the nudge branch and returns `kind: "failure"` after `MAX_NUDGES`, exercising the nudge path explicitly.

4. **does not terminate when `plan_done` is batched with a dispatch tool** — unchanged from r4 test 4 at [./02-design-r4.md](./02-design-r4.md#L268-L270); construction migrated.

5. **does not terminate when the `plan_done` dispatch result is an error** — unchanged from r4 test 5 at [./02-design-r4.md](./02-design-r4.md#L272-L276); construction migrated. The `validatePlanDone` throw path produces `isError: true` via [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197) and the override returns `null`.

6. **abort signal flipped mid-`callTool` wins over terminal hook** — unchanged from r4 test 6 at [./02-design-r4.md](./02-design-r4.md#L278-L285); construction migrated to:

   ```ts
   const abortSignal = { aborted: false };
   const { ctx } = makePlannerContext(tmpDir, router, {
     abortSignal,
     onPlanDoneCall: () => { abortSignal.aborted = true; },
   });
   const planner = await PlannerAgent.create(ctx, childSpawner, { abortSignal });
   ```

   This is the construction that the reviewer's first required change is principally about: with the r4 broken instantiation, `abortSignal` never reached `BaseAgentConfig.abortSignal`, so the post-dispatch gate at [src/agents/base.ts](../../../../src/agents/base.ts#L335-L346) was never exercised. With `await PlannerAgent.create(ctx, childSpawner, { abortSignal })`, the factory passes the config to the constructor's fifth parameter; `BaseAgent` stores it; the gate reads it as `this.abortSignal?.aborted === true` after dispatch and returns `finishReason: "abort"`. `result.kind === "abort"` is the production-evidence assertion.

7. **bare legacy text in assistant content does not terminate the planner** — unchanged from r4 test 7 at [./02-design-r4.md](./02-design-r4.md#L287-L289); construction migrated.

8. **F14 invariant** — `does not duplicate the nudged assistant message` — unchanged from r4 test 8 at [./02-design-r4.md](./02-design-r4.md#L291-L293); construction migrated. The existing test at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L77-L153) currently constructs `PlannerAgent` directly; r5 migrates it to `await PlannerAgent.create(...)` for consistency.

### 3.4 `PlanService` unit tests in `src/runtime/runtime.test.ts`

Unchanged from [./02-design-r4.md](./02-design-r4.md#L301-L334). Four tests covering direct method success/failure and `handleToolCall` success/failure paths.

## 4. Validation contract

Identical to [./02-design-r4.md](./02-design-r4.md#L336-L340):

```bash
npx tsc --noEmit
npx eslint .
npx vitest run src/agents/planner.nudge.test.ts src/runtime/runtime.test.ts
npx vitest run
npm run build
grep -rn PLAN_COMPLETE src/ prompts/
```

Acceptance:

- `npx tsc --noEmit` → 0 errors. The fix at §2 is type-required: `new PlannerAgent(ctx, childSpawner, { abortSignal })` fails strict typing because `{ abortSignal: ... }` is not assignable to `string` ([src/agents/planner.ts](../../../../src/agents/planner.ts#L45-L50)).
- `npx eslint .` → 0 errors.
- Focused vitest: eight tests in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) green; four `plan_done` tests in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) green.
- Full vitest: workspace green.
- `npm run build` → `dist/cli.js` produced.
- `grep -rn PLAN_COMPLETE src/ prompts/` → zero matches.
