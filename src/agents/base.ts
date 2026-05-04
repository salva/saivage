/**
 * Saivage — Agent Base Class
 * Wraps LLM provider calls, assembles context (system prompt + skills + references),
 * manages the conversation loop, tool execution, compaction, and stash.
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
  kind:
    | "text"
    | "activity"
    | "model_issue"
    | "model_repair"
    | "model_recovered"
    | "tool_call"
    | "tool_result"
    | "tool_error";
  content: string;
  tool?: string;
  timestamp?: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

export interface LlmResponseSource {
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

const MAX_DIAGNOSTIC_ENTRIES = 30;

const VISIBLE_EXECUTION_STYLE_PROMPT = `## Visible Execution Style

- In any response that includes one or more tool calls, begin the SAME response with a short explanation of what you are about to do.
- Keep that explanation concise and concrete: say what you are checking/changing, why it matters, and what outcome you expect.
- Do NOT wait for a separate text-only turn. Combine the explanation and the tool calls in one response.
- If several tool calls belong to one batch, summarize the batch once instead of narrating each call.
- Keep these explanations brief so they improve trace readability without creating extra churn.`;

function describeToolUseBlocks(blocks: ContentBlock[]): string {
  const names = blocks.map((block) => block.name ?? "unknown");
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const summary = Array.from(counts.entries())
    .map(([name, count]) => count === 1 ? name : `${name} x${count}`)
    .join(", ");
  const noun = blocks.length === 1 ? "tool" : "tools";
  return `Using ${blocks.length} ${noun}: ${summary}`;
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
 * compaction and stash.
 */
export class BaseAgent {
  private static readonly MAX_INVALID_FINAL_RESPONSES = 3;
  readonly id: string;
  readonly role: AgentRole;

  protected ctx: AgentContext;
  protected messages: Message[] = [];
  protected systemPrompt: string;
  protected cancelled = false;
  private dispatcher: Dispatcher;
  private hasChildSpawner = false;
  private compactionState: CompactionState = { compactionCount: 0 };
  private compactionConfig: CompactionConfig;
  private abortSignal?: { aborted: boolean };
  private onActivity?: (agentId: string) => void;
  private diagnostics: ConversationEntry[] = [];
  private messageTimestamps: string[] = [];
  private messageSources: (LlmResponseSource | undefined)[] = [];
  private toolCallNames: string[] = [];
  private invalidFinalResponseCount = 0;
  readonly startedAt = new Date().toISOString();

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
    this.systemPrompt = [
      config.systemPrompt,
      VISIBLE_EXECUTION_STYLE_PROMPT,
      skillBlock,
    ].filter(Boolean).join("\n\n");

    // Initialize dispatcher
    this.dispatcher = new Dispatcher(ctx.mcpRuntime);
    if (config.childSpawner) {
      this.dispatcher.setChildSpawner(config.childSpawner);
      this.hasChildSpawner = true;
    }

    const agentConfig = ctx.project.config.agents?.[ctx.role];

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
      this.pushMessage({
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
  async runLoop(): Promise<{ text: string; finishReason: string; source?: LlmResponseSource }> {
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

        this.replaceMessages(await compactConversation(
          this.systemPrompt,
          this.messages,
          this.ctx.router,
          this.compactionConfig,
          this.compactionState,
        ));
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
        const finalResponseIssue = this.validateFinalResponse(response.content);
        this.pushMessage({ role: "assistant", content: response.content }, undefined, responseSource(response));
        if (finalResponseIssue) {
          this.invalidFinalResponseCount += 1;
          this.addDiagnostic("model_repair", finalResponseIssue);
          if (this.invalidFinalResponseCount >= BaseAgent.MAX_INVALID_FINAL_RESPONSES) {
            return {
              text: `Agent terminated after ${this.invalidFinalResponseCount} invalid final responses: ${finalResponseIssue}`,
              finishReason: "error",
              source: responseSource(response),
            };
          }
          this.pushMessage({
            role: "user",
            content: `${finalResponseIssue} Continue the task by using the required tools and return a final result only after real execution evidence exists.`,
          });
          continue;
        }
        return { text: response.content, finishReason: response.finishReason, source: responseSource(response) };
      }

      this.invalidFinalResponseCount = 0;
      this.toolCallNames.push(...response.toolCalls.map((tc) => tc.name));

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
      this.pushMessage({ role: "assistant", content: assistantBlocks }, undefined, responseSource(response));

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
      this.pushMessage({ role: "user", content: resultBlocks });

      if (dispatchResult.aborted) {
        return { text: "Aborted during tool execution", finishReason: "abort" };
      }
    }

    return { text: "Cancelled", finishReason: "cancelled" };
  }

  /** Inject a message into the conversation (e.g., for notes). */
  injectMessage(text: string): void {
    this.pushMessage({ role: "user", content: text });
  }

  /** Get the current message count. */
  get messageCount(): number {
    return this.messages.length;
  }

  /** Return a serializable snapshot of the conversation for the dashboard. */
  getConversationSnapshot(): ConversationEntry[] {
    const entries: ConversationEntry[] = [];

    for (const [index, msg] of this.messages.entries()) {
      const timestamp = this.messageTimestamps[index];
      const source = msg.role === "assistant" ? this.messageSources[index] : undefined;
      if (typeof msg.content === "string") {
        entries.push({ role: msg.role, kind: "text", content: msg.content, timestamp, ...source });
      } else if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter((block) => block.type === "text" && block.text);
        const toolUseBlocks = msg.content.filter((block) => block.type === "tool_use");
        if (msg.role === "assistant" && textBlocks.length === 0 && toolUseBlocks.length > 0) {
          entries.push({
            role: "assistant",
            kind: "activity",
            content: describeToolUseBlocks(toolUseBlocks),
            timestamp,
            ...source,
          });
        }
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            entries.push({ role: msg.role, kind: "text", content: block.text, timestamp, ...source });
          } else if (block.type === "tool_use") {
            const inputStr = typeof block.input === "string"
              ? block.input
              : JSON.stringify(block.input, null, 2);
            entries.push({
              role: "assistant",
              kind: "tool_call",
              tool: block.name ?? "unknown",
              content: inputStr.length > 2000 ? inputStr.slice(0, 2000) + "\n…(truncated)" : inputStr,
              timestamp,
              ...source,
            });
          } else if (block.type === "tool_result") {
            const text = block.content ?? block.text ?? "";
            entries.push({
              role: "system",
              kind: block.is_error ? "tool_error" : "tool_result",
              tool: block.tool_use_id,
              content: text.length > 3000 ? text.slice(0, 3000) + "\n…(truncated)" : text,
              timestamp,
            });
          }
        }
      }
    }
    return [...entries, ...this.diagnostics];
  }

  // ─── Protected ──────────────────────────────────────────────────────────

  /** Make an LLM call with current conversation state.
   *  Retries on transient errors with exponential backoff
   *  (30s initial, x1.5, max 20min, max 50 attempts). Context overflow
   *  triggers compaction and immediate retry instead of backoff.
   */
  protected async callLLM(): Promise<ChatResponse> {
    const tools = this.getToolSchemas();
    const BASE_DELAY_S = 30;
    const BACKOFF_MULT = 1.5;
    const MAX_DELAY_S = 20 * 60; // 20 minutes
    const MAX_TRANSIENT_RETRIES = 500; // non-throttling errors only

    log.info(
      `[agent:${this.role}:${this.id}] Calling LLM with ${tools.length} tools, ${this.messages.length} messages`,
    );

    let nonThrottleAttempts = 0;

    for (let attempt = 0; ; attempt++) {
      if (this.cancelled || this.abortSignal?.aborted) {
        throw new Error("Agent cancelled");
      }

      try {
        const response = await this.ctx.router.chat({
          modelSpec: this.ctx.modelSpec,
          model: this.ctx.modelSpec.split("/")[1] ?? this.ctx.modelSpec,
          system: this.systemPrompt,
          messages: this.messages,
          tools: tools.length > 0 ? tools : undefined,
          authProfileKey: this.ctx.authProfileKey,
          accountRef: this.ctx.accountRef,
        });
        if (attempt > 0) {
          this.addDiagnostic(
            "model_recovered",
            `Model service recovered after ${attempt} failed ${attempt === 1 ? "attempt" : "attempts"}.`,
          );
        }
        return response;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        // Context overflow → compact and retry immediately (no backoff)
        if (isContextOverflowError(msg) || isOrphanedToolResultError(msg)) {
          const reason = isContextOverflowError(msg)
            ? "context window exceeded"
            : "orphaned tool_result";
          if (isMaxCompactionsReached(this.compactionState, this.compactionConfig)) {
            const failure = `Cannot repair malformed model request after ${this.compactionState.compactionCount} compactions (${reason}). Aborting this agent so the parent can handle the failure.`;
            this.addDiagnostic("model_issue", failure);
            throw new Error(failure);
          }
          this.addDiagnostic(
            "model_repair",
            `Model request issue detected (${reason}). Compacting/regenerating conversation context and retrying without adding this diagnostic to the prompt.`,
          );
          log.warn(
            `[agent:${this.role}:${this.id}] ${reason} — compacting and retrying`,
          );
          this.replaceMessages(await compactConversation(
            this.systemPrompt,
            this.messages,
            this.ctx.router,
            this.compactionConfig,
            this.compactionState,
          ));
          continue;
        }

        // Non-retryable errors (invalid tool calls, etc.) — propagate immediately
        if (isNonRetryableError(msg)) {
          throw err;
        }

        const throttled = isThrottlingError(msg);

        // Only count non-throttling errors toward the retry cap
        if (!throttled) {
          nonThrottleAttempts++;
          if (nonThrottleAttempts >= MAX_TRANSIENT_RETRIES) {
            const failure = `LLM call failed after ${nonThrottleAttempts} non-throttling attempts. Last error: ${truncateDiagnostic(msg)}`;
            this.addDiagnostic("model_issue", failure);
            throw new Error(failure);
          }
        }

        // Transient errors → exponential backoff
        const delaySec = Math.min(
          BASE_DELAY_S * Math.pow(BACKOFF_MULT, attempt),
          MAX_DELAY_S,
        );
        const label = throttled ? "throttled" : "failed";
        log.warn(
          `[agent:${this.role}:${this.id}] LLM ${label} (attempt ${attempt + 1}): ${msg} — retrying in ${Math.round(delaySec)}s`,
        );
        this.addDiagnostic(
          "model_issue",
          `${throttled ? "Provider throttling" : "Temporary model service issue"} on attempt ${attempt + 1}. Retrying in ${Math.round(delaySec)}s. Error: ${truncateDiagnostic(msg)}`,
        );

        // Clear sticky failovers so the router retries the primary model
        this.ctx.router.clearStickyFailover(this.ctx.modelSpec);

        await this.sleepWithCancellation(delaySec * 1000);
      }
    }
  }

  /** Get available tool schemas for this agent, filtered by role. */
  protected getToolSchemas(): ToolSchema[] {
    const allTools = this.ctx.mcpRuntime.getAllTools();
    const roleFilter = ROLE_TOOL_FILTER[this.role];
    const filtered = roleFilter
      ? allTools.filter((t: RuntimeToolEntry) => roleFilter(t.name, t.service))
      : allTools;
    const schemas: ToolSchema[] = filtered.map((t: RuntimeToolEntry) => ({
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

  protected validateFinalResponse(_text: string): string | null {
    return null;
  }

  protected getToolCallNames(): readonly string[] {
    return this.toolCallNames;
  }

  protected hasUsedAnyTool(): boolean {
    return this.toolCallNames.length > 0;
  }

  protected hasUsedToolNamed(...toolNames: string[]): boolean {
    const allowed = new Set(toolNames);
    return this.toolCallNames.some((name) => allowed.has(name));
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

  private addDiagnostic(kind: ConversationEntry["kind"], content: string): void {
    this.diagnostics.push({ role: "system", kind, content, timestamp: new Date().toISOString() });
    if (this.diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
      this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTIC_ENTRIES);
    }
    this.recordActivity();
  }

  protected pushMessage(message: Message, timestamp = new Date().toISOString(), source?: LlmResponseSource): void {
    this.messages.push(message);
    this.messageTimestamps.push(timestamp);
    this.messageSources.push(source);
  }

  protected replaceMessages(messages: Message[], timestamp = new Date().toISOString()): void {
    this.messages = messages;
    this.messageTimestamps = messages.map(() => timestamp);
    this.messageSources = messages.map(() => undefined);
  }

  private async sleepWithCancellation(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!this.cancelled && !this.abortSignal?.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
    }
    if (this.cancelled || this.abortSignal?.aborted) {
      throw new Error("Agent cancelled");
    }
  }
}

function truncateDiagnostic(value: string, max = 700): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

// ─── Error Classification (regex-based, provider-agnostic) ──────────────

const CONTEXT_OVERFLOW_RE = /context.{0,20}(window|length)|exceeds?.{0,20}(context|token|limit)|max.{0,10}tokens?.{0,10}exceed|too many tokens/i;
const ORPHANED_TOOL_RE = /no tool.{0,20}(call|use).{0,20}found|orphaned tool|tool_use_id.{0,20}not found|unexpected tool.{0,5}result/i;
const NON_RETRYABLE_RE = /consecutive invalid tool calls|agent cancelled/i;
const THROTTLING_RE = /rate[- ]?limit|throttl|too many requests|\b429\b|quota.{0,20}(exhaust|exceed)|capacity|overloaded|temporarily unavailable|resource.{0,10}exhaust|server.{0,10}busy/i;

function isContextOverflowError(msg: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(msg);
}

function isOrphanedToolResultError(msg: string): boolean {
  return ORPHANED_TOOL_RE.test(msg);
}

function isNonRetryableError(msg: string): boolean {
  return NON_RETRYABLE_RE.test(msg);
}

function isThrottlingError(msg: string): boolean {
  return THROTTLING_RE.test(msg);
}

function responseSource(response: ChatResponse): LlmResponseSource | undefined {
  if (!response.modelSpec && !response.provider && !response.model) return undefined;
  return {
    provider: response.provider,
    model: response.model,
    modelSpec: response.modelSpec,
    requestedModelSpec: response.requestedModelSpec,
  };
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

// ─── Role-Based Tool Filtering ──────────────────────────────────────────

/** Read-only tools safe for roles that should not modify the project. */
const READ_ONLY_TOOLS = new Set([
  "read_file", "list_dir", "search_files", "git_status", "git_log", "git_diff",
  "list_skills", "read_skill",
]);

/** Tools that only the planner (and manager for delegation) should use. */
const PLAN_TOOLS = new Set([
  "read_plan", "update_plan", "complete_stage", "escalate",
  "read_note", "list_notes", "acknowledge_note",
]);

/** Tools workers (coder/researcher/data_agent) do NOT need. */
const WORKER_EXCLUDED_TOOLS = new Set([
  ...PLAN_TOOLS,
  // Skills management — workers consume skills, not manage them
  "create_skill", "update_skill",
]);

/**
 * Role → tool filter function. Returns true if the tool is allowed.
 * Roles without an entry get all available tools (no filtering).
 */
const ROLE_TOOL_FILTER: Partial<Record<AgentRole, (toolName: string, service: string) => boolean>> = {
  // Planner: plan tools + read-only filesystem + notes + skills — no shell, no write_file
  planner: (name, _service) =>
    PLAN_TOOLS.has(name) || READ_ONLY_TOOLS.has(name) ||
    name === "read_stash" ||
    name === "write_note" || name === "list_notes" || name === "acknowledge_note" || name === "read_note",

  // Inspector: read-only tools only
  inspector: (name, _service) =>
    READ_ONLY_TOOLS.has(name) || name === "run_command" || name === "read_stash" ||
    name === "web_search" || name === "fetch_url" || name === "fetch_page_text",

  // Reviewer: read-only + shell (for running tests)
  reviewer: (name, _service) =>
    READ_ONLY_TOOLS.has(name) || name === "run_command" || name === "read_stash",

  // Workers: everything except plan management
  coder: (name, _service) => !WORKER_EXCLUDED_TOOLS.has(name),
  researcher: (name, _service) => !WORKER_EXCLUDED_TOOLS.has(name),
  data_agent: (name, _service) => !WORKER_EXCLUDED_TOOLS.has(name),
};
