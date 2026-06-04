import type { PlanService } from "./plan-server.js";
import type { Stage } from "../types.js";

export async function dispatchPlanToolCall(
  service: PlanService,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: unknown; isError: boolean }> {
  let result: unknown;
  let isError = false;

  switch (toolName) {
    case "plan_get":
      result = await service.plan_get();
      break;
    case "plan_get_stage":
      result = await service.plan_get_stage(args.stage_id as string);
      break;
    case "plan_get_current_stage":
      result = await service.plan_get_current_stage();
      break;
    case "plan_set_stages":
      result = await service.plan_set_stages(
        args.stages as Stage[],
        args.current_stage_id as string | null,
      );
      break;
    case "plan_add_stage":
      result = await service.plan_add_stage(args.stage as Stage);
      break;
    case "plan_remove_stage":
      result = await service.plan_remove_stage(args.stage_id as string);
      break;
    case "plan_set_current":
      result = await service.plan_set_current(args.stage_id as string | null);
      break;
    case "plan_complete_stage":
      result = await service.plan_complete_stage(args as Parameters<PlanService["plan_complete_stage"]>[0]);
      break;
    case "plan_get_history":
      result = await service.plan_get_history(args.last_n as number | undefined);
      break;
    case "plan_init":
      result = await service.plan_init(args.stages as Stage[] | undefined);
      break;
    case "plan_commit":
      result = await service.plan_commit(args.message as string);
      break;
    case "plan_done":
      result = await service.plan_done(args as { reason: string });
      break;
    default:
      result = { code: "VALIDATION_ERROR", error: `Unknown plan tool: ${toolName}` };
      isError = true;
  }

  if (result && typeof result === "object" && "code" in result && "error" in result) {
    isError = true;
  }

  return { content: result, isError };
}
