/**
 * Saivage — Fix 3 (plan-persistence-fix) self-correction guard.
 *
 * Asserts that when the dispatcher rejects run_manager with STAGE_MISMATCH
 * (or STAGE_NOT_FOUND), the planner's NEXT tool call is the missing
 * precondition tool (plan_set_current or plan_add_stage) for the SAME
 * stage id — not a re-dispatch and not plan_done.
 *
 * STATUS: skipped. Per SPEC/plan-persistence-fix/03-plan.md §3.6, this
 * test ships with the assertion shape preserved but skipped because:
 *   1. The stub-LLM harness needed to drive runPlanner does not yet
 *      exist (shared dependency with prompt-tool-sequence.test.ts).
 *   2. The structured `{code, error}` AgentResult.reason that the
 *      assertion inspects is introduced by Stage C (Fix 1) — see
 *      SPEC/plan-persistence-fix/02-architecture.md §2.3.
 * Re-enable in Stage C once both prerequisites land.
 */

import { describe, it, expect } from "vitest";
import { RECOVERY_PROMPT } from "./bootstrap.js";

describe.skip("planner self-correction (Fix 3)", () => {
  it("on STAGE_MISMATCH, next call is plan_set_current for the same stage", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    void RECOVERY_PROMPT;
    const runIdx = calls.findIndex((c) => c.name === "run_manager");
    expect(calls[runIdx + 1]?.name).toBe("plan_set_current");
    expect((calls[runIdx + 1]?.args as { stage_id: string }).stage_id).toBe(
      "stage-X",
    );
  });

  it("on STAGE_NOT_FOUND, next call is plan_add_stage for the same stage", async () => {
    const calls: Array<{ name: string; args: unknown }> = [];
    const runIdx = calls.findIndex((c) => c.name === "run_manager");
    expect(calls[runIdx + 1]?.name).toBe("plan_add_stage");
  });

  it("does NOT re-emit run_manager before the missing precondition tool runs", async () => {
    const calls: Array<{ name: string }> = [];
    const runIdxs = calls.flatMap((c, i) => (c.name === "run_manager" ? [i] : []));
    if (runIdxs.length >= 2) {
      const between = calls.slice(runIdxs[0] + 1, runIdxs[1]).map((c) => c.name);
      expect(between).toEqual(
        expect.arrayContaining(["plan_set_current"]),
      );
    }
  });
});
