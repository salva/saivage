import type { ActivePlanView, PlanDocument, PlanHistoryView } from "../../types.js";
import type { ProjectContext } from "../../store/project.js";
import { safeProjectConfigView, type SafeProjectConfig } from "./config.js";
import { activePlanView, planHistoryView } from "../../store/plan-read-models.js";

export interface SafeDebugStateResponse {
  runtime: unknown;
  plan: ActivePlanView | null;
  history: PlanHistoryView | null;
  config: SafeProjectConfig;
}

export function safeDebugStateResponse(args: {
  runtimeState: unknown;
  planDoc: PlanDocument | null;
  projectConfig: ProjectContext["config"];
}): SafeDebugStateResponse {
  return {
    runtime: args.runtimeState,
    plan: activePlanView(args.planDoc),
    history: planHistoryView(args.planDoc),
    config: safeProjectConfigView(args.projectConfig),
  };
}
