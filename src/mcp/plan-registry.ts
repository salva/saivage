import type { Stage } from "../types.js";
import type { PlanService } from "./plan-server.js";

export type PlanToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type PlanToolAccess = "reader" | "writer";

type PlanToolEntry = PlanToolSchema & {
  access: PlanToolAccess;
  handler(service: PlanService, args: Record<string, unknown>): Promise<unknown>;
};

export const PLAN_TOOL_REGISTRY = [
  {
    name: "plan_get",
    access: "reader",
    description: "Read the current plan.",
    inputSchema: { type: "object", properties: {} },
    handler: (service) => service.plan_get(),
  },
  {
    name: "plan_get_stage",
    access: "reader",
    description: "Get a single stage by ID (from active plan or history).",
    inputSchema: {
      type: "object",
      properties: { stage_id: { type: "string", description: "The stage ID to look up" } },
      required: ["stage_id"],
    },
    handler: (service, args) => service.plan_get_stage(args.stage_id as string),
  },
  {
    name: "plan_get_current_stage",
    access: "reader",
    description: "Get the stage currently being executed.",
    inputSchema: { type: "object", properties: {} },
    handler: (service) => service.plan_get_current_stage(),
  },
  {
    name: "plan_set_stages",
    access: "writer",
    description: "Replace the plan's stage list.",
    inputSchema: {
      type: "object",
      properties: {
        stages: { type: "array", items: { type: "object" }, description: "The new stage list" },
        current_stage_id: { type: ["string", "null"], description: "Which stage to mark as current" },
      },
      required: ["stages", "current_stage_id"],
    },
    handler: (service, args) => service.plan_set_stages(args.stages as Stage[], args.current_stage_id as string | null),
  },
  {
    name: "plan_add_stage",
    access: "writer",
    description: "Append a new stage to the plan.",
    inputSchema: {
      type: "object",
      properties: { stage: { type: "object", description: "The stage to add" } },
      required: ["stage"],
    },
    handler: (service, args) => service.plan_add_stage(args.stage as Stage),
  },
  {
    name: "plan_remove_stage",
    access: "writer",
    description: "Remove a stage from the active plan by ID.",
    inputSchema: {
      type: "object",
      properties: { stage_id: { type: "string" } },
      required: ["stage_id"],
    },
    handler: (service, args) => service.plan_remove_stage(args.stage_id as string),
  },
  {
    name: "plan_set_current",
    access: "writer",
    description: "Set which stage is currently being executed.",
    inputSchema: {
      type: "object",
      properties: { stage_id: { type: ["string", "null"] } },
      required: ["stage_id"],
    },
    handler: (service, args) => service.plan_set_current(args.stage_id as string | null),
  },
  {
    name: "plan_complete_stage",
    access: "writer",
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
    handler: (service, args) => service.plan_complete_stage(args as Parameters<PlanService["plan_complete_stage"]>[0]),
  },
  {
    name: "plan_get_history",
    access: "reader",
    description: "Read the plan history.",
    inputSchema: {
      type: "object",
      properties: { last_n: { type: "number", description: "Return only the N most recent entries" } },
    },
    handler: (service, args) => service.plan_get_history(args.last_n as number | undefined),
  },
  {
    name: "plan_init",
    access: "writer",
    description: "Initialize an empty plan.",
    inputSchema: {
      type: "object",
      properties: { stages: { type: "array", items: { type: "object" }, description: "Initial stages" } },
    },
    handler: (service, args) => service.plan_init(args.stages as Stage[] | undefined),
  },
  {
    name: "plan_commit",
    access: "writer",
    description: "Commit plan files to git.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "Commit message" } },
      required: ["message"],
    },
    handler: (service, args) => service.plan_commit(args.message as string),
  },
  {
    name: "plan_done",
    access: "reader",
    description:
      "Signal that ALL configured project objectives are verified complete with evidence from successful stages. " +
      "Call this once at the end of the planning session; this is the only way to end a planner session successfully. " +
      "Provide a one-paragraph reason summarising which objectives are satisfied and the evidence.",
    inputSchema: {
      type: "object",
      properties: { reason: { type: "string", description: "Why the project is complete." } },
      required: ["reason"],
    },
    handler: (service, args) => service.plan_done(args as { reason: string }),
  },
] as const satisfies readonly PlanToolEntry[];

export const PLAN_WRITER_TOOLS: ReadonlySet<string> = new Set(
  PLAN_TOOL_REGISTRY.filter((tool) => tool.access === "writer").map((tool) => tool.name),
);

export const PLAN_READER_TOOLS: ReadonlySet<string> = new Set(
  PLAN_TOOL_REGISTRY.filter((tool) => tool.access === "reader").map((tool) => tool.name),
);

export function getPlanToolSchemas(): PlanToolSchema[] {
  return PLAN_TOOL_REGISTRY.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function dispatchPlanToolCall(
  service: PlanService,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown; isError: boolean }> {
  const tool = PLAN_TOOL_REGISTRY.find((entry) => entry.name === toolName);
  if (!tool) {
    return { content: { code: "VALIDATION_ERROR", error: `Unknown plan tool: ${toolName}` }, isError: true };
  }

  const result = await tool.handler(service, args);
  const isError = !!(result && typeof result === "object" && "code" in result && "error" in result);
  return { content: result, isError };
}
