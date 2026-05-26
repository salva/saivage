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
import type { ToolCallResult } from "../providers/types.js";
import type { ChildSpawner, DispatchResult } from "../runtime/dispatcher.js";
import { NoteChannel, type NoteManager } from "../runtime/notes.js";
import { log } from "../log.js";
import { loadContract } from "../repo-layout/contract.js";
import { buildHandoffContext } from "./handoff.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";

const MAX_NUDGES = 15;


/**
 * The Planner is long-lived. It runs until all stages are complete,
 * the project is done, or it is aborted.
 */
export class PlannerAgent extends BaseAgent implements Agent {
  private noteManager: NoteManager;

  static async create(
    ctx: AgentContext,
    childSpawner: ChildSpawner,
    config?: Partial<BaseAgentConfig>,
  ): Promise<PlannerAgent> {
    const initialMessage = await buildPlannerMessage(ctx);
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      "planner",
      "Strategic planning and stage dispatch",
    );
    return new PlannerAgent(ctx, childSpawner, initialMessage, eagerSkillBlock, config);
  }

  constructor(
    ctx: AgentContext,
    childSpawner: ChildSpawner,
    initialMessage: string,
    eagerSkillBlock: string,
    config?: Partial<BaseAgentConfig>,
  ) {
    const noteManager = ctx.noteManager;

    super(ctx, {
      systemPrompt: loadRolePrompt("planner"),
      eagerSkillBlock,
      skillContext: {
        agentRole: "planner",
        description: "Strategic planning and stage dispatch",
      },
      childSpawner,
      initialMessage,
      inputChannels: [new NoteChannel(noteManager)],
      ...config,
    });

    this.noteManager = noteManager;
  }

  async run(): Promise<AgentResult> {
    log.info(`[planner:${this.id}] Starting planning session`);

    let nudgeCount = 0;

    while (true) {
      try {
        const loopResult = await this.runLoop();
        const { text, finishReason } = loopResult;

        // Always acknowledge notes on any exit path so they don't
        // get re-injected indefinitely after restarts.
        await this.noteManager.acknowledgeNotes();

        if (finishReason === "abort" || finishReason === "cancelled") {
          return { kind: "abort", reason: text };
        }

        if (finishReason === "max_compactions" || finishReason === "error") {
          return { kind: "failure", reason: text };
        }

        if (finishReason === "tool_terminal" && loopResult.terminal?.name === "plan_done") {
          const reason = (loopResult.terminal.data as { reason: string }).reason;
          return { kind: "success", data: { completion: "plan_done", summary: reason } };
        }

        // Planner ended a turn without structured completion — nudge to continue.
        nudgeCount++;
        if (nudgeCount >= MAX_NUDGES) {
          log.warn(`[planner:${this.id}] Max nudges reached (${MAX_NUDGES}), exiting for recovery`);
          return { kind: "failure", reason: `Planner stalled after ${MAX_NUDGES} nudges without progress` };
        }

        log.info(
          `[planner:${this.id}] Ended turn without plan_done — nudging (${nudgeCount}/${MAX_NUDGES})`,
        );

        // Nudge planner to continue. The terminal assistant message is already
        // pushed by BaseAgent.runLoop(); pushing again caused duplicate assistant
        // entries (F14).
        this.injectMessage(
          `SYSTEM: You ended your turn with text only and NO tool calls. This is NOT allowed. ` +
          `You MUST call a tool on every turn. The project objectives are NOT yet complete. ` +
          `Here is what you MUST do RIGHT NOW:\n\n` +
          `1. Call plan_get() to see the current plan state.\n` +
          `2. If there are stages in the queue, call plan_set_current() on the next one, then call run_manager() to dispatch it.\n` +
          `3. If stages have failed/escalated, create a new corrective stage with plan_add_stage(), then dispatch it.\n` +
          `4. If you need to understand a failure, call run_inspector().\n\n` +
          `5. If all configured objectives are verified complete and no continuous-improvement instruction is active, call plan_done(reason).\n\n` +
          `DO NOT respond with text only. CALL A TOOL NOW.`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[planner:${this.id}] Failed: ${msg}`);
        return { kind: "failure", reason: msg };
      }
    }
  }

  protected override detectTerminalToolCall(
    toolCalls: ToolCallResult[],
    dispatchResult: DispatchResult,
  ): { name: string; data: { reason: string } } | null {
    if (toolCalls.length !== 1) return null;
    const tc = toolCalls[0];
    if (tc.name !== "plan_done") return null;

    const result = dispatchResult.toolResults.find((tr) => tr.toolUseId === tc.id);
    if (!result || result.isError) return null;

    const input = tc.input;
    if (typeof input !== "object" || input === null) return null;
    const reason = (input as { reason?: unknown }).reason;
    if (typeof reason !== "string" || reason.trim() === "") return null;

    return { name: "plan_done", data: { reason } };
  }
}

function buildPlannerMessage(ctx: AgentContext): Promise<string> {
  return buildPlannerMessageImpl(ctx);
}

async function buildPlannerMessageImpl(ctx: AgentContext): Promise<string> {
  const config = ctx.project.config;
  const objectives = config.objectives ?? [];
  const startupDirectives = ctx.startupDirectives ?? [];

  const objList = objectives.length > 0
    ? objectives.map((o: string) => `- ${o}`).join("\n")
    : "(No objectives specified in config — read the project and determine objectives)";

  const runtimeDirectiveBlock = startupDirectives.length > 0
    ? `### Runtime Directives\n${startupDirectives.map((directive) => `- ${directive}`).join("\n")}\n\n`
    : "";

  const repoLayoutBlock = buildRepoLayoutBlock(ctx);
  const handoffBlock = await buildHandoffContext(ctx);

  return (
    `## Project Planning Session\n\n` +
    `${handoffBlock}\n\n` +
    `${runtimeDirectiveBlock}` +
    `**Project Root:** ${ctx.project.projectRoot}\n` +
    `**Saivage Dir:** ${ctx.project.saivageDir}\n\n` +
    `### Project Objectives\n${objList}\n\n` +
    `${repoLayoutBlock}` +
    `### Instructions\n` +
    `1. Read the project configuration and assess current state.\n` +
    `2. Call plan_get() before changing the plan. If plan_get() returns PLAN_NOT_FOUND, create the first multi-stage plan with plan_init(stages). If plan_get() returns an existing plan, DO NOT call plan_init(); continue it, or use plan_add_stage() / plan_set_stages() to add or replace remaining stages.\n` +
    `3. Execute stages one at a time via run_manager(stage).\n` +
    `4. Process results, adapt the plan, and continue until all objectives are met.\n` +
    `5. If all objectives are achieved but a continuous-improvement note is present, create and dispatch the next improvement/verification/hardening stage with plan_add_stage() or plan_set_stages(), not plan_init().\n` +
    `6. Call plan_done(reason) only when objectives are verified and no continuous-improvement instruction is active.`
  );
}

/**
 * Render the project's repo-layout contract (if any) into a generic block of
 * planner-facing instructions. The block is data-driven: topic names,
 * artifact directories, and stage-id patterns come from the contract, so this
 * function stays project-agnostic.
 */
function buildRepoLayoutBlock(ctx: AgentContext): string {
  const result = loadContract(ctx.project.projectRoot);
  if (!result.present || result.error || !result.contract) {
    return "";
  }
  const c = result.contract;
  const openTopics = c.topics.filter((t) => t.newStagesAllowed);
  const closedTopics = c.topics.filter((t) => !t.newStagesAllowed);

  const openList = openTopics
    .map((t) => `- \`${t.name}\` — artifacts under \`${t.artifactDir}\`; stage id must match \`${t.stageIdRe.source}\``)
    .join("\n");
  const closedList = closedTopics.length > 0
    ? `\nClosed topics (no new stages may be queued): ${closedTopics.map((t) => `\`${t.name}\``).join(", ")}.`
    : "";
  const whitelist = [...c.trackedDotSaivageWhitelist].sort().map((p) => `\`${p}\``).join(", ");

  return (
    `### Repo-Layout Contract\n` +
    `The target project declares a repo-layout contract at \`.saivage/repo-layout.json\`. Every new stage id MUST resolve to exactly one open topic below; do NOT create stages that match no topic or multiple topics. Every artifact written by a stage MUST land under that topic's \`artifact_dir\`. Files outside the contract's \`allowed_top_level_dirs\` or matching \`forbidden_paths\` must not be created or moved. Inside \`.saivage/\` only this whitelist may be tracked: ${whitelist || "(none)"}.\n\n` +
    `Open topics:\n${openList}${closedList}\n\n` +
    `You may verify a candidate stage id by invoking \`validate-stage-id\` (it returns the resolved topic or a reason like \`no_topic_match\`, \`multiple_topic_match\`, or \`topic_closed\`).\n\n`
  );
}
