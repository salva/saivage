/**
 * Saivage — Plan MCP Service
 * 11 tools for plan state management per 03-PLAN-MCP-SERVICE.md.
 * Atomic writes, schema validation, history append.
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import {
  readDoc,
  readDocOrNull,
  writeDoc,
  ensureDir,
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

  /** Git commit callback — called by plan_commit. */
  private gitCommitFn:
    | ((files: string[], message: string) => Promise<{ sha: string }>)
    | null = null;

  /** SHA of last commit for noop detection. */
  private lastCommitSha: string | null = null;

  constructor(projectSaivageDir: string) {
    this.planPath = join(projectSaivageDir, "plan.json");
    this.historyPath = join(projectSaivageDir, "plan-history.json");
    ensureDir(projectSaivageDir);
  }

  /** Set the callback used for git commits. */
  setGitCommit(
    fn: (files: string[], message: string) => Promise<{ sha: string }>,
  ): void {
    this.gitCommitFn = fn;
  }

  // ─── Tools ──────────────────────────────────────────────────────────────

  /** plan_get — Read the current plan. */
  plan_get(): Plan | PlanError {
    const plan = readDocOrNull(this.planPath, PlanSchema);
    if (!plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist. Call plan_init first.");
    return plan;
  }

  /** plan_get_stage — Get a single stage by ID (from active plan or history). */
  plan_get_stage(stageId: string): (Stage & { source: "active" | "history" }) | (CompletedStage & { source: "history" }) | PlanError {
    // Check active plan first
    const plan = readDocOrNull(this.planPath, PlanSchema);
    if (plan) {
      const stage = plan.stages.find((s) => s.id === stageId);
      if (stage) return { ...stage, source: "active" as const };
    }

    // Check history
    const history = readDocOrNull(this.historyPath, PlanHistorySchema);
    if (history) {
      const completed = history.stages.find((s) => s.id === stageId);
      if (completed) return { ...completed, source: "history" as const };
    }

    return planError("STAGE_NOT_FOUND", `Stage '${stageId}' not found in active plan or history`);
  }

  /** plan_get_current_stage — Get the stage currently being executed. */
  plan_get_current_stage(): Stage | null | PlanError {
    const plan = readDocOrNull(this.planPath, PlanSchema);
    if (!plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");
    if (!plan.current_stage_id) return null;
    return plan.stages.find((s) => s.id === plan.current_stage_id) ?? null;
  }

  /** plan_set_stages — Replace the plan's stage list. */
  plan_set_stages(
    stages: Stage[],
    currentStageId: string | null,
  ): Plan | PlanError {
    try {
      // Validate each stage
      for (const s of stages) {
        StageSchema.parse(s);
      }

      if (currentStageId !== null && !stages.some((s) => s.id === currentStageId)) {
        return planError("STAGE_NOT_FOUND", `current_stage_id '${currentStageId}' not found in provided stages`);
      }

      const plan: Plan = {
        updated_at: new Date().toISOString(),
        current_stage_id: currentStageId,
        stages,
      };
      writeDoc(this.planPath, plan, PlanSchema);
      return plan;
    } catch (err) {
      return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
    }
  }

  /** plan_add_stage — Append a new stage. */
  plan_add_stage(stage: Stage): Plan | PlanError {
    const plan = readDocOrNull(this.planPath, PlanSchema);
    if (!plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    if (plan.stages.some((s) => s.id === stage.id)) {
      return planError("STAGE_EXISTS", `Stage '${stage.id}' already exists`);
    }

    try {
      StageSchema.parse(stage);
    } catch (err) {
      return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
    }

    plan.stages.push(stage);
    plan.updated_at = new Date().toISOString();
    writeDoc(this.planPath, plan, PlanSchema);
    return plan;
  }

  /** plan_remove_stage — Remove a stage from the active plan. */
  plan_remove_stage(stageId: string): Plan | PlanError {
    const plan = readDocOrNull(this.planPath, PlanSchema);
    if (!plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    const idx = plan.stages.findIndex((s) => s.id === stageId);
    if (idx === -1) return planError("STAGE_NOT_FOUND", `Stage '${stageId}' not found`);

    plan.stages.splice(idx, 1);
    if (plan.current_stage_id === stageId) {
      plan.current_stage_id = null;
    }
    plan.updated_at = new Date().toISOString();
    writeDoc(this.planPath, plan, PlanSchema);
    return plan;
  }

  /** plan_set_current — Set which stage is currently being executed. */
  plan_set_current(stageId: string | null): Plan | PlanError {
    const plan = readDocOrNull(this.planPath, PlanSchema);
    if (!plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    if (stageId !== null && !plan.stages.some((s) => s.id === stageId)) {
      return planError("STAGE_NOT_FOUND", `Stage '${stageId}' not found`);
    }

    plan.current_stage_id = stageId;
    plan.updated_at = new Date().toISOString();
    writeDoc(this.planPath, plan, PlanSchema);
    return plan;
  }

  /** plan_complete_stage — Move a stage from active plan to history. */
  plan_complete_stage(args: {
    stage_id: string;
    result: "completed" | "failed" | "escalated" | "aborted";
    summary: string;
    actual_outcomes: string[];
    escalation?: Escalation;
    abort_reason?: string;
  }): { completed_stage: CompletedStage; plan: Plan } | PlanError {
    const plan = readDocOrNull(this.planPath, PlanSchema);
    if (!plan) return planError("PLAN_NOT_FOUND", "plan.json does not exist.");

    const stageIdx = plan.stages.findIndex((s) => s.id === args.stage_id);
    if (stageIdx === -1) {
      return planError("STAGE_NOT_FOUND", `Stage '${args.stage_id}' not found in active plan`);
    }

    const stage = plan.stages[stageIdx];
    const now = new Date().toISOString();

    const completedStage: CompletedStage = {
      id: stage.id,
      objective: stage.objective,
      expected_outcomes: stage.expected_outcomes,
      actual_outcomes: args.actual_outcomes,
      started_at: now, // ideally tracked by runtime, but we don't have it
      completed_at: now,
      result: args.result,
      summary: args.summary,
      escalation: args.escalation,
      abort_reason: args.abort_reason,
    };

    // Validate the completed stage
    try {
      CompletedStageSchema.parse(completedStage);
    } catch (err) {
      return planError("VALIDATION_ERROR", err instanceof Error ? err.message : String(err));
    }

    // Remove from active plan
    plan.stages.splice(stageIdx, 1);
    if (plan.current_stage_id === args.stage_id) {
      plan.current_stage_id = null;
    }
    plan.updated_at = now;

    // Write to history
    let history = readDocOrNull(this.historyPath, PlanHistorySchema);
    if (!history) {
      history = { stages: [] };
    }
    history.stages.push(completedStage);

    // Atomic writes (plan first, then history)
    writeDoc(this.planPath, plan, PlanSchema);
    writeDoc(this.historyPath, history, PlanHistorySchema);

    return { completed_stage: completedStage, plan };
  }

  /** plan_get_history — Read the plan history. */
  plan_get_history(lastN?: number): PlanHistory | PlanError {
    const history = readDocOrNull(this.historyPath, PlanHistorySchema);
    if (!history) return { stages: [] };

    if (lastN !== undefined && lastN > 0) {
      return { stages: history.stages.slice(-lastN) };
    }
    return history;
  }

  /** plan_init — Initialize an empty plan. */
  plan_init(stages?: Stage[]): Plan | PlanError {
    if (existsSync(this.planPath)) {
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
    writeDoc(this.planPath, plan, PlanSchema);
    return plan;
  }

  /** plan_commit — Commit plan files to git. */
  async plan_commit(
    message: string,
  ): Promise<{ sha: string; noop?: boolean } | PlanError> {
    if (!this.gitCommitFn) {
      return planError("IO_ERROR", "Git commit function not configured");
    }

    try {
      const files = [this.planPath, this.historyPath].filter((f) =>
        existsSync(f),
      );
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
    let result: unknown;
    let isError = false;

    switch (toolName) {
      case "plan_get":
        result = this.plan_get();
        break;
      case "plan_get_stage":
        result = this.plan_get_stage(args.stage_id as string);
        break;
      case "plan_get_current_stage":
        result = this.plan_get_current_stage();
        break;
      case "plan_set_stages":
        result = this.plan_set_stages(
          args.stages as Stage[],
          args.current_stage_id as string | null,
        );
        break;
      case "plan_add_stage":
        result = this.plan_add_stage(args.stage as Stage);
        break;
      case "plan_remove_stage":
        result = this.plan_remove_stage(args.stage_id as string);
        break;
      case "plan_set_current":
        result = this.plan_set_current(args.stage_id as string | null);
        break;
      case "plan_complete_stage":
        result = this.plan_complete_stage(args as Parameters<typeof this.plan_complete_stage>[0]);
        break;
      case "plan_get_history":
        result = this.plan_get_history(args.last_n as number | undefined);
        break;
      case "plan_init":
        result = this.plan_init(args.stages as Stage[] | undefined);
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
