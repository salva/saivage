# G09 — Plan r4

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis (r4)**: [./01-analysis-r4.md](./01-analysis-r4.md)
**Design (r4)**: [./02-design-r4.md](./02-design-r4.md)
**r3 plan**: [./03-plan-r3.md](./03-plan-r3.md)
**r3 review**: [./04-review-r3.md](./04-review-r3.md)

All edits are inside `/home/salva/g/ml/saivage`. Paths below are repo-relative to that root.

## r4 deltas vs r3 (one bullet per r3 required change)

1. **Step 1** rewrites `plan_done` as stateless (drop `pendingCompletion`, `consumePendingCompletion()`, the `recorded` field). **Step 4** and **step 5** are deleted — `AgentContext.planService` is dropped and no construction sites are touched. **Step 8(a)** no longer reads `ctx.planService`; it reads `tc.input` directly with an `unknown` narrow.
2. **Step 6** combines the abort check: `if (this.abortSignal?.aborted || dispatchResult.aborted)` replaces the existing single check. The terminal hook moves after the combined check (still after the tool-result push). **Step 14** test 6 replaces r3's pre-aborted-signal test with a stub `mcpRuntime.callTool` that flips a shared `{ aborted: boolean }` during the call.
3. **Step 14** stub `mcpRuntime.callTool` for `plan_done` now THROWS on validation failure (mirrors [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L206)) and returns content on success, so the dispatcher's error-conversion path at [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197) is exercised. No `PlanService` is imported under [src/agents](../../../../src/agents).
4. **Step 6 and step 8(a)** use the real provider/dispatcher types: `ToolCallResult[]` (input is `unknown`, per [src/providers/types.ts](../../../../src/providers/types.ts#L40-L48)) and `DispatchResult` (from [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L35-L40)). `tc.input` is narrowed before reading `reason`. The r3 "no PlanService import under src/agents" constraint is dropped — there is nothing in [src/agents](../../../../src/agents) that needs `PlanService` anymore. **Step 15** drops the `recorded`/`consumePendingCompletion` assertions.

Every other step from [./03-plan-r3.md](./03-plan-r3.md) is retained unchanged unless explicitly modified below.

## Steps

### 1. Add stateless `plan_done` to `PlanService` (REVISED — drop pending state)

In [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts), next to the other tool methods:

```ts
async plan_done(args: { reason: string }): Promise<{ ok: true } | PlanError> {
  if (typeof args.reason !== "string" || args.reason.trim() === "") {
    return planError("VALIDATION_ERROR", "plan_done requires a non-empty reason");
  }
  return { ok: true };
}
```

No private field. No `consumePendingCompletion()`. No `plan.json` write. No history append. The method is pure validation.

### 2. Wire `plan_done` into the MCP dispatcher

Unchanged from [./03-plan-r3.md](./03-plan-r3.md) §2. In the `switch (toolName)` in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L367-L405), before `default`:

```ts
case "plan_done":
  result = await this.plan_done(args as { reason: string });
  break;
```

Existing `isError` detection at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L405-L408) flips `isError` for the validation branch (a `PlanError` is detected by `code` / `error` shape, identical to every other tool).

### 3. Add the `plan_done` tool schema

Unchanged from [./03-plan-r3.md](./03-plan-r3.md) §3. Append to `getToolSchemas()`:

```ts
{
  name: "plan_done",
  description:
    "Signal that ALL configured project objectives are verified complete with evidence from successful stages. " +
    "Call this once at the end of the planning session; this is the only way to end a planner session successfully. " +
    "Provide a one-paragraph reason summarising which objectives are satisfied and the evidence.",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string", description: "Why the project is complete." } },
    required: ["reason"],
  },
},
```

### 4. ~~Add `planService` to `AgentContext`~~ (DELETED)

r3 step 4 is removed. `AgentContext` in [src/agents/types.ts](../../../../src/agents/types.ts#L30-L56) is not modified.

### 5. ~~Pass `planService` through every agent context~~ (DELETED)

r3 step 5 is removed. No `AgentContext` construction site under [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [src/agents/](../../../../src/agents/), or anywhere else needs a new field. The r3 "no PlanService import under src/agents" constraint is dropped along with the field — there is no field to populate so no production agent file has a reason to import `PlanService`.

### 6. Add `detectTerminalToolCall` hook to `BaseAgent` and widen `runLoop` (REVISED — typed signature + combined abort check)

In [src/agents/base.ts](../../../../src/agents/base.ts), at the top of the file alongside the existing provider/dispatcher imports:

```ts
import type { ToolCallResult } from "../providers/types.js";
import type { DispatchResult } from "../runtime/dispatcher.js";
```

Widen the `runLoop` return type at [src/agents/base.ts](../../../../src/agents/base.ts#L229) from

```ts
Promise<{ text: string; finishReason: string; source?: LlmResponseSource }>
```

to

```ts
Promise<{
  text: string;
  finishReason: string;
  source?: LlmResponseSource;
  terminal?: { name: string; data: unknown };
}>
```

Add a protected hook on `BaseAgent` (default returns `null`) — types match the real provider/dispatcher contracts:

```ts
protected detectTerminalToolCall(
  _toolCalls: ToolCallResult[],
  _dispatchResult: DispatchResult,
): { name: string; data: unknown } | null {
  return null;
}
```

**Modify the post-dispatch block at [src/agents/base.ts](../../../../src/agents/base.ts#L335-L345).** The existing two lines

```ts
this.pushMessage({ role: "user", content: resultBlocks });

if (dispatchResult.aborted) {
  return { text: "Aborted during tool execution", finishReason: "abort" };
}
```

become

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

Two changes vs r3:

- The abort check is widened to OR `this.abortSignal?.aborted` so an abort that flipped DURING `processToolCalls` (e.g. inside `mcpRuntime.callTool` or a child agent) is observed at the `runLoop` level. The dispatcher only checks the signal in the per-call prologue ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L93-L101), [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L122-L128)), so the `runLoop` check is the canonical post-dispatch gate.
- The terminal hook is invoked AFTER the combined abort check, with the real `ToolCallResult[]` and `DispatchResult` types passed through.

### 7. Add `plan_done` to `PLAN_TOOLS`

Unchanged from [./03-plan-r3.md](./03-plan-r3.md) §7. In the `PLAN_TOOLS` set near [src/agents/base.ts](../../../../src/agents/base.ts#L1084-L1089), add `"plan_done"`. `WORKER_EXCLUDED_TOOLS` spreads `PLAN_TOOLS` so workers and the inspector are blocked transitively.

### 8. Implement the `PlannerAgent` terminal-tool override and consume the new finishReason (REVISED — narrowed unknown input, no service read)

In [src/agents/planner.ts](../../../../src/agents/planner.ts):

**(a) Override (REVISED vs r3 — typed `ToolCallResult[]`, narrowed `tc.input`, no `ctx.planService` read):**

Add imports at the top of [src/agents/planner.ts](../../../../src/agents/planner.ts):

```ts
import type { ToolCallResult } from "../providers/types.js";
import type { DispatchResult } from "../runtime/dispatcher.js";
```

Add the override inside `class PlannerAgent`:

```ts
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

`reason` comes from `tc.input`, validated for being a non-empty trimmed string at the type-narrow site AND already validated at MCP-dispatch time (confirmed by `result.isError === false`). No `PlanService` read, no shared cell.

**(b) Replace the regex block at [src/agents/planner.ts](../../../../src/agents/planner.ts#L87-L93)** with the structural-completion handling inside the `while (true)` loop in `run()`:

```ts
const loopResult = await this.runLoop();
const { text, finishReason } = loopResult;
await this.noteManager.acknowledgeNotes();

if (finishReason === "abort" || finishReason === "cancelled") {
  return { kind: "abort", reason: text };
}
if (finishReason === "max_compactions" || finishReason === "error") {
  return { kind: "failure", reason: text };
}
if (finishReason === "tool_terminal" && loopResult.terminal?.name === "plan_done") {
  const reason = (loopResult.terminal.data as { reason: string }).reason;
  return { kind: "success", data: { completion: "plan_done", summary: reason } };
}

// Otherwise: planner ended turn with text only → nudge (unchanged).
```

The existing nudge block at [src/agents/planner.ts](../../../../src/agents/planner.ts#L96-L116) is preserved verbatim. The regex line at [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93) and its two-line comment at [src/agents/planner.ts](../../../../src/agents/planner.ts#L89-L90) are deleted.

### 9. Rewrite the planner startup message

Unchanged from [./03-plan-r3.md](./03-plan-r3.md) §9. Replace bullet 6 at [src/agents/planner.ts](../../../../src/agents/planner.ts#L172):

> `6. Call plan_done(reason) once — and only once — when all configured objectives are verified complete and there is no continuous-improvement directive active. Do not emit any free-text completion signal. plan_done is the only way to end the planning session.`

### 10. Rewrite the planner system prompt

Unchanged from [./03-plan-r3.md](./03-plan-r3.md) §10. In [prompts/planner.md](../../../../prompts/planner.md):

- At [prompts/planner.md](../../../../prompts/planner.md#L41-L49), delete the literal-token completion bullet and any sentence containing the legacy contiguous token.
- Under the Plan MCP Service section around [prompts/planner.md](../../../../prompts/planner.md#L65), add:

  > `- plan_done(reason) — Signal that all configured objectives are verified complete. Call exactly once at the end of the planning session. Do not use for partial progress; do not use after a continuous-improvement directive is queued.`

- At [prompts/planner.md](../../../../prompts/planner.md#L137), replace the legacy completion paragraph with:

  > `Call plan_done(reason) only when ALL configured objectives are achieved and verified AND there is no explicit runtime instruction to continue improving. If the runtime injects a continuous-improvement instruction, create and dispatch the next bounded improvement stage instead of ending the session.`

After the rewrite the legacy contiguous token must not appear in [prompts/planner.md](../../../../prompts/planner.md).

### 11. Update the recovery loop discriminator

Unchanged from [./03-plan-r3.md](./03-plan-r3.md) §11. Near `hasSummary` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L825-L827):

```ts
interface PlanDoneCompletion { completion: "plan_done"; summary: string }
function isPlanDoneCompletion(value: unknown): value is PlanDoneCompletion {
  return !!value
    && typeof value === "object"
    && (value as { completion?: unknown }).completion === "plan_done"
    && typeof (value as { summary?: unknown }).summary === "string";
}
```

Rewrite the recovery branch at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L644):

```ts
if (result.kind === "success" && isPlanDoneCompletion(result.data)) {
  if (!runtime.config.runtime.continuousImprovement) {
    log.info(`[recovery] Planner completed via plan_done: ${result.data.summary}`);
    return result;
  }
  queuePlannerDirective(runtime, CONTINUOUS_IMPROVEMENT_PROMPT);
  await runtime.eventBus.publish({
    type: "plan_updated",
    summary: "Planner completed the active plan via plan_done. Continuous-improvement directive queued; restarting Planner.",
    timestamp: new Date().toISOString(),
  });
  log.info("[recovery] Planner completed via plan_done; continuous-improvement mode is enabled. Restarting planner");
  continue;
}
```

Update the third log line at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L648-L650) from the legacy-token wording to `Planner ended without plan_done`.

### 12. Rewrite `RECOVERY_PROMPT` and `CONTINUOUS_IMPROVEMENT_PROMPT`

Unchanged from [./03-plan-r3.md](./03-plan-r3.md) §12. In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L525-L549):

- Replace the "DO NOT say <legacy-token>" sentence with `DO NOT call plan_done unless ALL objectives are truly achieved with evidence from successful stages. If stages have escalated or failed, the objectives are NOT complete — fix the issues and retry.`
- Replace the "Only say <legacy-token>" sentence with `Only call plan_done if continuous-improvement mode has been disabled by runtime configuration or shutdown is requested.`

### 13. Add the dashboard formatter entry

Unchanged from [./03-plan-r3.md](./03-plan-r3.md) §13. In [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts), alongside `plan_complete_stage`, add a `plan_done` entry. Label `Planner completed`; body surfaces `input.reason`.

### 14. Rewrite the planner tests (REVISED — McpRuntime-mirroring stub + abort-mid-call test)

In [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts):

**(a) File header + token constant.** Rewrite the top-of-file docstring at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L1-L6):

```ts
/**
 * PlannerAgent regressions:
 *  - Terminal protocol: planner exits on a single-call plan_done tool batch
 *    when the dispatch result is non-errored.
 *  - Exclusivity: planner does not exit when plan_done is batched with any
 *    sibling tool call, when the plan_done result is errored, or when an
 *    abort signal is observed by runLoop after dispatch.
 *  - Legacy text protocol is dead: a bare legacy completion token in
 *    assistant content does not terminate the planner.
 *  - F14 invariant: BaseAgent.runLoop pushes the terminal assistant message
 *    once; PlannerAgent must not push it again before the nudge user message.
 */

// Legacy free-text completion marker built via concatenation so the
// post-condition `grep -rn PLAN_COMPLETE src/ prompts/` returns zero across
// the executable tree.
const LEGACY_TOKEN = "PLAN_" + "COMPLETE";
```

Place `LEGACY_TOKEN` at module scope above the `beforeEach` block.

**(b) Fixture — stub `mcpRuntime.callTool` mirrors `McpRuntime` semantics + plumb `abortSignal`.** Replace the `mcpRuntime` literal in `makePlannerContext` at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L60-L67) and change the function's return shape:

```ts
const validatePlanDone = (args: unknown): { ok: true } => {
  const reason =
    typeof args === "object" && args !== null && typeof (args as { reason?: unknown }).reason === "string"
      ? ((args as { reason: string }).reason)
      : "";
  if (reason.trim() === "") {
    // Mirrors the throw in [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts#L168-L206);
    // the dispatcher catches this and returns isError:true per
    // [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L146-L197).
    throw new Error('Tool "plan_done" on "plan" returned error: {"code":"VALIDATION_ERROR"}');
  }
  return { ok: true };
};

function makePlannerContext(
  root: string,
  router: unknown,
  opts: {
    abortSignal?: { aborted: boolean };
    onPlanDoneCall?: () => void; // hook fired before validation; used by abort test
  } = {},
): { ctx: AgentContext; abortSignal: { aborted: boolean } } {
  // ... existing setup (saivageDir, ensureDir, project literal) ...
  const sig = opts.abortSignal ?? { aborted: false };
  const ctx: AgentContext = {
    project: { /* unchanged */ },
    router: router as AgentContext["router"],
    mcpRuntime: {
      getAllTools: () => [
        {
          service: "plan",
          name: "plan_done",
          description: "completion signal",
          inputSchema: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
        },
        // Add other tool entries used by tests 3 and 4 (plan_add_stage, run_manager).
      ] as unknown as ReturnType<AgentContext["mcpRuntime"]["getAllTools"]>,
      callTool: async (service: string, tool: string, args: Record<string, unknown>) => {
        if (service === "plan" && tool === "plan_done") {
          opts.onPlanDoneCall?.();
          return validatePlanDone(args);
        }
        if (service === "plan" && tool === "plan_add_stage") return { ok: true };
        return { ok: true };
      },
    } as AgentContext["mcpRuntime"],
    agentId: "planner-1",
    role: "planner",
    stageId: undefined,
    modelSpec: "test/model",
  };
  return { ctx, abortSignal: sig };
}
```

If the live `RuntimeToolEntry` shape from [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts) requires additional fields, copy the production shape rather than the snippet above. The schema entries for `plan_add_stage` and `run_manager` are added because tests 3 and 4 require those tool names to resolve through the dispatcher.

The `abortSignal` is passed into `PlannerAgent` via `BaseAgentConfig`:

```ts
const { ctx, abortSignal } = makePlannerContext(tmpDir, router);
const planner = new PlannerAgent(ctx, childSpawner, { abortSignal });
```

The existing `PlannerAgent` constructor at [src/agents/planner.ts](../../../../src/agents/planner.ts#L45-L66) already accepts a `config?: Partial<BaseAgentConfig>`, and `BaseAgentConfig.abortSignal` is at [src/agents/base.ts](../../../../src/agents/base.ts#L110).

**(c) Replace the `describe` body with the eight tests below.** Each test follows the existing router-stub pattern at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L74-L153).

```ts
describe("PlannerAgent — plan_done terminal protocol", () => {
  it("terminates on a single plan_done tool call", async () => {
    // Router: call 1 returns toolCalls:[{ id:"tc-done-1", name:"plan_done",
    //   input:{ reason:"objectives verified" } }] with finishReason:"tool_use".
    // Asserts:
    //   result.kind === "success"
    //   result.data === { completion:"plan_done", summary:"objectives verified" }
    //   calls.length === 1
  });

  it("a second planner cycle uses the second reason (no carried state)", async () => {
    // Run planner #1 with reason "first" → assert summary === "first".
    // Build a fresh PlannerAgent against the SAME mcpRuntime stub; run
    // with reason "second" → assert summary === "second".
    // Asserts onPlanDoneCall was invoked exactly twice across both runs.
    // Confirms no fixture-side or service-side cell carries state turn-to-turn.
  });

  it("does not terminate when plan_done is batched with another plan tool", async () => {
    // Call 1: toolCalls = [
    //   { id:"tc-add",  name:"plan_add_stage", input:{ /* valid */ } },
    //   { id:"tc-done", name:"plan_done",      input:{ reason:"ok" } },
    // ].
    // Subsequent calls return text-only → nudge branch.
    // Asserts kind === "failure" after MAX_NUDGES.
  });

  it("does not terminate when plan_done is batched with a dispatch tool", async () => {
    // Same shape with run_manager as the sibling. childSpawner returns a
    // success result. Same kind:"failure" assertion.
  });

  it("does not terminate when the plan_done dispatch result is an error", async () => {
    // Call 1: toolCalls = [{ id:"tc-bad", name:"plan_done", input:{ reason:"" } }].
    // The stub validatePlanDone throws; the dispatcher catches and returns
    // isError:true. Override returns null → planner iterates → nudge →
    // kind:"failure" after MAX_NUDGES.
    // Additionally asserts the tool-result content in calls[1].messages
    // contains "VALIDATION_ERROR" — proves the dispatcher's error-conversion
    // path actually ran.
  });

  it("aborts when the abort signal flips during mcpRuntime.callTool", async () => {
    // Fixture: abortSignal = { aborted:false }; onPlanDoneCall toggles it
    // to true before validatePlanDone returns success.
    // Call 1: toolCalls = [{ id:"tc-done", name:"plan_done",
    //   input:{ reason:"ok" } }] (finishReason:"tool_use").
    // Dispatcher returns aborted:false (the per-call prologue at
    // [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L93)
    // ran before the flip) AND isError:false. The new check in runLoop
    // (`this.abortSignal?.aborted || dispatchResult.aborted`) reads
    // aborted:true and returns finishReason:"abort".
    // Asserts result.kind === "abort". Asserts the terminal hook was NOT
    // reached: a stub `detectTerminalToolCall` is not directly observable,
    // but `result.kind === "success"` would have been produced if the
    // hook had fired before the abort check. The negative assertion is
    // therefore "result.kind !== 'success'" together with the explicit
    // "kind === 'abort'" check.
  });

  it("does not terminate on a bare legacy-text response", async () => {
    // Stub router returns { content: LEGACY_TOKEN, toolCalls: [],
    //   finishReason:"end_turn" } on every call.
    // Planner enters nudge branch; result.kind === "failure" after MAX_NUDGES.
    // The contiguous literal never appears in source — LEGACY_TOKEN is
    // concatenated.
  });

  it("does not duplicate the nudged assistant message in this.messages", async () => {
    // F14 invariant. Identical structure to the existing test at
    // [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L77-L153),
    // with call 2 now returning the plan_done tool_use:
    //   { content: "", toolCalls: [{ id:"tc-done-1", name:"plan_done",
    //     input:{ reason:"ack" } }], finishReason:"tool_use" }
    // The duplication count assertion and the next-message SYSTEM prefix
    // assertion are unchanged.
  });
});
```

Tests 3, 4, 5, 6 are NEW vs r2; test 6 replaces r3's un-runnable pre-aborted-signal test (review point 2). Test 2 is the no-stale-state regression (review point 1). Test 5 exercises the dispatcher's error-conversion path the r3 stub bypassed (review point 3). Test 7 uses the concatenated token (review point 3 from r2, retained).

### 15. Add `PlanService` unit tests (REVISED — drop pending-state assertions)

In [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) inside the existing `describe("PlanService", ...)` block around [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L348-L510):

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

The r3 "plan_done records once and consumePendingCompletion clears it" test is dropped (the method no longer exists). The `recorded: true/false` assertions are dropped (the field is dropped).

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

- `npx tsc --noEmit` → 0 errors. The hook signatures resolve `tc.input` as `unknown`; the planner override narrows before reading `reason`. The deleted `AgentContext.planService` field means no construction site needs to be updated.
- `npx eslint .` → 0 errors.
- Focused vitest: all eight tests in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) green; all four new `plan_done` tests in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) green.
- Full vitest: workspace green.
- `npm run build` → `dist/cli.js` produced without TS errors.
- `grep -rn PLAN_COMPLETE src/ prompts/` → **zero matches**. No `--exclude`, no `--include`. Executable as written. The legacy token only appears in `SPEC/v2/review-2026-05-round2/G09/*.md`.

## Validation

- **Static**: `npx tsc --noEmit` passes; `npx eslint .` passes; the production grep returns zero across the executable tree.
- **Focused unit**: see step 16. Test 1 covers the happy-path single-turn termination. Test 2 is the second-reason regression for stale-state (review point 1). Tests 3, 4, 5, 6 cover exclusivity and abort precedence (review point 2). Test 5 also covers the dispatcher's error-conversion semantics (review point 3). Test 7 uses the concatenated `LEGACY_TOKEN` (review point 3 from r2). Test 8 is the F14 invariant rewritten to exercise the new termination path.
- **Full vitest**: workspace green. The deleted `AgentContext.planService` field is the symmetric inverse of r3 step 5 — no construction site change is required; tests that did not depend on `planService` continue to compile.
- **Build**: `npm run build` succeeds.

## Rollback

Clean revert. `git restore -- src/mcp/plan-server.ts src/agents/base.ts src/agents/planner.ts src/agents/planner.nudge.test.ts src/runtime/runtime.test.ts src/server/bootstrap.ts prompts/planner.md web/src/utils/toolFormatters.ts` returns the planner to the legacy free-text protocol. No on-disk format change is introduced anywhere (`plan_done` does not write disk), so no state cleanup is required.

## Operator-gated saivage-v3 restart

This finding is scoped to the saivage v2 codebase under `/home/salva/g/ml/saivage`. The saivage-v3 harness at `/home/salva/g/ml/saivage-v3` and the LXC service `saivage.service` on `saivage-v3` (10.0.3.112) are NOT affected by this plan — saivage-v3 is a separate project tree consuming saivage v2 as the build, and a v2 deployment refresh on saivage-v3 is only required if saivage-v3's own runtime depends on the changed v2 dist. Defer container restart until the operator confirms; do not restart `saivage.service` as part of this plan.
