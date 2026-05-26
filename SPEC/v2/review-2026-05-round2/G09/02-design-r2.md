# G09 — Design r2

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis**: [./01-analysis-r2.md](./01-analysis-r2.md)
**r1 docs**: [./02-design-r1.md](./02-design-r1.md), [./03-plan-r1.md](./03-plan-r1.md)
**r1 review**: [./04-review-r1.md](./04-review-r1.md)

r1's Proposal A (harden the regex) remains rejected — accepted by the reviewer. r2 keeps Proposal B (replace text protocol with a `plan_done(reason)` MCP tool) and fixes the six required changes. Only Proposal B is restated here, in revised form.

## r2 deltas (one bullet per r1 required change)

1. **Terminal on the tool call.** Added §1 "Mechanism — terminal-tool hook" below. `BaseAgent.runLoop()` gains a focused override point `detectTerminalToolCall(toolCalls, results)` that returns `null` by default. `PlannerAgent` overrides it to detect successful `plan_done`. `runLoop` returns immediately, no extra LLM turn. Replaces r1's "runtime detects the call between `runLoop` iterations". Validated against [src/agents/base.ts](../../../../src/agents/base.ts#L229-L344).
2. **Explicit `PlanService` injection.** Added §2 "Wiring — `AgentContext.planService`". `AgentContext` gets a new required `planService: PlanService` field; [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L484-L498) populates it from `runtime.planService`. `PlannerAgent` reads `this.ctx.planService` only. Explicitly forbids `new PlanService(...)` inside the agent. Replaces r1's vague "agent context already gives access".
3. **Structural discriminator.** Added §3 "Completion shape & recovery loop". `PlannerAgent.run()` returns `{ kind: "success", data: { completion: "plan_done", summary: reason } }`. [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L644) uses a new `isPlanDoneCompletion(value)` typed guard. `hasSummary` is removed from this code path. Replaces r1's `result.kind === "success" && hasSummary(result.data)`.
4. **Union return type.** §4 below types `plan_done` as `Promise<{ ok: true; recorded: boolean } | PlanError>`, matching the existing union pattern at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L29-L40). Test coverage extended to both the direct method and `handleToolCall("plan_done", { reason: "" })` to verify the MCP error branch at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L405-L408) fires.
5. **Real test files in commands; stub gets a schema.** §5 "Test surface" gives the stub `mcpRuntime.getAllTools` a single-element array containing the `plan_done` schema, plus a stub `planService` plumbed through the new `AgentContext.planService`. The validation command (see [./03-plan-r2.md](./03-plan-r2.md)) drops `src/mcp/plan-server.ts` and lists only real test files.
6. **Clean revert only.** §6 "Rollback shape" specifies `git revert <sha>` of the protocol commit. No regex fallback. The Rollback section in [./03-plan-r2.md](./03-plan-r2.md) is rewritten accordingly.

## 1. Mechanism — terminal-tool hook in `BaseAgent`

`BaseAgent` gains one new protected method and one extension to its `runLoop` return shape:

```ts
// In BaseAgent
protected detectTerminalToolCall(
  _toolCalls: ToolCall[],
  _dispatchResult: DispatchResult,
): { name: string; data: unknown } | null {
  return null;
}
```

In the tool-call branch of `runLoop` (after the existing dispatcher call at [src/agents/base.ts](../../../../src/agents/base.ts#L325-L334) and before the next iteration), `BaseAgent` calls `this.detectTerminalToolCall(response.toolCalls, dispatchResult)`. If the hook returns a non-null value, `runLoop` returns:

```ts
return {
  text: response.content,
  finishReason: "tool_terminal",
  source: responseSource(response),
  terminal: { name, data },
};
```

The return signature is widened to `Promise<{ text: string; finishReason: string; source?: LlmResponseSource; terminal?: { name: string; data: unknown } }>`. Callers that ignore `terminal` are unaffected.

This is the smallest focused intervention. It does not introduce a generic "terminal tools" framework — there is one method, no registry, and the only agent that overrides it is `PlannerAgent`. The hook fires *after* dispatch, so the `tool_result` user message is still pushed; that keeps the message history consistent for any restart and for the F14 invariant on the nudge path (which is unaffected because the nudge path is the zero-tool-call branch, not this branch).

`PlannerAgent` overrides:

```ts
protected override detectTerminalToolCall(
  toolCalls: ToolCall[],
  dispatchResult: DispatchResult,
): { name: string; data: { reason: string } } | null {
  for (let i = 0; i < toolCalls.length; i++) {
    const tc = toolCalls[i];
    if (tc.name !== "plan_done") continue;
    const r = dispatchResult.toolResults[i];
    if (r?.isError) continue;
    const reason = typeof tc.input?.["reason"] === "string" ? tc.input["reason"] : "";
    return { name: "plan_done", data: { reason } };
  }
  return null;
}
```

The planner's outer loop in [src/agents/planner.ts](../../../../src/agents/planner.ts#L70-L116) then matches `finishReason === "tool_terminal"` and the existing regex branch is deleted:

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

The success exit is therefore triggered by the tool call itself, with no second model turn. The test from §5 verifies this by asserting the planner exits after exactly one router call that returns a `plan_done` tool_use.

## 2. Wiring — `AgentContext.planService`

[src/agents/types.ts](../../../../src/agents/types.ts#L30-L56) is extended:

```ts
export interface AgentContext {
  project: ProjectContext;
  router: ModelRouter;
  mcpRuntime: McpRuntime;
  planService: PlanService;   // ← new, required
  agentId: string;
  role: AgentRole;
  modelSpec: string;
  authProfileKey?: string;
  accountRef?: string;
  startupDirectives?: string[];
  stageId?: string;
  channelId?: string;
  sessionId?: string;
}
```

`PlanService` is imported from `../mcp/plan-server.js` in `types.ts`.

[src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L484-L498) `runPlanner` is updated to pass `planService: runtime.planService` in the `ctx` literal. All other agent-context construction sites (manager, worker, inspector, chat) must also include `planService: runtime.planService` so the type checks; none of them read it. r2 verifies this in the typecheck step.

`PlannerAgent` constructor / `create` do *not* receive a separate `planService` argument — they read `ctx.planService`. r2 design forbids any `new PlanService(...)` call in [src/agents/planner.ts](../../../../src/agents/planner.ts); the only `PlanService` instance in the process is the one at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L156-L169). The terminal-tool hook does *not* call `consumePendingCompletion()` from `PlanService` — it reads the reason out of the dispatched tool input directly. The `pendingCompletion` field in `PlanService` still exists (so that any non-planner observer can read it), but planner success no longer depends on it; that removes the cross-instance hazard the reviewer warned about.

## 3. Completion shape & recovery loop

`AgentResult["data"]` for the planner's success path is now `{ completion: "plan_done"; summary: string }`. This is not declared on `AgentResult` (whose `data` stays `unknown`) — it is asserted by a structural type guard in `bootstrap.ts`:

```ts
function isPlanDoneCompletion(value: unknown): value is { completion: "plan_done"; summary: string } {
  return !!value
    && typeof value === "object"
    && (value as { completion?: unknown }).completion === "plan_done"
    && typeof (value as { summary?: unknown }).summary === "string";
}
```

The recovery branch at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L644) becomes:

```ts
if (result.kind === "success" && isPlanDoneCompletion(result.data)) {
  if (!runtime.config.runtime.continuousImprovement) {
    log.info(`[recovery] planner completed: ${result.data.summary}`);
    return result;
  }
  queuePlannerDirective(runtime, CONTINUOUS_IMPROVEMENT_PROMPT);
  await runtime.eventBus.publish({
    type: "plan_updated",
    summary: "Planner completed the active plan. Continuous-improvement directive queued; restarting Planner.",
    timestamp: new Date().toISOString(),
  });
  log.info("[recovery] planner completed; continuous-improvement mode is enabled. Restarting planner");
  continue;
}
```

All occurrences of the literal `PLAN_COMPLETE` in log messages and prompt constants ([src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L525-L549), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L625), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L635), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L644)) are replaced with the structural language (`planner completed`, `call plan_done(reason)`, etc.). `hasSummary` is *not* called from the planner-completion path any more; if it has other call sites they keep it.

## 4. `plan_done` on `PlanService`

In [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts):

```ts
private pendingCompletion: { reason: string; requested_at: string } | null = null;

async plan_done(args: { reason: string }): Promise<{ ok: true; recorded: boolean } | PlanError> {
  if (typeof args?.reason !== "string" || args.reason.trim().length === 0) {
    return planError("VALIDATION_ERROR", "plan_done requires a non-empty reason");
  }
  if (this.pendingCompletion) {
    return { ok: true as const, recorded: false };
  }
  this.pendingCompletion = { reason: args.reason, requested_at: new Date().toISOString() };
  return { ok: true as const, recorded: true };
}

consumePendingCompletion(): { reason: string; requested_at: string } | null {
  const current = this.pendingCompletion;
  this.pendingCompletion = null;
  return current;
}
```

`handleToolCallInner` ([src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L360-L408)) gets a new `case "plan_done"` that calls `await this.plan_done(args as { reason: string })`. Because the result is the `{ ok; recorded } | PlanError` union and `PlanError` has `code` and `error`, the existing generic error detection at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L405-L408) sets `isError = true` for empty-reason calls without any new branch.

`getToolSchemas()` gains a `plan_done` entry. Schema:

```ts
{
  name: "plan_done",
  description: "Signal that all project objectives are verified complete. Call only after every configured objective has been achieved with evidence from successful stage completions. Provide a one-paragraph reason explaining which objectives are satisfied and how.",
  inputSchema: {
    type: "object",
    properties: { reason: { type: "string", description: "Why the project is complete." } },
    required: ["reason"],
  },
}
```

The role allow-list at [src/agents/base.ts](../../../../src/agents/base.ts#L1084-L1090) adds `"plan_done"` to `PLAN_TOOLS`; workers are blocked transitively via `WORKER_EXCLUDED_TOOLS`.

## 5. Test surface

### Planner success — `src/agents/planner.nudge.test.ts`

The stub `mcpRuntime` ([src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L63-L67)) is extended:

```ts
const planService = makeStubPlanService();   // matches AgentContext.planService shape
const ctx: AgentContext = {
  ...,
  planService,
  mcpRuntime: {
    getAllTools: () => [{
      service: "plan",
      name: "plan_done",
      description: "...",
      inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
    }],
    callTool: async (_service, name, args) => {
      if (name === "plan_done") return planService.plan_done(args as { reason: string });
      return { ok: true };
    },
  } as AgentContext["mcpRuntime"],
};
```

(The exact `getAllTools` element shape is what `mcpRuntime` returns elsewhere; the plan step references the existing `McpRuntime` types so the stub fits the real interface.)

New / rewritten tests in the same file:

- `succeeds when planner emits a plan_done tool_use` — call 1 returns `toolCalls: [{ name: "plan_done", input: { reason: "objectives verified" } }]` with `finishReason: "end_turn"`. Asserts:
  - `result.kind === "success"`;
  - `result.data` matches `{ completion: "plan_done", summary: "objectives verified" }`;
  - `calls.length === 1` (no second router call — proves the tool call is terminal, addressing required change 1);
  - The terminal hook fired (no nudge user message was injected).
- `ignores bare PLAN_COMPLETE text without plan_done` — every router call returns `content: "PLAN_COMPLETE", toolCalls: []`. Asserts the planner enters the nudge branch and eventually returns `kind: "failure"` after `MAX_NUDGES`. Proves the regex protocol is dead.
- F14 invariant test (the existing `does not duplicate the nudged assistant message`) is retained verbatim but its call-2 success response is rewritten to use a `plan_done` tool_use instead of `content: "PLAN_COMPLETE"`. Assertions about message-history non-duplication are unchanged.

### PlanService — `src/runtime/runtime.test.ts`

Next to the existing `plan_complete_stage` tests at [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L482-L510), add:

- `plan_done records a pending completion exactly once` — first call returns `{ ok: true, recorded: true }`; second call returns `{ ok: true, recorded: false }`; `consumePendingCompletion()` returns the first reason then `null`.
- `plan_done rejects empty reason as PlanError` — `await planService.plan_done({ reason: "" })` matches `{ code: "VALIDATION_ERROR" }`.
- `plan_done MCP path returns isError on empty reason` — `await planService.handleToolCall("plan_done", { reason: "" })` matches `{ isError: true, content: { code: "VALIDATION_ERROR", ... } }`. This is the MCP dispatch path the reviewer required.
- `plan_done MCP path records reason and reports recorded` — `handleToolCall("plan_done", { reason: "ok" })` returns `{ isError: false, content: { ok: true, recorded: true } }`; a second call returns `recorded: false`; `consumePendingCompletion()` returns `"ok"`.

### Dashboard formatter

[web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts) — one entry for `plan_done` so the tool_use renders as a first-class row ("Planner completed — `<reason>`"). Not a behavioural test; covered by the existing formatter snapshot tests if any.

## 6. Rollback shape

Rollback is `git revert <sha>` of the single protocol-change commit. The revert restores:

- The regex check at [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93).
- The `PLAN_COMPLETE` discriminator at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L623-L640).
- The prompt passages at [prompts/planner.md](../../../../prompts/planner.md) and the startup message at [src/agents/planner.ts](../../../../src/agents/planner.ts#L172).
- The previous shape of `AgentContext`.

`pendingCompletion` is in-memory only; `plan.json` and `plan-history.json` are not touched by this finding, so no on-disk migration is needed in either direction. There is no partial rollback. There is no regex fallback to "preserve" the protocol — the architecture-first guideline forbids mixed protocol modes.

## Files touched (final list)

- [src/agents/types.ts](../../../../src/agents/types.ts) — add `planService` to `AgentContext`.
- [src/agents/base.ts](../../../../src/agents/base.ts) — widen `runLoop` return; add `detectTerminalToolCall` hook; add `"plan_done"` to `PLAN_TOOLS`.
- [src/agents/planner.ts](../../../../src/agents/planner.ts) — delete regex + comment block; override `detectTerminalToolCall`; consume `finishReason === "tool_terminal"`; return `{ kind: "success", data: { completion: "plan_done", summary } }`; rewrite startup-message bullet 6.
- [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) — add `pendingCompletion`, `plan_done`, `consumePendingCompletion`; dispatch case; schema entry.
- [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts) — pass `planService` in `runPlanner` and any other `AgentContext` construction sites; replace recovery-loop discriminator with `isPlanDoneCompletion`; rewrite log strings and `RECOVERY_PROMPT` / `CONTINUOUS_IMPROVEMENT_PROMPT` to reference `plan_done(reason)`.
- [src/agents/manager.ts](../../../../src/agents/manager.ts), [src/agents/worker.ts](../../../../src/agents/worker.ts), [src/agents/inspector.ts](../../../../src/agents/inspector.ts), [src/agents/chat.ts](../../../../src/agents/chat.ts), and any other `AgentContext`-constructing site — add `planService: runtime.planService` to the literal so the type checks. No behavioural change.
- [prompts/planner.md](../../../../prompts/planner.md) — replace the three `PLAN_COMPLETE` instruction passages with `plan_done(reason)` wording.
- [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts) — add `plan_done` entry.
- [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) — extended stub + new tests per §5.
- [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) — new `plan_done` tests per §5.

## Deletion list

- The regex `/^\s*PLAN_COMPLETE\s*$/m.test(text)` and its comment block at [src/agents/planner.ts](../../../../src/agents/planner.ts#L89-L93).
- The literal `result.data.summary === "PLAN_COMPLETE"` discriminator at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L623).
- The three `PLAN_COMPLETE` instruction passages in [prompts/planner.md](../../../../prompts/planner.md#L41-L49), [prompts/planner.md](../../../../prompts/planner.md#L137) and the startup-message at [src/agents/planner.ts](../../../../src/agents/planner.ts#L172).
- The `PLAN_COMPLETE detected` log strings at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L625) and [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L635).
- The "Do not say PLAN_COMPLETE…" sentence in `RECOVERY_PROMPT` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L525-L535) and the "Only say PLAN_COMPLETE…" sentence in `CONTINUOUS_IMPROVEMENT_PROMPT` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L548-L549).

No shim, no fallback. Per architecture-first rule.

## What r2 still does not fix (in scope)

- A model that calls `plan_done` prematurely will exit the planner. Same model-trust surface as the previous regex protocol; surfaced now on the dashboard via the new formatter entry so an operator can intervene.
- The recovery loop's restart-on-any-non-success behaviour at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L666-L680) is unchanged.
- G04 (manager free-text final-response validation) and G11 (chat-restart regex) are independent findings of the same family; r2 establishes the canonical shape they should follow but does not change them.
