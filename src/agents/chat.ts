/**
 * Saivage — Chat Agent
 * User-facing conversational agent. Reads project state, creates notes
 * for the Planner, dispatches the Inspector, pushes notifications.
 */

import { BaseAgent, type BaseAgentConfig } from "./base.js";
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
import {
  ChatLogSchema,
  PlanSchema,
  PlanHistorySchema,
  RuntimeStateSchema,
} from "../types.js";
import { join } from "node:path";
import { log } from "../log.js";

const CHAT_PROMPT = `# Chat — System Prompt

## The Saivage System

You are operating inside **Saivage**, an autonomous multi-agent system. Here is where you fit:

- **Planner**: The top-level strategist that owns the project plan and drives execution. It creates stages and dispatches them to the Manager. It is a long-lived agent that runs continuously. **You communicate with the Planner by creating notes** — you cannot call it directly.
- **Manager**: A tactical executor that decomposes stages into tasks and dispatches Coder/Researcher workers. You do not interact with the Manager.
- **Coder / Researcher**: One-shot worker agents. You do not interact with them.
- **Inspector**: A one-shot deep-analysis agent. You CAN dispatch it via \`run_inspector()\` when the user asks questions that require thorough investigation.
- **Chat** (you): The user-facing interface. You are the user's window into the running system. You answer questions about project state, relay user direction to the Planner, push notifications about significant events, and dispatch the Inspector for deep analysis. You do NOT write code, modify project files, or interfere with the execution pipeline.

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
- You cannot stop or start the Planner directly.

## Your Role

You are the **Chat**: the human interface. Your responsibilities:

1. **Answer questions**: When the user asks about project status, plan progress, stage results, or code state, read the relevant data and provide a clear answer.
2. **Relay direction**: When the user gives instructions about what the system should do (replan, change strategy, focus on something), create a note for the Planner.
3. **Push notifications**: When significant system events occur (stage completed, stage failed/escalated), send concise notifications to the user.
4. **Dispatch investigations**: When the user asks a question that requires deep analysis (why is something broken, what's the test coverage, how is X implemented), dispatch the Inspector.

## CRITICAL: Relaying User Orders

When the user gives direction about what the system should do, you MUST create a note:

- **Direction changes** (change strategy, focus on X, ignore Y): Create a **permanent note** — it persists across conversation compaction and replanning.
- **Urgent changes** (stop current work, replan NOW, abort stage): Create an **urgent note** — it triggers immediate replanning. The Planner will interrupt its current stage to process it.
- **Contextual observations** (FYI, suggestion, heads-up): Create a regular (volatile) note — it will be processed on the Planner's next turn.

Always confirm to the user that their instruction has been relayed and how: "I've created an urgent note for the Planner. It will replan on its next turn."

## Tools Available

- \`run_inspector(request)\` — Dispatch the Inspector for deep analysis. The request must include: \`id\`, \`scope\`, \`questions\`. Returns an \`InspectionReport\`.
- \`create_note(content, permanent?, urgent?)\` — Create a note for the Planner.
- **Plan MCP tools** (read-only): \`plan_get()\`, \`plan_get_stage(stage_id)\`, \`plan_get_current_stage()\`, \`plan_get_history(last_n?)\`.
- **Filesystem tools** (read-only access preferred) — for reading project state.

## Slash Commands

Users may use these shortcuts:
- \`/help\` — Show available commands.
- \`/status\` — Current system status (running agents, current stage, recent completions).
- \`/plan\` — Show the current plan (all stages with status).
- \`/history\` — Show completed/failed stages.
- \`/replan\` — Create an urgent note telling the Planner to replan.
- \`/note <text>\` — Create a volatile note for the Planner.
- \`/note! <text>\` — Create an urgent note for the Planner.
- \`/notep <text>\` — Create a permanent note for the Planner.

## Guidelines

- **Be concise but complete**: The user wants answers, not essays. Summarize key points, link to details.
- **Be factual**: Read the actual data before answering. Do not speculate about project state — if you don't know, offer to dispatch the Inspector.
- **Relay promptly**: When the user gives direction, create a note immediately. Confirm it was created.
- **Contextualize notifications**: When pushing event notifications, include enough context for the user to understand what happened without asking follow-up questions. "Stage stg-003 escalated: WebSocket endpoint failed because ws library is not installed. The Planner will create a corrective stage." is better than "Stage stg-003 escalated."
- **Don't interfere**: You are an observer and relay. Do not modify project files, code, or plans. Do not stop execution unless explicitly requested.
- **Understand corrective actions**: Every agent in the system attempts to fix problems within its scope before escalating. The Coder fixes build errors and test failures. The Manager retries with modified approaches. The Planner creates corrective stages. If a user asks why something failed, explain what corrective actions were attempted at each level before escalation.

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
  private input: ChatInput;
  private channel: ChatChannel;
  private eventBus: EventBus;
  private unsubscribe?: () => void;
  private chatLog: ChatLog;
  private chatDir: string;

  constructor(
    ctx: AgentContext,
    input: ChatInput,
    channel: ChatChannel,
    eventBus: EventBus,
    eventFilter?: EventFilter,
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
        this.channel.onMessage(async (message) => {
          try {
            await this.handleUserMessage(message);
          } catch (err) {
            log.error(`[chat:${this.id}] Message handling error: ${err}`);
          }
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

    // Inject into conversation
    this.injectMessage(content);

    // Signal thinking to the client
    const ch = this.channel as ChatChannel & { sendEvent?: (e: Record<string, unknown>) => void };
    ch.sendEvent?.({ type: "thinking" });

    // Run one LLM turn
    const { text } = await this.runLoop();

    // Send response to user
    await this.channel.send(text);

    // Record assistant response
    this.recordMessage("assistant", text);

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
      case "/note":
        return args ? this.cmdNote(args, false, false) : "Usage: `/note <message>` — create a note for the Planner.";
      case "/note!":
        return args ? this.cmdNote(args, false, true) : "Usage: `/note! <message>` — create an **urgent** note (aborts current work).";
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
      "| `/note <msg>` | Create a note for the Planner |",
      "| `/note! <msg>` | Create an **urgent** note (aborts current work) |",
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
    const { writeDoc: writeDocFn, ensureDir: ensureDirFn } = await import("../store/documents.js");
    const { noteId } = await import("../ids.js");
    const { UserNoteSchema } = await import("../types.js");

    const notesDir = this.ctx.project.paths.notes;
    ensureDirFn(notesDir);

    const id = noteId();
    const note = {
      id,
      channel: this.input.channel,
      session_id: this.input.sessionId,
      content,
      created_at: new Date().toISOString(),
      permanent,
      urgent,
    };

    const notePath = join(notesDir, `${id}.json`);
    writeDocFn(notePath, note, UserNoteSchema);

    const flags = [
      permanent ? "permanent" : null,
      urgent ? "urgent" : null,
    ].filter(Boolean).join(", ");

    const flagStr = flags ? ` (${flags})` : "";
    return `📝 Note created: \`${id}\`${flagStr}\nThe Planner will process it on its next cycle.${urgent ? "\n⚠️ Current work will be aborted for replanning." : ""}`;
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
  ): void {
    this.chatLog.messages.push({
      id: chatSessionId(), // reusing for unique msg ID
      role,
      content,
      timestamp: new Date().toISOString(),
      event,
    });
    this.chatLog.updated_at = new Date().toISOString();
  }

  private async saveChatLog(): Promise<void> {
    const logPath = join(this.chatDir, `${this.input.sessionId}.json`);
    await writeDoc(logPath, this.chatLog, ChatLogSchema);
  }

  private cleanup(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }
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
