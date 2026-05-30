# G09 — Plan r1

**Finding**: [../G09-planner-plan-complete-text-protocol.md](../G09-planner-plan-complete-text-protocol.md)
**Analysis**: [./01-analysis-r1.md](./01-analysis-r1.md)
**Design**: [./02-design-r1.md](./02-design-r1.md) — Proposal B (`plan_done` tool).

## Steps

1. **Add `pendingCompletion` field and methods to `PlanService`.** In [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L48-L70), add a private field `private pendingCompletion: { reason: string; requested_at: string } | null = null;` to the class. Add two methods near the existing tool methods:

   - `async plan_done(args: { reason: string }): Promise<{ ok: true; recorded: boolean }>` — validates `args.reason` is a non-empty string (return `planError("VALIDATION_ERROR", …)` otherwise); if `pendingCompletion` is already set, returns `{ ok: true, recorded: false }` without overwriting; otherwise sets `pendingCompletion = { reason: args.reason, requested_at: new Date().toISOString() }` and returns `{ ok: true, recorded: true }`. No disk write.
   - `consumePendingCompletion(): { reason: string; requested_at: string } | null` — returns the current value and clears the field. Pure in-memory.

2. **Wire `plan_done` into the MCP dispatch table.** In [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L370-L405), add `case "plan_done": result = await this.plan_done(args as { reason: string }); break;`. In `getToolSchemas()` around [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts#L475-L487), add a schema entry:

   ```ts
   {
     name: "plan_done",
     description: "Signal that all project objectives are verified complete. Call only after every configured objective has been achieved with evidence from successful stage completions. Provide a one-paragraph reason explaining which objectives are satisfied and how.",
     inputSchema: {
       type: "object",
       properties: { reason: { type: "string", description: "Why the project is complete." } },
       required: ["reason"],
     },
   },
   ```

3. **Add `plan_done` to the planner role allow-list.** In [src/agents/base.ts](../../../../src/agents/base.ts#L1084-L1089), add `"plan_done"` to the `PLAN_TOOLS` set. `WORKER_EXCLUDED_TOOLS` spreads `PLAN_TOOLS` so workers are blocked transitively; no further change to `ROLE_TOOL_FILTER` is needed.

4. **Replace the regex check in PlannerAgent.** In [src/agents/planner.ts](../../../../src/agents/planner.ts#L87-L116), inside the `run()` loop, replace the comment block and regex line (lines 89–93) with:

   ```ts
   const completion = this.planService.consumePendingCompletion();
   if (completion) {
     return { kind: "success", data: { summary: completion.reason } };
   }
   ```

   Wire `planService` in by extending the agent context: `PlannerAgent.create` at [src/agents/planner.ts](../../../../src/agents/planner.ts#L30-L44) resolves the live `PlanService` instance (the runtime already constructs one; expose it via `ctx.mcpRuntime` or via the existing `runtime` registry — pick whichever the planner already imports for `noteManager` parity). Store on `this.planService` in the constructor. Do not duplicate the instance; the same `PlanService` must be the one the MCP dispatcher calls.

5. **Update the planner's startup-message instruction.** In [src/agents/planner.ts](../../../../src/agents/planner.ts#L172), replace step 6 (`Only respond with "PLAN_COMPLETE" when objectives are verified …`) with: `6. Call plan_done(reason) once — and only once — when all configured objectives are verified complete and there is no continuous-improvement instruction active. Do not emit any free-text completion signal; plan_done is the only way to end the planning session.`

6. **Rewrite the planner system prompt.** In [prompts/planner.md](../../../../prompts/planner.md):
   - At [prompts/planner.md](../../../../prompts/planner.md#L41-L49) (the "CRITICAL RULE — ALWAYS TAKE ACTION" block), delete bullet 5 (`If truly everything is done, say exactly "PLAN_COMPLETE" on its own line.`) and the standalone `**NEVER say "PLAN_COMPLETE" unless …**` sentence. The "always call a tool" rule is now consistent: completion *is* a tool call (`plan_done`).
   - At [prompts/planner.md](../../../../prompts/planner.md#L65) under "Plan MCP Service", add a new bullet: `- \`plan_done(reason)\` — Signal that all configured objectives are verified complete. Call once at the end of the planning session. Do not use this for partial progress.`
   - At [prompts/planner.md](../../../../prompts/planner.md#L137), replace the entire paragraph (`Return "PLAN_COMPLETE" only when …`) with: `Call \`plan_done(reason)\` only when ALL configured objectives are achieved and verified AND there is no explicit runtime instruction to continue improving. If the runtime injects a continuous-improvement instruction, create and dispatch the next bounded improvement stage instead of ending the session.`

7. **Update the recovery loop discriminator.** In [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L619-L640), replace the literal-string discriminator with a structural one:

   ```ts
   if (result.kind === "success" && hasSummary(result.data)) {
     if (!runtime.config.runtime.continuousImprovement) {
       log.info(`[recovery] Planner completed: ${result.data.summary}`);
       return result;
     }
     queuePlannerDirective(runtime, CONTINUOUS_IMPROVEMENT_PROMPT);
     await runtime.eventBus.publish({
       type: "plan_updated",
       summary: "Planner completed the active plan. Continuous-improvement directive queued; restarting Planner.",
       timestamp: new Date().toISOString(),
     });
     log.info("[recovery] Planner completed; continuous-improvement mode is enabled. Restarting planner");
     continue;
   }
   ```

   Update the inline log strings at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L625), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L635), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L644) to drop the `PLAN_COMPLETE` literal in favour of `planner completed` / `Planner ended without completion`. Also update the two `RECOVERY_PROMPT` / `CONTINUOUS_IMPROVEMENT_PROMPT` constants at [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts#L525-L549) to reference `plan_done(reason)` instead of `PLAN_COMPLETE`.

8. **Add `plan_done` to the dashboard tool formatter.** In [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts#L620-L635), add a `plan_done` entry alongside `plan_complete_stage`. Render the row label as "Planner completed" and surface `input.reason` as the body. No CSS or component changes required.

9. **Rewrite the planner success test.** In [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts):
   - Replace the call-2 response at [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts#L90-L96) with a tool-call response: `toolCalls: [{ id: "tc-done-1", name: "plan_done", input: { reason: "objectives verified" } }]` and any short `content`. Reflect the new shape in the assertions (the planner result's `summary` should now be `"objectives verified"`, not the literal `"PLAN_COMPLETE"`).
   - Inject a stub `mcpRuntime.callTool` that, when called with `name === "plan_done"`, calls into a stub `planService` and returns `{ ok: true, recorded: true }`; the same stub `planService.consumePendingCompletion()` must return the recorded reason on the next iteration so the planner's outer loop exits with success.
   - Preserve the F14 invariant: the test must still assert that the call-1 assistant text appears exactly once in `calls[1].messages` and the nudge user message follows it.
   - Add a sibling test `it("ignores a bare PLAN_COMPLETE text without plan_done")` — the router returns `content: "PLAN_COMPLETE"` on every call; assert the planner enters the nudge branch (does *not* succeed) and eventually returns `kind: "failure"` after `MAX_NUDGES` so the regression cannot regress silently.

10. **Add a `PlanService.plan_done` round-trip unit test.** In [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts) (next to the existing `plan_complete_stage` tests around [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts#L482-L500)), add:

    ```ts
    it("plan_done records a pending completion exactly once", async () => {
      const r1 = await planService.plan_done({ reason: "all objectives verified" });
      expect(r1).toEqual({ ok: true, recorded: true });
      const r2 = await planService.plan_done({ reason: "second call" });
      expect(r2).toEqual({ ok: true, recorded: false });
      const consumed = planService.consumePendingCompletion();
      expect(consumed?.reason).toBe("all objectives verified");
      expect(planService.consumePendingCompletion()).toBeNull();
    });
    ```

    Also add a validation test: `plan_done({ reason: "" })` returns a `VALIDATION_ERROR`.

11. **Delete the regex and its comment.** Remove the `// Only accept completion if planner explicitly says PLAN_COMPLETE / on its own line — not just as part of a sentence` comment block and the regex line at [src/agents/planner.ts](../../../../src/agents/planner.ts#L89-L93). Architecture-first; no shim.

12. **Type-check, lint, unit-test, build.** From `/home/salva/g/ml/saivage`:

    ```bash
    npx tsc --noEmit
    npx eslint .
    npx vitest run src/agents/planner.nudge.test.ts src/runtime/runtime.test.ts src/mcp/plan-server.ts
    npx vitest run
    npm run build
    ```

## Validation

- **Unit / repo-wide**: every command in step 12 succeeds; the two new tests (`plan_done` round-trip, "ignores bare PLAN_COMPLETE text") are green; the F14 message-non-duplication assertion still passes.
- **Build**: `npm run build` produces `dist/cli.js` without TS errors arising from the new `PlanService` surface or the planner constructor change.
- **Live, manual, against `saivage-v3` (10.0.3.112) only** (per workspace handoff):
  1. Read [/home/salva/g/ml/WORKSPACE_HANDOFF.md](../../../../../WORKSPACE_HANDOFF.md) and the live `.saivage/runtime/runtime-state.json` under [/home/salva/g/ml/saivage-v3/.saivage](../../../../../saivage-v3/.saivage) before any restart.
  2. On the host: `cd /home/salva/g/ml/saivage && npm run build`.
  3. `ssh root@10.0.3.112 systemctl restart saivage.service`.
  4. `curl -fsS http://10.0.3.112:8080/health` → 200; `curl -fsS http://10.0.3.112:8080/api/notes` → 200.
  5. Drive a short planner session via the dashboard (objective that completes in one or two stages). Confirm:
     - The planner emits a `plan_done` tool_use at end of session; the dashboard renders it via the new formatter.
     - The recovery loop logs `planner completed: <reason>` and either exits (continuous-improvement off) or queues `CONTINUOUS_IMPROVEMENT_PROMPT` (on).
     - A bare `PLAN_COMPLETE` literal embedded by the model in earlier text does **not** terminate the planner (verify by inspecting `.saivage/tmp/chats/*/messages.jsonl` for the test session).
  6. Verify no regression in the nudge branch: trigger a session where the model is forced (via a low-stage-budget objective and a short prompt) to end a turn with no tool calls; confirm the SYSTEM nudge fires exactly once per nudge with no duplicated assistant entries.
- **Do not** restart `saivage` (10.0.3.111) or `diedrico` (10.0.3.113) for this finding's validation. They share the bind-mount on `/home/salva/g/ml/saivage` so the binary updates with the rebuild, but they own unrelated long-running stage state; restart only with operator approval and against their own runtime-state checkpoints.

## Rollback

- Single revert: this change touches [src/mcp/plan-server.ts](../../../../src/mcp/plan-server.ts), [src/agents/planner.ts](../../../../src/agents/planner.ts), [src/agents/base.ts](../../../../src/agents/base.ts) (one set add), [src/server/bootstrap.ts](../../../../src/server/bootstrap.ts), [prompts/planner.md](../../../../prompts/planner.md), [web/src/utils/toolFormatters.ts](../../../../web/src/utils/toolFormatters.ts), [src/agents/planner.nudge.test.ts](../../../../src/agents/planner.nudge.test.ts), and [src/runtime/runtime.test.ts](../../../../src/runtime/runtime.test.ts). `git revert <merge-sha>` restores prior behaviour wholesale.
- **No on-disk schema change.** `pendingCompletion` is in-memory only and `plan.json` / `plan-history.json` are untouched. A revert does not need any data migration.
- After revert, rebuild and `ssh root@10.0.3.112 systemctl restart saivage.service`. The planner returns to regex-based detection on the next session boundary.
- If a partial rollback is preferred (keep `plan_done` available but restore the regex as a fallback), revert only the change at [src/agents/planner.ts](../../../../src/agents/planner.ts#L87-L116): re-add the regex check **before** `consumePendingCompletion()`. This is explicitly *not* recommended (it reintroduces the false-positive surface from §3.2 of the analysis) and should only be considered if a model regression is observed in the field.

## Cross-finding

- **G04 — manager validates final response against a hardcoded tool list.** Same architectural shape (text-protocol contract bolted onto a structured-tool agent). G04 should land **after** G09 so the manager change can reference the `plan_done`-style tool retirement as the canonical pattern.
- **G07 — compaction fallback can drop the marker.** Closing G09 with a tool call retires this failure mode entirely: `plan_done` is a structural assistant block preserved by the round-parser (Proposal B in G07's design) as part of its `ToolRound`, not a substring that summarisation can drop. G07 and G09 are independent but G07 should land first to keep the live-validation in §Validation clean of unrelated compaction noise.
- **F14 — PlannerAgent message duplication on the nudge path.** The nudge branch survives this change; the F14 invariant must be re-asserted in the rewritten `planner.nudge.test.ts`. Do **not** delete the existing F14 assertion when restructuring the test.
- **G11 — chat restart regex is English-only.** Same family (regex-on-LLM-text protocol). Out of scope for this finding but the metaplan should batch G04 / G09 / G11 as "free-text protocols to retire".
- **Workspace memory `saivage-v3-getrich-v2-bind-mounts`** is not directly relevant: this finding does not touch the GetRich-v2 container (`10.0.3.170`). The shared `/home/salva/g/ml/saivage` bind mount across `saivage` / `diedrico` / `saivage-v3` *is* relevant; see Validation step 6's "do not restart" note.
