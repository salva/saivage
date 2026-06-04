/**
 * Saivage — Built-in MCP Services (in-process)
 *
 * Core services run in-process — no subprocess spawning, no external
 * dependencies. Services that need libraries not yet integrated stay
 * unregistered until implemented.
 */

import type { McpRuntime } from "./runtime.js";
import { createBuiltinContext } from "./builtins/context.js";
import { makeFilesystemService } from "./builtins/filesystem.js";
import { makeGitService } from "./builtins/git.js";
import { registerKnowledgeServices } from "../knowledge/mcp-tools.js";
import { registerRagService } from "./builtins/rag.js";
import { makeShellService } from "./builtins/shell.js";
import { makeDataService } from "./builtins/web.js";

import { log } from "../log.js";
import type { ProjectContext } from "../store/project.js";

export interface BuiltinServicesOptions {
  project: Pick<ProjectContext, "projectRoot">;
  webSearchEndpoint?: string;
  rag?: import("../server/rag/service.js").RagService;
  /** F01 B03 — knowledge façade; when present handlers will use it. */
  knowledge?: import("../knowledge/init.js").KnowledgeStore;
}

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register all built-in services as in-process handlers on the MCP runtime.
 * No subprocess spawning — all operations run directly in the Node.js process.
 */
export function registerBuiltinServices(
  mcpRuntime: McpRuntime,
  mcpConfig: import("../config.js").SaivageConfig["mcp"],
  securityConfig: import("../config.js").SaivageConfig["security"],
  options: BuiltinServicesOptions,
): void {
  const context = createBuiltinContext(mcpConfig, securityConfig, options);

  const filesystem = makeFilesystemService(context);
  const git = makeGitService(context);
  const shell = makeShellService(context, mcpConfig);
  const data = makeDataService(context);

  mcpRuntime.registerInProcess("filesystem", filesystem.tools, filesystem.handler);
  mcpRuntime.registerInProcess("shell", shell.tools, shell.handler);
  mcpRuntime.registerInProcess("data", data.tools, data.handler);
  mcpRuntime.registerInProcess("git", git.tools, git.handler);

  registerKnowledgeServices(mcpRuntime, options.knowledge);

  const activeServices = 4 + (options.knowledge ? 2 : 0) + (registerRagService(mcpRuntime, options.rag) ? 1 : 0);
  log.info(`[builtins] ${activeServices} built-in services registered`);
}
