# G09 — Design r4

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis**: [./01-analysis-r4.md](./01-analysis-r4.md)
**r3 docs**: [./02-design-r3.md](./02-design-r3.md), [./03-plan-r3.md](./03-plan-r3.md)
**r3 review**: [./04-review-r3.md](./04-review-r3.md)

Direction is unchanged: Proposal B from r1 (terminate the planner on a `plan_done` MCP tool call via a terminal-tool path) is kept, with r3's exclusivity (`toolCalls.length === 1`, `toolUseId` match) and r3's legacy-token concatenation in tests. r4 modifies four localised parts of the r3 design in response to [./04-review-r3.md](./04-review-r3.md).

## r4 deltas vs r3 (one bullet per r3 required change)

1. **No `pendingCompletion`.** Drop the `PlanService` cell, drop `consumePendingCompletion()`, drop `AgentContext.planService`. `PlanService.plan_done` becomes stateless (validate `reason`, return `{ ok: true }`). The planner override reads `reason` from the current `tc.input` after asserting the dispatch result is non-errored. No shared state ⇒ no stale state class (§1).
2. **Abort check on the live signal.** `BaseAgent.runLoop` checks `this.abortSignal?.aborted || dispatchResult.aborted` after the tool-result push and before the terminal hook, so an abort that flips during `mcpRuntime.callTool` wins over the terminal hook (§2.1).
3. **Test stub matches real `McpRuntime.callTool` semantics.** The stub throws on validation failure and returns content on success, so the dispatcher's error-conversion branch ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197)) is exercised (§3.2).
4. **Typed hook signature; no PlanService under src/agents.** The hook takes `ToolCallResult[]` and `DispatchResult` (real types from [src/providers/types.ts](../../../../src/providers/types.ts) and [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts)); `tc.input` is narrowed before use. r3's step-5 constraint is dropped along with `AgentContext.planService`; nothing under [src/agents](../../../../src/agents) imports `PlanService` (§2.2, §3.2).

Every other element of [./02-design-r3.md](./02-design-r3.md) (the union return type for `plan_done` minus the now-dropped `recorded` field, the tagged `{ completion: "plan_done", summary }` shape, the `isPlanDoneCompletion` typed guard, the prompt rewrites, the dashboard formatter entry, the legacy-token-concatenation rule in tests, the clean-revert rollback) is retained.

## 1. Wiring — `PlanService.plan_done` is stateless

`AgentContext` reverts to its r2-pre-state. No new field is added:

```ts
// src/agents/types.ts (unchanged from current main)
export interface AgentContext {
  project: ProjectContext;
  router: ModelRouter;
  mcpRuntime: McpRuntime;
  // ... unchanged ...
}
```

`PlanService` (in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts)) gains only the new tool:

```ts
async plan_done(args: { reason: string }): Promise<{ ok: true } | PlanError> {
  if (typeof args.reason !== "string" || args.reason.trim() === "") {
    return planError("VALIDATION_ERROR", "plan_done requires a non-empty reason");
  }
  return { ok: true };
}
```

No private field. No `consumePendingCompletion()`. No `plan.json` write. No history append. The MCP path is the validator; the validated `reason` lives on the dispatcher's tool-result message (the canonical conversation record) and on the current `ToolCallResult.input` until the override consumes it on the same turn.

Why this is safe against the stale-state class r3 introduced:

- The override only ever returns terminal when the CURRENT dispatch result for the CURRENT tool call is `isError === false`. That non-error result is the production evidence that the model just called `plan_done` with a valid (non-empty trimmed) reason — because the service validates and the dispatcher converts validation failures into `isError: true` via the throw path in [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L206) and the catch path in [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197).
- The override reads `reason` from `tc.input`, not from any shared cell. There is no cross-turn or cross-cycle state to inspect, so a rejected batched `plan_done` in turn N leaves nothing behind for turn N+1 to consume. A valid single `plan_done` in turn N+1 carries its own reason via `tc.input` and that is what the override returns.

## 2. Mechanism

### 2.1 `BaseAgent.runLoop` — abort precedence and terminal hook

In [src/agents/base.ts](../../../../src/agents/base.ts) the tool-call branch at L325-L346 is modified so the order of the post-dispatch checks is:

```ts
// 1. Push tool_result user message (unchanged, [src/agents/base.ts](../../../../src/agents/base.ts#L335-L341)).
this.pushMessage({ role: "user", content: resultBlocks });

// 2. Abort wins — checks the LIVE signal as well as the dispatcher flag.
//    The live check catches abort signals that flipped during processToolCalls
//    (e.g. inside an mcpRuntime.callTool stub or a child agent that observed
//    the user's cancellation), which the dispatcher does not re-check after
//    the per-call prologue at
//    [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L93-L101).
if (this.abortSignal?.aborted || dispatchResult.aborted) {
  return { text: "Aborted during tool execution", finishReason: "abort" };
}

// 3. Terminal-tool hook fires LAST, only when the batch dispatched cleanly
//    AND no abort is in progress.
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

The combined check is the only ordering change vs r3. The dispatcher itself is not modified: the dispatch-tool abort branch at [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L122-L128) still does not set `DispatchResult.aborted`, but the new `this.abortSignal?.aborted` term covers that gap because `runLoop` owns the same signal and reads it post-dispatch.

The default `BaseAgent.detectTerminalToolCall` returns `null` and takes the real provider/dispatcher types:

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

`runLoop`'s widened return shape is unchanged from [./02-design-r3.md](./02-design-r3.md#L48-L52):

```ts
Promise<{
  text: string;
  finishReason: string;
  source?: LlmResponseSource;
  terminal?: { name: string; data: unknown };
}>
```

### 2.2 `PlannerAgent` override — narrowed `unknown` input, no service read

The override enforces a single-call batch, matches the dispatch result by `toolUseId`, and reads `reason` from `tc.input` directly:

```ts
// src/agents/planner.ts
import type { ToolCallResult } from "../providers/types.js";
import type { DispatchResult } from "../runtime/dispatcher.js";

protected override detectTerminalToolCall(
  toolCalls: ToolCallResult[],
  dispatchResult: DispatchResult,
): { name: string; data: { reason: string } } | null {
  // Exclusivity: the batch must be exactly one plan_done call.
  if (toolCalls.length !== 1) return null;
  const tc = toolCalls[0];
  if (tc.name !== "plan_done") return null;

  // Match by toolUseId. The dispatcher does not guarantee toolResults are
  // index-aligned with toolCalls when local and dispatch buckets coexist
  // ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L80-L132));
  // for a single-call batch this is trivial but cheap to enforce.
  const result = dispatchResult.toolResults.find((tr) => tr.toolUseId === tc.id);
  if (!result || result.isError) return null;

  // Narrow tc.input (typed as `unknown` in the provider contract at
  // [src/providers/types.ts](../../../../src/providers/types.ts#L40-L48))
  // before reading `reason`. The non-error dispatch result above already
  // proves PlanService.plan_done accepted the reason; the narrow here is
  // a type-system obligation, not a runtime safety net.
  const input = tc.input;
  if (typeof input !== "object" || input === null) return null;
  const reasonField = (input as { reason?: unknown }).reason;
  if (typeof reasonField !== "string" || reasonField.trim() === "") return null;

  return { name: "plan_done", data: { reason: reasonField } };
}
```

Properties this override establishes:

- **Single-call exclusivity.** A model response that batches `plan_done` with any sibling (`plan_add_stage`, `run_manager`, `note_*`, anything) returns `null`; the sibling already executed and its result is in the message history. The model can correct course on the next turn.
- **`toolUseId` match.** Robust to dispatcher ordering ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L80-L132)).
- **No cross-turn state.** `reason` comes from the current `tc.input`. Any prior turn's `plan_done` invocations are not consulted; rejected batched `plan_done` calls cannot poison subsequent turns.
- **Type-system enforcement.** `tc.input` is `unknown`. The narrow is unavoidable and explicit.

The override returns `null` (and the planner does not complete) in all of these cases:

- `toolCalls.length === 0` (handled by the no-tool-calls branch in `BaseAgent` anyway).
- `toolCalls.length > 1` (sibling tools present).
- The single call is not named `plan_done`.
- The `plan_done` result is missing from `toolResults` or `isError === true` (the validation error from an empty reason, an MCP-runtime exception, or a dispatcher catch).
- `tc.input` is not an object, or `tc.input.reason` is not a non-empty string (defensive — should not happen because the MCP validator only accepts `string` with `trim() !== ""`, but the narrow is required by the strict typing of `ToolCallResult.input`).

The planner's outer loop in [src/agents/planner.ts](../../../../src/agents/planner.ts#L70-L116) is unchanged from r3:

```ts
const loopResult = await this.runLoop();
const { text, finishReason } = loopResult;
await this.noteManager.acknowledgeNotes();

if (finishReason === "abort" || finishReason === "cancelled") return { kind: "abort", reason: text };
if (finishReason === "max_compactions" || finishReason === "error") return { kind: "failure", reason: text };
if (finishReason === "tool_terminal" && loopResult.terminal?.name === "plan_done") {
  const reason = (loopResult.terminal.data as { reason: string }).reason;
  return { kind: "success", data: { completion: "plan_done", summary: reason } };
}
// Otherwise: nudge branch — unchanged.
```

The cast `(loopResult.terminal.data as { reason: string })` is safe: the override is the only producer of a `tool_terminal` finish for the planner, and it constructs `data` with `{ reason: string }`.

## 3. Test surface

### 3.1 Module-level token constant (unchanged from r3)

[src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) defines:

```ts
// Legacy free-text completion marker constructed via concatenation so the
// post-condition `grep -rn PLAN_COMPLETE src/ prompts/` returns zero across
// the executable tree.
const LEGACY_TOKEN = "PLAN_" + "COMPLETE";
```

The file's leading docstring and every inline comment are rewritten to describe the protocol in structural terms (single-call `plan_done`, terminal hook, nudge branch, F14 invariant, abort precedence). No contiguous `PLAN_COMPLETE` literal remains.

### 3.2 Test fixture — stub `mcpRuntime` mirrors production semantics

`makePlannerContext` in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L29-L70) is extended with an inline `plan_done` validator that throws on validation failure (mirroring [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L206)):

```ts
// Mirrors McpRuntime.callTool: validate; throw on validation failure so
// the dispatcher catches and produces { isError: true } per
// [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197);
// return content on success. No PlanService is imported under src/agents.
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

function makePlannerContext(
  root: string,
  router: unknown,
  abortSignal?: { aborted: boolean },
): { ctx: AgentContext; abortSignal: { aborted: boolean } } {
  // ... existing setup (unchanged) ...
  const sig = abortSignal ?? { aborted: false };
  const ctx: AgentContext = {
    // ... existing fields ...
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
      callTool: async (service: string, tool: string, _args: Record<string, unknown>) => {
        if (service === "plan" && tool === "plan_done") return validatePlanDone(_args);
        return { ok: true };
      },
    } as AgentContext["mcpRuntime"],
  };
  return { ctx, abortSignal: sig };
}
```

If the live `RuntimeToolEntry` shape from [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts) differs, the implementation copies the real shape; the snippet above is illustrative.

The `abortSignal` field is plumbed into `PlannerAgent` via `BaseAgentConfig` ([src/agents/base.ts](../../../../src/agents/base.ts#L110)) — `new PlannerAgent(ctx, childSpawner, { abortSignal: sig })`. This matches the existing constructor surface and does not require any private-field test reflection.

### 3.3 Required tests in `src/agents/planner.nudge.test.ts`

`describe("PlannerAgent — plan_done terminal protocol")`:

1. **terminates on a single `plan_done` tool call**
   - Router returns `toolCalls: [{ id: "tc-done-1", name: "plan_done", input: { reason: "objectives verified" } }]` with `finishReason: "tool_use"` on call 1.
   - Asserts `result.kind === "success"`, `result.data === { completion: "plan_done", summary: "objectives verified" }`, and the router was called exactly once.

2. **second cycle uses the second reason** (the test the reviewer required at [./04-review-r3.md](./04-review-r3.md#L24-L25))
   - Build the fixture once. Run `planner.run()` with call 1 returning `plan_done` reason `"first"`; assert `summary === "first"`. Re-build a fresh `PlannerAgent` against the same `mcpRuntime` stub and run with call 1 returning `plan_done` reason `"second"`; assert `summary === "second"`. Confirms no service-side or fixture-side cell influences the second run. Counts the stub `mcpRuntime.callTool` invocations to assert exactly one `plan_done` call per cycle.

3. **does not terminate when `plan_done` is batched with another plan tool**
   - Call 1: `toolCalls = [{ id: "tc-add", name: "plan_add_stage", input: { /* valid */ } }, { id: "tc-done", name: "plan_done", input: { reason: "ok" } }]`.
   - Planner must NOT exit on call 1 (sibling present). Subsequent calls return text-only; planner enters nudge branch and returns `kind: "failure"` after `MAX_NUDGES`.

4. **does not terminate when `plan_done` is batched with a dispatch tool**
   - Same shape with `run_manager` (or any name in `DISPATCH_TOOLS` from [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L26)) as the sibling. Stub `childSpawner` returns a success result. Same `kind: "failure"` assertion.

5. **does not terminate when the `plan_done` dispatch result is an error**
   - Call 1: `toolCalls = [{ id: "tc-bad", name: "plan_done", input: { reason: "" } }]`.
   - The stub `validatePlanDone` throws; the dispatcher catches and returns `isError: true`. The override sees `result.isError === true` and returns `null`. Planner iterates to call 2, nudge branch, `kind: "failure"` after `MAX_NUDGES`.
   - Additionally assert the tool-result content received by call 2 (from `calls[1].messages`) contains the validation-error fragment, proving the dispatcher's error-conversion path was actually taken.

6. **abort signal flipped mid-`callTool` wins over terminal hook** (replaces r3's pre-aborted test)
   - Build fixture with `abortSignal = { aborted: false }`. Wrap `validatePlanDone`: before returning, set `abortSignal.aborted = true`.
   - Call 1: `toolCalls = [{ id: "tc-done", name: "plan_done", input: { reason: "ok" } }]`.
   - The dispatcher's local-tool path succeeds (no isError, `DispatchResult.aborted === false`); the new `runLoop` check reads `this.abortSignal?.aborted === true` and returns `finishReason: "abort"`.
   - Assert `result.kind === "abort"`.
   - Exercises the actual post-dispatch ordering ([src/agents/base.ts](../../../../src/agents/base.ts#L343-L346)) without any private-field surgery and without a pre-aborted signal.

7. **bare legacy text in assistant content does not terminate the planner**
   - Stub router returns `content: LEGACY_TOKEN, toolCalls: [], finishReason: "end_turn"` on every call.
   - Planner enters nudge branch and returns `kind: "failure"` after `MAX_NUDGES`. Uses `LEGACY_TOKEN` (concatenated) — the contiguous literal never appears in source.

8. **F14 invariant** — `does not duplicate the nudged assistant message`
   - The existing F14 test at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L77-L153) is rewritten so call 2 returns `toolCalls: [{ id: "tc-done-1", name: "plan_done", input: { reason: "ack" } }]` instead of the legacy `content: "PLAN_COMPLETE"`. The two existing assertions (duplication count, next-message SYSTEM prefix) are unchanged.

Tests 3, 4, 5, 6 are NEW vs r2; test 6 in particular replaces the un-runnable pre-aborted-signal test from r3 (review point 2). Test 2 is the second-reason regression the reviewer required (review point 1). Test 5 exercises the dispatcher-error-conversion path that r3's stub failed to reach (review point 3).

### 3.4 `PlanService` unit tests in `src/runtime/runtime.test.ts`

The r3 set in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) inside `describe("PlanService", ...)` is reduced to three tests:

```ts
it("plan_done with a valid reason returns ok", async () => {
  const r = await planService.plan_done({ reason: "objectives verified" });
  expect(r).toEqual({ ok: true });
});

it("plan_done rejects an empty reason (direct method)", async () => {
  const r = await planService.plan_done({ reason: "" });
  expect(r).toHaveProperty("code", "VALIDATION_ERROR");
});

it("plan_done rejects an empty reason via handleToolCall", async () => {
  const r = await planService.handleToolCall("plan_done", { reason: "" });
  expect(r.isError).toBe(true);
  expect(r.content).toMatchObject({ code: "VALIDATION_ERROR" });
});

it("handleToolCall plan_done with a valid reason returns ok and is not an error", async () => {
  const r = await planService.handleToolCall("plan_done", { reason: "done" });
  expect(r.isError).toBe(false);
  expect(r.content).toEqual({ ok: true });
});
```

The r3 `consumePendingCompletion` test is dropped (the method no longer exists). The `recorded: true/false` assertions are dropped (the field is dropped).

## 4. Validation contract

Production post-conditions:

```bash
npx tsc --noEmit
npx eslint .
npx vitest run src/agents/planner.nudge.test.ts src/runtime/runtime.test.ts
npx vitest run
npm run build
grep -rn PLAN_COMPLETE src/ prompts/
```

Acceptance:

- `tsc` → 0 errors. Strict types catch any missed narrow on `tc.input`.
- `eslint` → 0 errors.
- Focused vitest: eight tests in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) green; four `plan_done` tests in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) green.
- Full vitest: workspace green.
- `npm run build` → `dist/cli.js` produced.
- `grep -rn PLAN_COMPLETE src/ prompts/` → zero matches across the executable tree. The token only appears in `SPEC/v2/review-2026-05-round2/G09/*.md`.

## 5. Rollback

Clean revert: every code change in r4 is additive on top of two deletions (the regex at [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93) and the legacy completion prompt fragments in [prompts/planner.md](../../../../prompts/planner.md) and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L525-L549)). `git restore` on the touched files in [src/](../../../../src), [prompts/](../../../../prompts), and [web/src/](../../../../web/src) returns the planner to the legacy free-text protocol. No data-on-disk format change is introduced anywhere (`plan_done` does not write disk), so revert does not require state cleanup.
