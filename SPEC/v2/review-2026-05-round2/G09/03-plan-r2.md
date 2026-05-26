# G09 — Plan r2

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis (r2)**: [./01-analysis-r2.md](./01-analysis-r2.md)
**Design (r2)**: [./02-design-r2.md](./02-design-r2.md)
**Round 1 review**: [./04-review-r1.md](./04-review-r1.md)

All edits are inside `/home/salva/g/ml/saivage`. Paths below are repo-relative to that root.

## Steps

### 1. Add `pendingCompletion`, `plan_done`, `consumePendingCompletion` to `PlanService`

In [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) (private fields region near [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L46-L60)):

```ts
private pendingCompletion: { reason: string; requested_at: string } | null = null;
```

Next to the other tool methods, add:

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

In the `switch (toolName)` in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L367-L405), add right before `default`:

```ts
case "plan_done":
  result = await this.plan_done(args as { reason: string });
  break;
```

The existing isError detection at [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L411-L414) flips `isError` automatically for the validation branch.

### 3. Add the `plan_done` tool schema

In `getToolSchemas()` in [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L417-L490) (append to the returned array):

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

In [src/agents/types.ts](../../../../src/agents/types.ts#L30-L56):

```ts
import type { PlanService } from "../mcp/plan-server.js";

export interface AgentContext {
  project: ProjectContext;
  router: ModelRouter;
  mcpRuntime: McpRuntime;
  planService: PlanService;
  agentId: string;
  // ... rest unchanged
}
```

`planService` is required, not optional.

### 5. Pass `planService` through every agent context in bootstrap

In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L484-L498) (`runPlanner`'s `ctx`), add `planService: runtime.planService` to the `AgentContext` literal.

Repeat in the manager / worker / inspector context builders elsewhere in `src/server/bootstrap.ts` and any other call sites where `AgentContext` is constructed (TypeScript will fail compilation until every site is updated — fix each in turn).

Constraint (code-review level, no runtime check): no file under `src/agents/` may import `PlanService` or call `new PlanService(...)`. The only constructor call remains at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L156).

### 6. Add `detectTerminalToolCall` hook to `BaseAgent` and widen `runLoop` return

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

In `runLoop`, immediately after the tool-result push at [src/agents/base.ts](../../../../src/agents/base.ts#L335-L341) and before the `if (dispatchResult.aborted)` check at [src/agents/base.ts](../../../../src/agents/base.ts#L343), insert:

```ts
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

The `tool_result` user message has already been pushed at this point — keeps message history consistent for any restart and preserves the F14 invariant on the (orthogonal) nudge path.

### 7. Add `plan_done` to `PLAN_TOOLS`

In the `PLAN_TOOLS` set near [src/agents/base.ts](../../../../src/agents/base.ts#L1084-L1089), add `"plan_done"`. `WORKER_EXCLUDED_TOOLS` spreads `PLAN_TOOLS` so workers are blocked transitively; no further filter edit needed.

### 8. Implement the `PlannerAgent` terminal-tool override and consume the new finishReason

In [src/agents/planner.ts](../../../../src/agents/planner.ts):

a. Override the hook (add as a protected method on `PlannerAgent`):

```ts
protected override detectTerminalToolCall(
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[],
  dispatchResult: { toolResults: { toolUseId: string; content: unknown; isError: boolean }[] },
): { name: string; data: { reason: string } } | null {
  for (const tc of toolCalls) {
    if (tc.name !== "plan_done") continue;
    const r = dispatchResult.toolResults.find((tr) => tr.toolUseId === tc.id);
    if (!r || r.isError) continue;
    const reason = tc.input?.["reason"];
    if (typeof reason === "string" && reason.trim() !== "") {
      return { name: "plan_done", data: { reason } };
    }
  }
  return null;
}
```

b. Replace the regex block at [src/agents/planner.ts](../../../../src/agents/planner.ts#L87-L93). The new `run()` handling order inside the `while (true)` loop:

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

// Otherwise: planner ended turn with text only → nudge (unchanged from current).
```

The existing nudge block at [src/agents/planner.ts](../../../../src/agents/planner.ts#L96-L116) is preserved verbatim. The regex line at [src/agents/planner.ts](../../../../src/agents/planner.ts#L91-L93) and its two-line comment at [src/agents/planner.ts](../../../../src/agents/planner.ts#L89-L90) are deleted.

### 9. Rewrite the planner startup message

In [src/agents/planner.ts](../../../../src/agents/planner.ts#L172), replace bullet 6 with:

> `6. Call plan_done(reason) once — and only once — when all configured objectives are verified complete and there is no continuous-improvement directive active. Do not emit any free-text completion signal. plan_done is the only way to end the planning session.`

### 10. Rewrite the planner system prompt

In [prompts/planner.md](../../../../prompts/planner.md):

- At [prompts/planner.md](../../../../prompts/planner.md#L41-L49), delete the `If truly everything is done, say exactly "PLAN_COMPLETE" on its own line.` bullet and any standalone `**NEVER say "PLAN_COMPLETE" unless …**` sentence. The "always call a tool" rule is now self-consistent: completion *is* a tool call.
- Under the Plan MCP Service section around [prompts/planner.md](../../../../prompts/planner.md#L65), add:

  > `- plan_done(reason) — Signal that all configured objectives are verified complete. Call exactly once at the end of the planning session. Do not use for partial progress; do not use after a continuous-improvement directive is queued.`

- At [prompts/planner.md](../../../../prompts/planner.md#L137), replace the `Return "PLAN_COMPLETE" only when …` paragraph with:

  > `Call plan_done(reason) only when ALL configured objectives are achieved and verified AND there is no explicit runtime instruction to continue improving. If the runtime injects a continuous-improvement instruction, create and dispatch the next bounded improvement stage instead of ending the session.`

After the rewrite the string `PLAN_COMPLETE` must not appear in [prompts/planner.md](../../../../prompts/planner.md). Verify with `grep -n PLAN_COMPLETE prompts/planner.md`.

### 11. Update the recovery loop discriminator

In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), next to `hasSummary` at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L825-L827) add:

```ts
interface PlanDoneCompletion { completion: "plan_done"; summary: string }
function isPlanDoneCompletion(value: unknown): value is PlanDoneCompletion {
  return !!value
    && typeof value === "object"
    && (value as { completion?: unknown }).completion === "plan_done"
    && typeof (value as { summary?: unknown }).summary === "string";
}
```

Rewrite the recovery branch at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L644) to:

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

Update the third log line at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L648-L650) from `Planner ended without PLAN_COMPLETE` to `Planner ended without plan_done`.

### 12. Rewrite `RECOVERY_PROMPT` and `CONTINUOUS_IMPROVEMENT_PROMPT`

In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L525-L549):

- Replace `DO NOT say PLAN_COMPLETE unless ALL objectives are truly achieved …` with `DO NOT call plan_done unless ALL objectives are truly achieved with evidence from successful stages. If stages have escalated or failed, the objectives are NOT complete — fix the issues and retry.`
- Replace `Only say PLAN_COMPLETE if continuous-improvement mode has been disabled by runtime configuration or shutdown is requested.` with `Only call plan_done if continuous-improvement mode has been disabled by runtime configuration or shutdown is requested.`

After this step, `grep -n PLAN_COMPLETE src/` must return no matches.

### 13. Add the dashboard formatter entry

In [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts), alongside the existing `plan_complete_stage` formatter, add a `plan_done` entry. Label `Planner completed`; body surfaces `input.reason`. No CSS or component changes.

### 14. Rewrite the planner success test (single-turn termination)

In [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts):

a. Expand the stub `mcpRuntime` at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L63-L64) to:

```ts
const stubPlanService = new PlanService(join(saivageDir));
await stubPlanService.init();

mcpRuntime: {
  getAllTools: () => [{
    service: "plan",
    name: "plan_done",
    description: "completion signal",
    inputSchema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
  }],
  callTool: async (service: string, tool: string, args: Record<string, unknown>) => {
    if (service === "plan" && tool === "plan_done") {
      return await stubPlanService.plan_done(args as { reason: string });
    }
    return { ok: true };
  },
} as AgentContext["mcpRuntime"],
```

Also pass `planService: stubPlanService` in the `AgentContext` literal returned by `makePlannerContext`.

(If the live `McpRuntime.getAllTools()` shape differs from the literal above, copy the actual shape from [src/mcp/runtime.ts](../../../../src/mcp/runtime.ts) when implementing — match the runtime contract, not this snippet verbatim.)

b. Add a new test `it("terminates on plan_done tool call without an extra model turn")`:

```ts
const calls: ChatRequest[] = [];
const router = {
  getMaxContextTokens: () => 200_000,
  countTokens: () => 0,
  chat: async (request: ChatRequest): Promise<ChatResponse> => {
    calls.push(request);
    return {
      content: "",
      toolCalls: [{ id: "tc-done-1", name: "plan_done", input: { reason: "objectives verified" } }],
      finishReason: "tool_use",
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  },
};

const planner = new PlannerAgent(/* ... */);
const result = await planner.run();
expect(result.kind).toBe("success");
expect(result.data).toEqual({ completion: "plan_done", summary: "objectives verified" });
expect(calls).toHaveLength(1); // single turn — no extra model call required
```

c. Add a negative test `it("does not terminate on a bare PLAN_COMPLETE text — only on plan_done tool call")`. The router returns `content: "PLAN_COMPLETE"` with `toolCalls: []` on call 1; on every subsequent call it returns the same. Assert the planner enters the nudge branch and eventually returns `kind: "failure"` after `MAX_NUDGES = 15`.

d. Preserve the existing F14 test at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L113-L155) — the assistant-text-equals-one assertion and the SYSTEM-nudge-follows-it assertion must remain. Update the *follow-up* response (after the nudge) from `content: "PLAN_COMPLETE"` to a tool-call response: `toolCalls: [{ id: "tc-done-1", name: "plan_done", input: { reason: "ack" } }]`, so the F14 test now also exercises the new termination path. The duplication-count assertion stays unchanged.

### 15. Add PlanService unit tests (both dispatch paths)

In [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts), inside the existing `describe("PlanService", ...)` block around [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L348-L510):

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

### 16. Type-check, lint, unit-test, build (validation commands)

From `/home/salva/g/ml/saivage`:

```bash
npx tsc --noEmit
npx eslint .
npx vitest run src/agents/planner.nudge.test.ts src/runtime/runtime.test.ts
npx vitest run
npm run build
```

Note: the focused vitest line includes only real test files — [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) and [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts). Do **not** pass [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts) — it is a source file, not a test file (r1 plan bug).

Verification greps after edits (must all return zero matches, except documentation in `SPEC/v2/review-2026-05-round2/G09/`):

```bash
grep -rn PLAN_COMPLETE src/ prompts/
```

If any match appears outside the deletion list, fix before running validation.

## Validation

- **Static**: `npx tsc --noEmit` passes; `npx eslint .` passes; `grep -rn PLAN_COMPLETE src/ prompts/` returns zero.
- **Focused unit**: the two new test files produce green; the F14 assertion in [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts) is preserved and green; the `plan_done` single-turn-termination test is green and asserts the router was called exactly once on the success path; the bare-`PLAN_COMPLETE`-text negative test is green and ends with `kind === "failure"` after 15 nudges.
- **Full unit**: `npx vitest run` is green workspace-wide. No collateral test break should occur (the AgentContext addition is a required new field; all internal callers will type-fail until updated by step 5, so an all-green run also confirms step 5 was applied at every site).
- **Build**: `npm run build` produces `dist/cli.js` without TS errors.
- **Operator-gated live restart** (only if the operator approves; otherwise stop here):
  1. Read [/home/salva/g/ml/WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md) and the live `.saivage/runtime/runtime-state.json` under [/home/salva/g/ml/saivage-v3/.saivage](../../../../../saivage-v3/.saivage) before any restart.
  2. `ssh root@10.0.3.112 systemctl restart saivage.service`.
  3. `curl -fsS http://10.0.3.112:8080/health` → 200.
  4. `curl -fsS http://10.0.3.112:8080/api/notes` → 200.
  5. Drive a short planner session against a small objective. Confirm via the dashboard that the planner emits a `plan_done` tool_use; the formatter renders "Planner completed" with the model's `reason`; the recovery loop logs `Planner completed via plan_done: <reason>` and either exits (continuous-improvement off) or queues `CONTINUOUS_IMPROVEMENT_PROMPT` (on).
  6. Verify in `.saivage/tmp/chats/*/messages.jsonl` for the session that no bare `PLAN_COMPLETE` substring ever terminated the planner.
- **Do not** restart `saivage` (10.0.3.111) or `diedrico` (10.0.3.113). They share the bind mount on `/home/salva/g/ml/saivage` and pick up the binary on rebuild, but they own unrelated long-running stage state; restart only with operator approval and against their own runtime-state checkpoints.

## Rollback

Clean revert only. No partial mode. No regex fallback.

1. `git revert <merge-sha>` (or `git revert <commit-sha>` if the change merged as a fast-forward of a single commit). This restores [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts), [src/agents/types.ts](../../../../src/agents/types.ts), [src/agents/base.ts](../../../../src/agents/base.ts), [src/agents/planner.ts](../../../../src/agents/planner.ts), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [prompts/planner.md](../../../../prompts/planner.md), [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts), [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts), and [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) wholesale to their pre-finding state.
2. `npm run build` to regenerate `dist/cli.js`.
3. If operator approves: `ssh root@10.0.3.112 systemctl restart saivage.service`. The planner returns to regex-based detection on the next session boundary.

No on-disk schema change occurred (`pendingCompletion` is in-memory only; `plan.json` / `plan-history.json` are untouched). Revert needs no data migration.

The r1 partial rollback path — "keep `plan_done` but restore the regex as fallback" — is explicitly **removed**. A mixed protocol is a backward-compat shim and contradicts the workspace's architecture-first guideline. If a model regression is observed post-merge, the response is `git revert` followed by investigation, not regex re-introduction.

## Cross-finding

- **G04** — Manager final-response validation. Lands after G09. The `detectTerminalToolCall` hook generalises to `manager_done(reason)`; the `isPlanDoneCompletion` shape generalises to a tagged-union `completion: "plan_done" | "manager_done" | …`.
- **G07** — Compaction marker loss. Retired by construction: a `plan_done` tool_use is a structural assistant block preserved by the round-parser as part of its `ToolRound`, not a substring that summarisation can drop. G07 should still land before G09 in the metaplan to keep live validation here free of unrelated compaction noise.
- **F14** — Nudge-path message non-duplication. Re-asserted in the rewritten [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts). Do not delete the F14 assertion when restructuring the test.
- **G11** — Chat restart regex (English-only). Metaplan batches G04 / G09 / G11 as "free-text protocols to retire". Not blocking; not in scope for this finding.
