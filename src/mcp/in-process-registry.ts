import type { ToolEntry } from "./types.js";
import type { ToolCallContext } from "./toolContext.js";
import { applyToolFilter } from "../agents/tool-filters.js";
import { getToolFilter } from "../agents/roster.js";
import { log } from "../log.js";

export interface RuntimeToolEntry extends ToolEntry {
  service: string;
}

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

export class InProcessServiceRegistry {
  private services = new Map<string, InProcessService>();

  constructor(private readonly opts: { inProcessTimeoutMs: number; shellTimeoutMs: number }) {}

  register(
    name: string,
    tools: ToolEntry[],
    handler: InProcessToolHandler,
  ): void {
    this.services.set(name, { name, tools, handler });
    log.info(`In-process service "${name}" registered — ${tools.length} tools`);
  }

  hasService(name: string): boolean {
    return this.services.has(name);
  }

  async callTool(
    serviceName: string,
    toolName: string,
    args: Record<string, unknown>,
    ctx?: ToolCallContext,
  ): Promise<unknown> {
    const service = this.services.get(serviceName);
    if (!service) throw new Error(`Unknown in-process MCP service "${serviceName}"`);

    this.authorizeToolCall(service, toolName, ctx);
    const timeoutMs = serviceName === "shell"
      ? this.opts.shellTimeoutMs
      : this.opts.inProcessTimeoutMs;
    const result = await withTimeout(
      service.handler(toolName, args, ctx),
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

  getAllTools(): RuntimeToolEntry[] {
    const tools: RuntimeToolEntry[] = [];
    for (const [name, svc] of this.services) {
      for (const tool of svc.tools) tools.push({ ...tool, service: name });
    }
    return tools;
  }

  listAllToolsForApi(): Array<{
    name: string;
    service: string;
    description: string;
    inputSchema: unknown;
  }> {
    const out: Array<{ name: string; service: string; description: string; inputSchema: unknown }> = [];
    for (const [name, svc] of this.services) {
      for (const tool of svc.tools) {
        out.push({
          name: tool.name,
          service: name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        });
      }
    }
    return out;
  }

  private authorizeToolCall(
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
