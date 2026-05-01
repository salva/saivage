import { McpClient } from "./client.js";
import type { ServiceEntry, ToolEntry } from "./registry.js";
import {
  listRegisteredServices,
  updateServiceStatus,
  getService,
} from "./registry.js";
import { log } from "../log.js";
import type { SaivageConfig } from "../config.js";

export interface RuntimeToolEntry extends ToolEntry {
  service: string;
}

/** Handler for in-process tools — avoids subprocess overhead */
export type InProcessToolHandler = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{ content: unknown; isError: boolean }>;

interface InProcessService {
  name: string;
  tools: ToolEntry[];
  handler: InProcessToolHandler;
  available: boolean;
}

interface ManagedService {
  entry: ServiceEntry;
  client: McpClient;
  lastHealthCheck: number;
  crashCount: number;
  idleSince: number | null;
}

/**
 * MCP Runtime — manages lifecycle of MCP service processes.
 * Start, stop, health-check, lazy loading, idle shutdown, crash recovery.
 */
export class McpRuntime {
  private services = new Map<string, ManagedService>();
  private inProcessServices = new Map<string, InProcessService>();
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private idleInterval: ReturnType<typeof setInterval> | null = null;
  private config: SaivageConfig["runtime"];

  constructor(config: SaivageConfig["runtime"]) {
    this.config = config;
  }

  /** Start health-check and idle-shutdown loops */
  startMonitoring(): void {
    if (this.config.healthCheckIntervalMs > 0) {
      this.healthInterval = setInterval(
        () => this.healthCheckAll(),
        this.config.healthCheckIntervalMs,
      );
    }
    if (this.config.idleShutdownMs > 0) {
      this.idleInterval = setInterval(
        () => this.checkIdleServices(),
        60_000, // check every minute
      );
    }
  }

  stopMonitoring(): void {
    if (this.healthInterval) clearInterval(this.healthInterval);
    if (this.idleInterval) clearInterval(this.idleInterval);
  }

  /** Start a service by name (from registry) */
  async startService(name: string): Promise<McpClient> {
    const existing = this.services.get(name);
    if (existing?.client.connected) {
      existing.idleSince = null; // Mark as active
      return existing.client;
    }

    const entry = getService(name);
    if (!entry) throw new Error(`Service "${name}" not found in registry`);

    return this.startFromEntry(entry);
  }

  /** Start a service from an entry (not necessarily in registry) */
  async startFromEntry(entry: ServiceEntry): Promise<McpClient> {
    const client = new McpClient(entry);
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
      updateServiceStatus(entry.name, "active");
      return client;
    } catch (err) {
      updateServiceStatus(entry.name, "error");
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

  /** Get a running client (lazy-start if not running) */
  async getClient(name: string): Promise<McpClient> {
    return this.startService(name);
  }

  /** Register an in-process service (no subprocess, direct function calls) */
  registerInProcess(
    name: string,
    tools: ToolEntry[],
    handler: InProcessToolHandler,
    options: { available?: boolean } = {},
  ): void {
    const available = options.available ?? true;
    this.inProcessServices.set(name, { name, tools, handler, available });
    log.info(
      `In-process service "${name}" registered — ${tools.length} tools` +
      (available ? "" : " (unavailable)"),
    );
  }

  /** Call a tool on a service (lazy-start) */
  async callTool(
    serviceName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // Check in-process services first
    const inProc = this.inProcessServices.get(serviceName);
    if (inProc) {
      if (!inProc.available) {
        throw new Error(`Service "${serviceName}" is registered but unavailable`);
      }
      const result = await inProc.handler(toolName, args);
      if (result.isError) {
        throw new Error(
          `Tool "${toolName}" on "${serviceName}" returned error: ${JSON.stringify(result.content)}`,
        );
      }
      return result.content;
    }

    const client = await this.getClient(serviceName);
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

  /** Get all tool schemas across all services (in-process + running + registry) */
  getAllTools(): RuntimeToolEntry[] {
    const tools: RuntimeToolEntry[] = [];
    const seen = new Set<string>();

    // First: in-process services (always available, no startup needed)
    for (const [name, svc] of this.inProcessServices) {
      if (!svc.available) continue;
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

    // Second: tools from registry for services not yet started
    for (const entry of listRegisteredServices()) {
      if (entry.status !== "active") continue;
      for (const tool of entry.tools) {
        if (!seen.has(tool.name)) {
          tools.push({ ...tool, service: entry.name });
          seen.add(tool.name);
        }
      }
    }

    return tools;
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
      updateServiceStatus(name, "error");
      this.services.delete(name);
      return;
    }

    const backoffMs = Math.min(1000 * 2 ** managed.crashCount, 30_000);
    log.info(`Restarting "${name}" in ${backoffMs}ms (crash #${managed.crashCount})`);
    await new Promise((r) => setTimeout(r, backoffMs));

    try {
      const client = new McpClient(managed.entry);
      await client.connect();
      managed.client = client;
      managed.lastHealthCheck = Date.now();
      log.info(`Service "${name}" restarted successfully`);
    } catch (err) {
      log.error(`Failed to restart "${name}": ${err}`);
    }
  }

  // --- Idle shutdown ---

  private async checkIdleServices(): Promise<void> {
    const now = Date.now();
    for (const [name, managed] of this.services) {
      if (managed.idleSince === null) {
        managed.idleSince = now; // Start tracking
        continue;
      }
      if (now - managed.idleSince > this.config.idleShutdownMs) {
        log.info(`Service "${name}" idle for ${this.config.idleShutdownMs}ms, shutting down`);
        await this.stopService(name);
      }
    }
  }
}
