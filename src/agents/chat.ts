import { randomUUID } from "node:crypto";
import type { ChatChannel } from "../channels/types.js";
import type { WebSocketChannel, WsEvent } from "../channels/websocket.js";
import type { EventBus } from "../orchestrator/eventBus.js";
import type { ModelRouter } from "../providers/router.js";
import type { Orchestrator } from "../orchestrator/orchestrator.js";
import type { Message, ContentBlock, ToolSchema } from "../providers/types.js";
import { parseModelId } from "../providers/types.js";
import type { SaivageConfig } from "../config.js";
import { orchestratorTools } from "../orchestrator/mcpService.js";
import { log } from "../log.js";

import { createOrchestratorToolHandler } from "../orchestrator/mcpService.js";
import type { InProcessToolHandler } from "../mcp/runtime.js";

/**
 * Chat agent — one per user session. User-facing, read-only except for
 * orch_* tools. Subscribes to events to push proactive updates.
 */
export class ChatAgent {
  readonly id: string;
  private channel: ChatChannel;
  private router: ModelRouter;
  private orchestrator: Orchestrator;
  private eventBus: EventBus;
  private config: SaivageConfig;
  private messages: Message[] = [];
  private unsubscribers: Array<() => void> = [];
  private active = true;
  private orchToolHandler: InProcessToolHandler;

  constructor(params: {
    channel: ChatChannel;
    router: ModelRouter;
    orchestrator: Orchestrator;
    eventBus: EventBus;
    config: SaivageConfig;
  }) {
    this.id = randomUUID();
    this.channel = params.channel;
    this.router = params.router;
    this.orchestrator = params.orchestrator;
    this.eventBus = params.eventBus;
    this.config = params.config;
    this.orchToolHandler = createOrchestratorToolHandler(params.orchestrator);
  }

  /** Start the chat agent — listen to user messages and events */
  start(): void {
    // Listen for user messages
    this.channel.onMessage((msg) => this.handleUserMessage(msg));
    this.channel.onClose(() => this.stop());

    // Subscribe to orchestrator events for proactive updates
    this.unsubscribers.push(
      this.eventBus.on("orchestrator:dispatched", (data) => {
        const { todoId, agentId, agentType, goal } = data as {
          todoId: string;
          agentId: string;
          agentType: string;
          goal: string;
        };
        this.sendTypedEvent({
          type: "work_dispatched",
          todoId,
          agentId,
          agentType,
          goal,
        });
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on("orchestrator:completed", (data) => {
        const { todoId, result } = data as { todoId: string; result: string };
        this.sendTypedEvent({
          type: "work_completed",
          todoId,
          result,
        });
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on("orchestrator:failed", (data) => {
        const { todoId, error } = data as { todoId: string; error: string };
        this.sendTypedEvent({
          type: "work_failed",
          todoId,
          error,
        });
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on("agent:progress", (data) => {
        const { taskId, agentId, iteration, summary } = data as {
          taskId: string;
          agentId: string;
          iteration: number;
          summary: string;
        };
        // Forward every 2nd progress event
        if (iteration % 2 === 0) {
          this.sendTypedEvent({
            type: "agent_progress",
            todoId: taskId,
            agentId,
            iteration,
            summary,
          });
        }
      }),
    );

    this.unsubscribers.push(
      this.eventBus.on("orchestrator:planning", (data) => {
        const { status, message, tasksCreated, error } = data as {
          status: string;
          message?: string;
          tasksCreated?: number;
          error?: string;
        };
        this.sendTypedEvent({
          type: "planning",
          status,
          message,
          tasksCreated,
          error,
        });
      }),
    );

    log.info(`Chat agent ${this.id} started`);
  }

  /** Send a typed event to the WebSocket client */
  private sendTypedEvent(event: WsEvent): void {
    const wsChannel = this.channel as unknown as WebSocketChannel;
    if (typeof wsChannel.sendEvent === "function") {
      wsChannel.sendEvent(event);
    } else {
      // Fallback for non-WebSocket channels
      this.channel.send(JSON.stringify(event));
    }
  }

  /** Stop and clean up */
  stop(): void {
    if (!this.active) return;
    this.active = false;

    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];

    log.info(`Chat agent ${this.id} stopped`);
  }

  /** Handle a user message */
  private async handleUserMessage(text: string): Promise<void> {
    if (!this.active) return;

    // Record user activity to gate background scheduling
    this.orchestrator.touchUserActivity();

    // Add user message
    this.messages.push({ role: "user", content: text });

    // Signal that we're processing
    this.sendTypedEvent({ type: "thinking", active: true });

    try {
      // Convert orchestrator tools to LLM tool schemas
      const tools: ToolSchema[] = orchestratorTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));

      // Tool-calling loop: let the LLM call orch_* tools, then respond
      const maxRounds = 5; // Safety cap
      for (let round = 0; round < maxRounds; round++) {
        const modelSpec = this.router.resolveModelForRole("chat");
        const { model } = parseModelId(modelSpec);

        const response = await this.router.chat({
          modelSpec,
          model,
          system: this.buildSystemPrompt(),
          messages: this.messages,
          tools,
          maxTokens: 4096,
        });

        if (response.toolCalls.length === 0) {
          // No tool calls — final text response
          this.sendTypedEvent({ type: "thinking", active: false });
          this.messages.push({ role: "assistant", content: response.content });
          if (response.content) {
            this.channel.send(response.content);
          }
          return;
        }

        // Build assistant message with tool calls
        const assistantBlocks: ContentBlock[] = [];
        if (response.content) {
          assistantBlocks.push({ type: "text", text: response.content });
        }
        for (const tc of response.toolCalls) {
          assistantBlocks.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.input,
          });
        }
        this.messages.push({ role: "assistant", content: assistantBlocks });

        // Execute tool calls against the orchestrator
        const resultBlocks: ContentBlock[] = [];
        for (const tc of response.toolCalls) {
          const args = (tc.input ?? {}) as Record<string, unknown>;
          try {
            const result = await this.orchToolHandler(tc.name, args);
            resultBlocks.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: typeof result.content === "string"
                ? result.content
                : JSON.stringify(result.content),
              is_error: result.isError,
            });

            // Emit UI events for work submission/replan
            if (tc.name === "orch_submit_work" && !result.isError) {
              const parsed = JSON.parse(
                typeof result.content === "string"
                  ? result.content
                  : (result.content as any)?.[0]?.text ?? "{}",
              );
              this.sendTypedEvent({
                type: "work_submitted",
                todoId: parsed.id,
                goal: args.goal,
                agentType: args.agentType ?? "coder",
                priority: args.priority ?? 1,
              });
            } else if (tc.name === "orch_replan" && !result.isError) {
              this.sendTypedEvent({
                type: "replan_requested",
                requirements: args.requirements,
              });
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            resultBlocks.push({
              type: "tool_result",
              tool_use_id: tc.id,
              content: `Error: ${msg}`,
              is_error: true,
            });
          }
        }
        this.messages.push({ role: "user", content: resultBlocks });

        // Loop back so the LLM can see tool results and respond
      }

      // If we hit the max rounds, send whatever we have
      this.sendTypedEvent({ type: "thinking", active: false });
      this.channel.send("(Reached tool call limit — please rephrase if needed)");
    } catch (err) {
      this.sendTypedEvent({ type: "thinking", active: false });
      const msg = err instanceof Error ? err.message : String(err);
      this.channel.send(`Error: ${msg}`);
      log.error(`Chat agent error: ${msg}`);
    }
  }

  private buildSystemPrompt(): string {
    const state = this.orchestrator.getState();
    const todoSummary = state.todos
      .filter((t) => t.status !== "completed" && t.status !== "cancelled")
      .slice(0, 15)
      .map((t) => `- [${t.status}] (${t.id.slice(0, 8)}) ${t.goal}`)
      .join("\n");

    const agentSummary = state.activeAgents
      .map((a) => `- ${a.type} [${a.id.slice(0, 8)}]: task ${a.taskId.slice(0, 8)} (iter ${a.iteration})`)
      .join("\n");

    const planSummary = this.orchestrator.getPlanSummary();
    const stageSummary = this.orchestrator.getStageSummary();

    let prompt = `You are Saivage, an autonomous AI agent system. You are the chat interface.

## Your Role
- You answer questions about the system state, files, and previous work.
- When the user asks you to DO something (write code, fix a bug, research, etc.),
  use the orch_submit_work tool to delegate it to a worker agent.
- When the user wants to change direction, reprioritize, or stop current work,
  use the orch_replan tool — the orchestrator will figure out what to cancel, modify, or add.
- To check what's happening, use orch_get_state, orch_get_todos, orch_get_agents,
  orch_get_plan, or orch_get_stage.
- To send a message to a running agent, use orch_message_agent.
- You are READ-ONLY — you cannot modify files directly. You delegate work via tools.`;

    if (planSummary) {
      prompt += `\n\n## Master Plan\nVision: ${planSummary.vision}\n${planSummary.stages.map((s) => `- Stage ${s.id}: ${s.title} [${s.status}]`).join("\n")}`;
    }

    if (stageSummary) {
      prompt += `\n\n## Active Stage: ${stageSummary.title}\nGoal: ${stageSummary.goal}\n${stageSummary.tasks.map((t) => `- [${t.status}] Task ${t.ref}: ${t.title}`).join("\n")}`;
    }

    prompt += `\n\n## Current State\nActive todos:\n${todoSummary || "(none)"}\n\nActive agents:\n${agentSummary || "(none)"}`;

    prompt += `

## Agent Types
- coder: writes and modifies code, runs tests
- researcher: reads files, searches web, synthesizes information
- executor: runs commands, checks outputs

## Priority Levels
0=interactive (user is waiting), 1=foreground, 2=system, 3=background

## Rules
- Be concise and helpful.
- If you can answer from context, do so directly without tools.
- Always tell the user what you're doing.
- Use orch_replan (not orch_submit_work) when the user wants to change direction on existing work.
- Use orch_submit_work for specific, self-contained new tasks.`;

    // Inject project context
    const proj = this.config.project;
    if (proj.root) {
      prompt += `\n\n## Active Project\nRoot: ${proj.root}`;
      if (proj.venv) prompt += `\nPython venv: ${proj.venv}`;
      if (proj.description) prompt += `\n${proj.description}`;
    }

    return prompt;
  }
}