# G09 — Analysis r4

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**r1 docs**: [./01-analysis-r1.md](./01-analysis-r1.md), [./02-design-r1.md](./02-design-r1.md), [./03-plan-r1.md](./03-plan-r1.md)
**r2 docs**: [./01-analysis-r2.md](./01-analysis-r2.md), [./02-design-r2.md](./02-design-r2.md), [./03-plan-r2.md](./03-plan-r2.md)
**r3 docs**: [./01-analysis-r3.md](./01-analysis-r3.md), [./02-design-r3.md](./02-design-r3.md), [./03-plan-r3.md](./03-plan-r3.md)
**r3 review**: [./04-review-r3.md](./04-review-r3.md) (CHANGES_REQUESTED, 4 required changes)

r3's structural direction (terminal-tool override, exclusive single-call batch, dead legacy free-text token) is accepted. r4 only re-examines the four points the reviewer flagged in [./04-review-r3.md](./04-review-r3.md): the stale-state class around `pendingCompletion`, the gap between `DispatchResult.aborted` and the actual abort signal, the test stub's deviation from `McpRuntime.callTool` semantics, and the typed hook signature plus an internal contradiction about `PlanService` imports under [src/agents](../../../../src/agents).

## r4 deltas vs r3 (one section per r3 required change)

- §A REPLACES r3 §A. Drop `pendingCompletion`, `consumePendingCompletion()`, and `AgentContext.planService` entirely. `PlanService.plan_done` becomes stateless: validate `reason`, return `{ ok: true }`. The planner override reads `reason` straight from the current tool call's `input` and only after the dispatch result is non-errored. No service-side cell ⇒ no stale state to leak between turns or recovery cycles.
- §B REPLACES r3 §B.1. Abort precedence is enforced by actual code: `BaseAgent.runLoop` checks `this.abortSignal?.aborted || dispatchResult.aborted` after pushing tool results and before the terminal hook. The dispatch-tool abort branch in [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L122-L135) is not modified — the new combined check on the abort signal is sufficient and is the right surface (`runLoop` already owns the signal). r3 §B.2 (single-call exclusivity, `toolUseId` match) is unchanged.
- §C REPLACES r3 §A's reasoning about "test stub returns service result directly". The test fixture stubs `mcpRuntime.callTool` so it mirrors [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L206): on validation failure it THROWS (dispatcher catches and produces `isError: true` per [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197)), on success it returns content. No `PlanService` is constructed under [src/agents](../../../../src/agents); the stub validates `reason` inline. r3 §C (legacy-token concatenation in tests) is unchanged.
- §D NEW. The terminal-hook signature uses the live provider types: `ToolCallResult[]` (where `input: unknown`, per [src/providers/types.ts](../../../../src/providers/types.ts#L40-L48)) and the real `DispatchResult` from [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L35-L40). `tc.input` is narrowed before any field is read. The r3 step-5 constraint ("no file under [src/agents](../../../../src/agents) may import or construct `PlanService`") is dropped along with `AgentContext.planService`; there is nothing to constrain.

## A. Why `pendingCompletion` must not exist at all (replaces r3 §A)

r3 introduced `PlanService.pendingCompletion`, `consumePendingCompletion()`, and an `AgentContext.planService` wiring so the override could consume the cell on success. The reviewer's first required change ([./04-review-r3.md](./04-review-r3.md#L17-L25)) shows the resulting stale-state class is real:

- The dispatcher in [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L81-L135) executes local tools (including `plan_done`) BEFORE the planner's terminal hook ever runs. A response like `[plan_add_stage, plan_done]` or `[plan_done, run_manager]` executes `plan_done`, writes `pendingCompletion`, and only THEN runs through `processToolCalls` → the override, which rejects the batch under the exclusivity rule (r3 §B.2). The cell is now occupied.
- On the next turn, a clean single-call `plan_done` reaches [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) via the dispatch path, finds the existing `pendingCompletion`, and returns `{ ok: true, recorded: false }`. The override does not inspect the result payload (only `isError`), so it accepts the call and consumes the old reason. The planner terminates on a stale completion.
- The same hazard exists for the continuous-improvement recovery loop in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L644): the `PlanService` instance is shared across recovery cycles, so any rejected/aborted batch with `plan_done` in cycle N leaks state into cycle N+1.

The reviewer offered two valid options:

  (a) Do not record `pendingCompletion` until the terminal batch is accepted (move recording out of `PlanService.plan_done` and into the planner override path).
  (b) Clear the cell on every rejected batch containing `plan_done` before continuing.

r4 picks (a) and takes the architecture-first interpretation: there is no need for service-side state at all. The override reads `reason` directly from `tc.input` of the current tool call, on a current dispatch result that is non-errored — i.e. the reason has just been validated by `PlanService.plan_done`. The reason of record is necessarily from the current call by construction; no "fresh-vs-stale" identity check is required because no shared cell exists.

Concretely:

- `PlanService.plan_done({ reason })` becomes: validate `reason` is a non-empty trimmed string; return `{ ok: true }` on success or a `PlanError` on validation failure. No private field, no `consumePendingCompletion()`. No `plan.json` write, no history append (unchanged from r3).
- `AgentContext.planService` is dropped from [src/agents/types.ts](../../../../src/agents/types.ts#L30-L56). The wiring at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L155-L169) and every other agent-context construction site reverts to its r2-pre-state.
- The planner override reads `tc.input` as `unknown`, narrows it to `{ reason?: unknown }`, type-guards `reason` as `string`, and uses it only when the corresponding `toolResults` entry has `isError === false`. `isError === false` is the proof that the reason was a non-empty trimmed string — that is exactly the contract `plan_done` enforces.

This is strictly fewer moving parts than r3 and dissolves the staleness class at the source. It also collapses the r3 §A "two writers / one cell / well-defined call sites" story into "no writers, no cell, one reader of the current `tc.input`". The "MCP path is the source of truth for the recorded reason" argument from r3 becomes "MCP path is the validator; the model's `tc.input.reason` is the reason of record, and it only counts when validation passed (`isError === false`) on the current call".

The reviewer also asked for tests where a rejected batched `plan_done` is followed by a valid single `plan_done`; the second run must use the second reason and must not see `recorded: false` from stale state ([./04-review-r3.md](./04-review-r3.md#L24-L25)). Under r4 the `recorded` boolean does not exist and there is no cell to be stale, but the test is still written: it asserts the second run terminates with `summary === <second reason>` and that `mcpRuntime.callTool` for `plan_done` was invoked twice — once per batch — proving the override does not reach back to any prior turn's value.

## B. Why abort precedence must be enforced in actual code (replaces r3 §B.1)

The reviewer's second required change ([./04-review-r3.md](./04-review-r3.md#L27-L37)) is correct on both counts:

- `BaseAgent.runLoop` only consults `dispatchResult.aborted` after dispatch ([src/agents/base.ts](../../../../src/agents/base.ts#L337-L345)). The dispatcher sets that flag for the LOCAL path when the signal is aborted BEFORE the local call runs ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L93-L101)). For the DISPATCH path, the abort branch returns an aborted `ToolCallResultEntry` without setting `DispatchResult.aborted` ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L122-L128)).
- More importantly, the signal can flip DURING `processToolCalls` and not be observed at all. A local `plan_done` that completes successfully will not see the post-call abort, because the dispatcher only checks the signal in the per-call prologue ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L93)). The signal can therefore be aborted by the time `runLoop` returns from `processToolCalls`, yet `dispatchResult.aborted` reads `false`, and r3's ordering would fire the terminal hook anyway.

r4 enforces the precedence in `runLoop` itself. After pushing the tool-result message, the existing single abort check is widened to OR the live signal:

```ts
this.pushMessage({ role: "user", content: resultBlocks });

if (this.abortSignal?.aborted || dispatchResult.aborted) {
  return { text: "Aborted during tool execution", finishReason: "abort" };
}

const terminal = this.detectTerminalToolCall(response.toolCalls, dispatchResult);
if (terminal) {
  return {
    text: response.content,
    finishReason: "tool_terminal",
    source: responseSource(response),
    terminal,
  };
}
```

Reading `this.abortSignal?.aborted` is safe because `BaseAgent` already polls the same field at three other points ([src/agents/base.ts](../../../../src/agents/base.ts#L232), [src/agents/base.ts](../../../../src/agents/base.ts#L497), [src/agents/base.ts](../../../../src/agents/base.ts#L902)). The signal is the canonical abort surface for the agent.

The reviewer's alternative — also set `DispatchResult.aborted` in the dispatch-tool abort branch — is intentionally NOT taken in r4. The dispatcher's flag is a "the batch as a whole was cut short" signal, currently only set for local pre-call aborts; widening it without a wider audit risks behaviour changes in other consumers of `aborted`. The `runLoop`-level check is local, single-point, and exactly answers the question the terminal hook needs answered: "is the agent supposed to be terminating right now?".

The proposed r3 abort test ([./03-plan-r3.md](./03-plan-r3.md#L383-L390)) is unrunnable as the reviewer notes: a pre-aborted signal returns at the top of `runLoop` ([src/agents/base.ts](../../../../src/agents/base.ts#L232-L234)) before any LLM call, so it never exercises post-dispatch ordering. r4 replaces it with a test that flips a shared abort flag DURING `mcpRuntime.callTool`:

- The fixture builds `const abortSignal = { aborted: false }` and passes it as `BaseAgentConfig.abortSignal` (the field is `{ aborted: boolean }` at [src/agents/base.ts](../../../../src/agents/base.ts#L110)).
- The stub `mcpRuntime.callTool` for `plan_done` runs `abortSignal.aborted = true;` and then returns the validated success content.
- The dispatcher's `executeLocalTool` does not re-check the signal after its own success ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L138-L208)), so `DispatchResult.aborted` is `false` AND the local result is `isError: false`. The terminal-hook precondition is met from the dispatcher's point of view.
- The new check in `runLoop` reads the freshly-flipped `abortSignal.aborted` and returns `finishReason: "abort"` instead of consulting `detectTerminalToolCall`.

The seam is fully public/protected: `BaseAgentConfig.abortSignal` is constructor-level, and `mcpRuntime` is a field on `AgentContext`. No private surgery on `BaseAgent` is required, and no `BaseAgent` subclass test helper is needed.

## C. Why the test stub must mirror `McpRuntime.callTool` (replaces r3's stub direction)

The reviewer's third required change ([./04-review-r3.md](./04-review-r3.md#L39-L45)) is correct: [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L206) throws on `isError` and returns only `content` on success. The dispatcher catches the throw in [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197) and converts it into a `ToolCallResultEntry` with `isError: true`. A stub that returns `planService.plan_done(args)` directly — including the `PlanError` object for an empty-reason call — does NOT exercise this branch; the dispatcher would JSON-stringify the `PlanError` and mark `isError: false`.

r4 ties the stub to the production contract without constructing a real `PlanService` under [src/agents](../../../../src/agents):

```ts
const validatePlanDone = (args: unknown): { ok: true } => {
  const reason =
    typeof args === "object" && args !== null && typeof (args as { reason?: unknown }).reason === "string"
      ? ((args as { reason: string }).reason)
      : "";
  if (reason.trim() === "") {
    throw new Error('Tool "plan_done" on "plan" returned error: {"code":"VALIDATION_ERROR"}');
  }
  return { ok: true };
};

return {
  // ... existing context fields ...
  mcpRuntime: {
    getAllTools: () => [{
      service: "plan",
      name: "plan_done",
      description: "completion signal",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    }],
    callTool: async (service: string, tool: string, args: Record<string, unknown>) => {
      if (service === "plan" && tool === "plan_done") return validatePlanDone(args);
      return { ok: true };
    },
  } as AgentContext["mcpRuntime"],
};
```

The throw message shape matches [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L186-L207), so the dispatcher's catch path produces an `isError: true` tool result with the validation code embedded — exactly the production behaviour. The empty-reason test asserts the corresponding `ToolCallResultEntry.isError === true` indirectly: the override returns `null` because of the `isError` check, the planner falls through to the nudge branch, and after `MAX_NUDGES` returns `kind: "failure"`. The test additionally inspects the tool-result content (via the message log on the next router call) to confirm it carries the validation-error string.

This keeps every `PlanService` construction outside [src/agents](../../../../src/agents) without losing semantic fidelity. The real `PlanService` is still exercised end-to-end by the unit tests in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) (existing r3 set, with the `recorded` assertions removed — see Design r4 §3).

## D. Hook signature and the dead PlanService-import constraint (replaces r3 step-5 wording)

The reviewer's fourth required change ([./04-review-r3.md](./04-review-r3.md#L47-L52)) has two parts.

### D.1 Typed hook signature

`response.toolCalls` is `ToolCallResult[]` ([src/providers/types.ts](../../../../src/providers/types.ts#L17-L21)); `ToolCallResult.input` is `unknown`. r3's hook typed it as `Record<string, unknown>`, which is not assignable from `unknown` under strict TypeScript. r4 types the hook against the real types and narrows inside the body:

```ts
// src/agents/base.ts
import type { ToolCallResult } from "../providers/types.js";
import type { DispatchResult } from "../runtime/dispatcher.js";

protected detectTerminalToolCall(
  _toolCalls: ToolCallResult[],
  _dispatchResult: DispatchResult,
): { name: string; data: unknown } | null {
  return null;
}
```

The planner override narrows `tc.input` before reading `reason`:

```ts
// src/agents/planner.ts
protected override detectTerminalToolCall(
  toolCalls: ToolCallResult[],
  dispatchResult: DispatchResult,
): { name: string; data: { reason: string } } | null {
  if (toolCalls.length !== 1) return null;
  const tc = toolCalls[0];
  if (tc.name !== "plan_done") return null;

  const result = dispatchResult.toolResults.find((tr) => tr.toolUseId === tc.id);
  if (!result || result.isError) return null;

  const input = tc.input;
  if (typeof input !== "object" || input === null) return null;
  const reasonField = (input as { reason?: unknown }).reason;
  if (typeof reasonField !== "string" || reasonField.trim() === "") return null;

  return { name: "plan_done", data: { reason: reasonField } };
}
```

Both signatures use the real `ToolCallResult` and `DispatchResult` types, so the override is type-checkable as written and matches what `BaseAgent.runLoop` passes in at the new call site.

### D.2 Drop the "no PlanService import under src/agents" constraint

r3 step 5 forbids any file under [src/agents](../../../../src/agents) from importing or constructing `PlanService`, but r3 step 14 imports and constructs it in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) ([./04-review-r3.md](./04-review-r3.md#L49-L52)).

r4 dissolves the contradiction by removing both halves:

- `AgentContext.planService` is dropped (see §A), so no production agent file has any reason to import `PlanService` in the first place. The architectural constraint is enforced by the type system: there is no `planService` field to populate, and `BaseAgent` does not depend on `PlanService`.
- The test fixture in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) is the inline stub from §C. No `PlanService` import is needed under [src/agents](../../../../src/agents); the real `PlanService` is exercised directly only in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts).

The post-condition for r4 is therefore not "grep that no file under [src/agents](../../../../src/agents) imports `PlanService`" (no rule needed) but "the dependency direction is correct": [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) is imported only by [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts), and any other non-agent module that already exists. `npx tsc --noEmit` is the enforcing oracle.

## E. r3 claims that survive r4 unchanged

- The `plan_done` tool schema, prompt rewrites in [prompts/planner.md](../../../../prompts/planner.md), `RECOVERY_PROMPT` / `CONTINUOUS_IMPROVEMENT_PROMPT` rewrites in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L525-L549), recovery-loop discriminator (`isPlanDoneCompletion`), dashboard formatter entry in [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts), and the `plan_done` listing in `PLAN_TOOLS` at [src/agents/base.ts](../../../../src/agents/base.ts#L1084-L1089) all carry over from r3.
- Exclusivity (single-call batch) and `toolUseId` matching from r3 §B.2 carry over verbatim.
- The legacy-token concatenation rule from r3 §C carries over. The post-condition `grep -rn PLAN_COMPLETE src/ prompts/` returns zero matches across the executable tree.
- The `plan_done` return type collapses from `Promise<{ ok: true; recorded: boolean } | PlanError>` to `Promise<{ ok: true } | PlanError>` (one fewer field, see §A). The dashboard formatter and dispatcher consumers do not depend on the dropped `recorded` field.

## F. Validation surface (forward-looking; full contract in Plan r4)

- `npx tsc --noEmit` (strict): the new hook signatures resolve `tc.input` as `unknown`, the override narrows before use, and the dropped `AgentContext.planService` field means no construction site needs to provide it.
- Focused vitest: [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) covers single-call termination, batched-with-plan-tool, batched-with-dispatch-tool, errored `plan_done` dispatch, signal-aborted-mid-call, second-cycle-uses-second-reason, and the legacy-token negative regression. [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) covers `PlanService.plan_done` validate-and-return-ok, validation error via direct call, validation error via `handleToolCall` (`isError: true`), and success via `handleToolCall` (`isError: false`).
- Full vitest: workspace green.
- `npm run build`: `dist/cli.js` produced.
- `grep -rn PLAN_COMPLETE src/ prompts/` returns zero matches (no `--exclude`, no `--include`).
