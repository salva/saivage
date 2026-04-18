/**
 * Saivage — Built-in MCP Services (in-process)
 *
 * Core services (filesystem, shell, git, skills) run in-process — no
 * subprocess spawning, no external dependencies.  Services that need
 * libraries not yet integrated (web, memory, index, lock) are registered
 * as stubs that return a descriptive error if called.
 */

import type { McpRuntime, InProcessToolHandler } from "./runtime.js";
import type { ToolEntry } from "./registry.js";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../log.js";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 100 * 1024; // 100 KB

function projectRoot(): string {
  return process.env["PROJECT_ROOT"] ?? process.cwd();
}

function resolvePath(p: string): string {
  if (p.startsWith("/")) return p;
  return join(projectRoot(), p);
}

// ─── Filesystem ─────────────────────────────────────────────────────────────

const filesystemTools: ToolEntry[] = [
  {
    name: "read_file",
    description: "Read the contents of a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Write content to a file (creates parent dirs if needed)",
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
    description: "Search for files matching a glob pattern",
    inputSchema: {
      type: "object",
      properties: { directory: { type: "string" }, pattern: { type: "string" } },
      required: ["directory", "pattern"],
    },
  },
];

const filesystemHandler: InProcessToolHandler = async (toolName, args) => {
  switch (toolName) {
    case "read_file": {
      const fp = resolvePath(args.path as string);
      const content = readFileSync(fp, "utf-8");
      return { content: { content }, isError: false };
    }
    case "write_file": {
      const fp = resolvePath(args.path as string);
      mkdirSync(dirname(fp), { recursive: true });
      writeFileSync(fp, args.content as string, "utf-8");
      return { content: { written: true, path: fp }, isError: false };
    }
    case "list_dir": {
      const dp = resolvePath(args.path as string);
      const entries = readdirSync(dp, { withFileTypes: true }).map((e) => ({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
      }));
      return { content: { entries }, isError: false };
    }
    case "search_files": {
      const dir = resolvePath(args.directory as string);
      const pattern = args.pattern as string;
      // Extract filename-level glob for find -name (handles **/*.ext etc.)
      const namePattern = pattern.includes("/") ? pattern.split("/").pop()! : pattern;
      try {
        const { stdout } = await execFileAsync(
          "find",
          [dir, "-name", namePattern, "-type", "f"],
          { maxBuffer: MAX_OUTPUT },
        );
        const files = stdout.trim().split("\n").filter(Boolean);
        return { content: { files }, isError: false };
      } catch {
        return { content: { files: [] }, isError: false };
      }
    }
    default:
      return { content: { error: `Unknown filesystem tool: ${toolName}` }, isError: true };
  }
};

// ─── Shell ──────────────────────────────────────────────────────────────────

const shellTools: ToolEntry[] = [
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
];

const shellHandler: InProcessToolHandler = async (toolName, args) => {
  if (toolName !== "run_command") {
    return { content: { error: `Unknown shell tool: ${toolName}` }, isError: true };
  }

  const command = args.command as string;
  const cwd = args.cwd ? resolvePath(args.cwd as string) : projectRoot();
  const timeout = (args.timeout as number | undefined) ?? 60_000;

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd,
      timeout,
      maxBuffer: MAX_OUTPUT,
      env: { ...process.env, PROJECT_ROOT: projectRoot() },
    });
    return { content: { stdout, stderr, exitCode: 0 }, isError: false };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
    if (e.killed) {
      return {
        content: { stdout: e.stdout ?? "", stderr: `Command timed out after ${timeout}ms`, exitCode: 124 },
        isError: false,
      };
    }
    return {
      content: {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? "",
        exitCode: typeof e.code === "number" ? e.code : 1,
      },
      isError: false, // non-zero exit is not an MCP error
    };
  }
};

// ─── Git ────────────────────────────────────────────────────────────────────

const gitTools: ToolEntry[] = [
  { name: "git_status", description: "Show working tree status", inputSchema: { type: "object", properties: {} } },
  { name: "git_create_branch", description: "Create and checkout a new branch", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "git_checkout", description: "Checkout a branch or ref", inputSchema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "git_commit", description: "Stage specified files and commit", inputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } }, message: { type: "string" }, task_id: { type: "string" } }, required: ["message"] } },
  { name: "git_merge", description: "Merge a branch", inputSchema: { type: "object", properties: { branch: { type: "string" } }, required: ["branch"] } },
  { name: "git_diff", description: "Show diff", inputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } }, ref1: { type: "string" }, ref2: { type: "string" } } } },
  { name: "git_delete_branch", description: "Delete a branch", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "git_log", description: "Show recent commit log", inputSchema: { type: "object", properties: { n: { type: "number" }, branch: { type: "string" } } } },
];

async function gitExec(gitArgs: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", gitArgs, { cwd, maxBuffer: MAX_OUTPUT });
  return stdout.trim();
}

const gitHandler: InProcessToolHandler = async (toolName, args) => {
  const cwd = projectRoot();

  switch (toolName) {
    case "git_status": {
      const raw = await gitExec(["status", "--porcelain"], cwd);
      const lines = raw.split("\n").filter(Boolean);
      const modified: string[] = [];
      const added: string[] = [];
      const deleted: string[] = [];
      const untracked: string[] = [];
      for (const line of lines) {
        const status = line.substring(0, 2);
        const file = line.substring(3);
        if (status.includes("?")) untracked.push(file);
        else if (status.includes("D")) deleted.push(file);
        else if (status.includes("A")) added.push(file);
        else modified.push(file);
      }
      return { content: { modified, added, deleted, untracked }, isError: false };
    }

    case "git_create_branch": {
      const name = args.name as string;
      await gitExec(["checkout", "-b", name], cwd);
      return { content: { branch: name, created: true }, isError: false };
    }

    case "git_checkout": {
      const ref = args.ref as string;
      await gitExec(["checkout", ref], cwd);
      return { content: { ref, checked_out: true }, isError: false };
    }

    case "git_commit": {
      const files = (args.files as string[] | undefined) ?? ["."];
      const message = args.message as string;
      const taskId = args.task_id as string | undefined;
      const prefix = taskId ? `[tsk-${taskId}] ` : "";

      for (const f of files) {
        await gitExec(["add", "--", f], cwd);
      }

      try {
        await gitExec(["commit", "-m", prefix + message], cwd);
      } catch (err: unknown) {
        const msg = (err as Error).message ?? "";
        if (msg.includes("nothing to commit")) {
          return { content: { sha: "none", message: "Nothing to commit" }, isError: false };
        }
        const status = await gitExec(["status", "--porcelain"], cwd);
        if (status.includes("UU") || status.includes("AA")) {
          const conflictFiles = status
            .split("\n")
            .filter((l) => l.startsWith("UU") || l.startsWith("AA"))
            .map((l) => l.substring(3));
          return { content: { error: "CONFLICT", files: conflictFiles }, isError: true };
        }
        throw err;
      }

      const sha = await gitExec(["rev-parse", "HEAD"], cwd);
      return { content: { sha }, isError: false };
    }

    case "git_merge": {
      const branch = args.branch as string;
      const output = await gitExec(["merge", branch], cwd);
      return { content: { merged: true, output }, isError: false };
    }

    case "git_diff": {
      const files = args.files as string[] | undefined;
      const ref1 = args.ref1 as string | undefined;
      const ref2 = args.ref2 as string | undefined;
      const gitArgs = ["diff"];
      if (ref1) gitArgs.push(ref1);
      if (ref2) gitArgs.push(ref2);
      if (files?.length) {
        gitArgs.push("--");
        gitArgs.push(...files);
      }
      const diff = await gitExec(gitArgs, cwd);
      return { content: { diff }, isError: false };
    }

    case "git_delete_branch": {
      const name = args.name as string;
      await gitExec(["branch", "-d", name], cwd);
      return { content: { branch: name, deleted: true }, isError: false };
    }

    case "git_log": {
      const n = (args.n as number | undefined) ?? 10;
      const branch = args.branch as string | undefined;
      const gitArgs = ["log", "--format=%H%x00%s%x00%an%x00%aI", `-n`, String(n)];
      if (branch) gitArgs.push(branch);
      const raw = await gitExec(gitArgs, cwd);
      const commits = raw
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, message, author, date] = line.split("\0");
          return { sha, message, author, date };
        });
      return { content: { commits }, isError: false };
    }

    default:
      return { content: { error: `Unknown git tool: ${toolName}` }, isError: true };
  }
};

// ─── Skills ─────────────────────────────────────────────────────────────────

const skillsTools: ToolEntry[] = [
  { name: "list_skills", description: "List all available skills", inputSchema: { type: "object", properties: {} } },
  { name: "read_skill", description: "Read a skill's content", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "create_skill", description: "Create a new skill", inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, content: { type: "string" } }, required: ["name", "description", "content"] } },
  { name: "update_skill", description: "Update an existing skill", inputSchema: { type: "object", properties: { name: { type: "string" }, content: { type: "string" }, reason: { type: "string" } }, required: ["name", "content", "reason"] } },
];

const skillsHandler: InProcessToolHandler = async (toolName, args) => {
  const skillsDir = join(
    process.env["SAIVAGE_ROOT"] ?? join(projectRoot(), ".saivage"),
    "skills",
  );

  switch (toolName) {
    case "list_skills": {
      const indexPath = join(skillsDir, "index.json");
      if (!existsSync(indexPath)) return { content: { skills: [] }, isError: false };
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      return { content: index, isError: false };
    }
    case "read_skill": {
      const name = args.name as string;
      const skillPath = join(skillsDir, `${name}.md`);
      if (!existsSync(skillPath)) {
        return { content: { error: `Skill "${name}" not found` }, isError: true };
      }
      return { content: { name, content: readFileSync(skillPath, "utf-8") }, isError: false };
    }
    case "create_skill": {
      const name = args.name as string;
      const description = args.description as string;
      const content = args.content as string;
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, `${name}.md`), content, "utf-8");
      const indexPath = join(skillsDir, "index.json");
      const index = existsSync(indexPath)
        ? JSON.parse(readFileSync(indexPath, "utf-8"))
        : { skills: [] };
      index.skills.push({ name, description, created_at: new Date().toISOString() });
      writeFileSync(indexPath, JSON.stringify(index, null, 2), "utf-8");
      return { content: { created: true, name }, isError: false };
    }
    case "update_skill": {
      const name = args.name as string;
      const content = args.content as string;
      const skillPath = join(skillsDir, `${name}.md`);
      if (!existsSync(skillPath)) {
        return { content: { error: `Skill "${name}" not found` }, isError: true };
      }
      writeFileSync(skillPath, content, "utf-8");
      return { content: { updated: true, name }, isError: false };
    }
    default:
      return { content: { error: `Unknown skills tool: ${toolName}` }, isError: true };
  }
};

// ─── Stubs (not yet implemented) ────────────────────────────────────────────

function stubHandler(serviceName: string): InProcessToolHandler {
  return async (toolName) => ({
    content: { error: `Service "${serviceName}" is not yet implemented. Tool "${toolName}" is unavailable.` },
    isError: true,
  });
}

const webTools: ToolEntry[] = [
  { name: "fetch_url", description: "Fetch raw URL content", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "fetch_page_content", description: "Fetch and extract page text", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
];

const memoryTools: ToolEntry[] = [
  { name: "store_memory", description: "Store a key-value memory", inputSchema: { type: "object", properties: { key: { type: "string" }, value: { type: "string" } }, required: ["key", "value"] } },
  { name: "recall_memory", description: "Recall a memory by key", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "list_memories", description: "List stored memories", inputSchema: { type: "object", properties: {} } },
  { name: "delete_memory", description: "Delete a memory by key", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
];

const indexTools: ToolEntry[] = [
  { name: "index_ingest", description: "Index a document for search", inputSchema: { type: "object", properties: { id: { type: "string" }, type: { type: "string" }, content: { type: "string" } }, required: ["id", "type", "content"] } },
  { name: "index_search", description: "Full-text search across indexed documents", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
];

const lockTools: ToolEntry[] = [
  { name: "lock_acquire", description: "Acquire an advisory lock", inputSchema: { type: "object", properties: { name: { type: "string" }, holder: { type: "string" } }, required: ["name", "holder"] } },
  { name: "lock_release", description: "Release a lock", inputSchema: { type: "object", properties: { name: { type: "string" }, holder: { type: "string" } }, required: ["name", "holder"] } },
  { name: "lock_status", description: "Check lock status", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "lock_list", description: "List all active locks", inputSchema: { type: "object", properties: {} } },
];

// ─── Registration ───────────────────────────────────────────────────────────

/**
 * Register all built-in services as in-process handlers on the MCP runtime.
 * No subprocess spawning — all operations run directly in the Node.js process.
 */
export function registerBuiltinServices(mcpRuntime: McpRuntime): void {
  mcpRuntime.registerInProcess("filesystem", filesystemTools, filesystemHandler);
  mcpRuntime.registerInProcess("shell", shellTools, shellHandler);
  mcpRuntime.registerInProcess("git", gitTools, gitHandler);
  mcpRuntime.registerInProcess("skills", skillsTools, skillsHandler);

  // Stubs — services that need external dependencies not yet integrated
  mcpRuntime.registerInProcess("web", webTools, stubHandler("web"));
  mcpRuntime.registerInProcess("memory", memoryTools, stubHandler("memory"));
  mcpRuntime.registerInProcess("index", indexTools, stubHandler("index"));
  mcpRuntime.registerInProcess("lock", lockTools, stubHandler("lock"));

  log.info("[builtins] 8 built-in services registered (4 active, 4 stubs)");
}
