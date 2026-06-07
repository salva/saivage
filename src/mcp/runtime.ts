import type { ServiceEntry, ToolEntry } from "./types.js";
import type { McpClient } from "./client.js";
import { log } from "../log.js";
import type { SaivageConfig } from "../config.js";
import type { ArtifactExecutionContext, ToolCallContext } from "./toolContext.js";
import { InProcessServiceRegistry, type InProcessToolHandler, type RuntimeToolEntry } from "./in-process-registry.js";
import { ExternalMcpRuntime } from "./external-runtime.js";

export type { InProcessToolHandler, RuntimeToolEntry } from "./in-process-registry.js";

export interface McpRuntimeOptions {
  clientFactory?: (entry: ServiceEntry) => McpClient;
  now?: () => number;
  crashFailureThreshold?: number;
  crashFailureWindowMs?: number;
  crashCooldownMs?: number;
}

/**
 * MCP Runtime — manages lifecycle of MCP service processes.
 * In-process services are registered directly; external services are started
 * from configured entries during bootstrap and are not lazily started by calls.
 */
export class McpRuntime {
  private readonly inProcess: InProcessServiceRegistry;
  private readonly external: ExternalMcpRuntime;

  constructor(
    config: SaivageConfig,
    options: McpRuntimeOptions = {},
  ) {
    this.inProcess = new InProcessServiceRegistry({
      inProcessTimeoutMs: config.mcp.inProcessTimeoutMs,
      shellTimeoutMs: config.mcp.shellTimeoutMs,
    });
    this.external = new ExternalMcpRuntime(config.runtime, options);
  }

  /** Start health-check monitoring for running external services. */
  startMonitoring(): void {
    this.external.startMonitoring();
  }

  stopMonitoring(): void {
    this.external.stopMonitoring();
  }

  /** Return a connected external service client that was already started. */
  async getRunningService(name: string) {
    return this.external.getRunningService(name);
  }

  /** Start a service from an entry (not necessarily in registry) */
  async startFromEntry(entry: ServiceEntry) {
    return this.external.startFromEntry(entry);
  }

  /** Stop a service */
  async stopService(name: string): Promise<void> {
    await this.external.stopService(name);
  }

  /** Register an in-process service (no subprocess, direct function calls) */
  registerInProcess(
    name: string,
    tools: ToolEntry[],
    handler: InProcessToolHandler,
  ): void {
    this.inProcess.register(name, tools, handler);
  }

  /** Call a tool on an in-process service or an already-running external service. */
  async callTool(
    serviceName: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx?: ToolCallContext,
    artifact?: ArtifactExecutionContext,
  ): Promise<unknown> {
    if (this.inProcess.hasService(serviceName)) {
      return this.inProcess.callTool(serviceName, toolName, args, ctx, artifact);
    }
    return this.external.callTool(serviceName, toolName, args, ctx);
  }

  /** Get all tool schemas across all services (in-process + running) */
  getAllTools(): RuntimeToolEntry[] {
    const tools: RuntimeToolEntry[] = [];
    tools.push(...this.inProcess.getAllTools());
    tools.push(...this.external.getAllTools());
    return tools;
  }

  /** Return a flat projection suitable for the `/api/mcp/tools` endpoint. */
  listAllToolsForApi(): Array<{
    name: string;
    service: string;
    description: string;
    inputSchema: unknown;
  }> {
    const inProcessTools = this.inProcess.listAllToolsForApi();
    const seen = new Set(inProcessTools.map((tool) => tool.name));
    return [...inProcessTools, ...this.external.listAllToolsForApi(seen)];
  }

  /** List running services */
  listRunning(): string[] {
    return this.external.listRunning();
  }

  /** Shut down all services */
  async shutdown(): Promise<void> {
    this.stopMonitoring();
    await this.external.shutdown();
    log.info("MCP Runtime shut down");
  }
}
