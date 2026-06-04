import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedProject } from "./project.js";
import { ProjectStore } from "./project-store.js";
import { StageRunStore } from "./stage-run-store.js";
import type { PlanDocument, StageSummary, TaskList, TaskReport } from "../types.js";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-stage-run-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("StageRunStore artifact reads", () => {
  it("returns missing for absent task reports and summaries", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new StageRunStore(project);

    expect(store.readExpectedStageTaskReport({ stageId: "stage-1", taskId: "task-1", agent: "coder" })).toEqual({
      kind: "missing",
      path: join(project.paths.stages, "stage-1", "reports", "task-1.json"),
    });
    expect(store.readExpectedStageSummary("stage-1")).toEqual({
      kind: "missing",
      path: join(project.paths.stages, "stage-1", "summary.json"),
    });
  });

  it("returns invalid for malformed or mismatched task reports and summaries", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new StageRunStore(project);
    mkdirSync(join(project.paths.stages, "stage-1", "reports"), { recursive: true });
    writeFileSync(join(project.paths.stages, "stage-1", "reports", "task-1.json"), "{", "utf-8");
    writeFileSync(join(project.paths.stages, "stage-1", "summary.json"), "{", "utf-8");

    expect(store.readExpectedStageTaskReport({ stageId: "stage-1", taskId: "task-1", agent: "coder" }).kind).toBe("invalid");
    expect(store.readExpectedStageSummary("stage-1").kind).toBe("invalid");

    writeFileSync(
      join(project.paths.stages, "stage-1", "reports", "task-1.json"),
      JSON.stringify(makeTaskReport({ task_id: "other-task" })),
      "utf-8",
    );
    writeFileSync(join(project.paths.stages, "stage-1", "summary.json"), JSON.stringify(makeStageSummary({ stage_id: "other-stage" })), "utf-8");

    expect(store.readExpectedStageTaskReport({ stageId: "stage-1", taskId: "task-1", agent: "coder" })).toMatchObject({
      kind: "invalid",
      reason: "task_id other-task does not match task-1",
    });
    expect(store.readExpectedStageSummary("stage-1")).toMatchObject({
      kind: "invalid",
      reason: "stage_id other-stage does not match stage-1",
    });
  });

  it("writes and reads valid task reports and summaries", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new StageRunStore(project);
    await store.writeTaskReport(makeTaskReport({ summary: "task artifact" }), { at: "2026-01-01T00:00:02.000Z" });
    await store.writeStageSummary(makeStageSummary({ summary: "stage artifact" }), { at: "2026-01-01T00:00:03.000Z" });

    expect(store.readExpectedStageTaskReport({ stageId: "stage-1", taskId: "task-1", agent: "coder" })).toMatchObject({
      kind: "valid",
      artifact: { summary: "task artifact" },
    });
    expect(store.readExpectedStageSummary("stage-1")).toMatchObject({
      kind: "valid",
      artifact: { summary: "stage artifact" },
    });
  });
});

describe("StageRunStore events", () => {
  it("deduplicates event_id values and tolerates an invalid trailing line", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new StageRunStore(project);
    const event = { event_id: "event-1", type: "task_report_written", stage_id: "stage-1", task_id: "task-1", at: "2026-01-01T00:00:00.000Z" };
    writeFileSync(project.paths.events!, `${JSON.stringify(event)}\n${JSON.stringify(event)}\n{`, "utf-8");

    expect(await store.readEvents()).toEqual([event]);
  });

  it("appends artifact events through the operation queue", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new StageRunStore(project);

    await Promise.all([
      store.writeTaskReport(makeTaskReport({ task_id: "task-1" }), { at: "2026-01-01T00:00:01.000Z" }),
      store.writeStageSummary(makeStageSummary(), { at: "2026-01-01T00:00:02.000Z" }),
    ]);

    const eventTypes = (await store.readEvents()).map((event) => event.type);
    expect(eventTypes).toEqual(["task_report_written", "stage_summary_written"]);
  });
});

describe("StageRunStore aggregate and ProjectStore compatibility", () => {
  it("reconstructs a stage run from existing task, report, and summary files", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new StageRunStore(project);
    await store.writeTaskList(makeTaskList(), { at: "2026-01-01T00:00:01.000Z" });
    await store.writeTaskReport(makeTaskReport(), { at: "2026-01-01T00:00:02.000Z" });
    await store.writeStageSummary(makeStageSummary(), { at: "2026-01-01T00:00:03.000Z" });

    const run = await store.getStageRun("stage-1");

    expect(run).toMatchObject({
      stage_id: "stage-1",
      status: "summarized",
      tasks: { tasks: [{ id: "task-1" }] },
      reports: [{ task_id: "task-1" }],
      summary: { stage_id: "stage-1" },
    });
    expect(run?.events.map((event) => event.type)).toEqual(["tasks_written", "task_report_written", "stage_summary_written"]);
  });

  it("keeps ProjectStore artifact API behavior compatible", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const projectStore = new ProjectStore(project);
    const report = makeTaskReport({ summary: "task artifact" });
    const summary = makeStageSummary({ summary: "stage artifact" });

    await projectStore.writeStageTaskReport(report);
    await projectStore.writeStageSummary(summary);

    expect(projectStore.stageTaskReportPath("stage-1", "task-1")).toBe(join(project.paths.stages, "stage-1", "reports", "task-1.json"));
    expect(projectStore.stageSummaryPath("stage-1")).toBe(join(project.paths.stages, "stage-1", "summary.json"));
    expect(projectStore.readExpectedStageTaskReport({ stageId: "stage-1", taskId: "task-1", agent: "coder" })).toMatchObject({ kind: "valid", artifact: report });
    expect(projectStore.readExpectedStageSummary("stage-1")).toMatchObject({ kind: "valid", artifact: summary });
    expect(await projectStore.stageDetails("stage-1")).toMatchObject({ stage_id: "stage-1", reports: [report], summary });
  });

  it("reconstructs completed stage runs from embedded plan history", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new StageRunStore(project);
    const plan: PlanDocument = {
      updated_at: "2026-01-01T00:00:02.000Z",
      current_stage_id: null,
      stages: [],
      history: [
        {
          id: "stage-1",
          objective: "done stage",
          expected_outcomes: ["outcome"],
          actual_outcomes: ["outcome"],
          started_at: "2026-01-01T00:00:00.000Z",
          completed_at: "2026-01-01T00:00:02.000Z",
          result: "completed",
          summary: "finished",
        },
      ],
    };
    writeFileSync(project.paths.plan, JSON.stringify(plan), "utf-8");

    const run = await store.getStageRun("stage-1");

    expect(run).toMatchObject({
      stage_id: "stage-1",
      status: "completed",
      started_at: "2026-01-01T00:00:00.000Z",
      completed_at: "2026-01-01T00:00:02.000Z",
    });
    expect(run?.events).toEqual([
      {
        event_id: "compat:stage-1:completed",
        type: "stage_completed",
        stage_id: "stage-1",
        at: "2026-01-01T00:00:02.000Z",
        result: "completed",
      },
    ]);
    await expect(store.listStageRuns()).resolves.toMatchObject([{ stage_id: "stage-1", status: "completed" }]);
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
        status: "completed",
        attempt: 1,
        max_attempts: 3,
      },
    ],
    ...overrides,
  };
}
