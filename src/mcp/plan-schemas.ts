export type PlanToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export function getPlanToolSchemas(): PlanToolSchema[] {
  return [
    {
      name: "plan_get",
      description: "Read the current plan.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "plan_get_stage",
      description: "Get a single stage by ID (from active plan or history).",
      inputSchema: {
        type: "object",
        properties: { stage_id: { type: "string", description: "The stage ID to look up" } },
        required: ["stage_id"],
      },
    },
    {
      name: "plan_get_current_stage",
      description: "Get the stage currently being executed.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "plan_set_stages",
      description: "Replace the plan's stage list.",
      inputSchema: {
        type: "object",
        properties: {
          stages: { type: "array", items: { type: "object" }, description: "The new stage list" },
          current_stage_id: { type: ["string", "null"], description: "Which stage to mark as current" },
        },
        required: ["stages", "current_stage_id"],
      },
    },
    {
      name: "plan_add_stage",
      description: "Append a new stage to the plan.",
      inputSchema: {
        type: "object",
        properties: { stage: { type: "object", description: "The stage to add" } },
        required: ["stage"],
      },
    },
    {
      name: "plan_remove_stage",
      description: "Remove a stage from the active plan by ID.",
      inputSchema: {
        type: "object",
        properties: { stage_id: { type: "string" } },
        required: ["stage_id"],
      },
    },
    {
      name: "plan_set_current",
      description: "Set which stage is currently being executed.",
      inputSchema: {
        type: "object",
        properties: { stage_id: { type: ["string", "null"] } },
        required: ["stage_id"],
      },
    },
    {
      name: "plan_complete_stage",
      description: "Move a stage from the active plan to history.",
      inputSchema: {
        type: "object",
        properties: {
          stage_id: { type: "string" },
          result: { type: "string", enum: ["completed", "failed", "escalated", "aborted"] },
          summary: { type: "string" },
          actual_outcomes: { type: "array", items: { type: "string" } },
          escalation: { type: "object", description: "Escalation object (if result=escalated)" },
          abort_reason: { type: "string", description: "If result=aborted" },
        },
        required: ["stage_id", "result", "summary", "actual_outcomes"],
      },
    },
    {
      name: "plan_get_history",
      description: "Read the plan history.",
      inputSchema: {
        type: "object",
        properties: { last_n: { type: "number", description: "Return only the N most recent entries" } },
      },
    },
    {
      name: "plan_init",
      description: "Initialize an empty plan.",
      inputSchema: {
        type: "object",
        properties: { stages: { type: "array", items: { type: "object" }, description: "Initial stages" } },
      },
    },
    {
      name: "plan_commit",
      description: "Commit plan files to git.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string", description: "Commit message" } },
        required: ["message"],
      },
    },
    {
      name: "plan_done",
      description:
        "Signal that ALL configured project objectives are verified complete with evidence from successful stages. " +
        "Call this once at the end of the planning session; this is the only way to end a planner session successfully. " +
        "Provide a one-paragraph reason summarising which objectives are satisfied and the evidence.",
      inputSchema: {
        type: "object",
        properties: { reason: { type: "string", description: "Why the project is complete." } },
        required: ["reason"],
      },
    },
  ];
}
