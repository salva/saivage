import type { ActivePlanView, PlanDocument, PlanHistoryView } from "../types.js";

export function activePlanView(doc: PlanDocument | null): ActivePlanView | null {
  if (!doc) return null;
  return {
    updated_at: doc.updated_at,
    current_stage_id: doc.current_stage_id,
    stages: doc.stages,
  };
}

export function planHistoryView(doc: PlanDocument | null, lastN?: number): PlanHistoryView | null {
  if (!doc) return null;
  const stages = lastN !== undefined ? doc.history.slice(-lastN) : doc.history;
  return { stages };
}
