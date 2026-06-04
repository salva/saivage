import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedProject } from "../store/project.js";
import { StageRunStore } from "../store/stage-run-store.js";
import { PlanService } from "./plan-server.js";
import type { StageSummary, TaskList, TaskReport } from "../types.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-stage-tools-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("Plan MCP stage artifact tools", () => {
  it("registers the typed artifact tool schemas", () => {
    const schemas = new Map(PlanService.getToolSchemas().map((tool) => [tool.name, tool]));

    for (const name of ["stage_write_tasks", "task_write_report", "stage_write_summary", "stage_get_run", "stage_list_reports"]) {
      expect(schemas.get(name)?.inputSchema).toMatchObject({ type: "object" });
    }
    expect(schemas.get("stage_write_tasks")?.inputSchema).toMatchObject({ required: ["task_list"] });
    expect(schemas.get("task_write_report")?.inputSchema).toMatchObject({ required: ["report"] });
    expect(schemas.get("stage_write_summary")?.inputSchema).toMatchObject({ required: ["summary"] });
  });

  it("persists task lists, reports, and summaries through StageRunStore", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const stageRuns = new StageRunStore(project);
    const service = new PlanService(project.saivageDir, stageRuns);
    await service.init();

    const tasks = makeTaskList();
    const report = makeTaskReport();
    const summary = makeStageSummary();

    await expect(service.handleToolCall("stage_write_tasks", { task_list: tasks }, { agentId: "manager-1" })).resolves.toMatchObject({ isError: false });
    await expect(service.handleToolCall("task_write_report", { report }, { agentId: "worker-1" })).resolves.toMatchObject({ isError: false });
    await expect(service.handleToolCall("stage_write_summary", { summary }, { agentId: "manager-1" })).resolves.toMatchObject({ isError: false });

    expect(JSON.parse(readFileSync(stageRuns.stageTaskListPath("stage-1"), "utf-8"))).toMatchObject({ stage_id: "stage-1" });
    expect(JSON.parse(readFileSync(stageRuns.stageTaskReportPath("stage-1", "task-1"), "utf-8"))).toMatchObject({ task_id: "task-1" });
    expect(JSON.parse(readFileSync(stageRuns.stageSummaryPath("stage-1"), "utf-8"))).toMatchObject({ result: "completed" });

    const run = await service.handleToolCall("stage_get_run", { stage_id: "stage-1" });
    expect(run.content).toMatchObject({ stage_id: "stage-1", reports: [{ task_id: "task-1" }], summary: { stage_id: "stage-1" } });
    const reports = await service.handleToolCall("stage_list_reports", { stage_id: "stage-1" });
    expect(reports.content).toMatchObject({ reports: [{ task_id: "task-1" }] });
  });

  it("returns validation errors instead of writing malformed artifacts", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const service = new PlanService(project.saivageDir, new StageRunStore(project));
    await service.init();

    const result = await service.handleToolCall("task_write_report", { report: { stage_id: "stage-1" } });

    expect(result).toMatchObject({ isError: true, content: { code: "VALIDATION_ERROR" } });
  });
});

function makeTaskReport(overrides: Partial<TaskReport> = {}): TaskReport {
  return {
    task_id: "task-1",
    stage_id: "stage-1",
    agent: "coder",
    status: "completed",
    summary: "done",
    checklist_results: [],
    files_modified: [],
    files_created: [],
    tests_added: [],
    tests_run: [],
    commits: [],
    issues_found: [],
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1,
    ...overrides,
  };
}

function makeStageSummary(overrides: Partial<StageSummary> = {}): StageSummary {
  return {
    stage_id: "stage-1",
    result: "completed",
    summary: "done",
    tasks_completed: 1,
    tasks_failed: 0,
    total_tasks: 1,
    outcomes_achieved: [],
    outcomes_missed: [],
    issues: [],
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: "2026-01-01T00:00:01.000Z",
    duration_ms: 1,
    ...overrides,
  };
}

function makeTaskList(overrides: Partial<TaskList> = {}): TaskList {
  return {
    stage_id: "stage-1",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    tasks: [
      {
        id: "task-1",
        type: "code",
        assigned_to: "coder",
        description: "do work",
        checklist: [],
        dependencies: [],
        status: "pending",
        attempt: 1,
        max_attempts: 3,
      },
    ],
    ...overrides,
  };
}
