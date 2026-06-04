/**
 * Saivage — Plan MCP Service
 * 12 tools for plan state management per 03-PLAN-MCP-SERVICE.md.
 * Atomic writes, schema validation, embedded history.
 */

import { dirname, join } from "node:path";
import {
  readDocOrNull,
  writeDoc,
  ensureDir,
  pathExists,
} from "../store/documents.js";
import {
  PlanDocumentSchema,
  StageSchema,
  CompletedStageSchema,
  type ActivePlanView,
  type PlanDocument,
  type PlanHistoryView,
  type Stage,
  type CompletedStage,
  type Escalation,
} from "../types.js";
import { archiveStage } from "../knowledge/lifecycle.js";
import { log } from "../log.js";
import { dispatchPlanToolCall } from "./plan-dispatch.js";
import { getPlanToolSchemas } from "./plan-schemas.js";
export { PLAN_READER_TOOLS, PLAN_WRITER_TOOLS } from "./plan-registry.js";
import { PLAN_WRITER_TOOLS } from "./plan-registry.js";

/** Error codes returned by the Plan MCP service. */
export type PlanErrorCode =
  | "PLAN_NOT_FOUND"
  | "STAGE_NOT_FOUND"
  | "STAGE_EXISTS"
  | "STAGE_MISMATCH"
  | "VALIDATION_ERROR"
  | "IO_ERROR";

export interface PlanError {
  code: PlanErrorCode;
  error: string;
}

function planError(code: PlanErrorCode, message: string): PlanError {
  return { code, error: message };
}

/** Internal factory exported for the admin backfill script (see
 * src/scripts/backfill-plan-history.ts). NOT for general use. */
export function makePlanError(code: PlanErrorCode, message: string): PlanError {
  return planError(code, message);
}

/**
 * Plan MCP Service — manages plan.json, including embedded history.
 * All operations are atomic (tmp + rename).
 */
export class PlanService {
  private docPath: string;
  private projectRoot: string;
  private opQueue: Promise<unknown> = Promise.resolve();

  /** In-memory cache, hydrated by init(). */
  private doc: PlanDocument | null = null;

  /** Git commit callback — called by plan_commit. */
  private gitCommitFn:
    | ((files: string[], message: string) => Promise<{ sha: string }>)
    | null = null;

  /** SHA of last commit for noop detection. */
  private lastCommitSha: string | null = null;

  constructor(projectSaivageDir: string) {
    this.docPath = join(projectSaivageDir, "plan.json");
    this.projectRoot = join(projectSaivageDir, "..");
  }

  private stampStarted(stage: Stage): Stage {
    return stage.started_at ? stage : { ...stage, started_at: new Date().toISOString() };
  }

  private preserveStartedAt(
    incoming: readonly Stage[],
    existing: readonly Stage[],
  ): Stage[] {
    const existingById = new Map(existing.map((stage) => [stage.id, stage]));
    return incoming.map((stage) => {
      if (stage.started_at !== undefined) return stage;
      const prev = existingById.get(stage.id);
      return prev?.started_at ? { ...stage, started_at: prev.started_at } : stage;
    });
  }

  private activeView(doc: PlanDocument): ActivePlanView {
    return {
      updated_at: doc.updated_at,
      current_stage_id: doc.current_stage_id,
      stages: doc.stages,
    };
  }

  private historyView(doc: PlanDocument): PlanHistoryView {
    return { stages: doc.history };
  }

  private async writeDoc(nextDoc: PlanDocument): Promise<void> {
    await writeDoc(this.docPath, nextDoc, PlanDocumentSchema);
    this.doc = nextDoc;
  }

  /** Hydrate the in-memory cache from disk. Must be called once before use. */
  async init(): Promise<void> {
    await ensureDir(dirname(this.docPath));
    this.doc = await readDocOrNull(this.docPath, PlanDocumentSchema);
  }

  /** Set the callback used for git commits. */
  setGitCommit(
    fn: (files: string[], message: string) => Promise<{ sha: string }>,
  ): void {
    this.gitCommitFn = fn;
  }

  // ─── Tools ──────────────────────────────────────────────────────────────

  /** plan_get — Read the current plan. */
  async plan_get(): Promise<ActivePlanView | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist. Call plan_init first.");
    return structuredClone(this.activeView(this.doc));
  }

  /** plan_get_stage — Get a single stage by ID (from active plan or history). */
  async plan_get_stage(stageId: string): Promise<(Stage & { source: "active" | "history" }) | (CompletedStage & { source: "history" }) | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");
    const stage = this.doc.stages.find((s) => s.id === stageId);
    if (stage) return { ...structuredClone(stage), source: "active" as const };
    const completed = this.doc.history.find((s) => s.id === stageId);
    if (completed) return { ...structuredClone(completed), source: "history" as const };
    return planError("STAGE_NOT_FOUND", `Stage '${stageId}' not found in active plan or history`);
  }

  /** plan_get_current_stage — Get the stage currently being executed. */
  async plan_get_current_stage(): Promise<Stage | null | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");
    const currentStageId = this.doc.current_stage_id;
    if (!currentStageId) return null;
    const found = this.doc.stages.find((s) => s.id === currentStageId);
    return found ? structuredClone(found) : null;
  }

  /** plan_set_stages — Replace the plan's stage list. */
  async plan_set_stages(
    stages: Stage[],
    currentStageId: string | null,
  ): Promise<ActivePlanView | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    try {
      for (const s of stages) {
        StageSchema.parse(s);
      }

      if (currentStageId !== null && !stages.some((s) => s.id === currentStageId)) {
        return planError("STAGE_NOT_FOUND", `current_stage_id '${currentStageId}' not found in provided stages`);
      }

      const merged = this.preserveStartedAt(stages, this.doc.stages);
      if (currentStageId !== null) {
        const idx = merged.findIndex((stage) => stage.id === currentStageId);
        if (idx !== -1) merged[idx] = this.stampStarted(merged[idx]);
      }

      const nextDoc: PlanDocument = {
        updated_at: new Date().toISOString(),
        current_stage_id: currentStageId,
        stages: merged,
        history: structuredClone(this.doc.history),
      };
      await this.writeDoc(nextDoc);
      return structuredClone(this.activeView(nextDoc));
    } catch (err) {
      return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
    }
  }

  /** plan_add_stage — Append a new stage. */
  async plan_add_stage(stage: Stage): Promise<ActivePlanView | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    if (this.doc.stages.some((s) => s.id === stage.id) || this.doc.history.some((s) => s.id === stage.id)) {
      return planError("STAGE_EXISTS", `Stage '${stage.id}' already exists`);
    }

    try {
      StageSchema.parse(stage);
    } catch (err) {
      return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
    }

    const nextDoc = structuredClone(this.doc);
    nextDoc.stages.push(stage);
    nextDoc.updated_at = new Date().toISOString();
    await this.writeDoc(nextDoc);
    return structuredClone(this.activeView(nextDoc));
  }

  /** plan_remove_stage — Remove a stage from the active plan. */
  async plan_remove_stage(stageId: string): Promise<ActivePlanView | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    const idx = this.doc.stages.findIndex((s) => s.id === stageId);
    if (idx === -1) return planError("STAGE_NOT_FOUND", `Stage '${stageId}' not found`);

    const nextDoc = structuredClone(this.doc);
    nextDoc.stages.splice(idx, 1);
    if (nextDoc.current_stage_id === stageId) {
      nextDoc.current_stage_id = null;
    }
    nextDoc.updated_at = new Date().toISOString();
    await this.writeDoc(nextDoc);
    return structuredClone(this.activeView(nextDoc));
  }

  /** plan_set_current — Set which stage is currently being executed. */
  async plan_set_current(stageId: string | null): Promise<ActivePlanView | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    if (stageId !== null && !this.doc.stages.some((s) => s.id === stageId)) {
      return planError("STAGE_NOT_FOUND", `Stage '${stageId}' not found`);
    }

    const nextDoc = structuredClone(this.doc);
    nextDoc.current_stage_id = stageId;
    if (stageId !== null) {
      const idx = nextDoc.stages.findIndex((stage) => stage.id === stageId);
      if (idx !== -1) nextDoc.stages[idx] = this.stampStarted(nextDoc.stages[idx]);
    }
    nextDoc.updated_at = new Date().toISOString();
    await this.writeDoc(nextDoc);
    return structuredClone(this.activeView(nextDoc));
  }

  /** plan_complete_stage — Move a stage from active plan to history. */
  async plan_complete_stage(args: {
    stage_id: string;
    result: "completed" | "failed" | "escalated" | "aborted";
    summary: string;
    actual_outcomes: string[];
    escalation?: Escalation;
    abort_reason?: string;
  }): Promise<{ completed_stage: CompletedStage; plan: ActivePlanView } | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    const stageIdx = this.doc.stages.findIndex((s) => s.id === args.stage_id);
    if (stageIdx === -1) {
      return planError("STAGE_NOT_FOUND", `Stage '${args.stage_id}' not found in active plan`);
    }

    const stage = this.doc.stages[stageIdx];
    if (!stage.started_at) {
      return planError("VALIDATION_ERROR", `Stage '${args.stage_id}' has no started_at; plan_set_current was never called`);
    }
    const now = new Date().toISOString();

    const completedStage: CompletedStage = {
      id: stage.id,
      objective: stage.objective,
      expected_outcomes: stage.expected_outcomes,
      actual_outcomes: args.actual_outcomes,
      started_at: stage.started_at,
      completed_at: now,
      result: args.result,
      summary: args.summary,
      escalation: args.escalation,
      abort_reason: args.abort_reason,
    };

    try {
      CompletedStageSchema.parse(completedStage);
    } catch (err) {
      return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
    }

    const nextDoc = structuredClone(this.doc);
    nextDoc.stages.splice(stageIdx, 1);
    if (nextDoc.current_stage_id === args.stage_id) {
      nextDoc.current_stage_id = null;
    }
    nextDoc.history.push(completedStage);
    nextDoc.updated_at = now;
    await this.writeDoc(nextDoc);

    // FR-9 / WI-11: archive stage-scoped skills + memory at stage close.
    try {
      await archiveStage(this.projectRoot, stage.id);
    } catch (err) {
      log.warn(`[plan-server] archiveStage failed for ${stage.id}: ${String(err)}`);
    }

    return { completed_stage: structuredClone(completedStage), plan: structuredClone(this.activeView(nextDoc)) };
  }

  /**
   * Admin-only: append a synthesised CompletedStage directly to history.
   * NOT exposed as an MCP tool (absent from PLAN_WRITER_TOOLS and
   * getToolSchemas()); intended exclusively for the offline backfill
   * script at src/scripts/backfill-plan-history.ts. Writes via writeDoc so
   * the atomic tmp+rename guarantee and in-memory cache invalidation still
   * apply.
   */
  async plan_append_history(
    stage: CompletedStage,
  ): Promise<{ history_len: number } | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");
    try {
      CompletedStageSchema.parse(stage);
    } catch (err) {
      return planError(
        "VALIDATION_ERROR",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (this.doc.stages.some((s) => s.id === stage.id)) {
      return planError(
        "STAGE_EXISTS",
        `Stage '${stage.id}' is in active plan.stages; refusing to append to history.`,
      );
    }
    if (this.doc.history.some((s) => s.id === stage.id)) {
      return planError(
        "STAGE_EXISTS",
        `Stage '${stage.id}' already in history; refusing to duplicate.`,
      );
    }
    const nextDoc = structuredClone(this.doc);
    nextDoc.history.push(stage);
    nextDoc.updated_at = new Date().toISOString();
    await this.writeDoc(nextDoc);
    return { history_len: nextDoc.history.length };
  }

  /** plan_get_history — Read the plan history. */
  async plan_get_history(lastN?: number): Promise<PlanHistoryView | PlanError> {
    if (!this.doc) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");
    if (lastN !== undefined && lastN > 0) {
      return { stages: structuredClone(this.doc.history.slice(-lastN)) };
    }
    return structuredClone(this.historyView(this.doc));
  }

  /** plan_init — Initialize an empty plan. */
  async plan_init(stages?: Stage[]): Promise<ActivePlanView | PlanError> {
    if (this.doc !== null) {
      return planError("STAGE_EXISTS", "plan.json already exists. Use plan_set_stages to overwrite.");
    }

    const parsedStages: Stage[] = [];
    if (stages) {
      try {
        for (const s of stages) {
          parsedStages.push(StageSchema.parse(s));
        }
      } catch (err) {
        return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
      }
    }

    const doc: PlanDocument = {
      updated_at: new Date().toISOString(),
      current_stage_id: null,
      stages: parsedStages,
      history: [],
    };
    await this.writeDoc(doc);
    return structuredClone(this.activeView(doc));
  }

  /** plan_commit — Commit plan files to git. */
  async plan_commit(
    message: string,
  ): Promise<{ sha: string; noop?: boolean } | PlanError> {
    if (!this.gitCommitFn) {
      return planError("IO_ERROR", "Git commit function not configured");
    }

    try {
      if (!(await pathExists(this.docPath))) {
        return planError("PLAN_NOT_FOUND", "No plan files to commit");
      }

      const prefixed = `[planner] ${message}`;
      const result = await this.gitCommitFn([this.docPath], prefixed);

      if (result.sha === this.lastCommitSha) {
        return { sha: result.sha, noop: true };
      }

      this.lastCommitSha = result.sha;
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Detect no-change commits (git returns error when nothing to commit)
      if (msg.includes("nothing to commit") || msg.includes("no changes")) {
        return {
          sha: this.lastCommitSha ?? "unknown",
          noop: true,
        };
      }
      return planError("IO_ERROR", msg);
    }
  }

  /** plan_done — Structured terminal signal for Planner completion. */
  async plan_done(args: { reason: string }): Promise<{ ok: true } | PlanError> {
    if (typeof args.reason !== "string" || args.reason.trim() === "") {
      return planError("VALIDATION_ERROR", "plan_done requires a non-empty reason");
    }
    return { ok: true };
  }

  // ─── MCP Tool Handler ──────────────────────────────────────────────────

  /**
   * Handle an MCP tool call by name.
   * Used when registering as an in-process MCP service.
   */
  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown; isError: boolean }> {
    if (PLAN_WRITER_TOOLS.has(toolName)) {
      return this.serializeOp(() => dispatchPlanToolCall(this, toolName, args));
    }
    return dispatchPlanToolCall(this, toolName, args);
  }

  private async serializeOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opQueue.catch(() => undefined).then(fn);
    this.opQueue = run.catch(() => undefined);
    return run;
  }

  /** Get MCP tool schemas for registration. */
  static getToolSchemas(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return getPlanToolSchemas();
  }
}
