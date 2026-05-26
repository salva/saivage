# G09 — Design r3

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis**: [./01-analysis-r3.md](./01-analysis-r3.md)
**r2 docs**: [./02-design-r2.md](./02-design-r2.md), [./03-plan-r2.md](./03-plan-r2.md)
**r2 review**: [./04-review-r2.md](./04-review-r2.md)

Direction is unchanged: Proposal B from r1 (terminate the planner on a `plan_done` MCP tool call via a terminal-tool path) is kept. r3 modifies three localised parts of the r2 design.

## r3 deltas vs r2 (one bullet per r2 required change)

1. **Consume on success.** §1 below extends the planner's `detectTerminalToolCall` override to read and clear `this.ctx.planService.consumePendingCompletion()` before returning the terminal payload. `pendingCompletion`, `consumePendingCompletion()`, and the `AgentContext.planService` wiring from r2 are KEPT and now have a live reader. A new test in §3 proves a successful terminal consumes the pending completion and a follow-up planner cycle can record a fresh one.
2. **Exclusive + abort-first.** §2 reorders the runLoop insertion point and tightens the override. `runLoop` evaluates `if (dispatchResult.aborted) return abort` BEFORE calling `detectTerminalToolCall`. The override returns non-null only when the response was a single-call batch (`toolCalls.length === 1`) whose sole call is a non-errored `plan_done`, keyed by `toolUseId`. New focused tests cover batched `[plan_add_stage, plan_done]`, batched `[plan_done, run_manager]`, and aborted/errored `plan_done` dispatch results.
3. **Token-concatenation in tests.** §4 specifies that the negative regression test constructs the legacy `PLAN_COMPLETE` token via string concatenation (`const LEGACY_TOKEN = "PLAN_" + "COMPLETE";`). The post-condition `grep -rn PLAN_COMPLETE src/ prompts/` is therefore executable as written and must return zero matches across the full executable tree (no `--exclude` flag, no special case). The test docstring and inline comments are rewritten so they do not contain the literal token either.

Every other element of [./02-design-r2.md](./02-design-r2.md) (the union return type for `plan_done`, the tagged `{ completion: "plan_done", summary }` shape, the `isPlanDoneCompletion` typed guard, the prompt rewrites, the dashboard formatter entry, the clean-revert rollback) is retained unchanged.

## 1. Wiring — `AgentContext.planService` now consumed on success

`AgentContext` keeps the new required field declared in [./02-design-r2.md](./02-design-r2.md#L84-L110):

```ts
// src/agents/types.ts
import type { PlanService } from "../mcp/plan-server.js";

export interface AgentContext {
  // ... unchanged ...
  mcpRuntime: McpRuntime;
  planService: PlanService;
  // ... unchanged ...
}
```

[src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L155-L169) (and every other site that builds an `AgentContext`) passes `planService: runtime.planService` from the canonical instance.

`PlanService` (in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts)) keeps the r2 shape:

```ts
private pendingCompletion: { reason: string; requested_at: string } | null = null;

async plan_done(args: { reason: string }): Promise<{ ok: true; recorded: boolean } | PlanError> {
  // Validates reason; sets pendingCompletion once; returns recorded boolean.
  // Identical to [./02-design-r2.md](./02-design-r2.md#L175-L189).
}

consumePendingCompletion(): { reason: string; requested_at: string } | null {
  const v = this.pendingCompletion;
  this.pendingCompletion = null;
  return v;
}
```

The change vs r2 is purely on the planner side: the terminal-tool override now reads and clears the cell on success. The MCP closure registered at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L155-L169) is the only writer; the planner override is the only reader. One in-memory cell, two operations, two well-defined call sites.

## 2. Mechanism — exclusive terminal hook after the abort check

### 2.1 `BaseAgent.runLoop` insertion point (revised)

In [src/agents/base.ts](../../../../src/agents/base.ts) the tool-call branch around L325-L346 is modified so the order of the post-dispatch checks is:

```ts
// 1. Push tool_result user message (unchanged, [src/agents/base.ts](../../../../src/agents/base.ts#L335-L341)).
this.pushMessage({ role: "user", content: resultBlocks });

// 2. Abort wins — unchanged location; unchanged behaviour ([src/agents/base.ts](../../../../src/agents/base.ts#L343)).
if (dispatchResult.aborted) {
  return { text: "Aborted during tool execution", finishReason: "abort" };
}

// 3. Terminal-tool hook fires LAST, only when we know the batch dispatched cleanly.
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

This is the only ordering change vs r2. The default `BaseAgent.detectTerminalToolCall` still returns `null` and the widened return signature is unchanged from [./02-design-r2.md](./02-design-r2.md#L48-L52):

```ts
protected detectTerminalToolCall(
  _toolCalls: ToolCall[],
  _dispatchResult: DispatchResult,
): { name: string; data: unknown } | null {
  return null;
}
```

Abort precedence is now structural: the only way to reach the terminal hook is a complete dispatch with `aborted === false`. The hook itself does not re-check `aborted`.

### 2.2 `PlannerAgent` override (revised)

The override now enforces a single-call batch, matches by `toolUseId`, and consumes the pending completion on success:

```ts
// src/agents/planner.ts
protected override detectTerminalToolCall(
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[],
  dispatchResult: { toolResults: { toolUseId: string; content: unknown; isError: boolean }[] },
): { name: string; data: { reason: string } } | null {
  // Exclusivity: the batch must be exactly one plan_done call.
  if (toolCalls.length !== 1) return null;
  const tc = toolCalls[0];
  if (tc.name !== "plan_done") return null;

  // Match by toolUseId, not by position.
  const r = dispatchResult.toolResults.find((tr) => tr.toolUseId === tc.id);
  if (!r || r.isError) return null;

  // PlanService is the source of truth for the recorded reason. The MCP
  // dispatch path is the only writer of pendingCompletion; this override
  // is the only reader. Consume it before returning.
  const consumed = this.ctx.planService.consumePendingCompletion();
  const reason = consumed?.reason
    ?? (typeof tc.input?.["reason"] === "string" ? (tc.input["reason"] as string) : "");
  if (reason.trim() === "") return null;

  return { name: "plan_done", data: { reason } };
}
```

Three properties this override establishes vs r2:

- **Single-call exclusivity.** A model response that batches `plan_done` with any sibling (`plan_add_stage`, `run_manager`, `note_*`, anything) returns `null` and the planner falls through to the next iteration; the sibling has already executed and its result is in the message history. The model can correct course on the next turn.
- **toolUseId match.** Robust to dispatcher ordering ([src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L80-L124)) even though the single-call shape makes ordering trivial today.
- **Consume on success.** `pendingCompletion` is empty after a successful terminal exit. A subsequent recovery cycle starts with a clean cell and can record a fresh completion.

The override returns `null` (and the planner does not complete) in all of these cases:

- `toolCalls.length === 0` (handled by the no-tool-calls branch in `BaseAgent` anyway).
- `toolCalls.length > 1` (sibling tools present).
- The single call is not named `plan_done`.
- The `plan_done` result is missing or `isError === true` (the validation error from an empty reason, an MCP-runtime exception, or a dispatcher rejection).
- `pendingCompletion` was somehow never set AND the tool input does not carry a non-empty `reason` (defensive — should not happen in practice because the MCP path is the only writer and validates reason; a defensive fallback to `tc.input.reason` covers any future code path that bypasses `pendingCompletion`).

The planner's outer loop in [src/agents/planner.ts](../../../../src/agents/planner.ts#L70-L116) is unchanged from [./02-design-r2.md](./02-design-r2.md#L70-L82):

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

## 3. Test surface (revised)

`src/agents/planner.nudge.test.ts` is rewritten as follows. Every reference to the legacy free-text token uses concatenation; the literal contiguous string never appears in the file.

### 3.1 Module-level constants (top of file)

```ts
// The legacy free-text completion marker. Built via concatenation so the
// post-condition `grep -rn PLAN_COMPLETE src/ prompts/` returns zero.
const LEGACY_TOKEN = "PLAN_" + "COMPLETE";
```

The file's leading docstring and every inline comment are rewritten to describe the protocol in structural terms (`plan_done` tool call, terminal hook, nudge branch, F14 invariant). Examples — old then new:

| Location (current) | Old text contains | New text |
| --- | --- | --- |
| [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L1-L6) | "no-PLAN_COMPLETE nudge branch" | `PlannerAgent regression — covers the plan_done terminal protocol, the bare legacy-text negative regression, and the F14 no-duplication invariant on the nudge branch.` |
| [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L80-L82) | "Call 1: text only, no PLAN_COMPLETE" | `Call 1: text only, no terminal tool call → planner enters nudge branch.` |
| [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L90-L92) | "PLAN_COMPLETE → planner exits cleanly" | `Call 2: plan_done tool call → terminal hook fires, planner exits cleanly.` |

### 3.2 Stub `mcpRuntime` + stub `planService`

[src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L63-L67) `makePlannerContext` is extended:

```ts
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

The stub uses the real `PlanService` (constructed against the tmp `saivageDir`) so the `pendingCompletion` / `consumePendingCompletion` semantics are exercised end-to-end. `makePlannerContext` returns both the context and the `PlanService` reference (e.g. as a tuple or as a property the tests can re-read).

### 3.3 Required tests in `src/agents/planner.nudge.test.ts`

1. `terminates on plan_done tool call and consumes the pending completion`
   - Stub router returns `toolCalls: [{ id: "tc-done-1", name: "plan_done", input: { reason: "objectives verified" } }]` with `finishReason: "tool_use"` on call 1.
   - Asserts `result.kind === "success"`, `result.data === { completion: "plan_done", summary: "objectives verified" }`, router was called exactly once (single-turn termination), AND `planService.consumePendingCompletion() === null` after `planner.run()` returns (proves the override consumed it).
2. `lets a fresh planner cycle record a new pending completion after the previous one was consumed`
   - Reuses the same `PlanService` instance from the previous test (or runs back-to-back inside one `it` block): runs planner #1 with `reason: "first"`, asserts success; runs planner #2 with `reason: "second"`, asserts success. Direct `planService.plan_done({ reason: "third" })` after planner #2 returns `{ ok: true, recorded: true }` (proves the cell was clean), then `consumePendingCompletion()` returns `{ reason: "third", ... }`.
3. `does not terminate when plan_done is batched with another plan tool`
   - Call 1 returns `toolCalls: [{ id: "tc-add", name: "plan_add_stage", input: { ... } }, { id: "tc-done", name: "plan_done", input: { reason: "ok" } }]`. Asserts the planner does NOT exit on call 1; it iterates to call 2. On call 2 the stub returns a plain text response so the planner enters the nudge branch. Asserts `result.kind === "failure"` (after exhausting nudges) — confirms the batched `plan_done` was ignored and the planner did not complete.
4. `does not terminate when plan_done is batched with a dispatch tool`
   - Same shape but with `run_manager` (or `run_worker`) as the sibling. Same assertions. Confirms exclusivity holds across the local-vs-dispatch split in [src/runtime/dispatcher.ts](../../../../src/runtime/dispatcher.ts#L80-L124).
5. `does not terminate when the plan_done dispatch result is an error`
   - Call 1 returns `toolCalls: [{ id: "tc-bad", name: "plan_done", input: { reason: "" } }]` (empty reason). The stub `PlanService.plan_done` returns a `PlanError`; the MCP dispatcher flips `isError = true` (per [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L405-L408)). Asserts the planner does NOT exit on call 1, iterates to call 2 (nudge branch), and eventually returns `kind: "failure"` after MAX_NUDGES.
6. `does not terminate when the dispatch result is aborted` (focused; can be a unit test that drives `runLoop` indirectly by injecting a stub dispatcher via the abort signal)
   - Run the planner with a pre-aborted `abortSignal`. The dispatcher returns `aborted: true`. Assert the runLoop returns `finishReason: "abort"` and the planner returns `kind: "abort"`. Confirms abort wins over the terminal hook.
7. `does not terminate on a bare legacy-text response — only on plan_done tool call`
   - Stub router returns `content: LEGACY_TOKEN, toolCalls: []` on every call. Asserts the planner enters the nudge branch and eventually returns `kind: "failure"` after MAX_NUDGES. Uses `LEGACY_TOKEN` (concatenated) — the literal contiguous string never appears in the test source.
8. F14 invariant — `does not duplicate the nudged assistant message`
   - Identical to the existing test at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L77-L153), but with call 2 rewritten to return `toolCalls: [{ id: "tc-done-1", name: "plan_done", input: { reason: "ack" } }]` instead of `content: LEGACY_TOKEN`. Duplication-count assertion unchanged.

Tests 3, 4, 5, 6 are NEW vs r2 (focused tests required by review point 2). Test 1's consume assertion is NEW vs r2 (review point 1). Test 7 uses the concatenated `LEGACY_TOKEN` (review point 3).

### 3.4 `PlanService` unit tests in `src/runtime/runtime.test.ts`

[src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) keeps the r2 tests (`plan_done records once and consumePendingCompletion clears it`, `plan_done rejects an empty reason (direct method)`, `plan_done rejects an empty reason via handleToolCall`, `handleToolCall plan_done with a valid reason returns ok and is not an error`). No change vs r2.

## 4. Validation contract

Production post-conditions (no scoped exclude, no per-file allowance):

```bash
grep -rn PLAN_COMPLETE src/ prompts/
```

This returns ZERO matches across the full executable tree, including `*.test.ts`, because every test that needs the legacy token constructs it via concatenation. The grep is executable as written. The only allowed matches workspace-wide are inside `SPEC/v2/review-2026-05-round2/G09/*.md` (the review documents themselves).

## 5. Files touched (final list, r3)

Identical to [./02-design-r2.md](./02-design-r2.md) "Files touched (final list)" with one additional behavioural change in `src/agents/planner.ts` (`detectTerminalToolCall` now consumes `pendingCompletion`) and one additional ordering change in `src/agents/base.ts` (terminal hook runs after the abort check). No new files; no removed files.

## 6. Deletion list (unchanged)

Same as [./02-design-r2.md](./02-design-r2.md) "Deletion list".

## 7. Rollback (unchanged)

`git revert <sha>` of the single protocol commit. No mixed-protocol fallback. See [./02-design-r2.md](./02-design-r2.md) §6 for the full statement.

## 8. What r3 still does not fix (in scope)

- A model that calls `plan_done` as the sole tool with a valid reason will exit the planner. Same model-trust surface as before; r3 narrows it to a single-call shape but cannot make it zero. Operator surface is the dashboard formatter entry.
- The recovery loop's restart-on-any-non-success behaviour at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L666-L680) is unchanged.
- G04 / G11 stay independent findings; r3 establishes patterns they will reuse.
