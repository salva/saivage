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
import { ProviderError } from "../providers/error.js";
import type {
  AgentContext,
  AgentResult,
  AgentRole,
  InputChannel,
} from "./types.js";
import { ROSTER } from "./roster.js";
import { getToolFilter } from "./roster.js";
import { applyToolFilter } from "./tool-filters.js";
import { Dispatcher, DISPATCH_TOOLS } from "../runtime/dispatcher.js";
import type { ChildSpawner } from "../runtime/dispatcher.js";
import {
  shouldCompact,
  isMaxCompactionsReached,
  compactConversation,
  type CompactionConfig,
  type CompactionState,
} from "../runtime/compaction.js";
import { buildSurvivorBlock } from "../knowledge/eagerLoader.js";
import type { KnowledgeAgentRole } from "../knowledge/types.js";
import type { SkillMatchContext } from "../knowledge/loader.js";
import { checkConvention } from "./conventions.js";
import { stashResult } from "../runtime/stash.js";
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
  timestamp: string;
  roundId: string;
  messageIndex: number;
  blockIndex: number;
  toolUseId?: string;
  toolName?: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

/** Runtime activity status surfaced to the dashboard. */
export interface ActivityStatus {
  pending_call: {
    started_at: string;
    status: "in_flight" | "backoff";
    attempt: number;
    reason: string | null;
    retry_at: string | null;
  } | null;
  last_activity_at: string;
}

export interface LlmResponseSource {
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
}

const MAX_DIAGNOSTIC_ENTRIES = 30;

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
  /** Skill matching context (kept for documentation; eager block is pre-built by factories). */
  skillContext?: SkillMatchContext;
  /** Pre-built §D.6 eager knowledge block to append to the system prompt. */
  eagerSkillBlock?: string;
  /** Child spawner for agent dispatch tools. */
  childSpawner?: ChildSpawner;
  /** Additional context message injected at the start. */
  initialMessage?: string;
  /** Abort signal shared with the runtime. */
  abortSignal?: { aborted: boolean };
  /** Notify the runtime that this agent is still making progress. */
  onActivity?: (agentId: string) => void;
  /** Notify the runtime when compaction counters change. */
  onCompactionUpdate?: (
    agentId: string,
    compaction: {
      count: number;
      summarizerFallbacks: number;
      consecutiveFallbacks: number;
      oversizedAtomicFallback: boolean;
    },
  ) => void;
  /**
   * Test hook (FR-16 / WI-14): invoked once after the Planner
   * pre-compaction memory-write window closes, with the number of
   * `create_memory` (or related) tool calls observed during the window.
   */
  onCompactionHookComplete?: (writeCount: number) => void;
  /**
   * Input channels that may inject `{role:"user"}` messages immediately
   * before each `router.chat` call, and that observe context resets.
   */
  inputChannels?: InputChannel[];
}

/**
 * Base class for all v2 agents.
 * Implements the conversation loop with LLM calls, tool execution,
 * compaction and stash.
 */
const LLM_BACKOFF_BASE_SECONDS = 30;
const LLM_BACKOFF_MULT = 1.5;
const LLM_BACKOFF_MAX_SECONDS = 20 * 60; // 20 minutes

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
  private compactionState: CompactionState = {
    compactionCount: 0,
    summarizerFallbacks: 0,
    consecutiveFallbacks: 0,
    oversizedAtomicFallback: false,
  };
  private compactionConfig: CompactionConfig;
  private abortSignal?: { aborted: boolean };
  private onActivity?: (agentId: string) => void;
  private onCompactionUpdate?: BaseAgentConfig["onCompactionUpdate"];
  private diagnostics: ConversationEntry[] = [];
  private messageTimestamps: string[] = [];
  private messageSources: (LlmResponseSource | undefined)[] = [];
  private toolCallNames: string[] = [];
  private invalidFinalResponseCount = 0;
  private roundCounter = 0;
  private compactionCounter = 0;
  private currentRoundId: string | null = null;
  private pendingRoundId: string | null = null;
  private messageRoundIds: (string | null)[] = [];
  private lastActivityAt: string = new Date().toISOString();
  private pendingCall: NonNullable<ActivityStatus["pending_call"]> | null = null;
  private onCompactionHookComplete?: (writeCount: number) => void;
  private readonly inputChannels: InputChannel[];
  private runningInputTokens = 0;
  private staticInputTokens = 0;
  readonly startedAt = new Date().toISOString();

  constructor(ctx: AgentContext, config: BaseAgentConfig) {
    this.id = ctx.agentId;
    this.role = ctx.role;
    this.ctx = ctx;

    // FR-1 / FR-15 §D.6: factories pre-build the eager block (async I/O) and pass it here.
    const skillBlock = config.eagerSkillBlock ?? "";
    this.systemPrompt = [
      config.systemPrompt,
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
      maxConsecutiveFallbacks: 3,
      summaryModelSpec: ctx.modelSpec, // use same model for summarization
    };

    this.abortSignal = config.abortSignal;
    this.onActivity = config.onActivity;
    this.onCompactionUpdate = config.onCompactionUpdate;
    this.onCompactionHookComplete = config.onCompactionHookComplete;
    this.inputChannels = config.inputChannels ?? [];

    // F07 — precompute static input (system prompt + tools) once.
    this.staticInputTokens = this.ctx.router.countTokens(
      this.ctx.modelSpec,
      [],
      this.systemPrompt,
      this.getToolSchemas(),
    );

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
      if (shouldCompact(this.runningInputTokens + this.staticInputTokens, this.compactionConfig)) {
        if (isMaxCompactionsReached(this.compactionState, this.compactionConfig)) {
          const stopReason = this.compactionStopReason();
          log.warn(
            `[agent:${this.role}:${this.id}] Compaction stop reached (${stopReason}) — terminating`,
          );
          return {
            text: `Agent terminated: ${stopReason}`,
            finishReason: "max_compactions",
          };
        }

        await this.compactWithReinjection();
      }

      await this.drainChannels();

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
        `[agent:${this.role}:${this.id}] LLM response: ${response.toolCalls.length} tool calls, finish=${response.finishReason}` +
        (response.reasoning ? `, reasoning=${response.reasoning.length}ch` : "") +
        `, content=${response.content?.slice(0, 200)}`,
      );

      // No tool calls → agent is done
      if (response.toolCalls.length === 0) {
        const finalResponseIssue = this.validateFinalResponse(response.content);
        const assistantContent: string | ContentBlock[] = response.reasoning
          ? [
              { type: "thinking", thinking: response.reasoning, thinking_signature: "reasoning_content" },
              ...(response.content ? [{ type: "text", text: response.content } as ContentBlock] : []),
            ]
          : response.content;
        this.pushMessage({ role: "assistant", content: assistantContent }, undefined, responseSource(response));
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
      if (response.reasoning) {
        assistantBlocks.push({
          type: "thinking",
          thinking: response.reasoning,
          thinking_signature: "reasoning_content",
        });
      }
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
      const resultBlocks: ContentBlock[] = await Promise.all(
        dispatchResult.toolResults.map(async (r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolUseId,
          content: await this.maybeStash(r.content, r.toolUseId),
          is_error: r.isError,
        })),
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
    // Pass 1: per-toolUseId → { name, roundId } from assistant tool_use blocks.
    const toolMeta = new Map<string, { name: string; roundId: string }>();
    for (const [idx, msg] of this.messages.entries()) {
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
      const roundId = this.messageRoundIds[idx] ?? `r-msg:${idx}`;
      for (const block of msg.content) {
        if (block.type === "tool_use" && block.id) {
          toolMeta.set(block.id, { name: block.name ?? "unknown", roundId });
        }
      }
    }

    // Pass 2: walk messages and emit entries.
    const entries: ConversationEntry[] = [];
    for (const [idx, msg] of this.messages.entries()) {
      const timestamp = this.messageTimestamps[idx];
      const source = msg.role === "assistant" ? this.messageSources[idx] ?? {} : {};
      const ownRoundId = this.messageRoundIds[idx]
        ?? (msg.role === "assistant" ? `r-msg:${idx}` : `r-msg:${idx}`);

      if (typeof msg.content === "string") {
        entries.push({
          role: msg.role,
          kind: "text",
          content: msg.content,
          timestamp,
          roundId: ownRoundId,
          messageIndex: idx,
          blockIndex: 0,
          ...source,
        });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;

      const textBlocks = msg.content.filter((block) => block.type === "text" && block.text);
      const toolUseBlocks = msg.content.filter((block) => block.type === "tool_use");
      if (msg.role === "assistant" && textBlocks.length === 0 && toolUseBlocks.length > 0) {
        entries.push({
          role: "assistant",
          kind: "activity",
          content: describeToolUseBlocks(toolUseBlocks),
          timestamp,
          roundId: ownRoundId,
          messageIndex: idx,
          blockIndex: -1,
          ...source,
        });
      }

      for (const [bIdx, block] of msg.content.entries()) {
        if (block.type === "text" && block.text) {
          entries.push({
            role: msg.role,
            kind: "text",
            content: block.text,
            timestamp,
            roundId: ownRoundId,
            messageIndex: idx,
            blockIndex: bIdx,
            ...source,
          });
        } else if (block.type === "tool_use") {
          const inputStr = typeof block.input === "string"
            ? block.input
            : JSON.stringify(block.input, null, 2);
          entries.push({
            role: "assistant",
            kind: "tool_call",
            toolUseId: block.id,
            toolName: block.name ?? "unknown",
            content: inputStr.length > 2000 ? inputStr.slice(0, 2000) + "\n…(truncated)" : inputStr,
            timestamp,
            roundId: ownRoundId,
            messageIndex: idx,
            blockIndex: bIdx,
            ...source,
          });
        } else if (block.type === "tool_result") {
          const meta = block.tool_use_id ? toolMeta.get(block.tool_use_id) : undefined;
          const text = block.content ?? block.text ?? "";
          entries.push({
            role: "system",
            kind: block.is_error ? "tool_error" : "tool_result",
            toolUseId: block.tool_use_id,
            toolName: meta?.name,
            content: text.length > 3000 ? text.slice(0, 3000) + "\n…(truncated)" : text,
            timestamp,
            roundId: meta?.roundId ?? ownRoundId,
            messageIndex: idx,
            blockIndex: bIdx,
          });
        }
      }
    }

    return [...entries, ...this.diagnostics].sort(
      (a, b) =>
        a.timestamp.localeCompare(b.timestamp)
        || a.messageIndex - b.messageIndex
        || a.blockIndex - b.blockIndex,
    );
  }

  // ─── Protected ──────────────────────────────────────────────────────────

  /** Make an LLM call with current conversation state.
   *  Retries on transient errors with exponential backoff
   *  (30s initial, x1.5, max 20min, max 50 attempts). Context overflow
   *  triggers compaction and immediate retry instead of backoff.
   */
  protected async callLLM(): Promise<ChatResponse> {
    const myRoundId = `r${++this.roundCounter}`;
    this.pendingRoundId = myRoundId;
    this.pendingCall = {
      started_at: new Date().toISOString(),
      status: "in_flight",
      attempt: 0,
      reason: null,
      retry_at: null,
    };
    this.recordActivity();

    const tools = this.getToolSchemas();

    log.info(
      `[agent:${this.role}:${this.id}] Calling LLM with ${tools.length} tools, ${this.messages.length} messages`,
    );

    let nonThrottleAttempts = 0;

    for (let attempt = 0; ; attempt++) {
      if (this.cancelled || this.abortSignal?.aborted) {
        this.pendingCall = null;
        this.pendingRoundId = null;
        throw new ProviderError({ kind: "non_retryable", message: "Agent cancelled" });
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
            { source: responseSource(response) },
          );
        }
        this.pendingCall = null;
        // F07 — monotonically-tightening calibration: only trust the provider count
        // when it exceeds our estimate by >10%, never loosen the trigger.
        const reported = response.usage?.inputTokens;
        const estimated = this.runningInputTokens + this.staticInputTokens;
        if (typeof reported === "number" && reported > estimated * 1.1) {
          this.runningInputTokens = Math.max(0, reported - this.staticInputTokens);
        }
        return response;
      } catch (err) {
        const pe = err instanceof ProviderError
          ? err
          : new ProviderError({
              kind: "transient",
              message: err instanceof Error ? err.message : String(err),
              cause: err,
            });
        const msg = pe.message;

        // Context overflow / orphaned tool result → compact and retry immediately (no backoff)
        if (pe.kind === "context_overflow" || pe.kind === "orphaned_tool_result") {
          const reason = pe.kind === "context_overflow"
            ? "context window exceeded"
            : "orphaned tool_result";
          if (isMaxCompactionsReached(this.compactionState, this.compactionConfig)) {
            const stopReason = this.compactionStopReason();
            const failure = `Cannot repair malformed model request: ${stopReason} (${reason}). Aborting this agent so the parent can handle the failure.`;
            this.addDiagnostic("model_issue", failure);
            this.pendingCall = null;
            this.pendingRoundId = null;
            throw new ProviderError({ kind: "non_retryable", message: failure, cause: pe });
          }
          this.addDiagnostic(
            "model_repair",
            `Model request issue detected (${reason}). Compacting/regenerating conversation context and retrying without adding this diagnostic to the prompt.`,
          );
          log.warn(
            `[agent:${this.role}:${this.id}] ${reason} — compacting and retrying`,
          );
          await this.compactWithReinjection();
          await this.drainChannels();
          this.pendingRoundId = myRoundId;
          continue;
        }

        // Non-retryable errors — propagate immediately
        if (pe.kind === "non_retryable") {
          this.pendingCall = null;
          this.pendingRoundId = null;
          throw pe;
        }

        const throttled = pe.kind === "throttling";

        // Only count non-throttling errors toward the retry cap
        if (!throttled) {
          nonThrottleAttempts++;
          if (nonThrottleAttempts >= this.transientCap) {
            const failure = `LLM call failed after ${nonThrottleAttempts} non-throttling attempts. Last error: ${truncateDiagnostic(msg)}`;
            this.addDiagnostic("model_issue", failure);
            this.pendingCall = null;
            this.pendingRoundId = null;
            throw new ProviderError({ kind: "transient", message: failure, cause: pe });
          }
        }

        // Transient errors → exponential backoff (clamped by retryAfterMs when present)
        const expSec = Math.min(
          LLM_BACKOFF_BASE_SECONDS * Math.pow(LLM_BACKOFF_MULT, attempt),
          LLM_BACKOFF_MAX_SECONDS,
        );
        const retryAfterSec = pe.retryAfterMs ? pe.retryAfterMs / 1000 : 0;
        const delaySec = Math.min(
          Math.max(expSec, retryAfterSec),
          LLM_BACKOFF_MAX_SECONDS,
        );
        const label = throttled ? "throttled" : "failed";
        log.warn(
          `[agent:${this.role}:${this.id}] LLM ${label} (attempt ${attempt + 1}): ${msg} — retrying in ${Math.round(delaySec)}s`,
        );
        this.addDiagnostic(
          "model_issue",
          `${throttled ? "Provider throttling" : "Temporary model service issue"} on attempt ${attempt + 1}. Retrying in ${Math.round(delaySec)}s. Error: ${truncateDiagnostic(msg)}`,
        );

        // Reset model health so the router retries the primary model
        this.ctx.router.resetModelHealth(this.ctx.modelSpec);

        const retryAt = new Date(Date.now() + delaySec * 1000).toISOString();
        this.pendingCall = {
          started_at: this.pendingCall?.started_at ?? new Date().toISOString(),
          status: "backoff",
          attempt: attempt + 1,
          reason: throttled ? "throttled" : "transient",
          retry_at: retryAt,
        };
        await this.sleepWithCancellation(delaySec * 1000);
        this.pendingCall = {
          started_at: new Date().toISOString(),
          status: "in_flight",
          attempt: attempt + 1,
          reason: null,
          retry_at: null,
        };
      }
    }
  }

  /** Get available tool schemas for this agent, filtered by role. */
  protected getToolSchemas(): ToolSchema[] {
    const allTools = this.ctx.mcpRuntime.getAllTools();
    const kind = getToolFilter(this.role);
    const filtered = allTools.filter((t: RuntimeToolEntry) =>
      applyToolFilter(kind, { name: t.name, service: t.service }),
    );
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
   * Threshold: 5% of context window (in tokens).
   */
  private async maybeStash(content: string, toolUseId: string): Promise<string> {
    const tokenBudget = Math.floor(this.compactionConfig.contextWindow * 0.05);
    const tokens = this.ctx.router.countTokens(this.ctx.modelSpec, [
      { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
    ]);
    if (tokens <= tokenBudget) return content;

    const path = await stashResult(content, `tool_${toolUseId}`);
    return (
      `[Result stashed to disk — too large for context window (${tokens} tokens)]\n` +
      `Use read_stash(path="${path}") to read portions of this result.`
    );
  }

  private recordActivity(): void {
    this.lastActivityAt = new Date().toISOString();
    this.onActivity?.(this.id);
  }

  private recordCompactionUpdate(): void {
    this.onCompactionUpdate?.(this.id, {
      count: this.compactionState.compactionCount,
      summarizerFallbacks: this.compactionState.summarizerFallbacks,
      consecutiveFallbacks: this.compactionState.consecutiveFallbacks,
      oversizedAtomicFallback: this.compactionState.oversizedAtomicFallback,
    });
  }

  private compactionStopReason(): string {
    if (this.compactionState.oversizedAtomicFallback) {
      return "oversized atomic tool round (use stash)";
    }
    if (this.compactionState.consecutiveFallbacks >= this.compactionConfig.maxConsecutiveFallbacks) {
      return "summarizer fallback exhausted";
    }
    return "max compactions exceeded";
  }

  /** Public lifecycle status for the dashboard. */
  public getActivityStatus(): ActivityStatus {
    return {
      pending_call: this.pendingCall ? { ...this.pendingCall } : null,
      last_activity_at: this.lastActivityAt,
    };
  }

  /** Cap on non-throttling LLM retries before giving up. Overridable in tests. */
  protected get transientCap(): number {
    return 500;
  }

  private addDiagnostic(
    kind: ConversationEntry["kind"],
    content: string,
    opts?: { roundId?: string; source?: LlmResponseSource },
  ): void {
    const roundId = opts?.roundId ?? this.pendingRoundId ?? this.currentRoundId ?? "r-pre";
    const entry: ConversationEntry = {
      role: "system",
      kind,
      content,
      timestamp: new Date().toISOString(),
      roundId,
      messageIndex: -1,
      blockIndex: this.diagnostics.length,
      ...(opts?.source ?? {}),
    };
    this.diagnostics.push(entry);
    if (this.diagnostics.length > MAX_DIAGNOSTIC_ENTRIES) {
      this.diagnostics.splice(0, this.diagnostics.length - MAX_DIAGNOSTIC_ENTRIES);
    }
    this.recordActivity();
  }

  protected pushMessage(message: Message, timestamp = new Date().toISOString(), source?: LlmResponseSource): void {
    this.messages.push(message);
    this.runningInputTokens += this.ctx.router.countTokens(this.ctx.modelSpec, [message]);
    this.messageTimestamps.push(timestamp);
    this.messageSources.push(source);
    if (message.role === "assistant") {
      // Assistant message completes the pending round: claim pending id, then clear pending.
      const roundId = this.pendingRoundId ?? this.currentRoundId ?? `r-msg:${this.messages.length - 1}`;
      this.messageRoundIds.push(roundId);
      this.currentRoundId = roundId;
      this.pendingRoundId = null;
    } else {
      this.messageRoundIds.push(null);
    }
    this.recordActivity();
  }

  protected replaceMessages(messages: Message[], timestamp = new Date().toISOString()): void {
    this.messages = messages;
    this.runningInputTokens = this.ctx.router.countTokens(this.ctx.modelSpec, messages);
    this.messageTimestamps = messages.map(() => timestamp);
    this.messageSources = messages.map(() => undefined);
    const compactionRound = `r-compacted-${++this.compactionCounter}`;
    this.messageRoundIds = messages.map(() => compactionRound);
    this.currentRoundId = null;
    this.pendingRoundId = null;
    this.recordActivity();
  }

  /**
   * FR-16 / WI-14 — §E.2 Planner pre-compaction memory-write window.
   * Injects the nudge and lets the model run up to 5 tool-call turns so
   * survivable knowledge gets persisted before the summary is built.
   * Only invoked when role === "planner".
   */
  private async runPlannerCompactionHook(): Promise<void> {
    const MAX_TURNS = 5;
    const NUDGE =
      "PRE-COMPACTION MEMORY HOOK: Conversation context is about to be compacted. " +
      "You have up to 5 tool-call turns to call create_memory / create_skill " +
      "for anything important that must survive compaction. " +
      "Reply with a final text answer (no tool calls) to skip.";
    this.pushMessage({ role: "user", content: NUDGE });

    let writeCount = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.cancelled || this.abortSignal?.aborted) break;
      let response: ChatResponse;
      try {
        response = await this.callLLM();
      } catch (err) {
        log.warn(
          `[agent:${this.role}:${this.id}] pre-compaction hook callLLM failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
      if (response.toolCalls.length === 0) {
        const content: string | ContentBlock[] = response.reasoning
          ? [
              { type: "thinking", thinking: response.reasoning, thinking_signature: "reasoning_content" },
              ...(response.content ? [{ type: "text", text: response.content } as ContentBlock] : []),
            ]
          : response.content;
        this.pushMessage({ role: "assistant", content }, undefined, responseSource(response));
        break;
      }
      const blocks: ContentBlock[] = [];
      if (response.reasoning) {
        blocks.push({ type: "thinking", thinking: response.reasoning, thinking_signature: "reasoning_content" });
      }
      if (response.content) blocks.push({ type: "text", text: response.content });
      for (const tc of response.toolCalls) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
        if (tc.name === "create_memory" || tc.name === "create_skill") writeCount += 1;
      }
      this.pushMessage({ role: "assistant", content: blocks }, undefined, responseSource(response));
      const dispatchResult = await this.dispatcher.processToolCalls(
        response.toolCalls,
        this.ctx,
        this.abortSignal,
      );
      const resultBlocks: ContentBlock[] = dispatchResult.toolResults.map((r) => ({
        type: "tool_result" as const,
        tool_use_id: r.toolUseId,
        content: r.content,
        is_error: r.isError,
      }));
      this.pushMessage({ role: "user", content: resultBlocks });
      if (dispatchResult.aborted) break;
    }
    try {
      this.onCompactionHookComplete?.(writeCount);
    } catch (err) {
      log.warn(
        `[agent:${this.role}:${this.id}] onCompactionHookComplete threw: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * FR-15 / WI-14 — Compact the conversation and append the §E.1 survivor
   * reinjection block (if the knowledge loader is enabled). Used by both
   * the pre-LLM-call compaction path and the model-repair compaction path.
   */
  private async compactWithReinjection(): Promise<void> {
    if (this.role === "planner") {
      try {
        await this.runPlannerCompactionHook();
      } catch (err) {
        log.warn(
          `[agent:${this.role}:${this.id}] pre-compaction hook failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    const summarized = await compactConversation(
      this.systemPrompt,
      this.messages,
      this.ctx.router,
      {
        ...this.compactionConfig,
        onFallback: (info) => {
          this.addDiagnostic(
            "model_repair",
            `Summarizer fallback (round-parser truncation). keptRounds=${info.keptRounds}${info.oversizedAtomic ? ", oversized atomic round" : ""}.`,
          );
        },
      },
      this.compactionState,
      this.ctx.modelSpec,
      this.getToolSchemas(),
    );
    let next: Message[] = summarized;
    try {
      const block = await buildSurvivorBlock(
        this.ctx.project.projectRoot,
        this.role as KnowledgeAgentRole,
        this.compactionState.compactionCount,
      );
      if (block) next = [...summarized, { role: "user", content: block }];
    } catch (err) {
      log.warn(
        `[agent:${this.role}:${this.id}] survivor reinjection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.replaceMessages(next);
    this.recordCompactionUpdate();
    for (const ch of this.inputChannels) ch.onContextReset();
  }

  /** Push pending channel messages into this.messages. Call immediately before any router.chat. */
  private async drainChannels(): Promise<void> {
    for (const ch of this.inputChannels) {
      const drained = await ch.drain();
      if (drained) this.pushMessage({ role: "user", content: drained.message });
    }
  }

  private async sleepWithCancellation(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (!this.cancelled && !this.abortSignal?.aborted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, deadline - Date.now())));
    }
    if (this.cancelled || this.abortSignal?.aborted) {
      this.pendingCall = null;
      this.pendingRoundId = null;
      throw new ProviderError({ kind: "non_retryable", message: "Agent cancelled" });
    }
  }
}

function truncateDiagnostic(value: string, max = 700): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

// ─── Error Classification ───────────────────────────────────────────────
// All provider-error classification lives in providers/error.ts. The
// agent layer consumes the ProviderError discriminant instead of running
// regex over English error strings.

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

const RUN_CODER_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_coder",
  "Dispatch a coding task to a Coder worker agent. Returns a TaskReport.",
  "The task to execute",
);

const RUN_RESEARCHER_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_researcher",
  "Dispatch a research task to a Researcher worker agent. Returns a TaskReport.",
  "The research task",
);

const RUN_DATA_AGENT_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_data_agent",
  "Dispatch a data acquisition task to a Data Agent. Use for finding, downloading, validating, and documenting external datasets or API data. Returns a TaskReport.",
  "The data acquisition task",
);

const RUN_REVIEWER_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_reviewer",
  "Dispatch a review task to a Reviewer worker agent after stage work is done. Use to validate stage objectives, acceptance criteria, work products, data/statistical quality, and issues before writing StageSummary. Returns a TaskReport.",
  "The review task",
);

const RUN_DESIGNER_SCHEMA: ToolSchema = makeWorkerDispatchSchema(
  "run_designer",
  "Dispatch a design task to a Designer worker agent. Use for product, UX, interface, information-architecture, or system-design work that should be settled before coding starts. Returns a TaskReport.",
  "The design task",
);

function makeWorkerDispatchSchema(
  name: string,
  description: string,
  taskDescription: string,
): ToolSchema {
  return {
    name,
    description,
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "object",
          description: taskDescription,
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
}

/** Role → dispatch tools mapping. Only expose tools each role should use. */
/** Tool schema indexed by dispatch tool name (derived from roster). */
const DISPATCH_SCHEMA_BY_TOOL: Record<string, ToolSchema> = {
  run_manager: RUN_MANAGER_SCHEMA,
  run_inspector: RUN_INSPECTOR_SCHEMA,
  run_coder: RUN_CODER_SCHEMA,
  run_researcher: RUN_RESEARCHER_SCHEMA,
  run_data_agent: RUN_DATA_AGENT_SCHEMA,
  run_reviewer: RUN_REVIEWER_SCHEMA,
  run_designer: RUN_DESIGNER_SCHEMA,
};

/** Role → dispatch tools mapping, derived from `ROSTER[*].dispatchableBy`. */
const ROLE_DISPATCH_TOOLS: Partial<Record<AgentRole, ToolSchema[]>> = (() => {
  const map: Partial<Record<AgentRole, ToolSchema[]>> = {};
  for (const entry of ROSTER) {
    if (!entry.dispatchTool) continue;
    const schema = DISPATCH_SCHEMA_BY_TOOL[entry.dispatchTool];
    if (!schema) {
      throw new Error(`Missing dispatch schema for tool ${entry.dispatchTool}`);
    }
    for (const parent of entry.dispatchableBy) {
      const key = parent as AgentRole;
      (map[key] ??= []).push(schema);
    }
  }
  return map;
})();

function getDispatchToolsForRole(role: AgentRole): ToolSchema[] {
  return ROLE_DISPATCH_TOOLS[role] ?? [];
}
