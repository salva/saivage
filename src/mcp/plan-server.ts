/**
 * Saivage — Plan MCP Service
 * 11 tools for plan state management per 03-PLAN-MCP-SERVICE.md.
 * Atomic writes, schema validation, history append.
 */

import { dirname, join } from "node:path";
import {
  readDocOrNull,
  writeDoc,
  ensureDir,
  pathExists,
} from "../store/documents.js";
import {
  PlanSchema,
  PlanHistorySchema,
  StageSchema,
  CompletedStageSchema,
  type Plan,
  type PlanHistory,
  type Stage,
  type CompletedStage,
  type Escalation,
} from "../types.js";
import { archiveStage } from "../knowledge/lifecycle.js";
import { log } from "../log.js";

/** Error codes returned by the Plan MCP service. */
export type PlanErrorCode =
  | "PLAN_NOT_FOUND"
  | "STAGE_NOT_FOUND"
  | "STAGE_EXISTS"
  | "VALIDATION_ERROR"
  | "IO_ERROR";

export interface PlanError {
  code: PlanErrorCode;
  error: string;
}

function planError(code: PlanErrorCode, message: string): PlanError {
  return { code, error: message };
}

/**
 * Plan MCP Service — manages plan.json and plan-history.json.
 * All operations are atomic (tmp + rename).
 */
export class PlanService {
  private planPath: string;
  private historyPath: string;
  private projectRoot: string;
  private opQueue: Promise<unknown> = Promise.resolve();

  /** In-memory cache, hydrated by init(). */
  private plan: Plan | null = null;
  private history: PlanHistory = { stages: [] };

  /** Git commit callback — called by plan_commit. */
  private gitCommitFn:
    | ((files: string[], message: string) => Promise<{ sha: string }>)
    | null = null;

  /** SHA of last commit for noop detection. */
  private lastCommitSha: string | null = null;

  constructor(projectSaivageDir: string) {
    this.planPath = join(projectSaivageDir, "plan.json");
    this.historyPath = join(projectSaivageDir, "plan-history.json");
    this.projectRoot = join(projectSaivageDir, "..");
  }

  /** Hydrate the in-memory cache from disk. Must be called once before use. */
  async init(): Promise<void> {
    await ensureDir(dirname(this.planPath));
    this.plan = await readDocOrNull(this.planPath, PlanSchema);
    this.history = (await readDocOrNull(this.historyPath, PlanHistorySchema)) ?? { stages: [] };
  }

  /** Set the callback used for git commits. */
  setGitCommit(
    fn: (files: string[], message: string) => Promise<{ sha: string }>,
  ): void {
    this.gitCommitFn = fn;
  }

  // ─── Tools ──────────────────────────────────────────────────────────────

  /** plan_get — Read the current plan. */
  async plan_get(): Promise<Plan | PlanError> {
    if (!this.plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist. Call plan_init first.");
    return structuredClone(this.plan);
  }

  /** plan_get_stage — Get a single stage by ID (from active plan or history). */
  async plan_get_stage(stageId: string): Promise<(Stage & { source: "active" | "history" }) | (CompletedStage & { source: "history" }) | PlanError> {
    if (this.plan) {
      const stage = this.plan.stages.find((s) => s.id === stageId);
      if (stage) return { ...structuredClone(stage), source: "active" as const };
    }
    const completed = this.history.stages.find((s) => s.id === stageId);
    if (completed) return { ...structuredClone(completed), source: "history" as const };
    return planError("STAGE_NOT_FOUND", `Stage '${stageId}' not found in active plan or history`);
  }

  /** plan_get_current_stage — Get the stage currently being executed. */
  async plan_get_current_stage(): Promise<Stage | null | PlanError> {
    if (!this.plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");
    if (!this.plan.current_stage_id) return null;
    const found = this.plan.stages.find((s) => s.id === this.plan!.current_stage_id);
    return found ? structuredClone(found) : null;
  }

  /** plan_set_stages — Replace the plan's stage list. */
  async plan_set_stages(
    stages: Stage[],
    currentStageId: string | null,
  ): Promise<Plan | PlanError> {
    try {
      for (const s of stages) {
        StageSchema.parse(s);
      }

      if (currentStageId !== null && !stages.some((s) => s.id === currentStageId)) {
        return planError("STAGE_NOT_FOUND", `current_stage_id '${currentStageId}' not found in provided stages`);
      }

      const nextPlan: Plan = {
        updated_at: new Date().toISOString(),
        current_stage_id: currentStageId,
        stages,
      };
      await writeDoc(this.planPath, nextPlan, PlanSchema);
      this.plan = nextPlan;
      return structuredClone(nextPlan);
    } catch (err) {
      return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
    }
  }

  /** plan_add_stage — Append a new stage. */
  async plan_add_stage(stage: Stage): Promise<Plan | PlanError> {
    if (!this.plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    if (this.plan.stages.some((s) => s.id === stage.id)) {
      return planError("STAGE_EXISTS", `Stage '${stage.id}' already exists`);
    }

    try {
      StageSchema.parse(stage);
    } catch (err) {
      return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
    }

    const nextPlan = structuredClone(this.plan);
    nextPlan.stages.push(stage);
    nextPlan.updated_at = new Date().toISOString();
    await writeDoc(this.planPath, nextPlan, PlanSchema);
    this.plan = nextPlan;
    return structuredClone(nextPlan);
  }

  /** plan_remove_stage — Remove a stage from the active plan. */
  async plan_remove_stage(stageId: string): Promise<Plan | PlanError> {
    if (!this.plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    const idx = this.plan.stages.findIndex((s) => s.id === stageId);
    if (idx === -1) return planError("STAGE_NOT_FOUND", `Stage '${stageId}' not found`);

    const nextPlan = structuredClone(this.plan);
    nextPlan.stages.splice(idx, 1);
    if (nextPlan.current_stage_id === stageId) {
      nextPlan.current_stage_id = null;
    }
    nextPlan.updated_at = new Date().toISOString();
    await writeDoc(this.planPath, nextPlan, PlanSchema);
    this.plan = nextPlan;
    return structuredClone(nextPlan);
  }

  /** plan_set_current — Set which stage is currently being executed. */
  async plan_set_current(stageId: string | null): Promise<Plan | PlanError> {
    if (!this.plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    if (stageId !== null && !this.plan.stages.some((s) => s.id === stageId)) {
      return planError("STAGE_NOT_FOUND", `Stage '${stageId}' not found`);
    }

    const nextPlan = structuredClone(this.plan);
    nextPlan.current_stage_id = stageId;
    nextPlan.updated_at = new Date().toISOString();
    await writeDoc(this.planPath, nextPlan, PlanSchema);
    this.plan = nextPlan;
    return structuredClone(nextPlan);
  }

  /** plan_complete_stage — Move a stage from active plan to history. */
  async plan_complete_stage(args: {
    stage_id: string;
    result: "completed" | "failed" | "escalated" | "aborted";
    summary: string;
    actual_outcomes: string[];
    escalation?: Escalation;
    abort_reason?: string;
  }): Promise<{ completed_stage: CompletedStage; plan: Plan } | PlanError> {
    if (!this.plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    const stageIdx = this.plan.stages.findIndex((s) => s.id === args.stage_id);
    if (stageIdx === -1) {
      return planError("STAGE_NOT_FOUND", `Stage '${args.stage_id}' not found in active plan`);
    }

    const stage = this.plan.stages[stageIdx];
    const now = new Date().toISOString();

    const completedStage: CompletedStage = {
      id: stage.id,
      objective: stage.objective,
      expected_outcomes: stage.expected_outcomes,
      actual_outcomes: args.actual_outcomes,
      started_at: now,
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

    const nextPlan = structuredClone(this.plan);
    nextPlan.stages.splice(stageIdx, 1);
    if (nextPlan.current_stage_id === args.stage_id) {
      nextPlan.current_stage_id = null;
    }
    nextPlan.updated_at = now;

    const nextHistory = structuredClone(this.history);
    nextHistory.stages.push(completedStage);

    // Disk writes first. If either rejects the cache stays at the prior
    // value and the error propagates. A failure of the second write
    // leaves disk with an updated plan.json but stale plan-history.json;
    // this residual cross-document gap is out of scope for F34.
    await writeDoc(this.planPath, nextPlan, PlanSchema);
    await writeDoc(this.historyPath, nextHistory, PlanHistorySchema);
    this.plan = nextPlan;
    this.history = nextHistory;

    // FR-9 / WI-11: archive stage-scoped skills + memory at stage close.
    try {
      await archiveStage(this.projectRoot, stage.id);
    } catch (err) {
      log.warn(`[plan-server] archiveStage failed for ${stage.id}: ${String(err)}`);
    }

    return { completed_stage: structuredClone(completedStage), plan: structuredClone(nextPlan) };
  }

  /** plan_get_history — Read the plan history. */
  async plan_get_history(lastN?: number): Promise<PlanHistory | PlanError> {
    if (lastN !== undefined && lastN > 0) {
      return { stages: structuredClone(this.history.stages.slice(-lastN)) };
    }
    return structuredClone(this.history);
  }

  /** plan_init — Initialize an empty plan. */
  async plan_init(stages?: Stage[]): Promise<Plan | PlanError> {
    if (this.plan !== null) {
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

    const plan: Plan = {
      updated_at: new Date().toISOString(),
      current_stage_id: null,
      stages: parsedStages,
    };
    await writeDoc(this.planPath, plan, PlanSchema);
    this.plan = plan;
    return structuredClone(plan);
  }

  /** plan_commit — Commit plan files to git. */
  async plan_commit(
    message: string,
  ): Promise<{ sha: string; noop?: boolean } | PlanError> {
    if (!this.gitCommitFn) {
      return planError("IO_ERROR", "Git commit function not configured");
    }

    try {
      const candidates = [this.planPath, this.historyPath];
      const files: string[] = [];
      for (const f of candidates) if (await pathExists(f)) files.push(f);
      if (files.length === 0) {
        return planError("PLAN_NOT_FOUND", "No plan files to commit");
      }

      const prefixed = `[planner] ${message}`;
      const result = await this.gitCommitFn(files, prefixed);

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

  // ─── MCP Tool Handler ──────────────────────────────────────────────────

  /**
   * Handle an MCP tool call by name.
   * Used when registering as an in-process MCP service.
   */
  async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown; isError: boolean }> {
    return this.serializeOp(() => this.handleToolCallInner(toolName, args));
  }

  private async serializeOp<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.opQueue.catch(() => undefined).then(fn);
    this.opQueue = run.catch(() => undefined);
    return run;
  }

  private async handleToolCallInner(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown; isError: boolean }> {
    let result: unknown;
    let isError = false;

    switch (toolName) {
      case "plan_get":
        result = await this.plan_get();
        break;
      case "plan_get_stage":
        result = await this.plan_get_stage(args.stage_id as string);
        break;
      case "plan_get_current_stage":
        result = await this.plan_get_current_stage();
        break;
      case "plan_set_stages":
        result = await this.plan_set_stages(
          args.stages as Stage[],
          args.current_stage_id as string | null,
        );
        break;
      case "plan_add_stage":
        result = await this.plan_add_stage(args.stage as Stage);
        break;
      case "plan_remove_stage":
        result = await this.plan_remove_stage(args.stage_id as string);
        break;
      case "plan_set_current":
        result = await this.plan_set_current(args.stage_id as string | null);
        break;
      case "plan_complete_stage":
        result = await this.plan_complete_stage(args as Parameters<typeof this.plan_complete_stage>[0]);
        break;
      case "plan_get_history":
        result = await this.plan_get_history(args.last_n as number | undefined);
        break;
      case "plan_init":
        result = await this.plan_init(args.stages as Stage[] | undefined);
        break;
      case "plan_commit":
        result = await this.plan_commit(args.message as string);
        break;
      default:
        result = { code: "VALIDATION_ERROR", error: `Unknown plan tool: ${toolName}` };
        isError = true;
    }

    // Check if the result is an error
    if (result && typeof result === "object" && "code" in result && "error" in result) {
      isError = true;
    }

    return { content: result, isError };
  }

  /** Get MCP tool schemas for registration. */
  static getToolSchemas(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> {
    return [
      {
        name: "plan_get",
        description: "Read the current plan.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "plan_get_stage",
        description: "Get a single stage by ID (from active plan or history).",
        inputSchema: {
          type: "object",
          properties: { stage_id: { type: "string", description: "The stage ID to look up" } },
          required: ["stage_id"],
        },
      },
      {
        name: "plan_get_current_stage",
        description: "Get the stage currently being executed.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "plan_set_stages",
        description: "Replace the plan's stage list.",
        inputSchema: {
          type: "object",
          properties: {
            stages: { type: "array", items: { type: "object" }, description: "The new stage list" },
            current_stage_id: { type: ["string", "null"], description: "Which stage to mark as current" },
          },
          required: ["stages", "current_stage_id"],
        },
      },
      {
        name: "plan_add_stage",
        description: "Append a new stage to the plan.",
        inputSchema: {
          type: "object",
          properties: { stage: { type: "object", description: "The stage to add" } },
          required: ["stage"],
        },
      },
      {
        name: "plan_remove_stage",
        description: "Remove a stage from the active plan by ID.",
        inputSchema: {
          type: "object",
          properties: { stage_id: { type: "string" } },
          required: ["stage_id"],
        },
      },
      {
        name: "plan_set_current",
        description: "Set which stage is currently being executed.",
        inputSchema: {
          type: "object",
          properties: { stage_id: { type: ["string", "null"] } },
          required: ["stage_id"],
        },
      },
      {
        name: "plan_complete_stage",
        description: "Move a stage from the active plan to history.",
        inputSchema: {
          type: "object",
          properties: {
            stage_id: { type: "string" },
            result: { type: "string", enum: ["completed", "failed", "escalated", "aborted"] },
            summary: { type: "string" },
            actual_outcomes: { type: "array", items: { type: "string" } },
            escalation: { type: "object", description: "Escalation object (if result=escalated)" },
            abort_reason: { type: "string", description: "If result=aborted" },
          },
          required: ["stage_id", "result", "summary", "actual_outcomes"],
        },
      },
      {
        name: "plan_get_history",
        description: "Read the plan history.",
        inputSchema: {
          type: "object",
          properties: { last_n: { type: "number", description: "Return only the N most recent entries" } },
        },
      },
      {
        name: "plan_init",
        description: "Initialize an empty plan.",
        inputSchema: {
          type: "object",
          properties: { stages: { type: "array", items: { type: "object" }, description: "Initial stages" } },
        },
      },
      {
        name: "plan_commit",
        description: "Commit plan files to git.",
        inputSchema: {
          type: "object",
          properties: { message: { type: "string", description: "Commit message" } },
          required: ["message"],
        },
      },
    ];
  }
}
