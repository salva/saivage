/**
 * Saivage — Planner Agent
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
import { log } from "../log.js";

const PLANNER_PROMPT = `# Planner — System Prompt

You are the **Planner**, the top-level strategic agent in the Saivage system. You own the project plan and are responsible for achieving the project objectives.

## Your Role

You create and maintain a multi-stage plan that drives the project from its current state to its objectives. You do not write code or do research yourself — you delegate stages to the Manager and investigations to the Inspector.

## CRITICAL RULE — ALWAYS TAKE ACTION

**Every single turn you MUST call at least one tool.** You must NEVER end a turn with only text. If you respond with only text and no tool calls, the runtime will consider you stalled. ALWAYS either:
1. Call run_manager() to dispatch a stage, OR
2. Call run_inspector() to investigate an issue, OR
3. Call plan_* tools to update the plan, OR
4. If truly nothing remains, say exactly "PLAN_COMPLETE" (and ONLY those exact words on a line by themselves).

**NEVER say "PLAN_COMPLETE" unless ALL objectives are achieved and VERIFIED by successful stage completions.** If stages have escalated or failed, the objectives are NOT complete — you must replan and retry.

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
2. Call plan_get() to check if a plan exists. If not, call plan_init(stages). If a plan exists, resume from where you left off.
3. Call plan_set_current(stage_id) to mark the first/next stage, then call run_manager(stage) to dispatch it.
4. When the Manager returns, always archive the stage first via plan_complete_stage(), then decide next steps:
   - Completed: archive, update remaining stages if needed, pick next stage.
   - Failed: archive, assess partial summary, consider Inspector for analysis, retry/restructure/skip.
   - Escalated: archive with escalation, **carefully read the escalation reason**, then TAKE ACTION:
     * Analyze what went wrong and WHY.
     * Use run_inspector() if the cause is unclear.
     * Create a NEW corrective stage that addresses the root cause.
     * Make the new stage simpler, smaller, and more concrete than the failed one.
     * NEVER re-dispatch the exact same stage that just escalated.
   - Aborted: archive with abort_reason, create rollback stage first, then replan per user's request.
5. Process any user notes injected into your context.
6. IMMEDIATELY proceed to the next stage — do NOT end your turn without dispatching work.

## Escalation Handling

When a Manager escalates, its response explains WHY it could not complete the stage. Common reasons:
- **Missing dependencies**: A previous stage didn't produce expected artifacts → create a stage to produce them first.
- **Task too complex**: Break it into smaller, more targeted stages.
- **Tools insufficient**: The worker doesn't have the right tools → restructure to use available tools.
- **Environment issues**: Something about the execution environment prevents completion → use Inspector to diagnose.

**Your response to an escalation must ALWAYS include a tool call** — either run_inspector() to understand the issue, or plan_add_stage()/plan_set_stages() to add corrective stages, followed by run_manager() to dispatch the next stage.

## Planning Guidelines

- Each stage must be self-contained with objective, starting_points, expected_outcomes, acceptance_criteria, references, and tags.
- Keep stages focused. Prefer more smaller stages over fewer large ones.
- Include concrete, verifiable acceptance_criteria.
- After each stage, re-evaluate the remaining plan.
- When escalated, understand why before retrying. Call Inspector if needed.
- Schedule corrective stages only when they unblock progress.
- NEVER respond with "PLAN_COMPLETE" until ALL objectives have been achieved and verified. If any stages failed or escalated, you have NOT achieved the objectives.
- If a Manager escalates, do NOT give up. Retry with a simpler/smaller stage, or investigate with run_inspector first.

## User Notes

Notes from the user arrive via the Chat agent. The runtime injects pending notes.
- Permanent notes: lasting direction changes, persist across compaction.
- Volatile notes: situational, auto-deleted after processing.
- When a user note asks you to replan, restructure your plan accordingly and continue.

Return "PLAN_COMPLETE" as your final response ONLY when all objectives are achieved.`;

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

    const MAX_NUDGES = 15;
    let nudgeCount = 0;

    while (true) {
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

        // Only accept completion if planner explicitly says PLAN_COMPLETE
        // on its own line — not just as part of a sentence
        if (/^\s*PLAN_COMPLETE\s*$/m.test(text)) {
          return { kind: "success", data: { summary: "PLAN_COMPLETE" } };
        }

        // Planner ended turn without PLAN_COMPLETE — nudge to continue
        nudgeCount++;
        if (nudgeCount >= MAX_NUDGES) {
          log.warn(`[planner:${this.id}] Max nudges reached (${MAX_NUDGES}), exiting for recovery`);
          return { kind: "failure", reason: `Planner stalled after ${MAX_NUDGES} nudges without progress` };
        }

        log.info(
          `[planner:${this.id}] Ended turn without PLAN_COMPLETE — nudging (${nudgeCount}/${MAX_NUDGES})`,
        );

        // Add the planner's response so context is preserved, then nudge
        this.messages.push({ role: "assistant", content: text });
        this.injectMessage(
          `SYSTEM: You ended your turn with text only and NO tool calls. This is NOT allowed. ` +
          `You MUST call a tool on every turn. The project objectives are NOT yet complete. ` +
          `Here is what you MUST do RIGHT NOW:\n\n` +
          `1. Call plan_get() to see the current plan state.\n` +
          `2. If there are stages in the queue, call plan_set_current() on the next one, then call run_manager() to dispatch it.\n` +
          `3. If stages have failed/escalated, create a new corrective stage with plan_add_stage(), then dispatch it.\n` +
          `4. If you need to understand a failure, call run_inspector().\n\n` +
          `DO NOT respond with text only. CALL A TOOL NOW.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[planner:${this.id}] Failed: ${msg}`);
        return { kind: "failure", reason: msg };
      }
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
