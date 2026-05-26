/**
 * Saivage — Type definitions and Zod schemas
 * All interfaces from SPEC/v2/01-DATA-MODEL.md
 */

import { z } from "zod";
import { projectRoutingSchema } from "./routing/resolver.js";
import { ALL_ROLES, WORKER_ROLES } from "./agents/roster.js";

// ─── 1. Project Config ──────────────────────────────────────────────────────

export const ProjectConfigSchema = z.object({
  project_name: z.string(),
  objectives: z.array(z.string()),
  model_overrides: z.record(z.string(), z.string()).optional(),
  routing: projectRoutingSchema.optional(),
  skills: z.object({
    max_per_agent: z.number().default(5),
  }),
  agents: z
    .record(
      z.string(),
      z.object({
        compaction_threshold_pct: z.number().default(80),
        max_compactions: z.number().default(3),
      }),
    )
    .optional(),
});
export type ProjectConfig = z.output<typeof ProjectConfigSchema>;

// ─── 3. Plan ────────────────────────────────────────────────────────────────

export const StageSchema = z.object({
  id: z.string().min(1),
  objective: z.string().min(1).max(1000),
  starting_points: z.array(z.string()),
  expected_outcomes: z.array(z.string()).min(1),
  acceptance_criteria: z.array(z.string()).min(1),
  references: z.array(z.string()),
  tags: z.array(z.string()),
});
export type Stage = z.infer<typeof StageSchema>;

export const PlanSchema = z.object({
  updated_at: z.string(),
  current_stage_id: z.string().nullable(),
  stages: z.array(StageSchema),
});
export type Plan = z.infer<typeof PlanSchema>;

// ─── 4. Plan History ────────────────────────────────────────────────────────

export const CompletedStageSchema = z.object({
  id: z.string(),
  objective: z.string(),
  expected_outcomes: z.array(z.string()),
  actual_outcomes: z.array(z.string()),
  started_at: z.string(),
  completed_at: z.string(),
  result: z.enum(["completed", "failed", "escalated", "aborted"]),
  summary: z.string(),
  escalation: z
    .object({
      stage_id: z.string(),
      task_id: z.string().optional(),
      reason: z.string(),
      attempted_remediations: z.array(z.string()),
      suggested_action: z.string().optional(),
      created_at: z.string(),
    })
    .optional(),
  abort_reason: z.string().optional(),
});
export type CompletedStage = z.infer<typeof CompletedStageSchema>;

export const PlanHistorySchema = z.object({
  stages: z.array(CompletedStageSchema),
});
export type PlanHistory = z.infer<typeof PlanHistorySchema>;

/** Persisted Telegram chat-id subscriptions (notification destinations). */
export const TelegramSubscriptionsSchema = z.object({
  chatIds: z.array(z.number()).default([]),
});
export type TelegramSubscriptions = z.infer<typeof TelegramSubscriptionsSchema>;

// ─── 5. Tasks ───────────────────────────────────────────────────────────────

export const ChecklistItemSchema = z.object({
  description: z.string(),
  required: z.boolean(),
});
export type ChecklistItem = z.infer<typeof ChecklistItemSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  type: z.enum(["code", "research", "data", "review", "test", "document", "design"]),
  assigned_to: z.enum(WORKER_ROLES),
  description: z.string(),
  checklist: z.array(ChecklistItemSchema),
  dependencies: z.array(z.string()),
  status: z.enum(["pending", "in-progress", "completed", "failed", "aborted"]),
  tags: z.array(z.string()).optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  attempt: z.number().default(1),
  max_attempts: z.number().default(3),
});
export type Task = z.infer<typeof TaskSchema>;

export const TaskListSchema = z.object({
  stage_id: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  tasks: z.array(TaskSchema),
});
export type TaskList = z.infer<typeof TaskListSchema>;

// ─── 6. Task Report ─────────────────────────────────────────────────────────

export const ChecklistResultSchema = z.object({
  description: z.string(),
  passed: z.boolean(),
  notes: z.string().optional(),
});
export type ChecklistResult = z.infer<typeof ChecklistResultSchema>;

export const TestResultSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  output: z.string().optional(),
});
export type TestResult = z.infer<typeof TestResultSchema>;

export const IssueSchema = z.object({
  severity: z.enum(["info", "warning", "error"]),
  description: z.string(),
  file: z.string().nullable().optional(),
  line: z.number().nullable().optional(),
  error_output: z.string().nullable().optional(),
  root_cause: z.string().nullable().optional(),
  suggestion: z.string().nullable().optional(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const TaskReportSchema = z.object({
  task_id: z.string(),
  stage_id: z.string(),
  agent: z.enum(WORKER_ROLES),
  status: z.enum(["completed", "failed"]),
  summary: z.string(),
  checklist_results: z.array(ChecklistResultSchema),
  files_modified: z.array(z.string()),
  files_created: z.array(z.string()),
  tests_added: z.array(z.string()),
  tests_run: z.array(TestResultSchema),
  commits: z.array(z.string()),
  issues_found: z.array(IssueSchema),
  output_truncated: z.boolean().optional(),
  failure_reason: z.string().optional(),
  started_at: z.string(),
  completed_at: z.string(),
  duration_ms: z.number(),
});
export type TaskReport = z.infer<typeof TaskReportSchema>;

// ─── 7. Stage Summary ───────────────────────────────────────────────────────

export const EscalationSchema = z.object({
  stage_id: z.string(),
  task_id: z.string().optional(),
  reason: z.string(),
  attempted_remediations: z.array(z.string()),
  suggested_action: z.string().optional(),
  created_at: z.string(),
});
export type Escalation = z.infer<typeof EscalationSchema>;

export const StageSummarySchema = z.object({
  stage_id: z.string(),
  result: z.enum(["completed", "failed", "escalated", "aborted"]),
  summary: z.string(),
  tasks_completed: z.number(),
  tasks_failed: z.number(),
  total_tasks: z.number(),
  outcomes_achieved: z.array(z.string()),
  outcomes_missed: z.array(z.string()),
  issues: z.array(IssueSchema),
  escalation: EscalationSchema.optional(),
  abort_reason: z.string().optional(),
  started_at: z.string(),
  completed_at: z.string(),
  duration_ms: z.number(),
});
export type StageSummary = z.infer<typeof StageSummarySchema>;

// ─── 8. User Notes ──────────────────────────────────────────────────────────

export const UserNoteSchema = z.object({
  id: z.string(),
  channel: z.string(),
  session_id: z.string(),
  content: z.string(),
  created_at: z.string(),
  permanent: z.boolean(),
  urgent: z.boolean(),
  acknowledged_at: z.string().optional(),
});
export type UserNote = z.infer<typeof UserNoteSchema>;

// ─── 9. Inspection Report ───────────────────────────────────────────────────

export const InspectionRequestSchema = z.object({
  id: z.string(),
  scope: z.string(),
  questions: z.array(z.string()),
  requested_at: z.string(),
  requested_by: z.enum(["planner", "chat"]),
  chat_channel: z.string().optional(),
});
export type InspectionRequest = z.infer<typeof InspectionRequestSchema>;

export const InspectionReportSchema = z.object({
  id: z.string(),
  requested_by: z.enum(["planner", "chat"]),
  request: InspectionRequestSchema,
  findings: z.string(),
  recommendations: z.array(z.string()),
  data: z.record(z.string(), z.unknown()),
  artifacts: z.array(z.string()),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  duration_ms: z.number(),
});
export type InspectionReport = z.infer<typeof InspectionReportSchema>;

// ─── 11. Runtime State ──────────────────────────────────────────────────────

export const AgentStateSchema = z.object({
  agent_type: z.enum(ALL_ROLES),
  agent_id: z.string(),
  status: z.enum(["running", "suspended", "idle"]),
  current_task_id: z.string().optional(),
  channel: z.string().optional(),
  started_at: z.string(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;

export const RuntimeStateSchema = z.object({
  status: z.enum(["idle", "running", "suspended", "error"]),
  current_stage_id: z.string().nullable(),
  active_agents: z.array(AgentStateSchema),
  started_at: z.string(),
  updated_at: z.string(),
  pid: z.number(),
});
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const ShutdownRequestSchema = z.object({
  reason: z.string().min(1),
  requested_by: z.string().default("external"),
  requested_at: z.string(),
});
export type ShutdownRequest = z.infer<typeof ShutdownRequestSchema>;

export const ShutdownSummarySchema = z.object({
  reason: z.string(),
  requested_by: z.string(),
  requested_at: z.string().nullable(),
  shutdown_started_at: z.string(),
  completed_at: z.string(),
  duration_ms: z.number(),
  pid: z.number(),
  runtime_status: z.string().nullable(),
  runtime_started_at: z.string().nullable(),
  runtime_updated_at: z.string().nullable(),
  uptime_ms: z.number().nullable(),
  current_stage_id: z.string().nullable(),
  active_agents: z.array(AgentStateSchema.extend({ elapsed_ms: z.number().nullable() })),
  plan: z.object({
    current_stage_id: z.string().nullable(),
    pending_stages: z.number(),
    history_stages: z.number(),
  }).nullable(),
});
export type ShutdownSummary = z.infer<typeof ShutdownSummarySchema>;

// ─── 12. Chat Log ───────────────────────────────────────────────────────────

export const SystemEventSchema = z.object({
  type: z.enum([
    "stage_completed",
    "stage_failed",
    "escalation",
    "inspector_complete",
    "task_failed",
    "plan_updated",
  ]),
  stage_id: z.string().optional(),
  task_id: z.string().optional(),
  report_id: z.string().optional(),
  summary: z.string(),
  timestamp: z.string().optional(),
});
export type SystemEvent = z.infer<typeof SystemEventSchema>;

export const ChatMessageSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  timestamp: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  modelSpec: z.string().optional(),
  requestedModelSpec: z.string().optional(),
  event: SystemEventSchema.optional(),
  note_id: z.string().optional(),
  inspector_request_id: z.string().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatLogSchema = z.object({
  session_id: z.string(),
  channel: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  messages: z.array(ChatMessageSchema),
});
export type ChatLog = z.infer<typeof ChatLogSchema>;
