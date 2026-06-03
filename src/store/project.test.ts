/**
 * Tests for project init / load (WI-10: knowledge tree scaffolding).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { initProjectTree, seedProject } from "./project.js";
import { ProjectStore } from "./project-store.js";
import { readDoc } from "./documents.js";
import { loadConfig, SaivageConfigSchema, type SaivageConfig } from "../config.js";
import type { PlanDocument, RuntimeState, StageSummary, TaskList, TaskReport } from "../types.js";
import {
  DEFAULT_ANTHROPIC_CLIENT_ID,
  DEFAULT_GITHUB_COPILOT_CLIENT_ID,
  DEFAULT_OPENAI_CODEX_CLIENT_ID,
} from "../auth/defaults.js";
import {
  DEFAULT_CONFIG_POINTER_SUFFIXES,
  DEFAULT_CREDENTIAL_LEXEMES,
} from "../security/secrets.js";

let projectRoot: string;

const EXPECTED_SEED: SaivageConfig = {
  models: {},
  providers: {},
  failover: {},
  modelEquivalents: {},
  server: { port: 8080, host: "0.0.0.0" },
  agent: { maxConcurrentAgents: 3 },
  runtime: {
    maxServices: 50,
    restartOnCrash: true,
    continuousImprovement: true,
    healthCheckIntervalMs: 30_000,
    idleShutdownMs: 300_000,
    recoveryDelayMs: 60_000,
    notes: { volatileTtlMs: 2 * 60 * 60 * 1000 },
  },
  security: {
    envScrubber: {
      credentialLexemes: [...DEFAULT_CREDENTIAL_LEXEMES],
      configPointerSuffixes: [...DEFAULT_CONFIG_POINTER_SUFFIXES],
    },
  },
  supervisor: {
    enabled: true,
    intervalMs: 20 * 60 * 1000,
    consecutiveStuckVerdicts: 3,
    logLines: 400,
    forceCancelDelayMs: 600_000,
  },
  telegram: { botToken: "", allowedUserIds: [] },
  mcp: {
    shellTimeoutMs: 4 * 60 * 60 * 1000,
    shellTimeoutFloorMs: 10 * 60 * 1000,
    inProcessTimeoutMs: 300_000,
    maxOutputBytes: 100 * 1024,
    maxFetchBytes: 200_000,
    maxDownloadBytes: 250 * 1024 * 1024,
    maxFileReadBytes: 200_000,
    maxSearchResults: 1_000,
    maxSearchDepth: 20,
    maxSearchMs: 10_000,
    fetchTimeoutMs: 60_000,
    webSearchMaxBytes: 2 * 1024 * 1024,
    webSearchMaxResults: 20,
    webSearchTimeoutMs: 15_000,
  },
  notifications: {
    channels: ["web"],
    filters: { min_severity: "info", categories: [] },
  },
  oauth: {
    anthropic: { clientId: DEFAULT_ANTHROPIC_CLIENT_ID },
    openaiCodex: { clientId: DEFAULT_OPENAI_CODEX_CLIENT_ID },
    githubCopilot: { clientId: DEFAULT_GITHUB_COPILOT_CLIENT_ID },
  },
  mcpServers: {},
  rag: { enabled: false, datasets: [] },
};

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "saivage-project-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("seedProject", () => {
  it("does not seed legacy skills/memory JSON tree (F01 B07)", async () => {
    await seedProject(projectRoot, { name: "test-project", objectives: ["test"] });
    const saivage = join(projectRoot, ".saivage");
    expect(existsSync(join(saivage, "skills"))).toBe(false);
    expect(existsSync(join(saivage, "memory"))).toBe(false);
  });

  it("writes .gitignore with tmp/ (FR-21)", async () => {
    await seedProject(projectRoot, { name: "test-project", objectives: ["test"] });
    const gitignore = readFileSync(
      join(projectRoot, ".saivage", ".gitignore"),
      "utf-8",
    );
    const lines = gitignore.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain("tmp/");
  });

  it("writes saivage.json with web channel and info severity", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const cfg = await loadConfig(projectRoot);
    expect(cfg.notifications.channels).toEqual(["web"]);
    expect(cfg.notifications.filters.min_severity).toBe("info");
  });

  it("does not write a default orchestrator model into saivage.json", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const cfg = await loadConfig(projectRoot);
    expect(cfg.models.orchestrator).toBeUndefined();
  });

  it("seeded saivage.json equals the committed EXPECTED_SEED literal", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const path = join(projectRoot, ".saivage", "saivage.json");
    const raw = JSON.parse(await readFile(path, "utf-8"));
    expect(raw).toEqual(EXPECTED_SEED);
  });

  it("SaivageConfigSchema.parse({}) equals EXPECTED_SEED (review-on-change)", () => {
    expect(SaivageConfigSchema.parse({})).toEqual(EXPECTED_SEED);
  });

  it("seeded saivage.json contains no providers or mcp servers by default", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const path = join(projectRoot, ".saivage", "saivage.json");
    const raw = JSON.parse(await readFile(path, "utf-8")) as SaivageConfig;
    expect(raw.providers).toEqual({});
    expect(raw.mcpServers).toEqual({});
  });

  it("seeded saivage.json top-level keys match the schema shape", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const path = join(projectRoot, ".saivage", "saivage.json");
    const raw = JSON.parse(await readFile(path, "utf-8")) as Record<string, unknown>;
    expect(Object.keys(raw).sort()).toEqual(Object.keys(SaivageConfigSchema.shape).sort());
  });

  it("seeded saivage.json parses through the loader contract", async () => {
    await seedProject(projectRoot, { name: "p", objectives: [] });
    const path = join(projectRoot, ".saivage", "saivage.json");
    const cfg = await readDoc(path, SaivageConfigSchema);
    expect(cfg).toBeDefined();
  });
});

describe("initProjectTree — idempotence", () => {
  it("does not duplicate .gitignore lines on re-run", async () => {
    await seedProject(projectRoot, { name: "test-project", objectives: ["test"] });
    const gitignorePath = join(projectRoot, ".saivage", ".gitignore");
    const before = readFileSync(gitignorePath, "utf-8");
    await initProjectTree(projectRoot);
    await initProjectTree(projectRoot);
    const after = readFileSync(gitignorePath, "utf-8");
    expect(after).toBe(before);
  });

  it("appends missing lines to a pre-existing .gitignore", async () => {
    const saivage = join(projectRoot, ".saivage");
    // Simulate a pre-existing .gitignore without the required lines.
    mkdirSync(saivage, { recursive: true });
    writeFileSync(join(saivage, ".gitignore"), "# user comment\n", "utf-8");

    await initProjectTree(projectRoot);

    const content = readFileSync(join(saivage, ".gitignore"), "utf-8");
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);
    expect(lines).toContain("tmp/");
    expect(lines).toContain("# user comment");
  });
});

describe("ProjectStore stage artifacts", () => {
  it("returns missing for absent task reports and stage summaries", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new ProjectStore(project);

    expect(store.readExpectedStageTaskReport({ stageId: "stage-1", taskId: "task-1", agent: "coder" })).toEqual({
      kind: "missing",
      path: join(project.paths.stages, "stage-1", "reports", "task-1.json"),
    });
    expect(store.readExpectedStageSummary("stage-1")).toEqual({
      kind: "missing",
      path: join(project.paths.stages, "stage-1", "summary.json"),
    });
  });

  it("returns invalid for malformed task reports and stage summaries", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new ProjectStore(project);
    mkdirSync(join(project.paths.stages, "stage-1", "reports"), { recursive: true });
    writeFileSync(join(project.paths.stages, "stage-1", "reports", "task-1.json"), "{", "utf-8");
    writeFileSync(join(project.paths.stages, "stage-1", "summary.json"), "{", "utf-8");

    expect(store.readExpectedStageTaskReport({ stageId: "stage-1", taskId: "task-1", agent: "coder" }).kind).toBe("invalid");
    expect(store.readExpectedStageSummary("stage-1").kind).toBe("invalid");
  });

  it("returns invalid for artifact identity mismatches", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new ProjectStore(project);
    mkdirSync(join(project.paths.stages, "stage-1", "reports"), { recursive: true });
    writeFileSync(
      join(project.paths.stages, "stage-1", "reports", "task-1.json"),
      JSON.stringify(makeTaskReport({ task_id: "other-task" })),
      "utf-8",
    );
    writeFileSync(
      join(project.paths.stages, "stage-1", "summary.json"),
      JSON.stringify(makeStageSummary({ stage_id: "other-stage" })),
      "utf-8",
    );

    expect(store.readExpectedStageTaskReport({ stageId: "stage-1", taskId: "task-1", agent: "coder" })).toMatchObject({
      kind: "invalid",
      reason: "task_id other-task does not match task-1",
    });
    expect(store.readExpectedStageSummary("stage-1")).toMatchObject({
      kind: "invalid",
      reason: "stage_id other-stage does not match stage-1",
    });
  });

  it("reads valid task reports and stage summaries", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new ProjectStore(project);
    const report = makeTaskReport({ summary: "task artifact" });
    const summary = makeStageSummary({ summary: "stage artifact" });
    await store.writeStageTaskReport(report);
    await store.writeStageSummary(summary);

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

describe("ProjectStore dashboard reads", () => {
  it("returns active plan, history, and runtime state views", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new ProjectStore(project);
    const plan = makePlanDocument();
    const runtimeState = makeRuntimeState();
    writeFileSync(project.paths.plan, JSON.stringify(plan), "utf-8");
    writeFileSync(project.paths.runtimeState, JSON.stringify(runtimeState), "utf-8");

    expect(await store.activePlanView()).toEqual({
      updated_at: plan.updated_at,
      current_stage_id: plan.current_stage_id,
      stages: plan.stages,
    });
    expect(await store.planHistoryView()).toEqual({ stages: plan.history });
    expect(await store.runtimeState()).toEqual(runtimeState);
  });

  it("returns stage details without server-side path assembly", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new ProjectStore(project);
    const tasks = makeTaskList();
    const summary = makeStageSummary({ summary: "stage summary" });
    const report = makeTaskReport({ summary: "task report" });
    mkdirSync(join(project.paths.stages, "stage-1", "reports"), { recursive: true });
    writeFileSync(join(project.paths.stages, "stage-1", "tasks.json"), JSON.stringify(tasks), "utf-8");
    writeFileSync(join(project.paths.stages, "stage-1", "summary.json"), JSON.stringify(summary), "utf-8");
    writeFileSync(join(project.paths.stages, "stage-1", "reports", "task-1.json"), JSON.stringify(report), "utf-8");

    expect(await store.stageDetails("stage-1")).toEqual({
      stage_id: "stage-1",
      tasks,
      summary,
      reports: [report],
    });
  });

  it("returns explicit lenient debug errors and timeline entries", async () => {
    const project = await seedProject(projectRoot, { name: "p", objectives: [] });
    const store = new ProjectStore(project);
    writeFileSync(project.paths.plan, JSON.stringify(makePlanDocument()), "utf-8");
    mkdirSync(join(project.paths.stages, "stage-1", "reports"), { recursive: true });
    writeFileSync(
      join(project.paths.stages, "stage-1", "summary.json"),
      JSON.stringify(makeStageSummary({
        result: "failed",
        summary: "stage failed",
        issues: [{ severity: "warning", description: "stage issue" }],
        completed_at: "2026-01-01T00:00:03.000Z",
      })),
      "utf-8",
    );
    writeFileSync(
      join(project.paths.stages, "stage-1", "reports", "task-1.json"),
      JSON.stringify(makeTaskReport({
        status: "failed",
        failure_reason: "task failed",
        completed_at: "2026-01-01T00:00:04.000Z",
      })),
      "utf-8",
    );
    writeFileSync(join(project.paths.stages, "stage-1", "reports", "bad.json"), "{", "utf-8");

    expect(await store.debugErrors()).toMatchObject([
      { source: "stage-1/task-1", type: "task_failed", message: "task failed" },
      { source: "stage-1", type: "stage_issue", message: "stage issue" },
      { source: "stage-1", type: "summary_failed", message: "stage failed" },
      { source: "done-stage", type: "stage_failed", message: "historical failure" },
    ]);
    expect(await store.debugTimeline()).toMatchObject([
      { source: "stage-1/task-1", type: "task_failed" },
      { source: "done-stage", type: "stage_failed" },
      { source: "done-stage", type: "stage_started" },
    ]);
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

function makePlanDocument(overrides: Partial<PlanDocument> = {}): PlanDocument {
  return {
    updated_at: "2026-01-01T00:00:00.000Z",
    current_stage_id: "stage-1",
    stages: [
      {
        id: "stage-1",
        objective: "active work",
        starting_points: [],
        expected_outcomes: ["done"],
        acceptance_criteria: ["done"],
        references: [],
        tags: [],
      },
    ],
    history: [
      {
        id: "done-stage",
        objective: "past work",
        expected_outcomes: ["done"],
        actual_outcomes: [],
        started_at: "2026-01-01T00:00:01.000Z",
        completed_at: "2026-01-01T00:00:02.000Z",
        result: "failed",
        summary: "historical failure",
      },
    ],
    ...overrides,
  };
}

function makeRuntimeState(overrides: Partial<RuntimeState> = {}): RuntimeState {
  return {
    status: "running",
    current_stage_id: "stage-1",
    active_agents: [],
    started_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    pid: 123,
    ...overrides,
  };
}
