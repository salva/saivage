/**
 * Saivage v2 — Agent Base Class
 * Wraps LLM provider calls, assembles context (system prompt + skills + references),
 * manages the conversation loop, tool execution, compaction, self-check, and stash.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type {
  Message,
  ContentBlock,
  ChatResponse,
  ToolSchema,
} from "../../providers/types.js";
import type {
  AgentContext,
  AgentResult,
  AgentRole,
} from "./types.js";
import { Dispatcher, DISPATCH_TOOLS } from "../runtime/dispatcher.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import {
  shouldCompact,
  isMaxCompactionsReached,
  compactConversation,
  type CompactionConfig,
  type CompactionState,
} from "../runtime/compaction.js";
import {
  createSelfCheckState,
  recordToolCallRound,
  selfCheckMessage,
  type SelfCheckState,
} from "../runtime/self-check.js";
import {
  resolveSkills,
  formatSkillsForPrompt,
  type SkillMatchContext,
} from "../skills/loader.js";
import { checkConvention } from "./conventions.js";
import { stashResult, readStash, cleanStash } from "../../agents/stash.js";
import type { RuntimeToolEntry } from "../../mcp/runtime.js";
import { log } from "../../log.js";

/** Configuration for creating a BaseAgent. */
export interface BaseAgentConfig {
  /** System prompt (from prompts/<role>.md). */
  systemPrompt: string;
  /** Skill matching context. */
  skillContext?: SkillMatchContext;
  /** Child spawner for agent dispatch tools. */
  childSpawner?: ChildSpawner;
  /** Additional context message injected at the start. */
  initialMessage?: string;
  /** Abort signal shared with the runtime. */
  abortSignal?: { aborted: boolean };
}

/**
 * Base class for all v2 agents.
 * Implements the conversation loop with LLM calls, tool execution,
 * compaction, self-check, and stash.
 */
export class BaseAgent {
  readonly id: string;
  readonly role: AgentRole;

  protected ctx: AgentContext;
  protected messages: Message[] = [];
  protected systemPrompt: string;
  protected cancelled = false;
  private dispatcher: Dispatcher;
  private compactionState: CompactionState = { compactionCount: 0 };
  private selfCheckState: SelfCheckState;
  private compactionConfig: CompactionConfig;
  private abortSignal?: { aborted: boolean };

  constructor(ctx: AgentContext, config: BaseAgentConfig) {
    this.id = ctx.agentId;
    this.role = ctx.role;
    this.ctx = ctx;

    // Build system prompt with skills
    const skills = config.skillContext
      ? resolveSkills(
          config.skillContext,
          ctx.project.paths.skills,
          ctx.project.config.skills.max_per_agent,
        )
      : [];

    const skillBlock = formatSkillsForPrompt(skills);
    this.systemPrompt = skillBlock
      ? `${config.systemPrompt}\n\n${skillBlock}`
      : config.systemPrompt;

    // Initialize dispatcher
    this.dispatcher = new Dispatcher(ctx.mcpRuntime);
    if (config.childSpawner) {
      this.dispatcher.setChildSpawner(config.childSpawner);
    }

    // Initialize self-check
    const agentConfig = ctx.project.config.agents?.[ctx.role];
    this.selfCheckState = createSelfCheckState(
      ctx.role,
      agentConfig?.self_check_frequency,
    );

    // Initialize compaction config
    const contextWindow = ctx.router.getMaxContextTokens(ctx.modelSpec);
    this.compactionConfig = {
      contextWindow,
      thresholdPct: agentConfig?.compaction_threshold_pct ?? 80,
      maxCompactions: agentConfig?.max_compactions ?? 3,
      summaryModelSpec: ctx.modelSpec, // use same model for summarization
    };

    this.abortSignal = config.abortSignal;

    // Set initial message
    if (config.initialMessage) {
      this.messages.push({
        role: "user",
        content: config.initialMessage,
      });
    }
  }

  /** Cancel the agent (used during abort). */
  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Run the main conversation loop.
   * Subclasses should call this and interpret the result.
   */
  async runLoop(): Promise<{ text: string; finishReason: string }> {
    while (!this.cancelled) {
      // Check for abort
      if (this.abortSignal?.aborted) {
        return { text: "Aborted by user", finishReason: "abort" };
      }

      // Check compaction before LLM call
      if (shouldCompact(this.messages, this.compactionConfig)) {
        if (isMaxCompactionsReached(this.compactionState, this.compactionConfig)) {
          log.warn(
            `[agent:${this.role}:${this.id}] Max compactions reached — terminating`,
          );
          return {
            text: "Agent terminated: max compactions exceeded",
            finishReason: "max_compactions",
          };
        }

        this.messages = await compactConversation(
          this.systemPrompt,
          this.messages,
          this.ctx.router,
          this.compactionConfig,
          this.compactionState,
        );
      }

      // Make LLM call
      let response: ChatResponse;
      try {
        response = await this.callLLM();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[agent:${this.role}:${this.id}] LLM call failed: ${msg}`);
        return { text: `LLM error: ${msg}`, finishReason: "error" };
      }

      // No tool calls → agent is done
      if (response.toolCalls.length === 0) {
        return { text: response.content, finishReason: response.finishReason };
      }

      // Build assistant message with tool-use blocks
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

      // Process tool calls through dispatcher
      const dispatchResult = await this.dispatcher.processToolCalls(
        response.toolCalls,
        this.ctx,
        this.abortSignal,
      );

      // Build tool result message
      const resultBlocks: ContentBlock[] = dispatchResult.toolResults.map(
        (r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolUseId,
          content: this.maybeStash(r.content, r.toolUseId),
          is_error: r.isError,
        }),
      );
      this.messages.push({ role: "user", content: resultBlocks });

      // Record tool-call round for self-check
      if (recordToolCallRound(this.selfCheckState)) {
        const checkMsg = selfCheckMessage(this.selfCheckState.frequency);
        this.messages.push({ role: "user", content: checkMsg });
      }

      if (dispatchResult.aborted) {
        return { text: "Aborted during tool execution", finishReason: "abort" };
      }
    }

    return { text: "Cancelled", finishReason: "cancelled" };
  }

  /** Inject a message into the conversation (e.g., for notes). */
  injectMessage(text: string): void {
    this.messages.push({ role: "user", content: text });
  }

  /** Get the current message count. */
  get messageCount(): number {
    return this.messages.length;
  }

  // ─── Protected ──────────────────────────────────────────────────────────

  /** Make an LLM call with current conversation state. */
  protected async callLLM(): Promise<ChatResponse> {
    const tools = this.getToolSchemas();

    return await this.ctx.router.chat({
      modelSpec: this.ctx.modelSpec,
      model: this.ctx.modelSpec.split("/")[1] ?? this.ctx.modelSpec,
      system: this.systemPrompt,
      messages: this.messages,
      tools: tools.length > 0 ? tools : undefined,
    });
  }

  /** Get available tool schemas for this agent. */
  protected getToolSchemas(): ToolSchema[] {
    const allTools = this.ctx.mcpRuntime.getAllTools();
    const schemas: ToolSchema[] = allTools.map((t: RuntimeToolEntry) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));

    // Add synthetic read_stash tool
    schemas.push({
      name: "read_stash",
      description:
        "Read a portion of a previously stashed large result. Use when a tool result was too large and was stashed to disk.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the stashed file",
          },
          offset: {
            type: "number",
            description: "Byte offset to start reading from (default: 0)",
          },
          length: {
            type: "number",
            description: "Number of bytes to read (default: 10000)",
          },
        },
        required: ["path"],
      },
    });

    return schemas;
  }

  // ─── Private ────────────────────────────────────────────────────────────

  /**
   * Stash large tool results to disk and return a reference instead.
   * Threshold: 5% of context window (in characters).
   */
  private maybeStash(content: string, toolUseId: string): string {
    const threshold = this.compactionConfig.contextWindow * 4 * 0.05; // 5% of context in chars
    if (content.length <= threshold) return content;

    const path = stashResult(content, `tool_${toolUseId}`);
    return (
      `[Result stashed to disk — too large for context window (${content.length} chars)]\n` +
      `Use read_stash(path="${path}") to read portions of this result.`
    );
  }
}
