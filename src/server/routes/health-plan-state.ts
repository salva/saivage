import type { FastifyInstance } from "fastify";
import type { ActivePlanView, PlanHistoryView, RuntimeState } from "../../types.js";
import type { StageDetailsView } from "../../store/project-store.js";

export interface HealthPlanStateReads {
  runtimeState(): Promise<RuntimeState | null>;
  activePlanView(): Promise<ActivePlanView | null>;
  planHistoryView(): Promise<PlanHistoryView | null>;
  stageDetails(stageId: string): Promise<StageDetailsView>;
}

export function registerHealthPlanStateRoutes(
  app: FastifyInstance,
  deps: { reads: HealthPlanStateReads; projectName: string },
): void {
  app.get("/health", async () => {
    const state = await deps.reads.runtimeState();
    return {
      status: "ok",
      version: "2.0.0",
      project: deps.projectName,
      runtime: state?.status ?? "unknown",
    };
  });

  app.get("/api/plan", async () => {
    const [plan, history] = await Promise.all([
      deps.reads.activePlanView(),
      deps.reads.planHistoryView(),
    ]);
    return { plan, history };
  });

  app.get("/api/plan/stages/:id", async (req) => {
    const { id } = req.params as { id: string };
    return deps.reads.stageDetails(id);
  });

  app.get("/api/state", async () => {
    const [state, plan] = await Promise.all([
      deps.reads.runtimeState(),
      deps.reads.activePlanView(),
    ]);
    return { state, plan };
  });
}
