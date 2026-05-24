import { describe, it, expect } from "vitest";
import {
  normalizeTask,
  parseTaskReport,
  buildFailureReport,
  type WorkerRole,
} from "./task-report.js";
import type { WorkerInput } from "./types.js";

const ROLES: WorkerRole[] = ["coder", "researcher", "data_agent", "reviewer"];
const ROLE_TYPE: Record<WorkerRole, string> = {
  coder: "code",
  researcher: "research",
  data_agent: "data",
  reviewer: "review",
};

function makeInput(role: WorkerRole): WorkerInput {
  return {
    stageId: "stage-1",
    task: normalizeTask({ id: "t1", description: "x" }, role),
    ctx: undefined as any,
  } as WorkerInput;
}

describe("task-report shared helpers", () => {
  it("normalizeTask applies role-specific defaults", () => {
    for (const role of ROLES) {
      const t = normalizeTask({ description: "hello" }, role);
      expect(t.assigned_to).toBe(role);
      expect(t.type).toBe(ROLE_TYPE[role]);
      expect(t.description).toContain("hello");
      expect(t.id).toBe("unknown");
      expect(t.attempt).toBe(1);
      expect(t.max_attempts).toBe(3);
    }
  });

  it("normalizeTask merges files and instructions into description", () => {
    const t = normalizeTask(
      {
        id: "x",
        description: "Do thing",
        files: ["a.ts", "b.ts"],
        instructions: "Use TDD",
        acceptance_criteria: ["passes"],
      },
      "coder",
    );
    expect(t.description).toContain("a.ts");
    expect(t.description).toContain("Use TDD");
    expect(t.checklist).toEqual([{ description: "passes", required: true }]);
  });

  it("parseTaskReport extracts JSON when present", () => {
    const input = makeInput("coder");
    const text =
      'Here is the report: {"task_id":"t1","stage_id":"stage-1","status":"completed","summary":"ok"}';
    const r = parseTaskReport(text, input, "coder", new Date().toISOString(), Date.now());
    expect(r.agent).toBe("coder");
    expect(r.status).toBe("completed");
    expect(r.summary).toBe("ok");
  });

  it("parseTaskReport falls back when no JSON found", () => {
    const input = makeInput("researcher");
    const text = "plain text answer no JSON here";
    const r = parseTaskReport(text, input, "researcher", new Date().toISOString(), Date.now());
    expect(r.agent).toBe("researcher");
    expect(r.status).toBe("completed");
    expect(r.summary).toContain("plain text");
  });

  it("buildFailureReport sets issues_found uniformly across all worker roles", () => {
    for (const role of ROLES) {
      const input = makeInput(role);
      const r = buildFailureReport(input, role, new Date().toISOString(), Date.now(), "boom");
      expect(r.agent).toBe(role);
      expect(r.status).toBe("failed");
      expect(r.failure_reason).toBe("boom");
      expect(r.issues_found).toEqual([
        { severity: "error", description: "boom" },
      ]);
    }
  });
});
