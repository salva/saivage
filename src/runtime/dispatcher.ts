/**
 * Saivage — Tool-call Dispatcher
 * Nested tool-call pattern: intercept agent-dispatch calls, suspend parent,
 * spawn child, resume parent with result. Supports parallel dispatch with
 * resume-on-each.
 */

import type { Message, ContentBlock, ToolCallResult, ChatResponse, ToolSchema } from "../providers/types.js";
import { ProviderError } from "../providers/error.js";
import type { AgentContext, AgentResult } from "../agents/types.js";
import { ROSTER, type DispatchableRole } from "../agents/roster.js";
import type { McpRuntime, RuntimeToolEntry } from "../mcp/runtime.js";
import { readStash } from "./stash.js";
import { log } from "../log.js";

/** Maps dispatch tool name to child agent role. */
export const DISPATCH_ROLE_MAP: Record<string, DispatchableRole> = Object.fromEntries(
  ROSTER
    .filter((entry) => entry.dispatchTool !== null)
    .map((entry) => [entry.dispatchTool as string, entry.role as DispatchableRole]),
);

/** Agent-dispatch tool names that trigger suspend/resume. */
export const DISPATCH_TOOLS = new Set<string>(Object.keys(DISPATCH_ROLE_MAP));

/** Handler for spawning a child agent and running it to completion. */
export type ChildSpawner = (
  role: DispatchableRole,
  input: unknown,
  parentCtx: AgentContext,
) => Promise<AgentResult>;

/** Result of processing tool calls from an LLM response. */
export interface DispatchResult {
  /** Tool results to inject back into the conversation. */
  toolResults: ToolCallResultEntry[];
  /** Whether an abort signal was detected during dispatch. */
  aborted: boolean;
}

export interface ToolCallResultEntry {
  toolUseId: string;
  content: string;
  isError: boolean;
}

/**
 * The Dispatcher handles all tool calls from an LLM response.
 * - Local tools are executed immediately via MCP runtime.
 * - Agent dispatch tools spawn child agents and suspend the parent.
 * - Parallel dispatch is supported with resume-on-each semantics.
 */
export class Dispatcher {
  private mcpRuntime: McpRuntime;
  private childSpawner: ChildSpawner | null = null;
  private consecutiveInvalidCalls = 0;
  private static readonly MAX_CONSECUTIVE_INVALID = 3;

  constructor(mcpRuntime: McpRuntime) {
    this.mcpRuntime = mcpRuntime;
  }

  /** Register the child spawner callback. */
  setChildSpawner(spawner: ChildSpawner): void {
    this.childSpawner = spawner;
  }

  /**
   * Process all tool calls from an LLM response.
   * Returns tool results to inject back into the conversation.
   */
  async processToolCalls(
    toolCalls: ToolCallResult[],
    ctx: AgentContext,
    abortSignal?: { aborted: boolean },
  ): Promise<DispatchResult> {
    const results: ToolCallResultEntry[] = [];
    let aborted = false;

    // Separate local tools from dispatch tools
    const localCalls: ToolCallResult[] = [];
    const dispatchCalls: ToolCallResult[] = [];

    for (const tc of toolCalls) {
      if (DISPATCH_TOOLS.has(tc.name)) {
        dispatchCalls.push(tc);
      } else {
        localCalls.push(tc);
      }
    }

    // Execute local tools immediately (sequentially to avoid race conditions)
    for (const tc of localCalls) {
      if (abortSignal?.aborted) {
        aborted = true;
        results.push({
          toolUseId: tc.id,
          content: "Aborted: operation cancelled",
          isError: true,
        });
        continue;
      }
      const result = await this.executeLocalTool(tc, ctx);
      results.push(result);
    }

    // Enforce dispatch constraints: max 1 worker of each type per batch.
    const { allowed: allowedDispatches, rejected } =
      this.enforceDispatchLimits(dispatchCalls);

    // Add rejection results for duplicate dispatches
    for (const tc of rejected) {
      results.push({
        toolUseId: tc.id,
        content: `Error: only 1 ${DISPATCH_ROLE_MAP[tc.name]} can run concurrently. This dispatch was rejected.`,
        isError: true,
      });
    }

    // Execute dispatch tools (start all concurrently, collect as they complete)
    const dispatchPromises = allowedDispatches.map(async (tc) => {
      if (abortSignal?.aborted) {
        return {
          toolUseId: tc.id,
          content: "Aborted: operation cancelled",
          isError: true,
        } as ToolCallResultEntry;
      }
      return await this.executeDispatchTool(tc, ctx);
    });

    const dispatchResults = await Promise.all(dispatchPromises);
    results.push(...dispatchResults);

    return { toolResults: results, aborted };
  }

  /** Execute a local tool (filesystem, shell, git, web, plan, etc.) via MCP runtime. */
  private async executeLocalTool(
    tc: ToolCallResult,
    ctx: AgentContext,
  ): Promise<ToolCallResultEntry> {
    try {
      // Handle synthetic read_stash tool
      if (tc.name === "read_stash") {
        const args = tc.input as { path?: string; offset?: number; length?: number };
        if (!args.path) {
          return { toolUseId: tc.id, content: "Error: 'path' is required for read_stash", isError: true };
        }
        const result = await readStash(args.path, args.offset ?? 0, args.length ?? 10_000);
        this.consecutiveInvalidCalls = 0;
        return { toolUseId: tc.id, content: JSON.stringify(result), isError: false };
      }

      // Find which service owns this tool
      const allTools = this.mcpRuntime.getAllTools();
      const toolEntry = allTools.find(
        (t: RuntimeToolEntry) => t.name === tc.name,
      );

      if (!toolEntry) {
        this.consecutiveInvalidCalls++;
        const available = allTools.map((t: RuntimeToolEntry) => t.name).join(", ");
        if (this.consecutiveInvalidCalls >= Dispatcher.MAX_CONSECUTIVE_INVALID) {
          throw new ProviderError({
            kind: "non_retryable",
            message: `${Dispatcher.MAX_CONSECUTIVE_INVALID} consecutive invalid tool calls`,
          });
        }
        return {
          toolUseId: tc.id,
          content: `Error: unknown tool '${tc.name}'. Available tools: [${available}]`,
          isError: true,
        };
      }

      this.consecutiveInvalidCalls = 0;

      const args = (tc.input ?? {}) as Record<string, unknown>;
      const toolCtx = {
        role: ctx.role,
        agentId: ctx.agentId,
        projectRoot: ctx.project.projectRoot,
        ...(ctx.stageId ? { stageId: ctx.stageId } : {}),
        ...(ctx.channelId ? { channelId: ctx.channelId } : {}),
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      };
      const result = await this.mcpRuntime.callTool(
        toolEntry.service,
        tc.name,
        args,
        toolCtx,
      );

      const content =
        typeof result === "string" ? result : JSON.stringify(result);
      return { toolUseId: tc.id, content, isError: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      // Check for 3 consecutive invalid calls
      if (err instanceof ProviderError && err.kind === "non_retryable") {
        throw err; // Propagate to terminate the agent
      }
      if (message.includes("consecutive invalid tool calls")) {
        throw err;
      }

      return {
        toolUseId: tc.id,
        content: `Error: ${message}`,
        isError: true,
      };
    }
  }

  /** Execute a dispatch tool (spawn child agent). */
  private async executeDispatchTool(
    tc: ToolCallResult,
    ctx: AgentContext,
  ): Promise<ToolCallResultEntry> {
    if (!this.childSpawner) {
      return {
        toolUseId: tc.id,
        content: "Error: agent dispatch not available in this context",
        isError: true,
      };
    }

    const role = DISPATCH_ROLE_MAP[tc.name];
    if (!role) {
      return {
        toolUseId: tc.id,
        content: `Error: unknown dispatch tool '${tc.name}'`,
        isError: true,
      };
    }

    try {
      log.info(`[dispatcher] Spawning ${role} agent from ${ctx.role}`);
      const result = await this.childSpawner(role, tc.input, ctx);

      // Format the result for the parent conversation
      const content = JSON.stringify(result.kind === "success" ? result.data : result);
      return {
        toolUseId: tc.id,
        content,
        isError: result.kind === "failure" || result.kind === "abort",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`[dispatcher] Child ${role} failed: ${message}`);
      return {
        toolUseId: tc.id,
        content: `Error spawning ${role}: ${message}`,
        isError: true,
      };
    }
  }

  /**
  * Enforce dispatch limits: max 1 of each worker type per batch.
   * Excess calls of the same type are rejected.
   */
  private enforceDispatchLimits(
    calls: ToolCallResult[],
  ): { allowed: ToolCallResult[]; rejected: ToolCallResult[] } {
    const seen: Record<string, boolean> = {};
    const allowed: ToolCallResult[] = [];
    const rejected: ToolCallResult[] = [];

    for (const tc of calls) {
      const role = DISPATCH_ROLE_MAP[tc.name];
      if (!role) continue;

      // For workers, enforce max 1 of each.
      if (role === "coder" || role === "researcher" || role === "data_agent" || role === "reviewer") {
        if (seen[role]) {
          log.warn(
            `[dispatcher] Rejecting duplicate ${role} dispatch — max 1 per batch`,
          );
          rejected.push(tc);
          continue;
        }
        seen[role] = true;
      }

      allowed.push(tc);
    }

    return { allowed, rejected };
  }

  /** Reset the consecutive invalid call counter. */
  resetInvalidCounter(): void {
    this.consecutiveInvalidCalls = 0;
  }

  /** Get the current consecutive invalid call count. */
  get invalidCallCount(): number {
    return this.consecutiveInvalidCalls;
  }
}
