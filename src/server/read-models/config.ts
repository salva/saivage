import type { SaivageRuntime } from "../bootstrap.js";
import type { ResolvedModelRoute } from "../../routing/resolver.js";

export interface SafeResolvedRoute {
  role: string;
  modelSpec: string;
  provider: string;
  model: string;
  preferredModels: string[];
  source: ResolvedModelRoute["source"];
}

export interface SafeProjectConfig {
  project_name: string;
  objectives: string[];
  skills?: { max_per_agent: number };
  agents?: Record<string, { compaction_threshold_pct: number; max_compactions: number }>;
}

export interface SafeConfigResponse extends SafeProjectConfig {
  project_root: string;
  saivage_dir: string;
  routing: {
    planner: SafeResolvedRoute;
    chat: SafeResolvedRoute;
  };
}

export interface SafeProvidersResponse {
  providers: Array<{
    name: string;
    models: string[];
    unavailable?: true;
  }>;
}

function safeRouteView(route: ResolvedModelRoute): SafeResolvedRoute {
  return {
    role: route.role,
    modelSpec: route.modelSpec,
    provider: route.provider,
    model: route.model,
    preferredModels: [...route.preferredModels],
    source: route.source,
  };
}

export function safeProjectConfigView(config: SaivageRuntime["project"]["config"]): SafeProjectConfig {
  return {
    project_name: config.project_name,
    objectives: [...config.objectives],
    ...(config.skills ? { skills: { max_per_agent: config.skills.max_per_agent } } : {}),
    ...(config.agents ? { agents: config.agents } : {}),
  };
}

export function safeConfigResponse(runtime: Pick<SaivageRuntime, "project" | "routing">): SafeConfigResponse {
  const plannerRoute = runtime.routing.resolve("planner");
  const chatRoute = runtime.routing.resolve("chat");
  return {
    ...safeProjectConfigView(runtime.project.config),
    project_root: runtime.project.projectRoot,
    saivage_dir: runtime.project.saivageDir,
    routing: {
      planner: safeRouteView(plannerRoute),
      chat: safeRouteView(chatRoute),
    },
  };
}

export async function safeProvidersResponse(
  router: Pick<SaivageRuntime["router"], "listProviders" | "listModels">,
): Promise<SafeProvidersResponse> {
  const providers = await Promise.all(router.listProviders().map(async (name) => {
    try {
      const models = await router.listModels(name);
      return { name, models: models.filter((model): model is string => typeof model === "string") };
    } catch {
      return { name, models: [], unavailable: true as const };
    }
  }));
  return { providers };
}
