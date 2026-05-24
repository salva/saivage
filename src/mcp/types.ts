export interface ToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ServiceEntry {
  name: string;
  version: string;
  origin: "builtin" | "external";
  command: string;
  args: string[];
  env: Record<string, string>;
  transport: "stdio" | "sse";
  tools: ToolEntry[];
  capabilities: string[];
  createdAt: string;
}
