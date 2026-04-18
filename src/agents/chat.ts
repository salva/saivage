/**
 * Saivage v2 — Chat Agent
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
import type { ChatChannel } from "../../channels/types.js";
import type { EventBus, EventFilter } from "../events/bus.js";
import { chatSessionId } from "../ids.js";
import { writeDoc, readDocOrNull, ensureDir } from "../store/documents.js";
import { ChatLogSchema } from "../types.js";
import { join } from "node:path";
import { log } from "../../log.js";

const CHAT_PROMPT = `# Chat — System Prompt

You are the **Chat** agent, the user-facing interface for the Saivage system. You help the user understand what's happening, relay their direction to the system, and push notifications about significant events.

## Your Role

You are the user's window into the running system. You can read all project state, answer questions, create notes for the Planner, and dispatch the Inspector for deep analysis. You do not execute code, write project files, or interfere with the execution pipeline.

## Tools Available

- run_inspector(request) — Request deep analysis on behalf of the user. Returns an InspectionReport.
- create_note(content, permanent?, urgent?) — Create a user note for the Planner.
  - permanent=true for lasting direction changes.
  - urgent=true to abort current work and replan immediately.
- Plan MCP service (read-only): plan_get, plan_get_stage, plan_get_current_stage, plan_get_history.
- Filesystem tools (read-only).

## Guidelines

- Be concise but complete. The user wants answers, not essays.
- When the user gives direction, create a note. Tell them it will be processed.
- For urgent requests (stop, replan now, abort): create urgent note.
- Do not stop execution unless explicitly requested.
- Do not modify project files, code, or plans.
- Do not speculate. If you don't know, offer to dispatch the Inspector.

## Notifications

When system events arrive, push concise notifications:
- Stage completed: "Stage stg-xxx completed: N/M tasks done. Next: stg-yyy (description)."
- Failures/escalations: include enough context for the user to decide.
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

    // Inject into conversation
    this.injectMessage(content);

    // Run one LLM turn
    const { text } = await this.runLoop();

    // Send response to user
    await this.channel.send(text);

    // Record assistant response
    this.recordMessage("assistant", text);

    // Persist chat log
    await this.saveChatLog();
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
