/**
 * Saivage — Agent types
 * Base interfaces for the agent system.
 */

import type {
  Stage,
  Task,
  InspectionRequest,
  Escalation,
} from "../types.js";
import type { ProjectContext } from "../store/project.js";
import type { ModelRouter } from "../providers/router.js";
import type { McpRuntime } from "../mcp/runtime.js";
import type { NoteManager } from "../runtime/notes.js";

import type { AgentRole } from "./roster.js";
export type { AgentRole };

/** Result of an agent's execution. */
export type AgentResult =
  | { kind: "success"; data: unknown }
  | { kind: "failure"; reason: string; partial?: unknown }
  | { kind: "escalation"; escalation: Escalation }
  | { kind: "abort"; reason: string; partial?: unknown };

/** Context passed to every agent on creation. */
export interface AgentContext {
  /** Resolved project paths and configuration. */
  project: ProjectContext;
  /** LLM provider router. */
  router: ModelRouter;
  /** MCP service runtime for tool calls. */
  mcpRuntime: McpRuntime;
  /** Shared runtime-owned note lifecycle manager. */
  noteManager: NoteManager;
  /** Agent instance ID. */
  agentId: string;
  /** Role of this agent. */
  role: AgentRole;
  /** Model spec to use (e.g. "provider/model"). */
  modelSpec: string;
  /** Optional exact auth profile to use for the selected provider. */
  authProfileKey?: string;
  /** Optional provider account reference (provider.account). */
  accountRef?: string;
  /** Runtime-supplied startup directives for the current agent instance. */
  startupDirectives?: string[];
  /** Active stage id for stage-scoped agents (manager, worker, inspector). */
  stageId?: string;
  /** Chat channel id for chat-scoped agents (web | telegram | …). */
  channelId?: string;
  /** Chat session id (per-channel monotonic id) for chat-scoped agents. */
  sessionId?: string;
}

/** Inputs for each agent type. */
export interface ManagerInput {
  stage: Stage;
}

export interface WorkerInput {
  task: Task;
  stageId: string;
}

export interface InspectorInput {
  request: InspectionRequest;
}

export interface ChatInput {
  channel: string;
  sessionId: string;
}

/** Agent interface — all agents implement this. */
export interface Agent {
  readonly id: string;
  readonly role: AgentRole;

  /**
   * Run the agent to completion.
   * Returns when the agent is done (success/failure/escalation/abort).
   */
  run(): Promise<AgentResult>;

  /**
   * Cancel the agent (used during abort).
   */
  cancel(): void;
}

/** Input channel for BaseAgent — pushes pending messages and reacts to context resets. */
export interface InputChannel {
  /** Return a single user-role message to inject before the next LLM turn, or null if nothing is pending. */
  drain(): Promise<{ message: string } | null>;
  /** Called by BaseAgent immediately after any successful compaction (after replaceMessages). */
  onContextReset(): void;
}
