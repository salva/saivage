/**
 * Saivage — MCP tool-call context.
 *
 * Source of truth: docs/internals/knowledge/skills-and-memory.md
 * (security + audit).
 * In-process tool handlers receive a `ToolCallContext` so they can attribute
 * writes to the calling agent (`role`, `agentId`, current `stageId` /
 * `channelId` / `sessionId`). External MCP subprocess tools ignore it.
 *
 * The context is OPTIONAL on the handler signature so existing handlers
 * that don't need attribution keep working. Knowledge-store handlers
 * (added in M2) will require it.
 */

import type { AgentRole } from "../agents/types.js";
import type { InProcessToolHandler } from "./runtime.js";

export interface ToolCallContext {
  /** Calling agent's role (planner | manager | coder | …). */
  role: AgentRole;
  /** Calling agent's instance id. */
  agentId: string;
  /** Project root (`<project>/`). */
  projectRoot: string;
  /**
   * Human-friendly author string for audit entries; defaults to
   * `<role>:<agentId>` when omitted.
   */
  author?: string;
  /** Current stage id, if the call originates from a stage-scoped agent. */
  stageId?: string;
  /** Chat channel id (web | telegram | …) for Chat-agent calls. */
  channelId?: string;
  /** Chat session id (per-channel monotonic id) for Chat-agent calls. */
  sessionId?: string;
  /**
   * Marks the call as originating from an operator-driven runtime path
   * (CLI invocation or HTTP/slash command bound to the operator). Set
   * only by the server bootstrap and CLI entry points; agent dispatch
   * paths and chat sessions MUST leave this unset.
   *
   * Authorization decisions that grant operator-only privileges (e.g.
   * RAG control tools without an admin role) MUST consult this flag via
   * `isRuntimeOperatorContext` in `src/server/rag/service.ts` and never
   * infer operator-ness from `role`.
   */
  operatorContext?: boolean;
}

/**
 * Wrap an in-process handler so callers may pass a `ToolCallContext`
 * even if the handler signature predates the change. Returns a new
 * handler whose third argument carries the context.
 */
export function withContext<H extends InProcessToolHandler>(handler: H): InProcessToolHandler {
  return (toolName, args, ctx?) => handler(toolName, args, ctx);
}

/**
 * Derive a stable `author` string for audit records when none is supplied.
 */
export function defaultAuthor(ctx: Pick<ToolCallContext, "role" | "agentId" | "author">): string {
  return ctx.author ?? `${ctx.role}:${ctx.agentId}`;
}
