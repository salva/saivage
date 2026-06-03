import { McpClient } from "./client.js";
import type { ServiceEntry, ToolEntry } from "./types.js";
import { log } from "../log.js";
import type { SaivageConfig } from "../config.js";
import { applyToolFilter } from "../agents/tool-filters.js";
import { getToolFilter } from "../agents/roster.js";
import type { ToolCallContext } from "./toolContext.js";

export interface RuntimeToolEntry extends ToolEntry {
  service: string;
}

/** Handler for in-process tools — avoids subprocess overhead */
export type InProcessToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
  ctx?: ToolCallContext,
) => Promise<{ content: unknown; isError: boolean }>;

interface InProcessService {
  name: string;
  tools: ToolEntry[];
  handler: InProcessToolHandler;
}

interface ManagedService {
  entry: ServiceEntry;
  client: McpClient;
  lastHealthCheck: number;
  crashCount: number;
  idleSince: number | null;
}

interface ExternalFailureState {
  failures: number[];
  cooldownUntil: number;
}

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
  private services = new Map<string, ManagedService>();
  private inProcessServices = new Map<string, InProcessService>();
  private externalFailures = new Map<string, ExternalFailureState>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private config: SaivageConfig["runtime"];
  private clientFactory: (entry: ServiceEntry) => McpClient;
  private now: () => number;
  private crashFailureThreshold: number;
  private crashFailureWindowMs: number;
  private crashCooldownMs: number;
  private readonly inProcessTimeoutMs: number;
  private readonly shellTimeoutMs: number;

  constructor(
    config: SaivageConfig,
    options: McpRuntimeOptions = {},
  ) {
    this.config = config.runtime;
    this.clientFactory = options.clientFactory ?? ((entry) => new McpClient(entry));
    this.now = options.now ?? (() => Date.now());
    this.crashFailureThreshold = options.crashFailureThreshold ?? 3;
    this.crashFailureWindowMs = options.crashFailureWindowMs ?? 60_000;
    this.crashCooldownMs = options.crashCooldownMs ?? 60_000;
    this.inProcessTimeoutMs = config.mcp.inProcessTimeoutMs;
    this.shellTimeoutMs = config.mcp.shellTimeoutMs;
  }

  /** Start health-check monitoring for running external services. */
  startMonitoring(): void {
    if (this.config.healthCheckIntervalMs > 0) {
      this.healthInterval = setInterval(
        () => this.healthCheckAll(),
        this.config.healthCheckIntervalMs,
      );
    }
  }

  stopMonitoring(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);
  }

  /** Return a connected external service client that was already started. */
  async getRunningService(name: string): Promise<McpClient> {
    this.assertNotCoolingDown(name);

    const existing = this.services.get(name);
    if (existing?.client.connected) {
      existing.idleSince = null; // Mark as active for diagnostics.
      return existing.client;
    }

    throw new Error(
      `MCP service "${name}" is not running; declare it under config.mcpServers with autostart: true and restart the runtime`,
    );
  }

  /** Start a service from an entry (not necessarily in registry) */
  async startFromEntry(entry: ServiceEntry): Promise<McpClient> {
    this.assertNotCoolingDown(entry.name);

    const client = this.clientFactory(entry);
    try {
      await client.connect();
      const managed: ManagedService = {
        entry,
        client,
        lastHealthCheck: Date.now(),
        crashCount: 0,
        idleSince: null,
      };
      this.services.set(entry.name, managed);
      this.clearExternalFailures(entry.name);
      return client;
    } catch (err) {
      this.recordExternalFailure(entry.name, err);
      throw err;
    }
  }

  /** Stop a service */
  async stopService(name: string): Promise<void> {
    const managed = this.services.get(name);
    if (!managed) return;

    await managed.client.disconnect();
    this.services.delete(name);
    log.info(`Stopped service "${name}"`);
  }

  /** Register an in-process service (no subprocess, direct function calls) */
  registerInProcess(
    name: string,
    tools: ToolEntry[],
    handler: InProcessToolHandler,
  ): void {
    this.inProcessServices.set(name, { name, tools, handler });
    log.info(`In-process service "${name}" registered — ${tools.length} tools`);
  }

  /** Call a tool on an in-process service or an already-running external service. */
  async callTool(
    serviceName: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx?: ToolCallContext,
  ): Promise<unknown> {
    // Check in-process services first
    const inProc = this.inProcessServices.get(serviceName);
    if (inProc) {
      this.authorizeInProcessToolCall(inProc, toolName, ctx);
      const timeoutMs = serviceName === "shell"
        ? this.shellTimeoutMs
        : this.inProcessTimeoutMs;
      const result = await withTimeout(
        inProc.handler(toolName, args, ctx),
        timeoutMs,
        `Tool "${toolName}" on "${serviceName}" timed out after ${timeoutMs}ms`,
      );
      if (result.isError) {
        throw new Error(
          `Tool "${toolName}" on "${serviceName}" returned error: ${JSON.stringify(result.content)}`,
        );
      }
      return result.content;
    }

    if (ctx && ctx.operatorContext !== true) {
      throw new Error(
        `UNAUTHORIZED_TOOL: ${ctx.role} cannot call external MCP tool ${serviceName}.${toolName}; operatorContext is required`,
      );
    }

    const client = await this.getRunningService(serviceName);
    const managed = this.services.get(serviceName);
    if (managed) managed.idleSince = null; // Active

    const result = await client.callTool(toolName, args);
    if (result.isError) {
      throw new Error(
        `Tool "${toolName}" on "${serviceName}" returned error: ${JSON.stringify(result.content)}`,
      );
    }
    return result.content;
  }

  private authorizeInProcessToolCall(
    service: InProcessService,
    toolName: string,
    ctx?: ToolCallContext,
  ): void {
    if (!ctx || ctx.operatorContext === true) return;
    const tool = service.tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`Unknown tool "${toolName}" on service "${service.name}"`);
    }
    const filter = getToolFilter(ctx.role);
    if (!applyToolFilter(filter, { ...tool, service: service.name })) {
      throw new Error(`UNAUTHORIZED_TOOL: ${ctx.role} cannot call ${service.name}.${toolName}`);
    }
  }

  /** Get all tool schemas across all services (in-process + running) */
  getAllTools(): RuntimeToolEntry[] {
    const tools: RuntimeToolEntry[] = [];
    const seen = new Set<string>();

    // First: in-process services (always available, no startup needed)
    for (const [name, svc] of this.inProcessServices) {
      for (const tool of svc.tools) {
        tools.push({ ...tool, service: name });
        seen.add(tool.name);
      }
    }

    // Second: tools from running services (freshest schemas)
    for (const [name, managed] of this.services) {
      for (const tool of managed.client.getTools()) {
        tools.push({ ...tool, service: name });
        seen.add(tool.name);
      }
    }

    return tools;
  }

  /** Return a flat projection suitable for the `/api/mcp/tools` endpoint. */
  listAllToolsForApi(): Array<{
    name: string;
    service: string;
    description: string;
    inputSchema: unknown;
  }> {
    const out: Array<{ name: string; service: string; description: string; inputSchema: unknown }> = [];
    const seen = new Set<string>();

    for (const [name, svc] of this.inProcessServices) {
      for (const tool of svc.tools) {
        out.push({
          name: tool.name,
          service: name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
        seen.add(tool.name);
      }
    }
    for (const [name, managed] of this.services) {
      for (const tool of managed.client.getTools()) {
        if (seen.has(tool.name)) continue;
        out.push({
          name: tool.name,
          service: name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
        seen.add(tool.name);
      }
    }
    return out;
  }

  /** List running services */
  listRunning(): string[] {
    return [...this.services.keys()];
  }

  /** Shut down all services */
  async shutdown(): Promise<void> {
    this.stopMonitoring();
    const names = [...this.services.keys()];
    await Promise.all(names.map((n) => this.stopService(n)));
    log.info("MCP Runtime shut down");
  }

  // --- Health checking ---

  private async healthCheckAll(): Promise<void> {
    for (const [name, managed] of this.services) {
      if (!managed.client.connected) {
        log.warn(`Service "${name}" disconnected, attempting restart`);
        await this.restartService(name, managed);
      }
      managed.lastHealthCheck = Date.now();
    }
  }

  private async restartService(
    name: string,
    managed: ManagedService,
  ): Promise<void> {
    if (!this.config.restartOnCrash) return;

    managed.crashCount++;
    if (managed.crashCount > 3) {
      log.error(`Service "${name}" crashed ${managed.crashCount} times, giving up`);
      this.services.delete(name);
      return;
    }

    const backoffMs = Math.min(1000 * 2 ** managed.crashCount, 30_000);
    log.info(`Restarting "${name}" in ${backoffMs}ms (crash #${managed.crashCount})`);
    await new Promise((r) => setTimeout(r, backoffMs));

    try {
      this.assertNotCoolingDown(name);
      const client = this.clientFactory(managed.entry);
      await client.connect();
      managed.client = client;
      managed.lastHealthCheck = Date.now();
      this.clearExternalFailures(name);
      log.info(`Service "${name}" restarted successfully`);
    } catch (err) {
      log.error(`Failed to restart "${name}": ${err}`);
      if (this.recordExternalFailure(name, err)) {
        this.services.delete(name);
      }
    }
  }

  private assertNotCoolingDown(name: string): void {
    const state = this.externalFailures.get(name);
    if (!state || state.cooldownUntil <= 0) return;

    const now = this.now();
    if (state.cooldownUntil <= now) {
      this.externalFailures.delete(name);
      return;
    }

    const waitMs = state.cooldownUntil - now;
    throw new Error(
      `Service "${name}" is cooling down after repeated startup failures; retry in ${Math.ceil(waitMs / 1000)}s`,
    );
  }

  private recordExternalFailure(name: string, err: unknown): boolean {
    const now = this.now();
    const state = this.externalFailures.get(name) ?? { failures: [], cooldownUntil: 0 };
    state.failures = state.failures.filter((t) => now - t <= this.crashFailureWindowMs);
    state.failures.push(now);

    if (state.failures.length >= this.crashFailureThreshold) {
      state.cooldownUntil = now + this.crashCooldownMs;
      state.failures = [];
      log.error(
        `Service "${name}" failed ${this.crashFailureThreshold} time(s) in ${this.crashFailureWindowMs}ms; cooling down for ${this.crashCooldownMs}ms: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.externalFailures.set(name, state);
      return true;
    }

    this.externalFailures.set(name, state);
    return false;
  }

  private clearExternalFailures(name: string): void {
    this.externalFailures.delete(name);
  }

}

/** Race a promise against a timeout. Rejects with the given message on timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
