/**
 * Saivage — Chat Agent
 * User-facing conversational agent. Reads project state, creates notes
 * for the Planner, dispatches the Inspector, pushes notifications.
 */

import { BaseAgent, type BaseAgentConfig } from "./base.js";
import type { LlmResponseSource } from "./base.js";
import type {
  AgentContext,
  AgentResult,
  ChatInput,
  Agent,
} from "./types.js";
import type { ActivePlanView, PlanDocument, PlanHistoryView, SystemEvent, ChatMessage, ChatLog } from "../types.js";
import type { ChatChannel } from "../channels/types.js";
import type { EventBus, EventFilter } from "../events/bus.js";
import { chatSessionId } from "../ids.js";
import { writeDoc, readDocOrNull, readDocLenient, ensureDir } from "../store/documents.js";
import { createUserNote } from "../runtime/notes.js";
import { parseSlashCommand, runSlashCommand } from "../chat/slashCommands.js";
import {
  ChatLogSchema,
  PlanDocumentSchema,
  RuntimeStateSchema,
} from "../types.js";
import { join } from "node:path";
import { log } from "../log.js";
import type { PlannerControl } from "../server/bootstrap.js";
import { archiveSession } from "../knowledge/lifecycle.js";
import { loadRolePrompt } from "./prompts.js";
import { buildEagerBlock } from "../knowledge/eagerLoader.js";
import {
  dispatchLocalCommand,
  restartPlanner,
  type LocalCommandContext,
} from "../chat/localCommands.js";

function activePlanView(doc: PlanDocument | null): ActivePlanView | null {
  if (!doc) return null;
  return {
    updated_at: doc.updated_at,
    current_stage_id: doc.current_stage_id,
    stages: doc.stages,
  };
}

function historyView(doc: PlanDocument | null): PlanHistoryView | null {
  return doc ? { stages: doc.history } : null;
}


/**
 * Chat agent instance — runs per channel (web UI, Telegram).
 * Integrates with the EventBus for push notifications and the channel
 * transport for user message I/O.
 */
export class ChatAgent extends BaseAgent implements Agent {
  private static readonly MAX_PENDING_MESSAGES = 5;
  private input: ChatInput;
  private channel: ChatChannel;
  private eventBus: EventBus;
  private plannerControl?: PlannerControl;
  private unsubscribe?: () => void;
  private chatLog: ChatLog;
  private chatDir: string;
  private messageQueue: Promise<void> = Promise.resolve();
  private pendingMessages = 0;

  static async create(
    ctx: AgentContext,
    input: ChatInput,
    channel: ChatChannel,
    eventBus: EventBus,
    eventFilter?: EventFilter,
    plannerControl?: PlannerControl,
    config?: Partial<BaseAgentConfig>,
  ): Promise<ChatAgent> {
    const eagerSkillBlock = await buildEagerBlock(
      ctx.project.projectRoot,
      "chat",
      "User-facing chat interface",
    );
    return new ChatAgent(ctx, input, channel, eventBus, eventFilter, plannerControl, {
      ...config,
      eagerSkillBlock,
    });
  }

  constructor(
    ctx: AgentContext,
    input: ChatInput,
    channel: ChatChannel,
    eventBus: EventBus,
    eventFilter?: EventFilter,
    plannerControl?: PlannerControl,
    config?: Partial<BaseAgentConfig>,
  ) {
    super(ctx, {
      systemPrompt: loadRolePrompt("chat"),
      eagerSkillBlock: config?.eagerSkillBlock ?? "",
      skillContext: {
        agentRole: "chat",
        description: "User-facing chat interface",
      },
      initialMessage: `Chat session started on channel "${input.channel}". Session ID: ${input.sessionId}. Waiting for user messages.`,
      ...config,
    });

    this.input = input;
    this.channel = channel;
    this.eventBus = eventBus;
    this.plannerControl = plannerControl;

    // Chat log directory
    this.chatDir = join(ctx.project.saivageDir, "tmp", "chats", input.channel);

    // Initialize chat log
    this.chatLog = {
      session_id: input.sessionId,
      channel: input.channel,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: [],
    };
    void this.loadExistingChatLog().catch((err) => {
      log.warn(`[chat:${this.id}] Failed to load existing chat log: ${err instanceof Error ? err.message : String(err)}`);
    });

    // Subscribe to event bus for notifications
    this.unsubscribe = eventBus.subscribe(
      `chat-${input.channel}-${input.sessionId}`,
      (event) => this.handleEvent(event),
      eventFilter,
    );
  }

  async run(): Promise<AgentResult> {
    log.info(
      `[chat:${this.id}] Starting on channel ${this.input.channel}`,
    );

    try {
      await ensureDir(this.chatDir);

      // Set up message handling
      return new Promise<AgentResult>((resolve) => {
        // Handle incoming user messages
        this.channel.onMessage((message) => {
          if (this.pendingMessages >= ChatAgent.MAX_PENDING_MESSAGES) {
            return this.rejectQueuedMessage();
          }
          this.pendingMessages += 1;
          this.messageQueue = this.messageQueue
            .catch((err) => {
              log.error(`[chat:${this.id}] Previous message handling failed: ${err}`);
            })
            .then(() => this.handleUserMessage(message))
            .catch((err) => {
              log.error(`[chat:${this.id}] Message handling error: ${err}`);
            })
            .finally(() => {
              this.pendingMessages = Math.max(0, this.pendingMessages - 1);
            });
          return this.messageQueue;
        });

        // Handle channel close
        this.channel.onClose(() => {
          log.info(`[chat:${this.id}] Channel closed`);
          // FR-9 / WI-11: archive session-scoped knowledge at channel close.
          void archiveSession(this.ctx.project.projectRoot, this.input.channel).catch((err) => {
            log.warn(`[chat:${this.id}] archiveSession failed: ${String(err)}`);
          });
          this.cleanup();
          resolve({ kind: "success", data: { sessionId: this.input.sessionId } });
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`[chat:${this.id}] Failed: ${msg}`);
      this.cleanup();
      return { kind: "failure", reason: msg };
    }
  }

  private async rejectQueuedMessage(): Promise<void> {
    const response = "I already have several chat messages queued for this session. Please wait for the current replies before sending more.";
    log.warn(`[chat:${this.id}] Rejecting chat message because queue is full`);
    await this.channel.send(response);
    this.recordMessage("assistant", response);
    await this.saveChatLog();
  }

  /** Handle an incoming user message — run through LLM and respond. */
  private async handleUserMessage(content: string): Promise<void> {
    // Record user message
    this.recordMessage("user", content);

    // Check for slash commands first
    const commandResult = await this.tryHandleCommand(content.trim());
    if (commandResult !== null) {
      await this.channel.send(commandResult);
      this.recordMessage("assistant", commandResult);
      await this.saveChatLog();
      return;
    }

    const restartResult = await this.tryHandleExplicitPlannerRestart(content.trim());
    if (restartResult !== null) {
      await this.channel.send(restartResult);
      this.recordMessage("assistant", restartResult);
      await this.saveChatLog();
      return;
    }

    // Inject into conversation
    this.injectMessage(content);

    // Signal thinking to the client
    const ch = this.channel as ChatChannel & { sendEvent?: (e: Record<string, unknown>) => void };
    ch.sendEvent?.({ type: "thinking" });

    // Run one LLM turn
    const { text, source } = await this.runLoop();

    // Send response to user
    await this.sendAssistantResponse(text, source);

    // Record assistant response
    this.recordMessage("assistant", text, undefined, source);

    // Persist chat log
    await this.saveChatLog();
  }

  /**
   * Try to handle a slash command. Returns the response string if handled,
   * or null to fall through to the LLM.
   */
  private async tryHandleCommand(content: string): Promise<string | null> {
    if (!content.startsWith("/")) return null;

    // M2/WI-09 — knowledge slash commands (`/skills`, `/memories`,
    // `/remember`, `/forget`). Reads go through MCP; writes hand off to
    // the Planner via inter-agent message (never call write tools).
    const parsed = parseSlashCommand(content);
    if (parsed) {
      try {
        return await runSlashCommand(parsed, {
          callTool: (service, tool, args) => this.ctx.mcpRuntime.callTool(service, tool, args, {
            role: this.ctx.role,
            agentId: this.ctx.agentId,
            projectRoot: this.ctx.project.projectRoot,
            ...(this.input.channel ? { channelId: this.input.channel } : {}),
            ...(this.input.sessionId ? { sessionId: this.input.sessionId } : {}),
          }),
          notifyPlanner: async (text, opts) => {
            const note = await createUserNote({
              notesDir: this.ctx.project.paths.notes,
              channel: this.input.channel,
              sessionId: this.input.sessionId,
              content: text,
              permanent: opts.permanent ?? true,
              urgent: opts.urgent ?? false,
            });
            return note.id;
          },
        });
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }

    return dispatchLocalCommand(content, this.localCommandContext());
  }

  private localCommandContext(): LocalCommandContext {
    return {
      notesDir: this.ctx.project.paths.notes,
      channel: this.input.channel,
      sessionId: this.input.sessionId,
      eventBus: this.eventBus,
      plannerControl: this.plannerControl,
      renderStatus: () => this.cmdStatus(),
      renderPlan: () => this.cmdPlan(),
      renderHistory: (n: number) => this.cmdHistory(String(n)),
    };
  }

  private async cmdStatus(): Promise<string> {
    const paths = this.ctx.project.paths;
    const runtime = await readDocOrNull(paths.runtimeState, RuntimeStateSchema);
    const doc = await readDocLenient(paths.plan, PlanDocumentSchema);
    const plan = activePlanView(doc);

    const lines: string[] = ["**System Status**", ""];

    if (runtime) {
      lines.push(`**Runtime:** ${runtime.status} (PID: ${runtime.pid})`);
      lines.push(`**Started:** ${runtime.started_at}`);
      if (runtime.active_agents.length > 0) {
        lines.push("", "**Active Agents:**");
        for (const a of runtime.active_agents) {
          const task = a.current_task_id ? ` (task: ${a.current_task_id})` : "";
          lines.push(`- ${a.agent_type} \`${a.agent_id}\` — ${a.status}${task}`);
        }
      } else {
        lines.push("**Active Agents:** none");
      }
    } else {
      lines.push("**Runtime:** not running");
    }

    if (plan) {
      lines.push("");
      lines.push(`**Current Stage:** ${plan.current_stage_id ?? "none"}`);
      lines.push(`**Pending Stages:** ${plan.stages.length}`);
    }

    return lines.join("\n");
  }

  private async cmdPlan(): Promise<string> {
    const plan = activePlanView(await readDocLenient(this.ctx.project.paths.plan, PlanDocumentSchema));
    if (!plan) return "No plan exists yet.";

    const lines: string[] = [
      "**Current Plan**",
      "",
      `Current stage: \`${plan.current_stage_id ?? "none"}\``,
      "",
    ];

    if (plan.stages.length === 0) {
      lines.push("_(no stages in queue)_");
    } else {
      for (const s of plan.stages) {
        const marker = s.id === plan.current_stage_id ? " ← **current**" : "";
        lines.push(`- \`${s.id}\`: ${s.objective}${marker}`);
      }
    }

    return lines.join("\n");
  }

  private async cmdHistory(args: string): Promise<string> {
    const n = parseInt(args, 10) || 5;
    const history = historyView(await readDocLenient(this.ctx.project.paths.plan, PlanDocumentSchema));
    if (!history || history.stages.length === 0) return "No completed stages yet.";

    const recent = history.stages.slice(-n);
    const lines: string[] = [`**Last ${recent.length} Completed Stages**`, ""];

    for (const s of recent) {
      const icon = s.result === "completed" ? "✅" : s.result === "failed" ? "❌" : "⚠️";
      lines.push(`${icon} \`${s.id}\`: ${s.objective}`);
      lines.push(`   Result: ${s.result} — ${s.summary.slice(0, 120)}`);
    }

    return lines.join("\n");
  }

  private async tryHandleExplicitPlannerRestart(content: string): Promise<string | null> {
    if (!/\b(restart|reset|relaunch)\b/i.test(content)) return null;
    if (!/\bplanner\b/i.test(content)) return null;
    return restartPlanner(this.localCommandContext(), content);
  }

  /** Handle a system event — format and push as notification. */
  private async handleEvent(event: SystemEvent): Promise<void> {
    const notification = formatEventNotification(event);

    // Send to channel
    try {
      await this.channel.send(notification);
      this.recordMessage("system", notification, event);
      await this.saveChatLog();
    } catch (err) {
      log.error(`[chat:${this.id}] Notification delivery failed: ${err}`);
    }
  }

  private recordMessage(
    role: "user" | "assistant" | "system",
    content: string,
    event?: SystemEvent,
    source?: LlmResponseSource,
  ): void {
    this.chatLog.messages.push({
      id: chatSessionId(), // reusing for unique msg ID
      role,
      content,
      timestamp: new Date().toISOString(),
      ...source,
      event,
    });
    this.chatLog.updated_at = new Date().toISOString();
  }

  private async sendAssistantResponse(content: string, source?: LlmResponseSource): Promise<void> {
    const eventChannel = this.channel as ChatChannel & { sendEvent?: (e: Record<string, unknown>) => void };
    if (this.input.channel !== "telegram" && eventChannel.sendEvent) {
      eventChannel.sendEvent({ type: "message", content, ...source });
      return;
    }
    await this.channel.send(content);
  }

  private async saveChatLog(): Promise<void> {
    const logPath = join(this.chatDir, `${this.input.sessionId}.json`);
    await writeDoc(logPath, this.chatLog, ChatLogSchema);
  }

  private async loadExistingChatLog(): Promise<void> {
    const logPath = join(this.chatDir, `${this.input.sessionId}.json`);
    const existing = await readDocOrNull(logPath, ChatLogSchema);
    if (!existing) return;

    this.chatLog = existing;
    for (const message of existing.messages) {
      this.pushMessage(
        { role: message.role, content: message.content },
        message.timestamp,
        message.role === "assistant" ? sourceFromChatMessage(message) : undefined,
      );
    }
    log.info(`[chat:${this.id}] Loaded ${existing.messages.length} previous messages for ${this.input.channel}:${this.input.sessionId}`);
  }

  private cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  override cancel(): void {
    super.cancel();
    void this.channel.close();
  }
}

function sourceFromChatMessage(message: ChatMessage): LlmResponseSource | undefined {
  if (!message.modelSpec && !message.provider && !message.model) return undefined;
  return {
    provider: message.provider,
    model: message.model,
    modelSpec: message.modelSpec,
    requestedModelSpec: message.requestedModelSpec,
  };
}

function formatEventNotification(event: SystemEvent): string {
  switch (event.type) {
    case "stage_completed":
      return `✅ Stage ${event.stage_id} completed: ${event.summary}`;
    case "stage_failed":
      return `❌ Stage ${event.stage_id} failed: ${event.summary}`;
    case "escalation":
      return `⚠️ Stage ${event.stage_id} escalated: ${event.summary}`;
    case "task_failed":
      return `⚠️ Task ${event.task_id} (stage ${event.stage_id}) failed: ${event.summary}`;
    case "inspector_complete":
      return `🔍 Inspector report ${event.report_id} ready: ${event.summary}`;
    case "plan_updated":
      return `📋 Plan updated: ${event.summary}`;
    default:
      return `[${event.type}] ${event.summary}`;
  }
}
