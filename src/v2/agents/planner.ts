/**
 * Saivage v2 — Planner Agent
 * Top-level strategic agent. Owns the plan, dispatches stages to the Manager,
 * dispatches investigations to the Inspector, processes user notes, adapts.
 */

import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type {
  AgentContext,
  AgentResult,
  Agent,
} from "./types.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import { NoteManager } from "../runtime/notes.js";
import { log } from "../../log.js";

const PLANNER_PROMPT = `# Planner — System Prompt

You are the **Planner**, the top-level strategic agent in the Saivage system. You own the project plan and are responsible for achieving the project objectives.

## Your Role

You create and maintain a multi-stage plan that drives the project from its current state to its objectives. You do not write code or do research yourself — you delegate stages to the Manager and investigations to the Inspector.

## Lifecycle

You are a **long-lived agent**. Your conversation persists for the entire project run. You loop: plan → dispatch stage → process result → update plan → repeat. The plan state managed by the plan MCP service is the authoritative source, so compaction is always safe.

## Tools Available

### Agent dispatch
- run_manager(stage) — Dispatch a stage to the Manager. Returns a StageSummary.
- run_inspector(request) — Request deep analysis from the Inspector. Returns an InspectionReport.

### Plan MCP service
All plan operations go through the plan MCP service. Do not read/write plan.json or plan-history.json directly.
- plan_get() — Read the current plan.
- plan_get_stage(stage_id) — Look up a stage (active or history).
- plan_get_current_stage() — Get the stage currently being executed.
- plan_set_stages(stages, current_stage_id) — Replace the plan's stage list.
- plan_add_stage(stage) — Append a new stage to the plan.
- plan_remove_stage(stage_id) — Remove a stage from the active plan.
- plan_set_current(stage_id) — Mark a stage as currently executing.
- plan_complete_stage(stage_id, result, summary, actual_outcomes, escalation?, abort_reason?) — Atomically move a stage from active plan to history.
- plan_get_history(last_n?) — Read plan history.
- plan_init(stages?) — Initialize an empty plan (first run only).
- plan_commit(message) — Commit plan files to git.

### Other tools
- MCP git tools (git_commit, git_status, git_diff, git_log) — for committing .saivage/ state files.
- Filesystem tools — for reading project files, notes, and other project state.

## Execution Model

1. Read project objectives from .saivage/config.json and current project state.
2. Call plan_init(stages) to create the initial plan with ordered stages.
3. Call plan_set_current(stage_id) to mark the first stage, then call run_manager(stage) to dispatch it.
4. When the Manager returns, always archive the stage first via plan_complete_stage(), then decide next steps:
   - Completed: archive, update remaining stages if needed, pick next stage.
   - Failed: archive, assess partial summary, consider Inspector for analysis, retry/restructure/skip.
   - Escalated: archive with escalation, read the Escalation object, revise/split/remove stage, use Inspector if needed.
   - Aborted: archive with abort_reason, create rollback stage first, then replan per user's request.
5. Process any user notes injected into your context.
6. Repeat from step 3.

## Planning Guidelines

- Each stage must be self-contained with objective, starting_points, expected_outcomes, acceptance_criteria, references, and tags.
- Keep stages focused. Prefer more smaller stages over fewer large ones.
- Include concrete, verifiable acceptance_criteria.
- After each stage, re-evaluate the remaining plan.
- When escalated, understand why before retrying. Call Inspector if needed.
- Schedule corrective stages only when they unblock progress.

## User Notes

Notes from the user arrive via the Chat agent. The runtime injects pending notes.
- Permanent notes: lasting direction changes, persist across compaction.
- Volatile notes: situational, auto-deleted after processing.

Return "PLAN_COMPLETE" as your final response when all objectives are achieved.`;

/**
 * The Planner is long-lived. It runs until all stages are complete,
 * the project is done, or it is aborted.
 */
export class PlannerAgent extends BaseAgent implements Agent {
  private noteManager: NoteManager;

  constructor(
    ctx: AgentContext,
    childSpawner: ChildSpawner,
    config?: Partial<BaseAgentConfig>,
  ) {
    const initialMessage = buildPlannerMessage(ctx);

    super(ctx, {
      systemPrompt: PLANNER_PROMPT,
      skillContext: {
        agentRole: "planner",
        description: "Strategic planning and stage dispatch",
      },
      childSpawner,
      initialMessage,
      ...config,
    });

    this.noteManager = new NoteManager(ctx.project.paths.notes);
  }

  async run(): Promise<AgentResult> {
    log.info(`[planner:${this.id}] Starting planning session`);

    try {
      // Inject any pending notes before each loop iteration
      await this.injectPendingNotes();

      const { text, finishReason } = await this.runLoop();

      if (finishReason === "abort" || finishReason === "cancelled") {
        return { kind: "abort", reason: text };
      }

      if (finishReason === "max_compactions" || finishReason === "error") {
        return { kind: "failure", reason: text };
      }

      // Planner returning normally means plan is complete
      return { kind: "success", data: { summary: text } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[planner:${this.id}] Failed: ${msg}`);
      return { kind: "failure", reason: msg };
    }
  }

  /**
   * Inject unacknowledged notes into the conversation context.
   * Called before the Planner resumes after a Manager/Inspector dispatch.
   */
  private async injectPendingNotes(): Promise<void> {
    const notes = await this.noteManager.getUnacknowledgedNotes();
    const permanent = await this.noteManager.getPermanentNotes();

    const allNotes = [...notes, ...permanent.filter(
      (p) => !notes.some((n) => n.id === p.id),
    )];

    if (allNotes.length === 0) return;

    const formatted = this.noteManager.formatNotesForInjection(allNotes);
    this.injectMessage(formatted);

    // Acknowledge the notes (uses internal pending list from getUnacknowledgedNotes)
    this.noteManager.acknowledgeNotes();

    log.info(
      `[planner:${this.id}] Injected ${allNotes.length} note(s) into context`,
    );
  }
}

function buildPlannerMessage(ctx: AgentContext): string {
  const config = ctx.project.config;
  const objectives = config.objectives ?? [];

  const objList = objectives.length > 0
    ? objectives.map((o: string) => `- ${o}`).join("\n")
    : "(No objectives specified in config — read the project and determine objectives)";

  return (
    `## Project Planning Session\n\n` +
    `**Project Root:** ${ctx.project.projectRoot}\n` +
    `**Saivage Dir:** ${ctx.project.saivageDir}\n\n` +
    `### Project Objectives\n${objList}\n\n` +
    `### Instructions\n` +
    `1. Read the project configuration and assess current state.\n` +
    `2. Create a multi-stage plan using plan_init(stages).\n` +
    `3. Execute stages one at a time via run_manager(stage).\n` +
    `4. Process results, adapt the plan, and continue until all objectives are met.\n` +
    `5. When all objectives are achieved, respond with "PLAN_COMPLETE".`
  );
}
