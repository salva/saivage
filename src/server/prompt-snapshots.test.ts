/**
 * Saivage — Fix 3 (plan-persistence-fix) structural prompt guards.
 *
 * Verifies that RECOVERY_PROMPT and CONTINUOUS_IMPROVEMENT_PROMPT carry the
 * plan-mutation contract block introduced by Stage A, plus a snapshot of each
 * to catch unintended drift.
 */

import { describe, it, expect } from "vitest";
import {
  RECOVERY_PROMPT,
  CONTINUOUS_IMPROVEMENT_PROMPT,
} from "./bootstrap.js";

describe("planner prompt contract (Fix 3) — structural", () => {
  it("RECOVERY_PROMPT names the four-call mutation contract", () => {
    for (const tool of [
      "plan_add_stage",
      "plan_set_current",
      "run_manager",
      "plan_complete_stage",
    ]) {
      expect(RECOVERY_PROMPT).toContain(tool);
    }
  });

  it("RECOVERY_PROMPT teaches recovery from STAGE_MISMATCH / STAGE_NOT_FOUND / PLAN_NOT_FOUND", () => {
    for (const code of [
      "STAGE_MISMATCH",
      "STAGE_NOT_FOUND",
      "PLAN_NOT_FOUND",
    ]) {
      expect(RECOVERY_PROMPT).toContain(code);
    }
  });

  it("CONTINUOUS_IMPROVEMENT_PROMPT contract block enumerates plan_add_stage → plan_set_current → run_manager in that order", () => {
    // The prompt must contain a "PLAN-MUTATION CONTRACT" block in which the
    // tools are enumerated in the canonical order. We isolate the enumerated
    // body (after the header line, which itself mentions run_manager) and
    // check ordering inside it.
    const afterHeader = CONTINUOUS_IMPROVEMENT_PROMPT.split(
      "PLAN-MUTATION CONTRACT",
    )[1];
    expect(afterHeader, "PLAN-MUTATION CONTRACT block must be present").toBeDefined();
    const block = (afterHeader ?? "").split("\n").slice(1).join("\n");
    const addIdx = block.indexOf("plan_add_stage");
    const setIdx = block.indexOf("plan_set_current");
    const runIdx = block.indexOf("run_manager");
    expect(addIdx).toBeGreaterThan(-1);
    expect(setIdx).toBeGreaterThan(addIdx);
    expect(runIdx).toBeGreaterThan(setIdx);
  });

  it("CONTINUOUS_IMPROVEMENT_PROMPT names plan_complete_stage to close the contract", () => {
    expect(CONTINUOUS_IMPROVEMENT_PROMPT).toContain("plan_complete_stage");
  });

  it("CONTINUOUS_IMPROVEMENT_PROMPT still forbids plan_init", () => {
    expect(CONTINUOUS_IMPROVEMENT_PROMPT).toMatch(/DO NOT call\s+plan_init/);
  });

  it("CONTINUOUS_IMPROVEMENT_PROMPT teaches recovery from STAGE_MISMATCH / STAGE_NOT_FOUND", () => {
    for (const code of ["STAGE_MISMATCH", "STAGE_NOT_FOUND"]) {
      expect(CONTINUOUS_IMPROVEMENT_PROMPT).toContain(code);
    }
  });

  it("RECOVERY_PROMPT snapshot", () => {
    expect(RECOVERY_PROMPT).toMatchSnapshot();
  });

  it("CONTINUOUS_IMPROVEMENT_PROMPT snapshot", () => {
    expect(CONTINUOUS_IMPROVEMENT_PROMPT).toMatchSnapshot();
  });
});
