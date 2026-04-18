---
name: mcp-authoring
description: How to create MCP server tools
version: 0.1.0
agentTypes: [coder]
triggers: [mcp, tool, service, server, generate.*service]
dependencies: [coding]
---

## MCP Service Authoring

When creating an MCP service:

1. **Use McpServer from `@modelcontextprotocol/sdk/server/mcp.js`** — not from `server/index.js`.
2. **Use zod for parameter schemas** — define each parameter with `.describe()`.
3. **Return content blocks** — always `{ content: [{ type: "text", text: "..." }] }`.
4. **Error handling** — catch errors and return `isError: true` with a message.
5. **Transport** — use `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.
6. **Self-contained** — each service is a standalone Node.js script with its own imports.
7. **Register in `~/.saivage/registry.json`** — include name, command, args, tools list.

### Template

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "my-service", version: "0.1.0" });

server.tool("my_tool", "Description", {
  param: z.string().describe("Parameter description"),
}, async ({ param }) => {
  return { content: [{ type: "text", text: JSON.stringify({ result: param }) }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
```
