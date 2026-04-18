/**
 * Protocol types for orchestrator ↔ sub-agent communication.
 */

export interface TaskAssignment {
  id: string;
  type: string; // "code" | "research" | "execute" | "plan" | "chat"
  goal: string;
  context?: string;
  skills?: string[];
  project?: "target" | "self";
  branch?: string;
  parentId?: string;
}

export interface AgentProgressEvent {
  agentId: string;
  taskId: string;
  iteration: number;
  summary: string;
}

export interface AgentCompletedEvent {
  agentId: string;
  taskId: string;
  result: string;
  artifacts?: string[];
}

export interface AgentFailedEvent {
  agentId: string;
  taskId: string;
  error: string;
  iteration: number;
}

export interface AgentBlockedEvent {
  agentId: string;
  taskId: string;
  reason: string;
  missingTool?: string;
}

export type AgentEvent =
  | { type: "agent:progress"; data: AgentProgressEvent }
  | { type: "agent:completed"; data: AgentCompletedEvent }
  | { type: "agent:failed"; data: AgentFailedEvent }
  | { type: "agent:blocked"; data: AgentBlockedEvent };
