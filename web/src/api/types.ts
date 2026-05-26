// Hand-written mirror of the Saivage HTTP response shapes consumed by the SPA.
// Canonical sources are the server-side Zod schemas in src/types.ts and the
// conversation snapshot interfaces in src/agents/base.ts.

export type AgentRole =
  | "planner"
  | "manager"
  | "coder"
  | "researcher"
  | "data_agent"
  | "reviewer"
  | "designer"
  | "inspector"
  | "chat";

export interface AgentCompactionState {
  count: number;
  summarizer_fallbacks: number;
  consecutive_fallbacks: number;
  oversized_atomic_fallback: boolean;
}

export interface AgentState {
  agent_type: AgentRole;
  agent_id: string;
  status: "running" | "suspended" | "idle";
  current_task_id?: string;
  channel?: string;
  started_at: string;
  compaction?: AgentCompactionState;
}

export interface RuntimeState {
  status: "idle" | "running" | "suspended" | "error";
  current_stage_id: string | null;
  active_agents: AgentState[];
  started_at: string;
  updated_at: string;
  pid: number;
}

export interface PlanStage {
  id: string;
  objective: string;
  starting_points: string[];
  expected_outcomes: string[];
  acceptance_criteria: string[];
  references: string[];
  tags: string[];
  started_at?: string;
}

export interface Plan {
  updated_at: string;
  current_stage_id: string | null;
  stages: PlanStage[];
}

export interface ApiState {
  state: RuntimeState | null;
  plan: Plan | null;
}

export type ConversationEntryKind =
  | "text"
  | "activity"
  | "model_issue"
  | "model_repair"
  | "model_recovered"
  | "tool_call"
  | "tool_result"
  | "tool_error";

export interface ConversationEntry {
  role: "user" | "assistant" | "system";
  kind: ConversationEntryKind;
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

export interface AgentConversation {
  agent_id: string;
  role: AgentRole;
  started_at?: string;
  message_count: number;
  entries: ConversationEntry[];
  activity_status: ActivityStatus | null;
  finished_at?: string;
}

export interface SystemEvent {
  type:
    | "stage_completed"
    | "stage_failed"
    | "escalation"
    | "inspector_complete"
    | "task_failed"
    | "plan_updated";
  stage_id?: string;
  task_id?: string;
  report_id?: string;
  summary: string;
  timestamp?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
  provider?: string;
  model?: string;
  modelSpec?: string;
  requestedModelSpec?: string;
  event?: SystemEvent;
  note_id?: string;
  inspector_request_id?: string;
}

export interface ChatLog {
  session_id: string;
  channel: string;
  started_at: string;
  updated_at: string;
  messages: ChatMessage[];
}

export interface ChatSession {
  session_id: string;
  channel: string;
  started_at: string;
  updated_at: string;
  message_count: number;
}
