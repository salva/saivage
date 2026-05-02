import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProjectContext } from "../store/project.js";
import { readDoc, writeDoc } from "../store/documents.js";
import {
  PlanHistorySchema,
  PlanSchema,
  RuntimeStateSchema,
  ShutdownSummarySchema,
} from "../types.js";
import {
  consumeShutdownHandoff,
  writeShutdownRequest,
  writeShutdownSummary,
} from "./shutdown-handoff.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "saivage-shutdown-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeProjectContext(root: string): ProjectContext {
  const saivageDir = join(root, ".saivage");
  return {
    projectRoot: root,
    saivageDir,
    config: {
      project_name: "test",
      objectives: [],
      provider: "test",
      notifications: {
        channels: [],
        filters: { min_severity: "info", categories: [] },
      },
      skills: { max_per_agent: 5 },
    },
    paths: {
      plan: join(saivageDir, "plan.json"),
      planHistory: join(saivageDir, "plan-history.json"),
      stages: join(saivageDir, "stages"),
      notes: join(saivageDir, "notes"),
      inspections: join(saivageDir, "inspections"),
      skills: join(saivageDir, "skills"),
      tools: join(saivageDir, "tools"),
      research: join(root, "research"),
      tmp: join(saivageDir, "tmp"),
      runtimeState: join(saivageDir, "tmp", "state", "runtime.json"),
      shutdownRequest: join(saivageDir, "tmp", "state", "shutdown-request.json"),
      shutdownSummary: join(saivageDir, "tmp", "state", "shutdown-summary.json"),
      chats: join(saivageDir, "tmp", "chats"),
      inspectorWorkspace: join(saivageDir, "tmp", "inspector-workspace"),
      work: join(saivageDir, "tmp", "work"),
    },
  };
}

function seedRuntimeDocs(project: ProjectContext) {
  const now = new Date().toISOString();
  writeDoc(project.paths.runtimeState, {
    status: "running",
    current_stage_id: "stage-active",
    active_agents: [
      {
        agent_type: "coder",
        agent_id: "coder-1",
        status: "running",
        current_task_id: "task-1",
        started_at: new Date(Date.now() - 90_000).toISOString(),
      },
    ],
    started_at: new Date(Date.now() - 3_600_000).toISOString(),
    updated_at: now,
    pid: 12345,
  }, RuntimeStateSchema);

  writeDoc(project.paths.plan, {
    updated_at: now,
    current_stage_id: "stage-active",
    stages: [
      {
        id: "stage-active",
        objective: "Continue the active work",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["verified"],
        references: [],
        tags: [],
      },
    ],
  }, PlanSchema);

  writeDoc(project.paths.planHistory, {
    stages: [
      {
        id: "stage-done",
        objective: "Previous work",
        expected_outcomes: ["done"],
        actual_outcomes: ["done"],
        started_at: new Date(Date.now() - 7_200_000).toISOString(),
        completed_at: new Date(Date.now() - 3_700_000).toISOString(),
        result: "completed",
        summary: "Finished earlier stage",
      },
    ],
  }, PlanHistorySchema);
}

describe("shutdown handoff", () => {
  it("writes a shutdown summary and consumes it as Planner restart context", () => {
    const project = makeProjectContext(tmpDir);
    seedRuntimeDocs(project);

    writeShutdownRequest(project, "Application code changed during deploy", "deploy");
    const summary = writeShutdownSummary(project);

    expect(summary.reason).toBe("Application code changed during deploy");
    expect(summary.requested_by).toBe("deploy");
    expect(summary.runtime_status).toBe("running");
    expect(summary.current_stage_id).toBe("stage-active");
    expect(summary.active_agents).toHaveLength(1);
    expect(summary.active_agents[0].elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(summary.plan).toEqual({
      current_stage_id: "stage-active",
      pending_stages: 1,
      history_stages: 1,
    });
    expect(existsSync(project.paths.shutdownRequest)).toBe(false);

    const persisted = readDoc(project.paths.shutdownSummary, ShutdownSummarySchema);
    expect(persisted.reason).toBe("Application code changed during deploy");

    const handoff = consumeShutdownHandoff(project);
    expect(handoff).toContain("SYSTEM RESTART HANDOFF");
    expect(handoff).toContain("External shutdown reason: Application code changed during deploy");
    expect(handoff).toContain("Active agents at shutdown");
    expect(handoff).toContain("coder:coder-1 task=task-1");
    expect(handoff).toContain("call plan_get() and plan_get_history()");
    expect(existsSync(project.paths.shutdownSummary)).toBe(false);
  });

  it("falls back to a request-only Planner handoff if no summary was saved", () => {
    const project = makeProjectContext(tmpDir);

    writeShutdownRequest(project, "Manual service restart", "operator");
    const handoff = consumeShutdownHandoff(project);

    expect(handoff).toContain("before the previous process could save a full shutdown summary");
    expect(handoff).toContain("Requested by: operator");
    expect(handoff).toContain("Reason: Manual service restart");
    expect(existsSync(project.paths.shutdownRequest)).toBe(false);
  });

  it("does not throw when a stale summary file is malformed", () => {
    const project = makeProjectContext(tmpDir);

    writeShutdownRequest(project, "Recover after malformed summary", "test");
    writeFileSync(project.paths.shutdownSummary, "{ nope", "utf-8");

    const handoff = consumeShutdownHandoff(project);

    expect(handoff).toContain("Reason: Recover after malformed summary");
    expect(existsSync(project.paths.shutdownRequest)).toBe(false);
  });
});
