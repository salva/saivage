import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { listDocs, pathExists, readDocOrNull } from "./documents.js";
import { StageRunStore } from "./stage-run-store.js";
import {
  ChatLogSchema,
  InspectionReportSchema,
  PlanDocumentSchema,
  RuntimeStateSchema,
  type ActivePlanView,
  type ChatLog,
  type InspectionReport,
  type PlanDocument,
  type PlanHistoryView,
  type RuntimeState,
  type StageSummary,
  type TaskList,
  type TaskReport,
} from "../types.js";
import type { ProjectContext } from "./project.js";

export type ArtifactReadResult<T> =
  | { kind: "valid"; path: string; artifact: T }
  | { kind: "missing"; path: string }
  | { kind: "invalid"; path: string; reason: string };

export interface StageDetailsView {
  stage_id: string;
  tasks: TaskList | null;
  summary: StageSummary | null;
  reports: TaskReport[];
}

export interface DebugErrorEntry {
  source: string;
  type: string;
  severity: string;
  message: string;
  details?: unknown;
  timestamp?: string;
}

export interface DebugTimelineEvent {
  timestamp: string;
  type: string;
  source: string;
  description: string;
}

export interface ChatSessionListEntry {
  session_id: string;
  channel: string;
  started_at: string;
  updated_at: string;
  message_count: number;
}

export type ChatLogReadResult =
  | { kind: "missing-root" }
  | { kind: "found"; chatLog: ChatLog }
  | { kind: "not-persisted"; chatLog: ChatLog };

export class ProjectStore {
  private readonly stageRuns: StageRunStore;

  constructor(private readonly project: Pick<ProjectContext, "paths">) {
    this.stageRuns = new StageRunStore(project);
  }

  async readPlan(): Promise<PlanDocument | null> {
    return readDocOrNull(this.project.paths.plan, PlanDocumentSchema);
  }

  async activePlanView(): Promise<ActivePlanView | null> {
    const doc = await this.readPlan();
    if (!doc) return null;
    return {
      updated_at: doc.updated_at,
      current_stage_id: doc.current_stage_id,
      stages: doc.stages,
    };
  }

  async planHistoryView(): Promise<PlanHistoryView | null> {
    const doc = await this.readPlan();
    return doc ? { stages: doc.history } : null;
  }

  async runtimeState(): Promise<RuntimeState | null> {
    return readDocOrNull(this.project.paths.runtimeState, RuntimeStateSchema);
  }

  async stageDetails(stageId: string): Promise<StageDetailsView> {
    const run = await this.stageRuns.getStageRun(stageId);
    return {
      stage_id: stageId,
      tasks: run?.tasks ?? null,
      summary: run?.summary ?? null,
      reports: run?.reports ?? [],
    };
  }

  async inspectionReports(): Promise<InspectionReport[]> {
    const files = await listDocs(this.project.paths.inspections);
    const reports = await Promise.all(
      files.map((file) => readDocOrNull(join(this.project.paths.inspections, file), InspectionReportSchema)),
    );
    return reports.filter((report): report is InspectionReport => report !== null);
  }

  async chatSessions(): Promise<ChatSessionListEntry[]> {
    const sessions: ChatSessionListEntry[] = [];

    if (!(await pathExists(this.project.paths.chats))) return sessions;

    for (const channel of await readdir(this.project.paths.chats)) {
      const channelDir = join(this.project.paths.chats, channel);
      try {
        if (!(await stat(channelDir)).isDirectory()) continue;
      } catch { continue; }

      for (const file of await readdir(channelDir)) {
        if (!file.endsWith(".json")) continue;
        const chatLog = await readDocOrNull(join(channelDir, file), ChatLogSchema);
        if (!chatLog) continue;
        sessions.push({
          session_id: chatLog.session_id,
          channel: chatLog.channel,
          started_at: chatLog.started_at,
          updated_at: chatLog.updated_at,
          message_count: chatLog.messages.length,
        });
      }
    }

    sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return sessions;
  }

  async chatLogBySessionId(sessionId: string): Promise<ChatLogReadResult> {
    if (!(await pathExists(this.project.paths.chats))) return { kind: "missing-root" };

    for (const channel of await readdir(this.project.paths.chats)) {
      const channelDir = join(this.project.paths.chats, channel);
      try {
        if (!(await stat(channelDir)).isDirectory()) continue;
      } catch { continue; }

      const chatLog = await readDocOrNull(join(channelDir, `${sessionId}.json`), ChatLogSchema);
      if (chatLog) return { kind: "found", chatLog };
    }

    return {
      kind: "not-persisted",
      chatLog: {
        session_id: sessionId,
        channel: "unknown",
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        messages: [],
      },
    };
  }

  stageTaskReportPath(stageId: string, taskId: string): string {
    return this.stageRuns.stageTaskReportPath(stageId, taskId);
  }

  stageSummaryPath(stageId: string): string {
    return this.stageRuns.stageSummaryPath(stageId);
  }

  readExpectedStageTaskReport(opts: {
    stageId: string;
    taskId: string;
    agent: TaskReport["agent"];
  }): ArtifactReadResult<TaskReport> {
    return this.stageRuns.readExpectedStageTaskReport(opts);
  }

  readExpectedStageSummary(stageId: string): ArtifactReadResult<StageSummary> {
    return this.stageRuns.readExpectedStageSummary(stageId);
  }

  async writeStageTaskReport(report: TaskReport): Promise<void> {
    await this.stageRuns.writeTaskReport(report);
  }

  async writeStageSummary(summary: StageSummary): Promise<void> {
    await this.stageRuns.writeStageSummary(summary);
  }

  async debugErrors(): Promise<DebugErrorEntry[]> {
    const errors: DebugErrorEntry[] = [];

    const history = await this.planHistoryView();
    if (history?.stages) {
      for (const stage of history.stages) {
        if (stage.result === "failed" || stage.result === "escalated") {
          errors.push({
            source: stage.id,
            type: `stage_${stage.result}`,
            severity: "error",
            message: stage.summary ?? stage.result,
            details: stage.escalation ?? stage.abort_reason ?? null,
            timestamp: stage.completed_at,
          });
        }
      }
    }

    for (const stageId of await this.stageIds()) {
      const stageDir = join(this.project.paths.stages, stageId);

      const summary = await readLenientDebugJson(join(stageDir, "summary.json"));
      if (summary && typeof summary === "object" && !Array.isArray(summary)) {
        const record = summary as Record<string, unknown>;
        const completedAt = typeof record.completed_at === "string" ? record.completed_at : undefined;
        if (Array.isArray(record.issues)) {
          for (const issue of record.issues) {
            if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
            const issueRecord = issue as Record<string, unknown>;
            errors.push({
              source: stageId,
              type: "stage_issue",
              severity: typeof issueRecord.severity === "string" ? issueRecord.severity : "warning",
              message: typeof issueRecord.description === "string" ? issueRecord.description : "Unknown issue",
              timestamp: completedAt,
            });
          }
        }
        if (record.result === "failed" || record.result === "escalated") {
          errors.push({
            source: stageId,
            type: `summary_${record.result}`,
            severity: "error",
            message: typeof record.summary === "string" ? record.summary : record.result,
            details: record.escalation ?? null,
            timestamp: completedAt,
          });
        }
      }

      for (const report of await this.readLenientDebugTaskReports(stageId)) {
        if (report.status === "failed") {
          errors.push({
            source: `${stageId}/${typeof report.task_id === "string" ? report.task_id : report.file}`,
            type: "task_failed",
            severity: "error",
            message: typeof report.failure_reason === "string"
              ? report.failure_reason
              : typeof report.summary === "string"
                ? report.summary
                : "Task failed",
            details: report.issues_found,
            timestamp: typeof report.completed_at === "string" ? report.completed_at : undefined,
          });
        }
      }
    }

    errors.sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
    return errors;
  }

  async debugTimeline(): Promise<DebugTimelineEvent[]> {
    const events: DebugTimelineEvent[] = [];

    const history = await this.planHistoryView();
    if (history?.stages) {
      for (const stage of history.stages) {
        if (stage.started_at) {
          events.push({
            timestamp: stage.started_at,
            type: "stage_started",
            source: stage.id,
            description: `Stage started: ${stage.objective?.slice(0, 100) ?? stage.id}`,
          });
        }
        if (stage.completed_at) {
          events.push({
            timestamp: stage.completed_at,
            type: `stage_${stage.result ?? "completed"}`,
            source: stage.id,
            description: `Stage ${stage.result}: ${stage.summary?.slice(0, 100) ?? stage.id}`,
          });
        }
      }
    }

    for (const stageId of await this.stageIds()) {
      for (const report of await this.readLenientDebugTaskReports(stageId)) {
        if (typeof report.completed_at === "string") {
          const description = typeof report.summary === "string"
            ? report.summary
            : typeof report.task_id === "string"
              ? report.task_id
              : report.file;
          events.push({
            timestamp: report.completed_at,
            type: `task_${typeof report.status === "string" ? report.status : "unknown"}`,
            source: `${stageId}/${typeof report.task_id === "string" ? report.task_id : report.file}`,
            description: `Task ${typeof report.status === "string" ? report.status : "unknown"}: ${description.slice(0, 100)}`,
          });
        }
      }
    }

    events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return events;
  }

  private async stageIds(): Promise<string[]> {
    if (!(await pathExists(this.project.paths.stages))) return [];
    const ids: string[] = [];
    for (const stageId of await readdir(this.project.paths.stages)) {
      try {
        if ((await stat(join(this.project.paths.stages, stageId))).isDirectory()) ids.push(stageId);
      } catch { /* ignore concurrently removed stages */ }
    }
    return ids;
  }

  private async readLenientDebugTaskReports(stageId: string): Promise<Array<Record<string, unknown> & { file: string }>> {
    const reportsDir = join(this.project.paths.stages, stageId, "reports");
    if (!(await pathExists(reportsDir))) return [];
    const reports: Array<Record<string, unknown> & { file: string }> = [];
    for (const file of await readdir(reportsDir)) {
      if (!file.endsWith(".json")) continue;
      const report = await readLenientDebugJson(join(reportsDir, file));
      if (report && typeof report === "object" && !Array.isArray(report)) {
        reports.push({ ...(report as Record<string, unknown>), file });
      }
    }
    return reports;
  }
}

async function readLenientDebugJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}
