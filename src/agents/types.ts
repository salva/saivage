/**
 * Saivage v2 — Agent types
 * Base interfaces for the agent system.
 */

import type {
  Stage,
  Task,
  TaskReport,
  StageSummary,
  InspectionRequest,
  InspectionReport,
  Escalation,
} from "../types.js";
import type { ProjectContext } from "../store/project.js";
import type { ModelRouter } from "../providers/router.js";
import type { McpRuntime } from "../mcp/runtime.js";

/** Agent roles in the hierarchy. */
export type AgentRole =
  | "planner"
  | "manager"
  | "coder"
  | "researcher"
  | "inspector"
  | "chat";

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
  /** Agent instance ID. */
  agentId: string;
  /** Role of this agent. */
  role: AgentRole;
  /** Model spec to use (e.g. "openai-codex/gpt-5.3-codex"). */
  modelSpec: string;
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
