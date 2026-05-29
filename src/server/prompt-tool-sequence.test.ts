/**
 * Saivage — Fix 3 (plan-persistence-fix) behavioural prompt guard.
 *
 * Asserts that under both RECOVERY_PROMPT and CONTINUOUS_IMPROVEMENT_PROMPT
 * the planner's first three tool calls follow plan_add_stage →
 * plan_set_current → run_manager.
 *
 * STATUS: skipped. Implementing this assertion requires a stub-LLM driver
 * + planner harness (`makeStubRuntime`, `contractCompliantPlanner`,
 * `runPlanner`) that does not yet exist in src/server/. The structural
 * guard in prompt-snapshots.test.ts already catches accidental removal
 * of any of those tool names from the prompts. This file is shipped with
 * the assertion shape preserved so the harness work is a follow-up.
 * See SPEC/plan-persistence-fix/03-plan.md §3.5.
 */

import { describe, it, expect } from "vitest";
import {
  RECOVERY_PROMPT,
  CONTINUOUS_IMPROVEMENT_PROMPT,
} from "./bootstrap.js";

describe.skip("planner prompt tool sequence (Fix 3)", () => {
  it("emits plan_add_stage → plan_set_current → run_manager under RECOVERY_PROMPT", async () => {
    // TODO(plan-persistence-fix harness): build makeStubRuntime +
    // contractCompliantPlanner + runPlanner injection.
    const calls: string[] = [];
    // const runtime = await makeStubRuntime({
    //   directives: [RECOVERY_PROMPT],
    //   onToolCall: (name) => calls.push(name),
    //   stubLLM: contractCompliantPlanner(),
    // });
    // await runPlanner(runtime);
    void RECOVERY_PROMPT;
    expect(calls.slice(0, 3)).toEqual([
      "plan_add_stage",
      "plan_set_current",
      "run_manager",
    ]);
  });

  it("emits plan_add_stage → plan_set_current → run_manager under CONTINUOUS_IMPROVEMENT_PROMPT", async () => {
    const calls: string[] = [];
    void CONTINUOUS_IMPROVEMENT_PROMPT;
    expect(calls.slice(0, 3)).toEqual([
      "plan_add_stage",
      "plan_set_current",
      "run_manager",
    ]);
  });
});
