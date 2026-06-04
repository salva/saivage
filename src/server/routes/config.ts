import type { FastifyInstance } from "fastify";
import { safeConfigResponse, safeProvidersResponse } from "../read-models/config.js";

export interface ConfigRouteDeps {
  runtime: Parameters<typeof safeConfigResponse>[0];
  router: Parameters<typeof safeProvidersResponse>[0];
  mcpRuntime: { listAllToolsForApi(): unknown[] };
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
