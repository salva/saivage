import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServiceEntry, ToolEntry } from "./types.js";
import { log } from "../log.js";

export interface McpToolCallResult {
  content: unknown;
  isError: boolean;
}

/**
 * Wraps the MCP SDK Client for a single service.
 * Handles connection, tool listing, and tool calls.
 */
export class McpClient {
  private client: Client;
  private transport: StdioClientTransport | null = null;
  private tools: ToolEntry[] = [];
  private _connected = false;

  constructor(private serviceEntry: ServiceEntry) {
    this.client = new Client(
      { name: "saivage", version: "0.1.0" },
      { capabilities: {} },
    );
  }

  get name(): string {
    return this.serviceEntry.name;
  }

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (this._connected) return;

    this.transport = new StdioClientTransport({
      command: this.serviceEntry.command,
      args: this.serviceEntry.args,
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...(this.serviceEntry.env ?? {}) }).filter(([, v]) => v !== undefined),
      ) as Record<string, string>,
    });

    await this.client.connect(this.transport);
    this._connected = true;

    // Discover tools
    try {
      const result = await this.client.listTools();
      this.tools = result.tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: (t.inputSchema ?? {}) as Record<string, unknown>,
      }));
      log.info(
        `Connected to "${this.name}" — ${this.tools.length} tools available`,
      );
    } catch (err) {
      log.warn(`Failed to list tools for "${this.name}": ${err}`);
    }
  }

  async disconnect(): Promise<void> {
    if (!this._connected) return;
    try {
      await this.client.close();
    } catch {
      // Ignore close errors
    }
    this._connected = false;
    this.transport = null;
  }

  getTools(): ToolEntry[] {
    return this.tools;
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpToolCallResult> {
    if (!this._connected) {
      throw new Error(`Service "${this.name}" not connected`);
    }

    const result = await this.client.callTool({ name: toolName, arguments: args });
    const isError = result.isError === true;
    return { content: result.content, isError };
  }
}
