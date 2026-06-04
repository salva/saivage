import { readFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ensureDir, listDocs, pathExists, readDocLenient, readDocOrNull, writeDoc } from "./documents.js";
import {
  PlanDocumentSchema,
  StageSummarySchema,
  TaskListSchema,
  TaskReportSchema,
  type CompletedStage,
  type Stage,
  type StageSummary,
  type TaskList,
  type TaskReport,
} from "../types.js";
import type { ProjectContext } from "./project.js";
import type { ArtifactReadResult } from "./project-store.js";

export type StageRunStatus = "planned" | "running" | "tasks_ready" | "summarized" | "completed" | "failed" | "escalated" | "aborted";

type StageRunStoreProject = {
  paths: Pick<ProjectContext["paths"], "plan" | "stages"> & Partial<Pick<ProjectContext["paths"], "events">>;
};

export interface StageRunEvent {
  event_id: string;
  type: string;
  stage_id: string;
  at: string;
  task_id?: string;
  task_count?: number;
  status?: TaskReport["status"];
  result?: StageSummary["result"];
  agent_id?: string;
  outcome?: "ok" | "failed";
}

export interface StageRun {
  stage_id: string;
  definition: Stage | null;
  status: StageRunStatus;
  tasks: TaskList | null;
  reports: TaskReport[];
  summary: StageSummary | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
  events: StageRunEvent[];
}

export interface StageRunSummary {
  stage_id: string;
  status: StageRunStatus;
  task_count: number;
  report_count: number;
  updated_at: string;
}

const StageRunEventSchema = z.object({
  event_id: z.string().min(1),
  type: z.string().min(1),
  stage_id: z.string().min(1),
  at: z.string().min(1),
  task_id: z.string().optional(),
  task_count: z.number().optional(),
  status: z.enum(["completed", "failed"]).optional(),
  result: z.enum(["completed", "failed", "escalated", "aborted"]).optional(),
  agent_id: z.string().optional(),
  outcome: z.enum(["ok", "failed"]).optional(),
}).passthrough();

export class StageRunStore {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly project: StageRunStoreProject) {}

  get eventsPath(): string {
    return this.project.paths.events ?? join(this.project.paths.stages, "..", "events.jsonl");
  }

  stageDir(stageId: string): string {
    return join(this.project.paths.stages, stageId);
  }

  stageTaskListPath(stageId: string): string {
    return join(this.stageDir(stageId), "tasks.json");
  }

  stageReportsDir(stageId: string): string {
    return join(this.stageDir(stageId), "reports");
  }

  stageTaskReportPath(stageId: string, taskId: string): string {
    return join(this.stageReportsDir(stageId), `${taskId}.json`);
  }

  stageSummaryPath(stageId: string): string {
    return join(this.stageDir(stageId), "summary.json");
  }

  async getStageRun(stageId: string): Promise<StageRun | null> {
    const { definition, completed } = await this.readPlanStage(stageId);
    const [tasks, summary, events] = await Promise.all([
      readDocLenient(this.stageTaskListPath(stageId), TaskListSchema),
      readDocLenient(this.stageSummaryPath(stageId), StageSummarySchema),
      this.readEvents({ stageId }),
    ]);
    const reports = await this.readTaskReports(stageId);
    if (!definition && !completed && !tasks && !summary && reports.length === 0 && events.length === 0) return null;

    const validTasks = TaskListSchema.safeParse(tasks).success ? tasks as TaskList : null;
    const validSummary = StageSummarySchema.safeParse(summary).success ? summary as StageSummary : null;
    const compatibilityEvents = deriveCompatibilityEvents(stageId, validTasks, reports, validSummary, completed);
    const effectiveEvents = events.length > 0 ? events : compatibilityEvents;
    const completionEvent = latestCompletionEvent(effectiveEvents);
    const status = deriveStatus({ completed, completionEvent, summary: validSummary, tasks: validTasks });
    const updatedAt = latestTimestamp([
      ...effectiveEvents.map((event) => event.at),
      validSummary?.completed_at,
      completed?.completed_at,
      validTasks?.updated_at,
      ...reports.map((report) => report.completed_at),
    ]);

    return {
      stage_id: stageId,
      definition,
      status,
      tasks: validTasks,
      reports,
      summary: validSummary,
      started_at: validSummary?.started_at ?? completed?.started_at ?? definition?.started_at ?? null,
      completed_at: completed?.completed_at ?? completionEvent?.at ?? validSummary?.completed_at ?? null,
      updated_at: updatedAt,
      events: effectiveEvents,
    };
  }

  async listStageRuns(): Promise<StageRunSummary[]> {
    const ids = await this.listKnownStageIds();
    const runs = await Promise.all([...ids].map((id) => this.getStageRun(id)));
    return runs.filter((run): run is StageRun => run !== null).map((run) => ({
      stage_id: run.stage_id,
      status: run.status,
      task_count: run.tasks?.tasks.length ?? 0,
      report_count: run.reports.length,
      updated_at: run.updated_at,
    }));
  }

  async listCompletedRuns(): Promise<StageRun[]> {
    const ids = await this.listKnownStageIds();
    const runs = await Promise.all([...ids].map((id) => this.getStageRun(id)));
    return runs
      .filter((run): run is StageRun => run !== null && isCompletedStatus(run.status))
      .sort((a, b) => (a.completed_at ?? a.updated_at).localeCompare(b.completed_at ?? b.updated_at));
  }

  readExpectedStageTaskReport(opts: {
    stageId: string;
    taskId: string;
    agent: TaskReport["agent"];
  }): ArtifactReadResult<TaskReport> {
    const path = this.stageTaskReportPath(opts.stageId, opts.taskId);
    const raw = readArtifactJson(path);
    if (raw.kind !== "read") return raw;

    const parsed = TaskReportSchema.safeParse(raw.value);
    if (!parsed.success) {
      return { kind: "invalid", path, reason: parsed.error.issues[0]?.message ?? "schema validation failed" };
    }
    if (parsed.data.stage_id !== opts.stageId) {
      return { kind: "invalid", path, reason: `stage_id ${parsed.data.stage_id} does not match ${opts.stageId}` };
    }
    if (parsed.data.task_id !== opts.taskId) {
      return { kind: "invalid", path, reason: `task_id ${parsed.data.task_id} does not match ${opts.taskId}` };
    }
    if (parsed.data.agent !== opts.agent) {
      return { kind: "invalid", path, reason: `agent ${parsed.data.agent} does not match ${opts.agent}` };
    }
    return { kind: "valid", path, artifact: parsed.data };
  }

  readExpectedStageSummary(stageId: string): ArtifactReadResult<StageSummary> {
    const path = this.stageSummaryPath(stageId);
    const raw = readArtifactJson(path);
    if (raw.kind !== "read") return raw;

    const parsed = StageSummarySchema.safeParse(raw.value);
    if (!parsed.success) {
      return { kind: "invalid", path, reason: parsed.error.issues[0]?.message ?? "schema validation failed" };
    }
    if (parsed.data.stage_id !== stageId) {
      return { kind: "invalid", path, reason: `stage_id ${parsed.data.stage_id} does not match ${stageId}` };
    }
    return { kind: "valid", path, artifact: parsed.data };
  }

  async writeTaskList(taskList: TaskList, opts: { agentId?: string; at?: string } = {}): Promise<void> {
    await this.enqueueWrite(async () => {
      await writeDoc(this.stageTaskListPath(taskList.stage_id), taskList, TaskListSchema);
      await this.appendEvent({
        event_id: randomUUID(),
        type: "tasks_written",
        stage_id: taskList.stage_id,
        at: opts.at ?? new Date().toISOString(),
        task_count: taskList.tasks.length,
        agent_id: opts.agentId,
      });
    });
  }

  async markStageStarted(stage: Stage, opts: { agentId?: string; at?: string } = {}): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.appendEvent({
        event_id: randomUUID(),
        type: "stage_started",
        stage_id: stage.id,
        at: opts.at ?? new Date().toISOString(),
        agent_id: opts.agentId,
      });
    });
  }

  async markTaskStarted(args: { stageId: string; taskId: string; agentId?: string; at?: string }): Promise<void> {
    await this.enqueueWrite(async () => {
      await this.appendEvent({
        event_id: randomUUID(),
        type: "task_started",
        stage_id: args.stageId,
        task_id: args.taskId,
        at: args.at ?? new Date().toISOString(),
        agent_id: args.agentId,
      });
    });
  }

  async writeTaskReport(report: TaskReport, opts: { agentId?: string; at?: string } = {}): Promise<void> {
    await this.enqueueWrite(async () => {
      await writeDoc(this.stageTaskReportPath(report.stage_id, report.task_id), report, TaskReportSchema);
      await this.appendEvent({
        event_id: randomUUID(),
        type: "task_report_written",
        stage_id: report.stage_id,
        task_id: report.task_id,
        at: opts.at ?? new Date().toISOString(),
        status: report.status,
        agent_id: opts.agentId,
      });
    });
  }

  async writeStageSummary(summary: StageSummary, opts: { agentId?: string; at?: string } = {}): Promise<void> {
    await this.enqueueWrite(async () => {
      await writeDoc(this.stageSummaryPath(summary.stage_id), summary, StageSummarySchema);
      await this.appendEvent({
        event_id: randomUUID(),
        type: "stage_summary_written",
        stage_id: summary.stage_id,
        at: opts.at ?? new Date().toISOString(),
        result: summary.result,
        agent_id: opts.agentId,
      });
    });
  }

  async markStageCompleted(args: {
    stageId: string;
    result: StageSummary["result"];
    agentId?: string;
    knowledgeArchiveOutcome?: "ok" | "failed";
    at?: string;
  }): Promise<void> {
    await this.enqueueWrite(async () => {
      const at = args.at ?? new Date().toISOString();
      await this.appendEvent({
        event_id: randomUUID(),
        type: "stage_completed",
        stage_id: args.stageId,
        at,
        result: args.result,
        agent_id: args.agentId,
      });
      if (args.knowledgeArchiveOutcome) {
        await this.appendEvent({
          event_id: randomUUID(),
          type: "knowledge_archived",
          stage_id: args.stageId,
          at,
          outcome: args.knowledgeArchiveOutcome,
        });
      }
    });
  }

  async readEvents(filter: { stageId?: string } = {}): Promise<StageRunEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.eventsPath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const lines = raw.split(/\r?\n/);
    const events: StageRunEvent[] = [];
    const seen = new Set<string>();
    const hasFinalNewline = raw.endsWith("\n") || raw.endsWith("\r\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim();
      if (!line) continue;
      const isLastLine = index === lines.length - 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        if (isLastLine && !hasFinalNewline) continue;
        throw err;
      }
      const event = StageRunEventSchema.parse(parsed) as StageRunEvent;
      if (seen.has(event.event_id)) continue;
      seen.add(event.event_id);
      if (!filter.stageId || event.stage_id === filter.stageId) events.push(event);
    }
    return events;
  }

  private async listKnownStageIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    const plan = await readDocOrNull(this.project.paths.plan, PlanDocumentSchema);
    for (const stage of plan?.stages ?? []) ids.add(stage.id);
    for (const stage of plan?.history ?? []) ids.add(stage.id);
    for (const event of await this.readEvents()) ids.add(event.stage_id);
    if (await pathExists(this.project.paths.stages)) {
      const { readdir, stat } = await import("node:fs/promises");
      for (const stageId of await readdir(this.project.paths.stages)) {
        try {
          if ((await stat(join(this.project.paths.stages, stageId))).isDirectory()) ids.add(stageId);
        } catch { /* ignore concurrently removed stages */ }
      }
    }
    return ids;
  }

  private async readPlanStage(stageId: string): Promise<{ definition: Stage | null; completed: CompletedStage | null }> {
    const plan = await readDocOrNull(this.project.paths.plan, PlanDocumentSchema);
    const definition = plan?.stages.find((stage) => stage.id === stageId) ?? null;
    const completed = plan?.history.find((stage) => stage.id === stageId) ?? null;
    return { definition, completed };
  }

  private async readTaskReports(stageId: string): Promise<TaskReport[]> {
    const reportsDir = this.stageReportsDir(stageId);
    const reportFiles = await listDocs(reportsDir, (file) => file.endsWith(".json"));
    const reports = await Promise.all(
      reportFiles.map((file) => readDocLenient(join(reportsDir, file), TaskReportSchema)),
    );
    return reports.filter((report): report is TaskReport => TaskReportSchema.safeParse(report).success);
  }

  private async appendEvent(event: StageRunEvent): Promise<void> {
    await ensureDir(dirname(this.eventsPath));
    await appendFile(this.eventsPath, `${JSON.stringify(StageRunEventSchema.parse(event))}\n`, "utf-8");
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.writeQueue.then(operation, operation);
    this.writeQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function readArtifactJson(path: string):
  | { kind: "read"; value: unknown }
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string; reason: string } {
  try {
    return { kind: "read", value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (err) {
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") return { kind: "missing", path };
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: "invalid", path, reason };
  }
}

function deriveCompatibilityEvents(
  stageId: string,
  tasks: TaskList | null,
  reports: TaskReport[],
  summary: StageSummary | null,
  completed: CompletedStage | null,
): StageRunEvent[] {
  const events: StageRunEvent[] = [];
  if (tasks) {
    events.push({ event_id: `compat:${stageId}:tasks`, type: "tasks_written", stage_id: stageId, at: tasks.updated_at, task_count: tasks.tasks.length });
  }
  for (const report of reports) {
    events.push({ event_id: `compat:${stageId}:report:${report.task_id}`, type: "task_report_written", stage_id: stageId, task_id: report.task_id, at: report.completed_at, status: report.status });
  }
  if (summary) {
    events.push({ event_id: `compat:${stageId}:summary`, type: "stage_summary_written", stage_id: stageId, at: summary.completed_at, result: summary.result });
  }
  if (completed) {
    events.push({ event_id: `compat:${stageId}:completed`, type: "stage_completed", stage_id: stageId, at: completed.completed_at, result: completed.result });
  }
  return events;
}

function deriveStatus(args: { completed: CompletedStage | null; completionEvent: StageRunEvent | null; summary: StageSummary | null; tasks: TaskList | null }): StageRunStatus {
  if (args.completed) return args.completed.result;
  if (args.completionEvent?.result) return args.completionEvent.result;
  if (args.summary) return "summarized";
  if (args.tasks) return "tasks_ready";
  return "planned";
}

function latestCompletionEvent(events: StageRunEvent[]): StageRunEvent | null {
  return events
    .filter((event) => event.type === "stage_completed" && event.result)
    .sort((a, b) => a.at.localeCompare(b.at))
    .at(-1) ?? null;
}

function isCompletedStatus(status: StageRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "escalated" || status === "aborted";
}

function latestTimestamp(values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? new Date(0).toISOString();
}
