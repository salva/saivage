import type { ActivePlanView, PlanDocument, PlanHistoryView } from "../../types.js";
import type { SaivageRuntime } from "../bootstrap.js";
import { safeProjectConfigView, type SafeProjectConfig } from "./config.js";

export interface SafeDebugStateResponse {
  runtime: unknown;
  plan: ActivePlanView | null;
  history: PlanHistoryView | null;
  config: SafeProjectConfig;
}

function activePlanView(doc: PlanDocument | null): ActivePlanView | null {
  if (!doc) return null;
  return {
    updated_at: doc.updated_at,
    current_stage_id: doc.current_stage_id,
    stages: doc.stages,
  };
}

function historyView(doc: PlanDocument | null): PlanHistoryView | null {
  return doc ? { stages: doc.history } : null;
}

export function safeDebugStateResponse(args: {
  runtimeState: unknown;
  planDoc: PlanDocument | null;
  projectConfig: SaivageRuntime["project"]["config"];
}): SafeDebugStateResponse {
  return {
    runtime: args.runtimeState,
    plan: activePlanView(args.planDoc),
    history: historyView(args.planDoc),
    config: safeProjectConfigView(args.projectConfig),
  };
}
