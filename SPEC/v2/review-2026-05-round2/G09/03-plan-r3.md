# G09 — Plan r3

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis (r3)**: [./01-analysis-r3.md](./01-analysis-r3.md)
**Design (r3)**: [./02-design-r3.md](./02-design-r3.md)
**r2 plan**: [./03-plan-r2.md](./03-plan-r2.md)
**r2 review**: [./04-review-r2.md](./04-review-r2.md)

All edits are inside `/home/salva/g/ml/saivage`. Paths below are repo-relative to that root.

## r3 deltas vs r2 (one bullet per r2 required change)

1. **Step 8** (planner override) now consumes `pendingCompletion` and only triggers on single-call batches matched by `toolUseId`. Step 14 (planner tests) gets a consume-on-success assertion, a fresh-cycle-records assertion, batched-with-sibling negative tests, an errored-`plan_done` negative test, and an aborted-dispatch negative test.
2. **Step 6** (runLoop insertion) reorders: abort check first, terminal hook second. Step 8 enforces `toolCalls.length === 1` and `toolUseId` matching.
3. **Step 14** constructs the legacy free-text token via concatenation (`const LEGACY_TOKEN = "PLAN_" + "COMPLETE";`). Step 16's `grep -rn PLAN_COMPLETE src/ prompts/` is now executable as written and must return zero matches across the entire executable tree.

Every other step from [./03-plan-r2.md](./03-plan-r2.md) is retained unchanged unless explicitly modified below.

## Steps

### 1. Add `pendingCompletion`, `plan_done`, `consumePendingCompletion` to `PlanService`

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §1. In [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) (private fields region near [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L46-L60)):

```ts
private pendingCompletion: { reason: string; requested_at: string } | null = null;
```

Next to the other tool methods:

```ts
async plan_done(args: { reason: string }): Promise<{ ok: true; recorded: boolean } | PlanError> {
  if (typeof args.reason !== "string" || args.reason.trim() === "") {
    return planError("VALIDATION_ERROR", "plan_done requires a non-empty reason");
  }
  if (this.pendingCompletion) {
    return { ok: true, recorded: false };
  }
  this.pendingCompletion = { reason: args.reason, requested_at: new Date().toISOString() };
  return { ok: true, recorded: true };
}

consumePendingCompletion(): { reason: string; requested_at: string } | null {
  const v = this.pendingCompletion;
  this.pendingCompletion = null;
  return v;
}
```

No disk write. No `plan.json` mutation. No history append.

### 2. Wire `plan_done` into the MCP dispatcher

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §2. In the `switch (toolName)` in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L367-L405), before `default`:

```ts
case "plan_done":
  result = await this.plan_done(args as { reason: string });
  break;
```

Existing isError detection at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L405-L408) flips `isError` for the validation branch.

### 3. Add the `plan_done` tool schema

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §3. Append to `getToolSchemas()`:

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

### 4. Add `planService` to `AgentContext`

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §4. In [src/agents/types.ts](../../../../src/agents/types.ts#L30-L56) add the import and the required field:

```ts
import type { PlanService } from "../mcp/plan-server.js";

export interface AgentContext {
  project: ProjectContext;
  router: ModelRouter;
  mcpRuntime: McpRuntime;
  planService: PlanService;
  // ... rest unchanged
}
```

### 5. Pass `planService` through every agent context

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §5. In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) the planner construction site (the `ctx` literal for the planner spawn near [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L155-L169) / the planner-context builder, depending on the actual code shape after type addition) adds `planService: runtime.planService`. Repeat for every manager / worker / inspector / chat context construction site — TypeScript will fail compilation until every site is updated.

Constraint (code-review level): no file under `src/agents/` may import `PlanService` or call `new PlanService(...)`. The only constructor call remains at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L156).

### 6. Add `detectTerminalToolCall` hook to `BaseAgent` and widen `runLoop` return (REORDERED)

In [src/agents/base.ts](../../../../src/agents/base.ts), widen the `runLoop` return type from

```ts
Promise<{ text: string; finishReason: string; source?: LlmResponseSource }>
```

to

```ts
Promise<{ text: string; finishReason: string; source?: LlmResponseSource; terminal?: { name: string; data: unknown } }>
```

Add a protected hook on `BaseAgent` (default returns `null`):

```ts
protected detectTerminalToolCall(
  _toolCalls: { id: string; name: string; input: Record<string, unknown> }[],
  _dispatchResult: { toolResults: { toolUseId: string; content: unknown; isError: boolean }[] },
): { name: string; data: unknown } | null {
  return null;
}
```

**Insertion ordering (REVISED vs r2).** In `runLoop`, immediately after the tool-result push at [src/agents/base.ts](../../../../src/agents/base.ts#L335-L341), the existing `if (dispatchResult.aborted)` check at [src/agents/base.ts](../../../../src/agents/base.ts#L343-L345) STAYS exactly where it is. The terminal-hook block goes AFTER it:

```ts
this.pushMessage({ role: "user", content: resultBlocks });

if (dispatchResult.aborted) {
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

This ordering — push results → abort wins → terminal hook last — preserves abort precedence in line with [src/agents/base.ts](../../../../src/agents/base.ts#L327-L346) and ensures the terminal hook only fires on a complete, non-aborted dispatch.

### 7. Add `plan_done` to `PLAN_TOOLS`

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §7. In the `PLAN_TOOLS` set near [src/agents/base.ts](../../../../src/agents/base.ts#L1084-L1089), add `"plan_done"`. `WORKER_EXCLUDED_TOOLS` spreads `PLAN_TOOLS` so workers are blocked transitively.

### 8. Implement the `PlannerAgent` terminal-tool override and consume the new finishReason (REVISED)

In [src/agents/planner.ts](../../../../src/agents/planner.ts):

**(a) Override (REVISED vs r2 — exclusive single-call batch, `toolUseId` match, `pendingCompletion` consume):**

```ts
protected override detectTerminalToolCall(
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[],
  dispatchResult: { toolResults: { toolUseId: string; content: unknown; isError: boolean }[] },
): { name: string; data: { reason: string } } | null {
  if (toolCalls.length !== 1) return null;
  const tc = toolCalls[0];
  if (tc.name !== "plan_done") return null;

  const r = dispatchResult.toolResults.find((tr) => tr.toolUseId === tc.id);
  if (!r || r.isError) return null;

  const consumed = this.ctx.planService.consumePendingCompletion();
  const reason = consumed?.reason
    ?? (typeof tc.input?.["reason"] === "string" ? (tc.input["reason"] as string) : "");
  if (reason.trim() === "") return null;

  return { name: "plan_done", data: { reason } };
}
```

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

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §9. Replace bullet 6 at [src/agents/planner.ts](../../../../src/agents/planner.ts#L172):

> `6. Call plan_done(reason) once — and only once — when all configured objectives are verified complete and there is no continuous-improvement directive active. Do not emit any free-text completion signal. plan_done is the only way to end the planning session.`

### 10. Rewrite the planner system prompt

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §10. In [prompts/planner.md](../../../../prompts/planner.md):

- At [prompts/planner.md](../../../../prompts/planner.md#L41-L49), delete the literal-token completion bullet and any `**NEVER say "PLAN_COMPLETE" unless …**` sentence.
- Under the Plan MCP Service section around [prompts/planner.md](../../../../prompts/planner.md#L65), add:

  > `- plan_done(reason) — Signal that all configured objectives are verified complete. Call exactly once at the end of the planning session. Do not use for partial progress; do not use after a continuous-improvement directive is queued.`

- At [prompts/planner.md](../../../../prompts/planner.md#L137), replace the legacy completion paragraph with:

  > `Call plan_done(reason) only when ALL configured objectives are achieved and verified AND there is no explicit runtime instruction to continue improving. If the runtime injects a continuous-improvement instruction, create and dispatch the next bounded improvement stage instead of ending the session.`

After the rewrite the legacy token must not appear in [prompts/planner.md](../../../../prompts/planner.md).

### 11. Update the recovery loop discriminator

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §11. Near `hasSummary` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L825-L827):

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

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §12. In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L525-L549):

- Replace the "DO NOT say <legacy-token>" sentence with `DO NOT call plan_done unless ALL objectives are truly achieved with evidence from successful stages. If stages have escalated or failed, the objectives are NOT complete — fix the issues and retry.`
- Replace the "Only say <legacy-token>" sentence with `Only call plan_done if continuous-improvement mode has been disabled by runtime configuration or shutdown is requested.`

### 13. Add the dashboard formatter entry

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §13. In [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts), alongside `plan_complete_stage`, add a `plan_done` entry. Label `Planner completed`; body surfaces `input.reason`.

### 14. Rewrite the planner tests (REVISED — token concatenation + new negative tests + consume assertion)

In [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts):

**(a) File header + token constant.** Rewrite the top-of-file docstring at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L1-L6) to:

```ts
/**
 * PlannerAgent regressions:
 *  - Terminal protocol: planner exits on a single-call plan_done tool batch
 *    and consumes PlanService.pendingCompletion.
 *  - Exclusivity: planner does not exit when plan_done is batched with any
 *    sibling tool call or when the plan_done result is errored / aborted.
 *  - Legacy text protocol is dead: a bare legacy completion token in
 *    assistant content does not terminate the planner.
 *  - F14 invariant: BaseAgent.runLoop pushes the terminal assistant message
 *    once; PlannerAgent must not push it again before the nudge user
 *    message.
 */

// Legacy free-text completion marker constructed via concatenation so the
// post-condition `grep -rn PLAN_COMPLETE src/ prompts/` returns zero across
// the executable tree.
const LEGACY_TOKEN = "PLAN_" + "COMPLETE";
```

Place `LEGACY_TOKEN` at module scope above the `beforeEach` block.

**(b) Stub `planService` + stub `mcpRuntime`.** Replace the `mcpRuntime` literal in `makePlannerContext` at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L60-L67) and add a `planService` field to the returned `AgentContext`:

```ts
import { PlanService } from "../mcp/plan-server.js";
// ...
const planService = new PlanService(saivageDir);
await planService.init();

return {
  // ... existing fields ...
  planService,
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
      if (service === "plan" && tool === "plan_done") {
        return await planService.plan_done(args as { reason: string });
      }
      return { ok: true };
    },
  } as AgentContext["mcpRuntime"],
};
```

If the live `McpRuntime.getAllTools()` element shape differs from the snippet above, copy the actual shape from [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts) when implementing — match the runtime contract, not this snippet verbatim.

Either change `makePlannerContext` to return `{ ctx, planService }` (so tests can re-read the service) or attach it to the context's `planService` field and have tests read `ctx.planService` directly. The latter is simpler.

**(c) Required tests** (replace the file's `describe` body with these — the existing F14 test is rewritten in (c.8)):

```ts
describe("PlannerAgent — plan_done terminal protocol", () => {
  it("terminates on a single plan_done tool call and consumes pending completion", async () => {
    // Router returns toolCalls: [{ id:"tc-done-1", name:"plan_done",
    //   input:{ reason:"objectives verified" } }] with finishReason:"tool_use".
    // Asserts:
    //   result.kind === "success"
    //   result.data === { completion: "plan_done", summary: "objectives verified" }
    //   calls.length === 1                                  // single-turn
    //   ctx.planService.consumePendingCompletion() === null // consumed by hook
  });

  it("allows a fresh planner cycle to record a new completion after consume", async () => {
    // Same fixture re-used across two planner.run() calls. After cycle 1
    // completes, directly call planService.plan_done({ reason: "third" })
    // and assert { ok:true, recorded:true }; then consumePendingCompletion
    // returns { reason: "third", ... }. Confirms the previous cycle left
    // the cell clean.
  });

  it("does not terminate when plan_done is batched with another plan tool", async () => {
    // Call 1: toolCalls = [
    //   { id:"tc-add",  name:"plan_add_stage", input:{ /* valid */ } },
    //   { id:"tc-done", name:"plan_done",      input:{ reason:"ok" } },
    // ].
    // The planner must NOT exit on call 1; it iterates. The plan_add_stage
    // result is in dispatchResult and its tool_result was pushed.
    // Subsequent calls return text-only; planner enters nudge branch and
    // eventually returns kind:"failure" after MAX_NUDGES.
  });

  it("does not terminate when plan_done is batched with a dispatch tool", async () => {
    // Same shape with run_manager (or any DISPATCH_TOOLS entry from
    // src/runtime/dispatcher.ts L80-L124) as the sibling. Same assertions.
  });

  it("does not terminate when the plan_done dispatch result is an error", async () => {
    // Call 1: toolCalls = [{ id:"tc-bad", name:"plan_done", input:{ reason:"" } }].
    // The stub PlanService.plan_done returns a PlanError; the MCP dispatcher
    // flips isError=true (per [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L405-L408)).
    // Assert planner does NOT exit; iterates into nudge; returns kind:"failure"
    // after MAX_NUDGES.
  });

  it("does not terminate when the dispatch is aborted", async () => {
    // Inject an abortSignal pre-set to aborted, or use a stub dispatcher
    // that returns aborted:true on the first tool call response.
    // Assert finishReason at runLoop level is "abort" and planner returns
    // kind:"abort" (abort wins over the terminal hook because the abort
    // check at [src/agents/base.ts](../../../../src/agents/base.ts#L343)
    // runs before detectTerminalToolCall).
  });

  it("does not terminate on a bare legacy-text response — only on plan_done tool call", async () => {
    // Stub router returns { content: LEGACY_TOKEN, toolCalls: [],
    //   finishReason:"end_turn" } on every call. Planner enters nudge branch.
    // Assert kind:"failure" after MAX_NUDGES. Uses LEGACY_TOKEN
    // (concatenated) — the contiguous literal never appears in source.
  });

  it("does not duplicate the nudged assistant message in this.messages", async () => {
    // F14 invariant. Identical to the existing test at
    // [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L77-L153)
    // with one change: call 2 now returns the plan_done tool_use:
    //   { content: "", toolCalls: [{ id:"tc-done-1", name:"plan_done",
    //     input:{ reason:"ack" } }], finishReason:"tool_use" }
    // so the F14 test also exercises the new termination path.
    // The "assistantTextEquals 'I have nothing else to do.'" count === 1
    // assertion is unchanged; the "next message is SYSTEM: …" assertion is
    // unchanged.
  });
});
```

The bodies of tests c.1–c.7 follow the same `makePlannerContext` + router-stub pattern already used in the F14 test (see the structure at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L74-L153) for the stub-router shape and `PlannerAgent` construction). Tests c.3, c.4, c.5, c.6 are NEW vs r2 (review point 2). Test c.1's consume assertion and test c.2 are NEW vs r2 (review point 1). Test c.7 uses the concatenated token (review point 3).

### 15. Add `PlanService` unit tests (both dispatch paths)

Unchanged from [./03-plan-r2.md](./03-plan-r2.md) §15. In [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) inside the existing `describe("PlanService", ...)` block around [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L348-L510):

```ts
it("plan_done records once and consumePendingCompletion clears it", async () => {
  const r1 = await planService.plan_done({ reason: "all objectives verified" });
  expect(r1).toEqual({ ok: true, recorded: true });
  const r2 = await planService.plan_done({ reason: "second call" });
  expect(r2).toEqual({ ok: true, recorded: false });
  const consumed = planService.consumePendingCompletion();
  expect(consumed?.reason).toBe("all objectives verified");
  expect(planService.consumePendingCompletion()).toBeNull();
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
  expect(r.content).toEqual({ ok: true, recorded: true });
});
```

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

- `npx tsc --noEmit` → 0 errors.
- `npx eslint .` → 0 errors.
- Focused vitest: all eight tests in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) green; all four new `plan_done` tests in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) green.
- Full vitest: green workspace-wide. (The `AgentContext.planService` addition is a required new field; every internal construction site must pass the field or TS will fail at step 5.)
- `npm run build` → `dist/cli.js` produced without TS errors.
- `grep -rn PLAN_COMPLETE src/ prompts/` → **zero matches**. Executable as written. No `--exclude`, no `--include`. The legacy token only appears in `SPEC/v2/review-2026-05-round2/G09/*.md` (the review documents), not under `src/` or `prompts/`.

## Validation

- **Static**: `npx tsc --noEmit` passes; `npx eslint .` passes; the production grep above returns zero across the executable tree.
- **Focused unit**: see step 16. The single-turn-termination test asserts `calls.length === 1` AND `planService.consumePendingCompletion() === null` after the run (review point 1). The four exclusivity / error / abort tests assert non-completion under each violation (review point 2). The bare-legacy-text test uses `LEGACY_TOKEN` (review point 3).
- **Full unit**: `npx vitest run` green workspace-wide.
- **Build**: `npm run build` produces `dist/cli.js`.
- **Operator-gated live restart** (only if the operator approves; otherwise stop after the build):
  1. Read [/home/salva/g/ml/WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md) and the live `.saivage/runtime/runtime-state.json` under [/home/salva/g/ml/saivage-v3/.saivage](../../../../../saivage-v3/.saivage) before any restart.
  2. `ssh root@10.0.3.112 systemctl restart saivage.service`.
  3. `curl -fsS http://10.0.3.112:8080/health` → 200.
  4. `curl -fsS http://10.0.3.112:8080/api/notes` → 200.
  5. Drive a short planner session against a small objective. Confirm via the dashboard that the planner emits a `plan_done` tool_use; the formatter renders "Planner completed" with the model's `reason`; the recovery loop logs `Planner completed via plan_done: <reason>` and either exits (continuous-improvement off) or queues `CONTINUOUS_IMPROVEMENT_PROMPT` (on).
  6. In `.saivage/tmp/chats/*/messages.jsonl` for the session, verify that no bare legacy-text token ever terminated the planner. (Search by concatenation in any ad-hoc grep, e.g. `grep "$(printf 'PLAN_%s' COMPLETE)" .saivage/tmp/chats/*/messages.jsonl`.)
- **Do not** restart `saivage` (10.0.3.111) or `diedrico` (10.0.3.113) without operator approval. They share the bind mount on `/home/salva/g/ml/saivage` and would pick up the binary on their own next restart against their own runtime-state checkpoints.

## Rollback

Clean revert only. No mixed-protocol mode.

1. `git revert <merge-sha>` (or `git revert <commit-sha>` for a fast-forwarded single commit). This restores [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts), [src/agents/types.ts](../../../../src/agents/types.ts), [src/agents/base.ts](../../../../src/agents/base.ts), [src/agents/planner.ts](../../../../src/agents/planner.ts), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [prompts/planner.md](../../../../prompts/planner.md), [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts), [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts), and [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) wholesale to their pre-finding state.
2. `npm run build` to regenerate `dist/cli.js`.
3. If operator approves: `ssh root@10.0.3.112 systemctl restart saivage.service`. The planner returns to regex-based detection on the next session boundary.

No on-disk schema change occurred (`pendingCompletion` is in-memory only; `plan.json` / `plan-history.json` are untouched). Revert needs no data migration. No regex-fallback shim is acceptable per the architecture-first rule.

## Cross-finding (unchanged vs r2)

- **G04** — Manager final-response validation. Lands after G09. The `detectTerminalToolCall` hook + abort-first ordering + single-call exclusivity + service-consume pattern transfer directly to a `manager_done(reason)` tool.
- **G07** — Compaction marker loss. Retired by construction: `plan_done` is a structural assistant `tool_use` block preserved by the round-parser, not a substring summarisation can drop.
- **F14** — Nudge-path message non-duplication. Re-asserted in the rewritten [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) test c.8. Do not delete the F14 assertion.
- **G11** — Chat restart regex. Metaplan batches G04 / G09 / G11 as "free-text protocols to retire"; not in scope here.
