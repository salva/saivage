import type { FastifyInstance } from "fastify";
import type { SaivageRuntime } from "../bootstrap.js";
import { safeConfigResponse, safeProvidersResponse } from "../read-models/config.js";

export interface ConfigRouteDeps {
  runtime: Pick<SaivageRuntime, "project" | "routing">;
  router: Pick<SaivageRuntime["router"], "listProviders" | "listModels">;
  mcpRuntime: Pick<SaivageRuntime["mcpRuntime"], "listAllToolsForApi">;
}

export function registerConfigRoutes(app: FastifyInstance, deps: ConfigRouteDeps): void {
  app.get("/api/config", async () => {
    return safeConfigResponse(deps.runtime);
  });

  app.get("/api/providers", async () => {
    return safeProvidersResponse(deps.router);
  });

  // WI-12 — Inspector endpoint listing every MCP tool the runtime is aware
  // of (in-process + running + registered), including the `available` flag.
  app.get("/api/mcp/tools", async () => {
    return { tools: deps.mcpRuntime.listAllToolsForApi() };
  });
}
