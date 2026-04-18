import type { ServiceEntry } from "./registry.js";
import { registerService, getService } from "./registry.js";

/**
 * Register built-in services if not already in the registry.
 */
export function ensureBuiltinServices(): void {
  const builtins: ServiceEntry[] = [
    {
      name: "filesystem",
      version: "0.1.0",
      origin: "builtin",
      command: "node",
      args: ["--import", "tsx", "src/services/filesystem/service.ts"],
      transport: "stdio",
      tools: [
        {
          name: "read_file",
          description: "Read the contents of a file",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        {
          name: "write_file",
          description: "Write content to a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
        {
          name: "list_dir",
          description: "List contents of a directory",
          inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        },
        {
          name: "search_files",
          description: "Search for files matching a pattern",
          inputSchema: {
            type: "object",
            properties: { directory: { type: "string" }, pattern: { type: "string" } },
            required: ["directory", "pattern"],
          },
        },
      ],
      capabilities: ["filesystem"],
      status: "active",
      createdAt: new Date().toISOString(),
    },
    {
      name: "shell",
      version: "0.1.0",
      origin: "builtin",
      command: "node",
      args: ["--import", "tsx", "src/services/shell/service.ts"],
      transport: "stdio",
      tools: [
        {
          name: "run_command",
          description: "Execute a shell command",
          inputSchema: {
            type: "object",
            properties: {
              command: { type: "string" },
              cwd: { type: "string" },
              timeout: { type: "number" },
            },
            required: ["command"],
          },
        },
      ],
      capabilities: ["shell"],
      status: "active",
      createdAt: new Date().toISOString(),
    },
    {
      name: "git",
      version: "0.1.0",
      origin: "builtin",
      command: "node",
      args: ["--import", "tsx", "src/services/git/service.ts"],
      transport: "stdio",
      tools: [
        { name: "status", description: "Show working tree status", inputSchema: { type: "object", properties: {} } },
        { name: "create_branch", description: "Create and checkout a new branch", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        { name: "checkout", description: "Checkout a branch or ref", inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
        { name: "commit", description: "Stage and commit changes", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
        { name: "merge", description: "Merge a branch", inputSchema: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] } },
        { name: "diff", description: "Show diff", inputSchema: { type: "object", properties: {} } },
        { name: "delete_branch", description: "Delete a branch", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        { name: "log", description: "Show recent commit log", inputSchema: { type: "object", properties: {} } },
      ],
      capabilities: ["git"],
      status: "active",
      createdAt: new Date().toISOString(),
    },
    {
      name: "lock",
      version: "0.1.0",
      origin: "builtin",
      command: "node",
      args: ["--import", "tsx", "src/services/lock/service.ts"],
      transport: "stdio",
      tools: [
        { name: "acquire", description: "Acquire an advisory lock", inputSchema: { type: "object", properties: { name: { type: "string" }, holder: { type: "string" } }, required: ["name", "holder"] } },
        { name: "release", description: "Release a lock", inputSchema: { type: "object", properties: { name: { type: "string" }, holder: { type: "string" } }, required: ["name", "holder"] } },
        { name: "status", description: "Check lock status", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        { name: "list", description: "List all active locks", inputSchema: { type: "object", properties: {} } },
      ],
      capabilities: ["locking"],
      status: "active",
      createdAt: new Date().toISOString(),
    },
    {
      name: "index",
      version: "0.1.0",
      origin: "builtin",
      command: "node",
      args: ["--import", "tsx", "src/services/index/service.ts"],
      transport: "stdio",
      tools: [
        { name: "ingest", description: "Index a document", inputSchema: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, content: { type: "string" } }, required: ["id", "type", "content"] } },
        { name: "search", description: "Full-text search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "search_conversations", description: "Search conversations", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
        { name: "search_work", description: "Search work items", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
      ],
      capabilities: ["search"],
      status: "active",
      createdAt: new Date().toISOString(),
    },
    {
      name: "memory",
      version: "0.1.0",
      origin: "builtin",
      command: "node",
      args: ["--import", "tsx", "src/services/memory/service.ts"],
      transport: "stdio",
      tools: [
        { name: "store", description: "Store a memory", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } },
        { name: "recall", description: "Recall a memory", inputSchema: { type: "object", properties: { key: { type: "string" } } } },
        { name: "list", description: "List memories", inputSchema: { type: "object", properties: {} } },
        { name: "delete", description: "Delete a memory", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
      ],
      capabilities: ["memory"],
      status: "active",
      createdAt: new Date().toISOString(),
    },
    {
      name: "web",
      version: "0.1.0",
      origin: "builtin",
      command: "node",
      args: ["--import", "tsx", "src/services/web/service.ts"],
      transport: "stdio",
      tools: [
        { name: "fetch_url", description: "Fetch raw URL content", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
        { name: "fetch_page_content", description: "Fetch and extract page text", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
      ],
      capabilities: ["network"],
      status: "active",
      createdAt: new Date().toISOString(),
    },
    {
      name: "skills",
      version: "0.1.0",
      origin: "builtin",
      command: "node",
      args: ["--import", "tsx", "src/services/skills/service.ts"],
      transport: "stdio",
      tools: [
        { name: "list_skills", description: "List all available skills with descriptions, triggers, and agent types", inputSchema: { type: "object", properties: {} } },
        { name: "read_skill", description: "Read the full content of a skill", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
        { name: "create_skill", description: "Create a new skill that teaches agents how to perform a task", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, content: { type: "string" }, scope: { type: "string", enum: ["user", "workspace"] } }, required: ["name", "description", "content"] } },
        { name: "update_skill", description: "Update an existing skill with improved instructions", inputSchema: { type: "object", properties: { name: { type: "string" }, content: { type: "string" }, reason: { type: "string" } }, required: ["name", "content", "reason"] } },
      ],
      capabilities: ["skills"],
      status: "active",
      createdAt: new Date().toISOString(),
    },
  ];

  for (const entry of builtins) {
    if (!getService(entry.name)) {
      registerService(entry);
    }
  }
}
