import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { seedProject } from "../store/project.js";
import { StageRunStore } from "../store/stage-run-store.js";
import { archiveStage } from "../knowledge/lifecycle.js";
import { PlanService } from "./plan-server.js";

vi.mock("../knowledge/lifecycle.js", () => ({
  archiveStage: vi.fn(),
}));

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-plan-complete-"));
  vi.mocked(archiveStage).mockResolvedValue({} as Awaited<ReturnType<typeof archiveStage>>);
});

afterEach(() => {
  vi.clearAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("plan_complete_stage stage-run completion", () => {
  it("writes stage completion and knowledge archive events after embedded history archival", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const stageRuns = new StageRunStore(project);
    const service = new PlanService(project.saivageDir, stageRuns);
    await service.init();
    await service.plan_init([makeStage()]);
    await service.plan_set_current("stage-1");

    const result = await service.plan_complete_stage({
      stage_id: "stage-1",
      result: "completed",
      summary: "done",
      actual_outcomes: ["outcome"],
    });

    expect(result).not.toHaveProperty("code");
    expect(archiveStage).toHaveBeenCalledTimes(1);
    expect(archiveStage).toHaveBeenCalledWith(projectRoot, "stage-1");

    const history = await service.plan_get_history();
    expect(history).toMatchObject({ stages: [{ id: "stage-1", result: "completed" }] });

    const events = await stageRuns.readEvents({ stageId: "stage-1" });
    expect(events).toEqual([
      expect.objectContaining({ type: "stage_completed", stage_id: "stage-1", result: "completed" }),
      expect.objectContaining({ type: "knowledge_archived", stage_id: "stage-1", outcome: "ok" }),
    ]);
    await expect(stageRuns.listCompletedRuns()).resolves.toMatchObject([
      { stage_id: "stage-1", status: "completed" },
    ]);
  });

  it("preserves archiveStage behavior when StageRunStore is not configured", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const service = new PlanService(project.saivageDir);
    await service.init();
    await service.plan_init([makeStage()]);
    await service.plan_set_current("stage-1");

    const result = await service.plan_complete_stage({
      stage_id: "stage-1",
      result: "completed",
      summary: "done",
      actual_outcomes: ["outcome"],
    });

    expect(result).not.toHaveProperty("code");
    expect(archiveStage).toHaveBeenCalledTimes(1);
    expect(archiveStage).toHaveBeenCalledWith(projectRoot, "stage-1");
    await expect(service.plan_get_history()).resolves.toMatchObject({ stages: [{ id: "stage-1" }] });
  });

  it("records failed knowledge archival outcome without failing stage completion", async () => {
    vi.mocked(archiveStage).mockRejectedValueOnce(new Error("archive failed"));
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const stageRuns = new StageRunStore(project);
    const service = new PlanService(project.saivageDir, stageRuns);
    await service.init();
    await service.plan_init([makeStage()]);
    await service.plan_set_current("stage-1");

    const result = await service.plan_complete_stage({
      stage_id: "stage-1",
      result: "failed",
      summary: "failed",
      actual_outcomes: [],
    });

    expect(result).not.toHaveProperty("code");
    expect(archiveStage).toHaveBeenCalledTimes(1);
    await expect(stageRuns.readEvents({ stageId: "stage-1" })).resolves.toEqual([
      expect.objectContaining({ type: "stage_completed", result: "failed" }),
      expect.objectContaining({ type: "knowledge_archived", outcome: "failed" }),
    ]);
  });
});

function makeStage() {
  return {
    id: "stage-1",
    objective: "do work",
    starting_points: [],
    expected_outcomes: ["outcome"],
    acceptance_criteria: ["pass"],
    references: [],
    tags: [],
  };
}
