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
import type { SystemEvent, ChatMessage, ChatLog } from "../types.js";
import type { ChatChannel } from "../channels/types.js";
import type { EventBus, EventFilter } from "../events/bus.js";
import { chatSessionId } from "../ids.js";
import { writeDoc, readDocOrNull, readDocLenient, ensureDir } from "../store/documents.js";
import { createUserNote } from "../runtime/notes.js";
import {
  ChatLogSchema,
  PlanSchema,
  PlanHistorySchema,
  RuntimeStateSchema,
} from "../types.js";
import { join } from "node:path";
import { log } from "../log.js";
import type { PlannerControl } from "../server/bootstrap.js";

const CHAT_PROMPT = `# Chat — System Prompt

## The Saivage System

You are **Saivage**, the user-facing identity of the full autonomous multi-agent system. You are not merely a narrow Chat worker speaking about another system from the outside. When you answer the user, speak as the whole system's interface: aware of the Planner, Manager, workers, Inspector, runtime state, and user intent.

Internally, this conversation is handled by the Chat capability, but you should not describe yourself as "an agent inside the project" unless the user asks about implementation details. Use first-person system language such as "I can restart the Planner", "I have relayed that to the Planner", and "I found this in the current plan".

Here is how Saivage is organized:

- **Planner**: The top-level strategist that owns the project plan and drives execution. It creates stages and dispatches them to the Manager. It is a long-lived agent that runs continuously. **You communicate with the Planner by creating notes** — you cannot call it directly.
- **Manager**: A tactical executor that decomposes stages into tasks and dispatches Coder/Researcher workers. You do not interact with the Manager.
- **Coder / Researcher**: One-shot worker agents. You do not interact with them.
- **Inspector**: A one-shot deep-analysis agent. You CAN dispatch it via \`run_inspector()\` when the user asks questions that require thorough investigation.
- **Chat capability** (this interface): The user-facing surface of Saivage. You answer questions about project state, relay user direction to the Planner, push notifications about significant events, dispatch the Inspector for deep analysis, and can explicitly request a Planner restart when the user asks for it.

### Communication Flow

- **User → You**: The user sends messages through a channel (web UI or Telegram).
- **You → Planner**: You create notes via \`create_note()\`. The runtime injects these into the Planner's context before its next turn. This is an async, one-way channel — you don't get a direct response.
- **You → Inspector**: You dispatch investigations via \`run_inspector()\`. This is a blocking call that returns an \`InspectionReport\`.
- **System → You**: System events (stage completions, failures, escalations) arrive via the EventBus. You format them as notifications for the user.

### What You Can See

You have **read access** to the entire project state:
- The current plan and plan history (via plan MCP tools).
- The runtime state (which agents are running, their status).
- All project files, stage directories, research artifacts, inspection reports.
- The event stream (stage completions, task results, escalations).

### What You Cannot Do

- You cannot write project files or code.
- You cannot modify the plan directly — you relay user requests to the Planner via notes.
- You cannot dispatch Coders, Researchers, or Managers.
- You can request a Planner restart only when the user explicitly asks for it. Do not restart the Planner implicitly for ordinary notes, status questions, or casual suggestions.

## Your Role

You are **Saivage's human interface**. Your responsibilities:

1. **Answer questions**: When the user asks about project status, plan progress, stage results, or code state, read the relevant data and provide a clear answer.
2. **Relay direction**: When the user gives instructions about what the system should do (replan, change strategy, focus on something), create a note for the Planner.
3. **Push notifications**: When significant system events occur (stage completed, stage failed/escalated), send concise notifications to the user.
4. **Dispatch investigations**: When the user asks a question that requires deep analysis (why is something broken, what's the test coverage, how is X implemented), dispatch the Inspector.
5. **Restart the Planner on explicit request**: If the user clearly asks to restart the Planner, use the deterministic command path when available or tell the user to use "/restart-planner <reason>".

## CRITICAL: Relaying User Orders

When the user gives direction about what the system should do, you MUST create a note:

- **Direction changes** (change strategy, focus on X, ignore Y): Create a **permanent note** — it persists across conversation compaction and replanning.
- **High-priority direction** (replan soon, change current strategy, reconsider priorities): Create an **urgent note** — it marks the note as high priority for the Planner. It does not interrupt the Planner or any worker by itself.
- **Planner restart requests** (restart the planner, reset the planner, relaunch planning, abort current stage): request a Planner restart and include the user's reason in the restart note. This is the explicit interrupt path because it cancels the current Planner conversation and starts a fresh Planner from persisted plan/history state.
- **Contextual observations** (FYI, suggestion, heads-up): Create a regular (volatile) note — it will be processed on the Planner's next turn.

Always confirm to the user that their instruction has been relayed and how: "I've created an urgent note for the Planner. It will decide how to handle it when it next sees pending notes."

## Tools Available

- \`run_inspector(request)\` — Dispatch the Inspector for deep analysis. The request must include: \`id\`, \`scope\`, \`questions\`. Returns an \`InspectionReport\`.
- \`create_note(content, permanent?, urgent?)\` — Create a note for the Planner. Urgent marks priority; it does not interrupt running work.
- **Plan MCP tools** (read-only): \`plan_get()\`, \`plan_get_stage(stage_id)\`, \`plan_get_current_stage()\`, \`plan_get_history(last_n?)\`.
- **Filesystem tools** (read-only access preferred) — for reading project state.

## Slash Commands

Users may use these shortcuts:
- \`/help\` — Show available commands.
- \`/status\` — Current system status (running agents, current stage, recent completions).
- \`/plan\` — Show the current plan (all stages with status).
- \`/history\` — Show completed/failed stages.
- \`/replan\` — Create an urgent note asking the Planner to replan when it next handles notes.
- \`/restart-planner [reason]\` — Explicitly cancel the current Planner turn and immediately restart it with the provided reason.
- \`/note <text>\` — Create a volatile note for the Planner.
- \`/note! <text>\` — Create a high-priority note for the Planner.
- \`/notep <text>\` — Create a permanent note for the Planner.

## Guidelines

- **Be concise but complete**: The user wants answers, not essays. Summarize key points, link to details.
- **Be factual**: Read the actual data before answering. Do not speculate about project state — if you don't know, offer to dispatch the Inspector.
- **Relay promptly**: When the user gives direction, create a note immediately. Confirm it was created.
- **Restart cautiously**: Only restart the Planner when the user explicitly asks to restart it. Explain that the new Planner reloads plan/history from disk and continues from persistent state.
- **Contextualize notifications**: When pushing event notifications, include enough context for the user to understand what happened without asking follow-up questions. "Stage stg-003 escalated: WebSocket endpoint failed because ws library is not installed. The Planner will create a corrective stage." is better than "Stage stg-003 escalated."
- **Don't interfere**: You are an observer and relay. Do not modify project files, code, or plans. Do not stop execution unless explicitly requested.
- **Understand corrective actions**: Every agent in the system evaluates whether it can solve a problem within its scope — if it can, it fixes it; if it can't, it escalates with a clear diagnosis. If a user asks why something was escalated, explain the agent's judgment call.

## Notification Format

When system events arrive, push concise but informative notifications:
- **Stage completed**: "Stage stg-xxx completed: N/M tasks done. Key outcomes: [list]. Next: stg-yyy (description)."
- **Stage failed/escalated**: "Stage stg-xxx escalated: [reason]. Attempted: [remediations]. The Planner will create corrective stages."
- **Plan complete**: "All objectives achieved. Plan complete."
- Respect notification filters from project config.`;

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
      systemPrompt: CHAT_PROMPT,
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
    this.loadExistingChatLog();

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

    const spaceIdx = content.indexOf(" ");
    const cmd = (spaceIdx === -1 ? content : content.slice(0, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? "" : content.slice(spaceIdx + 1).trim();

    switch (cmd) {
      case "/help":
        return this.cmdHelp();
      case "/status":
        return this.cmdStatus();
      case "/plan":
        return this.cmdPlan();
      case "/history":
        return this.cmdHistory(args);
      case "/replan":
        return this.cmdNote(
          args || "User requests replanning. Re-evaluate the current plan, analyze what has failed or escalated, and create a new strategy to achieve the project objectives.",
          false,
          true,
        );
      case "/restart-planner":
      case "/planner-restart":
        return this.cmdRestartPlanner(args);
      case "/note":
        return args ? this.cmdNote(args, false, false) : "Usage: `/note <message>` — create a note for the Planner.";
      case "/note!":
        return args ? this.cmdNote(args, false, true) : "Usage: `/note! <message>` — create an **urgent** high-priority note.";
      case "/notep":
        return args ? this.cmdNote(args, true, false) : "Usage: `/notep <message>` — create a **permanent** note.";
      default:
        return null; // Not a recognized command — pass to LLM
    }
  }

  private cmdHelp(): string {
    return [
      "**Available Commands**",
      "",
      "| Command | Description |",
      "|---------|-------------|",
      "| `/help` | Show this help message |",
      "| `/status` | Show runtime status (agents, current stage) |",
      "| `/plan` | Show the current plan with all stages |",
      "| `/history [n]` | Show completed stages (last n, default 5) |",
      "| `/replan [reason]` | Force replanning (urgent note to Planner) |",
      "| `/restart-planner [reason]` | Restart the Planner from persisted state |",
      "| `/note <msg>` | Create a note for the Planner |",
      "| `/note! <msg>` | Create an **urgent** high-priority note |",
      "| `/notep <msg>` | Create a **permanent** note |",
      "",
      "Any other message is handled by the AI assistant.",
    ].join("\n");
  }

  private cmdStatus(): string {
    const paths = this.ctx.project.paths;
    const runtime = readDocOrNull(paths.runtimeState, RuntimeStateSchema);
    const plan = readDocLenient(paths.plan, PlanSchema);

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

  private cmdPlan(): string {
    const plan = readDocLenient(this.ctx.project.paths.plan, PlanSchema);
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

  private cmdHistory(args: string): string {
    const n = parseInt(args, 10) || 5;
    const historyPath = this.ctx.project.paths.planHistory;
    const history = readDocLenient(historyPath, PlanHistorySchema);
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

  private async cmdNote(content: string, permanent: boolean, urgent: boolean): Promise<string> {
    const note = createUserNote({
      notesDir: this.ctx.project.paths.notes,
      channel: this.input.channel,
      sessionId: this.input.sessionId,
      content,
      permanent,
      urgent,
    });

    const flags = [
      permanent ? "permanent" : null,
      urgent ? "urgent" : null,
    ].filter(Boolean).join(", ");

    const flagStr = flags ? ` (${flags})` : "";
    return `📝 Note created: \`${note.id}\`${flagStr}\nThe Planner will decide how to handle it when it next sees pending notes.${urgent ? "\nMarked high priority; no running work was interrupted." : ""}`;
  }

  private async cmdRestartPlanner(reason: string): Promise<string> {
    if (!this.plannerControl) {
      return "Planner restart is not available in this runtime. Use `/replan <reason>` to create an urgent Planner note instead.";
    }

    const restartReason = reason || "User explicitly requested a Planner restart from chat.";
    const request = this.plannerControl.requestRestart(restartReason, `${this.input.channel}:${this.input.sessionId}`);
    await this.eventBus.publish({
      type: "plan_updated",
      summary: `Planner restart requested from ${this.input.channel}: ${restartReason}`,
    });

    return [
      `Planner restart requested at ${request.requestedAt}.`,
      "The current Planner turn will be cancelled, then a fresh Planner will reload plan/history from disk and continue from persistent state.",
      `Reason: ${restartReason}`,
    ].join("\n");
  }

  private async tryHandleExplicitPlannerRestart(content: string): Promise<string | null> {
    if (!/\b(restart|reset|relaunch)\b/i.test(content)) return null;
    if (!/\bplanner\b/i.test(content)) return null;
    return this.cmdRestartPlanner(content);
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

  private loadExistingChatLog(): void {
    const logPath = join(this.chatDir, `${this.input.sessionId}.json`);
    const existing = readDocOrNull(logPath, ChatLogSchema);
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
