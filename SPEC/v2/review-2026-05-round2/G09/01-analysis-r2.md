# G09 — Analysis r2

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**r1 docs**: [./01-analysis-r1.md](./01-analysis-r1.md), [./02-design-r1.md](./02-design-r1.md), [./03-plan-r1.md](./03-plan-r1.md)
**r1 review**: [./04-review-r1.md](./04-review-r1.md) (CHANGES_REQUESTED, 6 required changes)

r1's structural analysis (regex location, prompt mismatch, failure modes, false positives, compaction interaction, test-coverage gap, why text-protocol is the wrong shape for a v2 agent) is accepted in full and is not re-derived here. This r2 only re-examines the parts the reviewer flagged: the runtime control-flow path that has to make `plan_done` terminal, the exact agent-context wiring needed to share `PlanService`, the structural discriminator that has to replace the literal-string check, and the test/validation surface.

## 1. Why `plan_done` is not already terminal in the current code path

The reviewer's first required change is correct: `BaseAgent.runLoop()` does not return after a tool call. The relevant fragment lives at [src/agents/base.ts](../../../../src/agents/base.ts#L271-L344):

- After `callLLM()`, the loop branches on `response.toolCalls.length`.
- The `length === 0` branch is the only one that calls `validateFinalResponse(response.content)` and returns ([src/agents/base.ts](../../../../src/agents/base.ts#L271-L297)).
- The `length > 0` branch pushes the assistant `tool_use` block, dispatches the tool calls via `this.dispatcher.processToolCalls(...)` ([src/agents/base.ts](../../../../src/agents/base.ts#L325-L334)), pushes the resulting `tool_result` user message ([src/agents/base.ts](../../../../src/agents/base.ts#L336-L343)), and falls through to the next `while` iteration.
- The only way that branch exits early is `dispatchResult.aborted` ([src/agents/base.ts](../../../../src/agents/base.ts#L340-L342)), which yields `finishReason: "abort"`.

In other words: a successful `plan_done` tool call followed by `finishReason: "end_turn"` on that same response will inject a `tool_result` user message, ask the model for *another* assistant turn, and only return when that next turn happens to have zero tool calls — which is precisely the contradiction r1 still inherited from the regex protocol (model must call a tool but also must end with text). r1's test as written would either rely on the existence of a second text-only response from the stub router or stall the planner. The reviewer is correct that the planner outer loop in [src/agents/planner.ts](../../../../src/agents/planner.ts#L70-L116) cannot consume completion immediately after the `plan_done` tool_use under the r1 design.

The smallest correct intervention is a per-agent hook into `runLoop` that, after a successful dispatch, can signal "this tool call is terminal — return now". It does not need to be a generic "terminal tool framework"; it can be a single method on `BaseAgent` that returns `null` by default and is overridden in `PlannerAgent` to detect a successful `plan_done`. The return tuple of `runLoop` then carries the terminal tool's `reason` to the planner so the outer loop can build the `kind: "success"` result *from the tool input*, not from a subsequent text turn.

## 2. Why `PlanService` cannot be resolved from `mcpRuntime` and must be injected

The reviewer's second required change is correct: there is no API on `mcpRuntime` to retrieve the live `PlanService` instance, and re-instantiating one inside `PlannerAgent` would create a separate `pendingCompletion` field that the MCP dispatcher never writes to.

Evidence:

- `SaivageRuntime` owns the canonical `PlanService` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L51-L53).
- That exact instance is wired into MCP only as a *handler closure* — `(toolName, args) => planService.handleToolCall(toolName, args)` — at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L156-L169). The `McpRuntime` retains the closure, not the `PlanService` reference, so `mcpRuntime` cannot return the live instance.
- The planner agent context is constructed at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L484-L498) with `project`, `router`, `mcpRuntime`, and routing — no `planService`.
- `AgentContext` is declared at [src/agents/types.ts](../../../../src/agents/types.ts#L30-L36) with only `mcpRuntime`, no `planService`.

So the runtime owns one instance, the MCP dispatcher uses that one instance (via the registered closure), but `PlannerAgent` has no path to read from it. There are two valid wirings:

1. Add `planService: PlanService` to `AgentContext` and populate it in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L484-L498) from `runtime.planService`. Other agents simply ignore the field; only `PlannerAgent` reads it. This generalises if a future agent needs the same handle.
2. Pass `runtime.planService` directly through `PlannerAgent.create(ctx, childSpawner, planService, config)` and store on `this.planService`. Smaller surface but planner-specific.

r2 picks option (1) because the reviewer mentioned "add `planService` to `AgentContext`" first and because the only other agent that might want a structured completion signal later (Manager, for G04) will need the same handle.

Either way, the design must explicitly forbid `new PlanService(...)` anywhere inside `PlannerAgent` — the in-memory `pendingCompletion` field is the protocol surface, and two instances would silently break the protocol.

## 3. Why the recovery discriminator must be structural, not `hasSummary`

The reviewer's third required change is correct: the r1 plan replaced the literal `result.data.summary === "PLAN_COMPLETE"` check with `result.kind === "success" && hasSummary(result.data)`, but `hasSummary` is defined at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L825-L827) as a generic guard that returns true for *any* `{ summary: string }`. Under r1, every successful planner exit would be treated as completion, which collapses the "planner returned without `plan_done`" branch into the "planner explicitly signalled `plan_done`" branch.

Today the only call site of `PlannerAgent.run()` that constructs `kind: "success"` is the regex match at [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93), so `hasSummary` happens to be tight enough in practice. But:

- r2 introduces a second `kind: "success"` exit path (the `plan_done` terminal-tool branch).
- If a third path is ever added (e.g. structural manager-completion for G04), `hasSummary` will silently include it.
- The point of the finding is to make completion *machine-checkable*. A generic shape guard regresses that property.

r2 therefore widens `AgentResult["data"]` (via the planner's actual return) to a tagged shape and keys the recovery loop on the tag, not on `hasSummary`. The natural shape is `{ completion: "plan_done", summary: string }`. A typed guard `isPlanDoneCompletion(value)` lives next to `hasSummary` in [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L820-L830) and is the only thing the recovery loop checks at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L644). `hasSummary` is removed from the planner-completion path — if it has other call sites they can keep it for their own purposes.

## 4. Why `plan_done`'s return type must be a union and the MCP dispatch path must be tested

The reviewer's fourth required change is correct. r1 typed `plan_done` as `Promise<{ ok: true; recorded: boolean }>` while specifying that empty reasons return `planError("VALIDATION_ERROR", ...)`. Under strict TS this is a type error: `PlanError` is `{ code; error }`, not `{ ok; recorded }`.

The rest of `PlanService` already models this correctly. For example `plan_init` is declared `Promise<Plan | PlanError>` at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L29-L40). The MCP dispatcher at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L360-L408) relies on the union by inspecting the result for `"code" in result && "error" in result`:

```ts
if (result && typeof result === "object" && "code" in result && "error" in result) {
  isError = true;
}
```

So the correct type is `Promise<{ ok: true; recorded: boolean } | PlanError>`, and the test must cover both:

- Direct call: `planService.plan_done({ reason: "" })` returns the `PlanError` shape (so callers that hold a typed `PlanService` reference still see the union).
- MCP path: `planService.handleToolCall("plan_done", { reason: "" })` returns `{ content: <PlanError>, isError: true }` because the dispatcher's generic error-detection branch fires. Without this test there is nothing that guarantees an empty `reason` becomes an MCP-level error result rather than a successful tool_use carrying an error payload.

## 5. Why the test stub mcpRuntime needs a `plan_done` schema and validation commands must point at real test files

The reviewer's fifth required change is correct on both points.

(a) Test stub. The stub at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L63-L67) declares `getAllTools: () => []`. With an empty tool list, the planner has no `plan_done` schema in scope, so the dispatcher will reject the model's `plan_done` tool_use before it ever reaches the stub `callTool`. The rewritten test must give `getAllTools` a single-element array containing the `plan_done` schema (and the stub `callTool` must implement only that name, returning the recorded result). The stub also has to act as the `planService` source for the planner — easiest is to pass a stub `PlanService` through the new `AgentContext.planService` field, with a `pendingCompletion` field and the same `plan_done` / `consumePendingCompletion` methods. The stub `callTool` then writes to it and the planner reads it back via the terminal-tool hook (see §1).

(b) Validation commands. The r1 command `npx vitest run src/agents/planner.nudge.test.ts src/runtime/runtime.test.ts src/mcp/plan-server.ts` lists `src/mcp/plan-server.ts` as if it were a test file. It is not — it is the production `PlanService` module. Vitest would either skip it (no test cases) or fail to collect, depending on filter behaviour. The real PlanService tests live in [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L348-L510). r2 also adds new MCP-path coverage to that same file (rather than create a third test file), so the focused command is `npx vitest run src/agents/planner.nudge.test.ts src/runtime/runtime.test.ts` — no source files.

## 6. Why the rollback must be a clean revert with no regex fallback

The reviewer's sixth required change is correct and follows directly from the workspace's architecture-first / no-backward-compatibility rule. A rollback that keeps `plan_done` *and* restores the regex is a mixed protocol mode: both the structural tool call and the free-text marker would be accepted, doubling the failure surface (a model can succeed via the wrong protocol, an operator cannot tell which path fired without reading logs). The rule says: remove the old structure, do not preserve it as a shim. r2 rollback is `git revert <sha>` — single hop, no intermediate state.

## 7. Other r1 claims that survive r2 unchanged

- `plan_done` must remain in-memory only on `PlanService` (no `plan.json` mutation). Completion is a per-run runtime signal; persisting it would corrupt restart semantics.
- The tool is named `plan_done`, not `plan_complete` — `plan_complete_stage` already exists at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L367-L405) and the names would collide in dashboards and autocomplete.
- The `PLAN_TOOLS` allow-list at [src/agents/base.ts](../../../../src/agents/base.ts#L1085-L1090) gates planner-only access; adding `plan_done` to the set blocks all workers transitively via `WORKER_EXCLUDED_TOOLS`.
- The dashboard formatter at [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts) needs one entry for `plan_done`. Not in scope for the protocol change itself but listed in the plan because the dashboard otherwise renders a generic row.
- The F14 message-non-duplication invariant at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L113-L155) survives this finding — the nudge branch still fires when the model ends a turn with text and no tool calls (and no terminal tool). The rewritten test must keep that assertion.

## 8. Cross-links (revised)

- **G07** — compaction fallback. With change #1, the `plan_done` event is the terminal `runLoop` return; no later turn is required, so a compacted final assistant turn cannot drop completion. The cross-link claim from r1 is valid only after change #1 is satisfied; with it, G07's failure mode for the planner is closed.
- **G04** — manager hardcoded final-response validation. Same family. The structural `{ completion: "plan_done", summary }` shape established here is the canonical pattern for G04's eventual `manager_done` or equivalent.
- **F14** — nudge-path message-duplication regression. Independent; reasserted in the new test file.
- **G11** — chat restart regex is English-only. Independent; same family of "free-text protocols to retire" — metaplan groups them.
