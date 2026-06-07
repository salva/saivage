import { McpClient } from "./client.js";
import type { ServiceEntry } from "./types.js";
import type { ToolCallContext } from "./toolContext.js";
import type { SaivageConfig } from "../config.js";
import { log } from "../log.js";
import type { RuntimeToolEntry } from "./in-process-registry.js";
import { applyToolFilter } from "../agents/tool-filters.js";
import { getToolFilter } from "../agents/roster.js";

interface ManagedService {
  entry: ServiceEntry;
  client: McpClient;
  crashCount: number;
}

interface ExternalFailureState {
  failures: number[];
  cooldownUntil: number;
}

export interface ExternalMcpRuntimeOptions {
  clientFactory?: (entry: ServiceEntry) => McpClient;
  now?: () => number;
  crashFailureThreshold?: number;
  crashFailureWindowMs?: number;
  crashCooldownMs?: number;
}

export class ExternalMcpRuntime {
  private services = new Map<string, ManagedService>();
  private externalFailures = new Map<string, ExternalFailureState>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private readonly clientFactory: (entry: ServiceEntry) => McpClient;
  private readonly now: () => number;
  private readonly crashFailureThreshold: number;
  private readonly crashFailureWindowMs: number;
  private readonly crashCooldownMs: number;

  constructor(
    private readonly config: SaivageConfig["runtime"],
    options: ExternalMcpRuntimeOptions = {},
  ) {
    this.clientFactory = options.clientFactory ?? ((entry) => new McpClient(entry));
    this.now = options.now ?? (() => Date.now());
    this.crashFailureThreshold = options.crashFailureThreshold ?? 3;
    this.crashFailureWindowMs = options.crashFailureWindowMs ?? 60_000;
    this.crashCooldownMs = options.crashCooldownMs ?? 60_000;
  }

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

  async getRunningService(name: string): Promise<McpClient> {
    this.assertNotCoolingDown(name);

    const existing = this.services.get(name);
    if (existing?.client.connected) {
      return existing.client;
    }

    throw new Error(
      `MCP service "${name}" is not running; declare it under config.mcpServers with autostart: true and restart the runtime`,
    );
  }

  async startFromEntry(entry: ServiceEntry): Promise<McpClient> {
    this.assertNotCoolingDown(entry.name);

    const client = this.clientFactory(entry);
    try {
      await client.connect();
      const managed: ManagedService = {
        entry,
        client,
        crashCount: 0,
      };
      this.services.set(entry.name, managed);
      this.clearExternalFailures(entry.name);
      return client;
    } catch (err) {
      this.recordExternalFailure(entry.name, err);
      throw err;
    }
  }

  async stopService(name: string): Promise<void> {
    const managed = this.services.get(name);
    if (!managed) return;

    await managed.client.disconnect();
    this.services.delete(name);
    log.info(`Stopped service "${name}"`);
  }

  async callTool(
    serviceName: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx?: ToolCallContext,
  ): Promise<unknown> {
    const client = await this.getRunningService(serviceName);
    this.authorizeToolCall(serviceName, client.getTools(), toolName, ctx);
    const result = await client.callTool(toolName, args);
    if (result.isError) {
      throw new Error(
        `Tool "${toolName}" on "${serviceName}" returned error: ${JSON.stringify(result.content)}`,
      );
    }
    return result.content;
  }

  getAllTools(reservedNames: Set<string> = new Set()): RuntimeToolEntry[] {
    const tools: RuntimeToolEntry[] = [];
    const visibleNames = new Set(reservedNames);
    for (const [name, managed] of this.services) {
      for (const tool of managed.client.getTools()) {
        const visibleName = visibleNames.has(tool.name)
          ? this.aliasToolName(name, tool.name, visibleNames)
          : tool.name;
        tools.push({
          ...tool,
          name: visibleName,
          service: name,
          ...(visibleName === tool.name ? {} : { originalName: tool.name }),
        });
        visibleNames.add(visibleName);
      }
    }
    return tools;
  }

  listAllToolsForApi(seen: Set<string> = new Set()): Array<{
    name: string;
    service: string;
    description: string;
    inputSchema: unknown;
  }> {
    return this.getAllTools(seen).map((tool) => ({
      name: tool.name,
      service: tool.service,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  listRunning(): string[] {
    return [...this.services.keys()];
  }

  async shutdown(): Promise<void> {
    this.stopMonitoring();
    const names = [...this.services.keys()];
    await Promise.all(names.map((n) => this.stopService(n)));
  }

  private async healthCheckAll(): Promise<void> {
    for (const [name, managed] of this.services) {
      if (!managed.client.connected) {
        log.warn(`Service "${name}" disconnected, attempting restart`);
        await this.restartService(name, managed);
      }
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

  private authorizeToolCall(
    serviceName: string,
    tools: Array<{ name: string }>,
    toolName: string,
    ctx?: ToolCallContext,
  ): void {
    if (!ctx || ctx.operatorContext === true) return;
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw new Error(`Unknown tool "${toolName}" on service "${serviceName}"`);
    }
    const filter = getToolFilter(ctx.role);
    if (!applyToolFilter(filter, { name: tool.name, service: serviceName })) {
      throw new Error(`UNAUTHORIZED_TOOL: ${ctx.role} cannot call ${serviceName}.${toolName}`);
    }
  }

  private aliasToolName(serviceName: string, toolName: string, visibleNames: Set<string>): string {
    const baseAlias = `${serviceName}_${toolName}`;
    if (!visibleNames.has(baseAlias)) return baseAlias;

    let suffix = 2;
    while (visibleNames.has(`${baseAlias}_${suffix}`)) suffix += 1;
    return `${baseAlias}_${suffix}`;
  }
}
