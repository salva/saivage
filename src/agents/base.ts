/**
 * Saivage — Agent Base Class
 * Wraps LLM provider calls, assembles context (system prompt + skills + references),
 * manages the conversation loop, tool execution, compaction, and stash.
 */

import type {
  Message,
  ContentBlock,
  ChatResponse,
  ToolSchema,
  ToolCallResult,
} from "../providers/types.js";
import { ProviderError } from "../providers/error.js";
import type {
  AgentContext,
  AgentRole,
  InputChannel,
} from "./types.js";
import { getToolFilter } from "./roster.js";
import { applyToolFilter } from "./tool-filters.js";
import { Dispatcher } from "../runtime/dispatcher.js";
import type { DispatchResult } from "../runtime/dispatcher.js";
import {
  type CompactionConfig,
  type CompactionState,
} from "../runtime/compaction.js";
import { stashResult } from "../runtime/stash.js";
import type { RuntimeToolEntry } from "../mcp/runtime.js";
import { log } from "../log.js";
import {
  ConversationState,
  type ConversationEntry,
  type LlmResponseSource,
} from "./conversation-state.js";
import { RetryPolicy } from "./retry-policy.js";
import { CompactionController } from "./compaction-controller.js";
import type { BaseAgentConfig } from "./base-config.js";
import { getDispatchToolsForRole, TRIVIAL_EVIDENCE_TOOLS } from "./dispatch-tool-schemas.js";
import { PendingCallTracker } from "./pending-call-tracker.js";

export type { ConversationEntry, LlmResponseSource } from "./conversation-state.js";
export type { BaseAgentConfig } from "./base-config.js";

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
  private conversation: ConversationState;
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
  private compactionController: CompactionController;
  private abortSignal?: { aborted: boolean };
  private onActivity?: (agentId: string) => void;
  private onCompactionUpdate?: BaseAgentConfig["onCompactionUpdate"];
  private toolCallNames: string[] = [];
  private meaningfulToolCallNames: string[] = [];
  private invalidFinalResponseCount = 0;
  private lastActivityAt: string = new Date().toISOString();
  private pendingCallTracker = new PendingCallTracker();
  private onCompactionHookComplete?: (writeCount: number) => void;
  private readonly inputChannels: InputChannel[];
  private staticInputTokens = 0;
  readonly startedAt = new Date().toISOString();

  constructor(ctx: AgentContext, config: BaseAgentConfig) {
    this.id = ctx.agentId;
    this.role = ctx.role;
    this.ctx = ctx;
    this.conversation = new ConversationState({
      modelSpec: ctx.modelSpec,
      countTokens: ctx.router.countTokens.bind(ctx.router),
    });

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

    this.compactionController = new CompactionController({
      agentId: this.id,
      role: this.role,
      projectRoot: this.ctx.project.projectRoot,
      router: this.ctx.router,
      modelSpec: this.ctx.modelSpec,
      systemPrompt: this.systemPrompt,
      compactionConfig: this.compactionConfig,
      compactionState: this.compactionState,
      inputChannels: this.inputChannels,
      getMessages: () => this.messages,
      getToolSchemas: () => this.getToolSchemas(),
      replaceMessages: (messages) => this.replaceMessages(messages),
      addDiagnostic: (kind, content) => this.addDiagnostic(kind, content),
      onCompactionUpdate: this.onCompactionUpdate,
    });

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
  async runLoop(): Promise<{
    text: string;
    finishReason: string;
    source?: LlmResponseSource;
    terminal?: { name: string; data: unknown };
  }> {
    while (!this.cancelled) {
      // Check for abort
      if (this.abortSignal?.aborted) {
        return { text: "Aborted by user", finishReason: "abort" };
      }

      // Check compaction before LLM call
      if (this.compactionController.shouldCompact(this.conversation.runningInputTokens + this.staticInputTokens)) {
        if (this.compactionController.isStopReached()) {
          const stopReason = this.compactionController.stopReason();
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
          const repair = this.recordInvalidFinalResponse(finalResponseIssue, responseSource(response));
          if (repair) return repair;
          continue;
        }
        this.invalidFinalResponseCount = 0;
        this.conversation.clearPendingRepairPrompt();
        return { text: response.content, finishReason: response.finishReason, source: responseSource(response) };
      }

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
      const meaningfulNames = response.toolCalls
        .filter((tc) => this.isMeaningfulToolEvidence(tc, dispatchResult))
        .map((tc) => tc.name);
      if (meaningfulNames.length > 0) {
        this.meaningfulToolCallNames.push(...meaningfulNames);
        this.invalidFinalResponseCount = 0;
      }

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

      if (this.abortSignal?.aborted || dispatchResult.aborted) {
        return { text: "Aborted during tool execution", finishReason: "abort" };
      }

      const terminal = this.detectTerminalToolCall(response.toolCalls, dispatchResult);
      if (terminal) {
        const terminalIssue = this.validateTerminalToolCall(terminal);
        if (terminalIssue) {
          const repair = this.recordInvalidFinalResponse(terminalIssue, responseSource(response));
          if (repair) return repair;
          continue;
        }
        this.invalidFinalResponseCount = 0;
        this.conversation.clearPendingRepairPrompt();
        return {
          text: response.content,
          finishReason: "tool_terminal",
          source: responseSource(response),
          terminal,
        };
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
    return this.conversation.messageCount;
  }

  /** Return a serializable snapshot of the conversation for the dashboard. */
  getConversationSnapshot(): ConversationEntry[] {
    return this.conversation.snapshot();
  }

  protected get messages(): Message[] {
    return this.conversation.messages;
  }

  // ─── Protected ──────────────────────────────────────────────────────────

  /** Make an LLM call with current conversation state.
   *  Retries on transient errors with exponential backoff
   *  (30s initial, x1.5, max 20min, max 50 attempts). Context overflow
   *  triggers compaction and immediate retry instead of backoff.
   */
  protected async callLLM(): Promise<ChatResponse> {
    const myRoundId = this.conversation.startRound();
    this.pendingCallTracker.startInFlight(0);
    this.recordActivity();

    const tools = this.getToolSchemas();

    log.info(
      `[agent:${this.role}:${this.id}] Calling LLM with ${tools.length} tools, ${this.messages.length} messages`,
    );

    const retryPolicy = new RetryPolicy({ transientCap: this.transientCap });

    for (let attempt = 0; ; attempt++) {
      if (this.cancelled || this.abortSignal?.aborted) {
        this.pendingCallTracker.clear();
        this.conversation.clearPendingRound();
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
        this.pendingCallTracker.clear();
        this.conversation.recordReportedInputTokens(response.usage?.inputTokens, this.staticInputTokens);
        return response;
      } catch (err) {
        const decision = retryPolicy.decide(err, attempt);

        // Context overflow / orphaned tool result → compact and retry immediately (no backoff)
        if (decision.kind === "repair_context") {
          const { error: pe, reason } = decision;
          if (this.compactionController.isStopReached()) {
            const stopReason = this.compactionController.stopReason();
            const failure = `Cannot repair malformed model request: ${stopReason} (${reason}). Aborting this agent so the parent can handle the failure.`;
            this.addDiagnostic("model_issue", failure);
            this.pendingCallTracker.clear();
            this.conversation.clearPendingRound();
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
          this.conversation.restorePendingRound(myRoundId);
          continue;
        }

        // Non-retryable errors — propagate immediately
        if (decision.kind === "throw") {
          if (decision.error.kind === "transient") {
            this.addDiagnostic("model_issue", decision.error.message);
          }
          this.pendingCallTracker.clear();
          this.conversation.clearPendingRound();
          throw decision.error;
        }

        // Transient errors → exponential backoff (clamped by retryAfterMs when present)
        log.warn(
          `[agent:${this.role}:${this.id}] LLM ${decision.label} (attempt ${decision.attemptNumber}): ${decision.error.message} — retrying in ${Math.round(decision.delaySec)}s`,
        );
        this.addDiagnostic("model_issue", decision.diagnostic);

        // Reset model health so the router retries the primary model
        this.ctx.router.resetModelHealth(this.ctx.modelSpec);

        const retryAt = new Date(Date.now() + decision.delaySec * 1000).toISOString();
        this.pendingCallTracker.startBackoff({
          attempt: decision.attemptNumber,
          reason: decision.pendingReason,
          retryAt,
        });
        await this.sleepWithCancellation(decision.delaySec * 1000);
        this.pendingCallTracker.startInFlight(decision.attemptNumber);
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

  protected validateTerminalToolCall(_terminal: { name: string; data: unknown }): string | null {
    return null;
  }

  protected detectTerminalToolCall(
    _toolCalls: ToolCallResult[],
    _dispatchResult: DispatchResult,
  ): { name: string; data: unknown } | null {
    return null;
  }

  protected getToolCallNames(): readonly string[] {
    return this.toolCallNames;
  }

  protected hasUsedAnyTool(): boolean {
    return this.toolCallNames.length > 0;
  }

  protected hasMeaningfulToolEvidence(): boolean {
    return this.meaningfulToolCallNames.length > 0;
  }

  protected hasUsedToolNamed(...toolNames: string[]): boolean {
    const allowed = new Set(toolNames);
    return this.toolCallNames.some((name) => allowed.has(name));
  }

  protected hasMeaningfulToolNamed(...toolNames: string[]): boolean {
    const allowed = new Set(toolNames);
    return this.meaningfulToolCallNames.some((name) => allowed.has(name));
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

  private recordInvalidFinalResponse(
    finalResponseIssue: string,
    source?: LlmResponseSource,
  ): { text: string; finishReason: string; source?: LlmResponseSource } | null {
    this.invalidFinalResponseCount += 1;
    this.addDiagnostic("model_repair", finalResponseIssue, { source });
    if (this.invalidFinalResponseCount >= BaseAgent.MAX_INVALID_FINAL_RESPONSES) {
      return {
        text: `Agent terminated after ${this.invalidFinalResponseCount} invalid final responses: ${finalResponseIssue}`,
        finishReason: "error",
        source,
      };
    }
    const prompt = `${finalResponseIssue} Continue the task by using the required tools and return a final result only after real execution evidence exists.`;
    this.conversation.setPendingRepairPrompt(prompt);
    this.pushMessage({ role: "user", content: prompt });
    return null;
  }

  private isMeaningfulToolEvidence(toolCall: ToolCallResult, dispatchResult: DispatchResult): boolean {
    const result = dispatchResult.toolResults.find((tr) => tr.toolUseId === toolCall.id);
    if (result?.isError) return false;
    return !TRIVIAL_EVIDENCE_TOOLS.has(toolCall.name);
  }

  /** Public lifecycle status for the dashboard. */
  public getActivityStatus(): ActivityStatus {
    return {
      pending_call: this.pendingCallTracker.snapshot(),
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
    this.conversation.addDiagnostic(kind, content, opts);
    this.recordActivity();
  }

  protected pushMessage(message: Message, timestamp = new Date().toISOString(), source?: LlmResponseSource): void {
    this.conversation.pushMessage(message, timestamp, source);
    this.recordActivity();
  }

  protected replaceMessages(messages: Message[], timestamp = new Date().toISOString()): void {
    this.conversation.replaceMessages(messages, timestamp);
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
    const pendingRepairPrompt = this.conversation.pendingRepairPrompt;
    await this.compactionController.compact(
      this.role === "planner"
        ? async () => {
            try {
              await this.runPlannerCompactionHook();
            } catch (err) {
              log.warn(
                `[agent:${this.role}:${this.id}] pre-compaction hook failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        : undefined,
    );
    if (pendingRepairPrompt) {
      this.pushMessage({ role: "user", content: pendingRepairPrompt });
      this.conversation.setPendingRepairPrompt(pendingRepairPrompt);
    }
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
      this.pendingCallTracker.clear();
      this.conversation.clearPendingRound();
      throw new ProviderError({ kind: "non_retryable", message: "Agent cancelled" });
    }
  }
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
