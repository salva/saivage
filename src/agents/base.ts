/**
 * Saivage — Agent Base Class
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
} from "../providers/types.js";
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
import { stashResult, readStash, cleanStash } from "../runtime/stash.js";
import type { RuntimeToolEntry } from "../mcp/runtime.js";
import { log } from "../log.js";

/** A single entry in the serialized conversation snapshot for the dashboard. */
export interface ConversationEntry {
  role: "user" | "assistant" | "system";
  kind: "text" | "tool_call" | "tool_result" | "tool_error";
  content: string;
  tool?: string;
}

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
  /** Notify the runtime that this agent is still making progress. */
  onActivity?: (agentId: string) => void;
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
  private hasChildSpawner = false;
  private compactionState: CompactionState = { compactionCount: 0 };
  private selfCheckState: SelfCheckState;
  private compactionConfig: CompactionConfig;
  private abortSignal?: { aborted: boolean };
  private onActivity?: (agentId: string) => void;

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
      this.hasChildSpawner = true;
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
    this.onActivity = config.onActivity;

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
        this.recordActivity();
        response = await this.callLLM();
        this.recordActivity();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(`[agent:${this.role}:${this.id}] LLM call failed: ${msg}`);
        return { text: `LLM error: ${msg}`, finishReason: "error" };
      }

      log.info(
        `[agent:${this.role}:${this.id}] LLM response: ${response.toolCalls.length} tool calls, finish=${response.finishReason}, content=${response.content?.slice(0, 200)}`,
      );

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
      this.recordActivity();
      const dispatchResult = await this.dispatcher.processToolCalls(
        response.toolCalls,
        this.ctx,
        this.abortSignal,
      );
      this.recordActivity();

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

  /** Return a serializable snapshot of the conversation for the dashboard. */
  getConversationSnapshot(): ConversationEntry[] {
    const entries: ConversationEntry[] = [];

    for (const msg of this.messages) {
      if (typeof msg.content === "string") {
        entries.push({ role: msg.role, kind: "text", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            entries.push({ role: msg.role, kind: "text", content: block.text });
          } else if (block.type === "tool_use") {
            const inputStr = typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input, null, 2);
            entries.push({
              role: "assistant",
              kind: "tool_call",
              tool: block.name ?? "unknown",
              content: inputStr.length > 2000 ? inputStr.slice(0, 2000) + "\n…(truncated)" : inputStr,
            });
          } else if (block.type === "tool_result") {
            const text = block.content ?? block.text ?? "";
            entries.push({
              role: "system",
              kind: block.is_error ? "tool_error" : "tool_result",
              tool: block.tool_use_id,
              content: text.length > 3000 ? text.slice(0, 3000) + "\n…(truncated)" : text,
            });
          }
        }
      }
    }
    return entries;
  }

  // ─── Protected ──────────────────────────────────────────────────────────

  /** Make an LLM call with current conversation state.
   *  Retries indefinitely on transient errors with exponential backoff
   *  (30s initial, x1.5, max 20min). Context overflow triggers compaction
   *  and immediate retry instead of backoff.
   */
  protected async callLLM(): Promise<ChatResponse> {
    const tools = this.getToolSchemas();
    const BASE_DELAY_S = 30;
    const BACKOFF_MULT = 1.5;
    const MAX_DELAY_S = 20 * 60; // 20 minutes

    log.info(
      `[agent:${this.role}:${this.id}] Calling LLM with ${tools.length} tools, ${this.messages.length} messages`,
    );

    for (let attempt = 0; ; attempt++) {
      if (this.cancelled || this.abortSignal?.aborted) {
        throw new Error("Agent cancelled");
      }

      try {
        return await this.ctx.router.chat({
          modelSpec: this.ctx.modelSpec,
          model: this.ctx.modelSpec.split("/")[1] ?? this.ctx.modelSpec,
          system: this.systemPrompt,
          messages: this.messages,
          tools: tools.length > 0 ? tools : undefined,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Context overflow → compact and retry immediately (no backoff)
        const isContextOverflow =
          msg.includes("exceeds the context window") ||
          msg.includes("context_length_exceeded");
        const isOrphanedToolResult =
          msg.includes("No tool call found for function call output") ||
          msg.includes("tool_use_id");

        if (isContextOverflow || isOrphanedToolResult) {
          const reason = isContextOverflow
            ? "context window exceeded"
            : "orphaned tool_result";
          log.warn(
            `[agent:${this.role}:${this.id}] ${reason} — compacting and retrying`,
          );
          this.messages = await compactConversation(
            this.systemPrompt,
            this.messages,
            this.ctx.router,
            this.compactionConfig,
            this.compactionState,
          );
          continue;
        }

        // All other errors → exponential backoff, retry forever
        const delaySec = Math.min(
          BASE_DELAY_S * Math.pow(BACKOFF_MULT, attempt),
          MAX_DELAY_S,
        );
        log.warn(
          `[agent:${this.role}:${this.id}] LLM failed (attempt ${attempt + 1}): ${msg} — retrying in ${Math.round(delaySec)}s`,
        );

        // Clear sticky failovers so the router retries the primary model
        this.ctx.router.clearStickyFailover(this.ctx.modelSpec);

        await new Promise((r) => setTimeout(r, delaySec * 1000));
      }
    }
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

    // Add dispatch tool schemas based on agent role
    if (this.hasChildSpawner) {
      const dispatchSchemas = getDispatchToolsForRole(this.role);
      schemas.push(...dispatchSchemas);
    }

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

  private recordActivity(): void {
    this.onActivity?.(this.id);
  }
}

// ─── Dispatch Tool Schemas (role-aware) ─────────────────────────────────

const RUN_MANAGER_SCHEMA: ToolSchema = {
  name: "run_manager",
  description:
    "Dispatch a stage to the Manager agent. The Manager decomposes it into tasks and runs worker agents. Returns a StageSummary on success.",
  inputSchema: {
    type: "object",
    properties: {
      stage: {
        type: "object",
        description: "The stage to execute",
        properties: {
          id: { type: "string", description: "Unique stage ID" },
          objective: { type: "string", description: "What this stage must achieve" },
          starting_points: { type: "array", items: { type: "string" }, description: "Files or areas to start from" },
          expected_outcomes: { type: "array", items: { type: "string" }, description: "What should exist when done" },
          acceptance_criteria: { type: "array", items: { type: "string" }, description: "Verifiable criteria for completion" },
          references: { type: "array", items: { type: "string" }, description: "Relevant files, docs, or URLs" },
          tags: { type: "array", items: { type: "string" }, description: "Tags for categorization" },
        },
        required: ["id", "objective", "starting_points", "expected_outcomes", "acceptance_criteria", "references", "tags"],
      },
    },
    required: ["stage"],
  },
};

const RUN_INSPECTOR_SCHEMA: ToolSchema = {
  name: "run_inspector",
  description:
    "Request deep analysis from the Inspector agent. Returns an InspectionReport with findings and recommendations.",
  inputSchema: {
    type: "object",
    properties: {
      request: {
        type: "object",
        description: "The inspection request",
        properties: {
          id: { type: "string", description: "Unique inspection ID" },
          scope: { type: "string", description: "What area to inspect" },
          questions: { type: "array", items: { type: "string" }, description: "Specific questions to answer" },
          requested_at: { type: "string", description: "ISO timestamp" },
          requested_by: { type: "string", enum: ["planner", "chat"], description: "Who requested this" },
        },
        required: ["id", "scope", "questions", "requested_at", "requested_by"],
      },
    },
    required: ["request"],
  },
};

const RUN_CODER_SCHEMA: ToolSchema = {
  name: "run_coder",
  description:
    "Dispatch a coding task to a Coder worker agent. Returns a TaskReport.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "object",
        description: "The task to execute",
        properties: {
          id: { type: "string" },
          objective: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          instructions: { type: "string" },
          acceptance_criteria: { type: "array", items: { type: "string" } },
        },
        required: ["id", "objective", "files", "instructions", "acceptance_criteria"],
      },
      stageId: { type: "string", description: "Parent stage ID" },
    },
    required: ["task", "stageId"],
  },
};

const RUN_RESEARCHER_SCHEMA: ToolSchema = {
  name: "run_researcher",
  description:
    "Dispatch a research task to a Researcher worker agent. Returns a TaskReport.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "object",
        description: "The research task",
        properties: {
          id: { type: "string" },
          objective: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          instructions: { type: "string" },
          acceptance_criteria: { type: "array", items: { type: "string" } },
        },
        required: ["id", "objective", "files", "instructions", "acceptance_criteria"],
      },
      stageId: { type: "string", description: "Parent stage ID" },
    },
    required: ["task", "stageId"],
  },
};

const RUN_DATA_AGENT_SCHEMA: ToolSchema = {
  name: "run_data_agent",
  description:
    "Dispatch a data acquisition task to a Data Agent. Use for finding, downloading, validating, and documenting external datasets or API data. Returns a TaskReport.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "object",
        description: "The data acquisition task",
        properties: {
          id: { type: "string" },
          objective: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          instructions: { type: "string" },
          acceptance_criteria: { type: "array", items: { type: "string" } },
        },
        required: ["id", "objective", "files", "instructions", "acceptance_criteria"],
      },
      stageId: { type: "string", description: "Parent stage ID" },
    },
    required: ["task", "stageId"],
  },
};

const RUN_REVIEWER_SCHEMA: ToolSchema = {
  name: "run_reviewer",
  description:
    "Dispatch a review task to a Reviewer worker agent after stage work is done. Use to validate stage objectives, acceptance criteria, work products, data/statistical quality, and issues before writing StageSummary. Returns a TaskReport.",
  inputSchema: {
    type: "object",
    properties: {
      task: {
        type: "object",
        description: "The review task",
        properties: {
          id: { type: "string" },
          objective: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          instructions: { type: "string" },
          acceptance_criteria: { type: "array", items: { type: "string" } },
        },
        required: ["id", "objective", "files", "instructions", "acceptance_criteria"],
      },
      stageId: { type: "string", description: "Parent stage ID" },
    },
    required: ["task", "stageId"],
  },
};

/** Role → dispatch tools mapping. Only expose tools each role should use. */
const ROLE_DISPATCH_TOOLS: Record<string, ToolSchema[]> = {
  planner: [RUN_MANAGER_SCHEMA, RUN_INSPECTOR_SCHEMA],
  manager: [RUN_CODER_SCHEMA, RUN_RESEARCHER_SCHEMA, RUN_DATA_AGENT_SCHEMA, RUN_REVIEWER_SCHEMA],
  chat: [RUN_INSPECTOR_SCHEMA],
};

function getDispatchToolsForRole(role: AgentRole): ToolSchema[] {
  return ROLE_DISPATCH_TOOLS[role] ?? [];
}
